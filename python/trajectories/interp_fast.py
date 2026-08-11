"""Optional Numba-accelerated height-path interpolation (Phase E)."""

from __future__ import annotations

from typing import Any

import numpy as np

_HAS_NUMBA = False
try:
    from numba import njit

    _HAS_NUMBA = True
except ImportError:  # pragma: no cover
    njit = None  # type: ignore[misc, assignment]


def _height_bracket_py(h_agl: np.ndarray, h_target: float) -> tuple[int, int, float, int]:
    """Returns k0, k1, hw, err_code (0=ok, 1=bad target, 2=above window)."""
    if not np.isfinite(h_target):
        return 0, 0, 0.0, 1
    L = h_agl.shape[0]
    k1 = 0
    while k1 < L and h_agl[k1] < h_target:
        k1 += 1
    if k1 >= L:
        return 0, 0, 0.0, 2
    k0 = k1 - 1 if k1 > 0 else 0
    if k1 == k0 or h_target <= h_agl[k0]:
        hw = 0.0
    else:
        hw = (h_target - h_agl[k0]) / (h_agl[k1] - h_agl[k0])
    return k0, k1, hw, 0


def _sample_level_py(series: np.ndarray, ti: int, tw: float) -> float:
    """series shape [nLevels, nTimes] or 1d [nTimes] for one level — here 1d time."""
    v0 = series[ti]
    v1 = series[ti + 1]
    return float(v0 + tw * (v1 - v0))


def _interp_uv_height_py(h_agl, u, v, h_target, ti, tw):
    k0, k1, hw, err = _height_bracket_py(h_agl, h_target)
    if err != 0:
        return 0.0, 0.0, 0.0, 0, 0, 0.0, err
    u0 = _sample_level_py(u[k0], ti, tw)
    u1 = _sample_level_py(u[k1], ti, tw)
    v0 = _sample_level_py(v[k0], ti, tw)
    v1 = _sample_level_py(v[k1], ti, tw)
    return (
        u0 + hw * (u1 - u0),
        v0 + hw * (v1 - v0),
        float(h_agl[k0] + hw * (h_agl[k1] - h_agl[k0])),
        k0, k1, hw, 0,
    )


# cache=False: editable installs / some runtimes lack a Numba source locator
# ("cannot cache function ... no locator available").
if _HAS_NUMBA and njit is not None:
    try:

        @njit(cache=False)
        def _height_bracket_nb(h_agl: np.ndarray, h_target: float) -> tuple[int, int, float, int]:
            if not np.isfinite(h_target):
                return 0, 0, 0.0, 1
            L = h_agl.shape[0]
            k1 = 0
            while k1 < L and h_agl[k1] < h_target:
                k1 += 1
            if k1 >= L:
                return 0, 0, 0.0, 2
            k0 = k1 - 1 if k1 > 0 else 0
            if k1 == k0 or h_target <= h_agl[k0]:
                hw = 0.0
            else:
                hw = (h_target - h_agl[k0]) / (h_agl[k1] - h_agl[k0])
            return k0, k1, hw, 0

        @njit(cache=False)
        def _interp_uv_height_nb(
            h_agl: np.ndarray,
            u: np.ndarray,
            v: np.ndarray,
            h_target: float,
            ti: int,
            tw: float,
        ) -> tuple[float, float, float, int, int, float, int]:
            """u,v: [nLevels, nTimes]. Returns u,v,hAgl,k0,k1,hw,err."""
            k0, k1, hw, err = _height_bracket_nb(h_agl, h_target)
            if err != 0:
                return 0.0, 0.0, 0.0, 0, 0, 0.0, err
            u0 = u[k0, ti] + tw * (u[k0, ti + 1] - u[k0, ti])
            u1 = u[k1, ti] + tw * (u[k1, ti + 1] - u[k1, ti])
            v0 = v[k0, ti] + tw * (v[k0, ti + 1] - v[k0, ti])
            v1 = v[k1, ti] + tw * (v[k1, ti + 1] - v[k1, ti])
            h0 = h_agl[k0]
            h1 = h_agl[k1]
            return u0 + hw * (u1 - u0), v0 + hw * (v1 - v0), h0 + hw * (h1 - h0), k0, k1, hw, 0

        # Force compile once so import-time / first-request failures fall back.
        _interp_uv_height_nb(
            np.array([10.0, 100.0], dtype=np.float32),
            np.zeros((2, 2), dtype=np.float32),
            np.zeros((2, 2), dtype=np.float32),
            50.0,
            0,
            0.0,
        )
    except Exception:  # pragma: no cover
        _HAS_NUMBA = False
        _interp_uv_height_nb = _interp_uv_height_py  # type: ignore[misc, assignment]
else:
    _interp_uv_height_nb = _interp_uv_height_py  # type: ignore[misc, assignment]


def ensure_point_arrays(pt: dict) -> None:
    """Attach float32 arrays on a WindField point dict (idempotent)."""
    if pt.get("_u_arr") is not None:
        return
    # pt["u"] is list of length-L time series (each list of T floats)
    L = len(pt["hAgl"])
    T = len(pt["u"][0]) if L else 0
    u = np.empty((L, T), dtype=np.float32)
    v = np.empty((L, T), dtype=np.float32)
    for k in range(L):
        u[k, :] = np.asarray(pt["u"][k], dtype=np.float32)
        v[k, :] = np.asarray(pt["v"][k], dtype=np.float32)
    pt["_u_arr"] = u
    pt["_v_arr"] = v
    pt["_h_arr"] = np.asarray(pt["hAgl"], dtype=np.float32)


def resolve_height_fast(pt: dict, h_target: float, tt: dict) -> dict[str, Any] | None:
    """
    Fast path for constant-height / z3d AGL targets.
    Returns None to fall back to Python resolve_on_target.
    """
    try:
        ensure_point_arrays(pt)
        u_out, v_out, h_out, k0, k1, hw, err = _interp_uv_height_nb(
            pt["_h_arr"],
            pt["_u_arr"],
            pt["_v_arr"],
            float(h_target),
            int(tt["ti"]),
            float(tt["tw"]),
        )
    except Exception:
        return None
    if err == 1:
        return {"error": "Ungültige Zielhöhe (Datenlücke)"}
    if err == 2:
        return {"error": "Oberhalb des geladenen Höhenfensters"}
    return {
        "u": float(u_out),
        "v": float(v_out),
        "hAgl": float(h_out),
        "k0": int(k0),
        "k1": int(k1),
        "hw": float(hw),
        "w": 0.0,
    }


def numba_enabled() -> bool:
    return _HAS_NUMBA
