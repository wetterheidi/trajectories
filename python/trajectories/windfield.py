"""Wind field / Open-Meteo client — port of src/windfield.js."""

from __future__ import annotations

import math
import threading
from typing import Any

import httpx

from . import config

KMH_TO_MS = 1 / 3.6
MAX_POINTS_PER_REQUEST = 10
KAPPA = 0.2854


class WindField:
    def __init__(
        self,
        model_key: str,
        *,
        client: httpx.Client | None = None,
        w_var_prefix: str | None = None,
        debug: bool = False,
        backend: str | None = None,
    ):
        if model_key not in config.MODELS:
            raise ValueError(f"Unbekanntes Modell: {model_key}")
        self.model = config.MODELS[model_key]
        self.model_key = model_key
        self._client = client
        self._owns_client = client is None
        self.w_var_prefix = w_var_prefix
        self.debug = debug
        self.points: dict[str, dict] = {}
        self.levels: list[int] | None = None
        self.times: list[float] | None = None
        self.units: dict[str, str] = {}
        self.needs = {"p": False, "t": False, "w": False, "met": False}
        self.start_date: str | None = None
        self.end_date: str | None = None
        self._pending: dict[str, Any] = {}
        self._points_lock = threading.Lock()
        self.backend_kind = backend or config.resolve_backend(model_key)
        self._om = None
        self._slab = None
        if self.backend_kind == "om":
            from .om_backend import get_om_backend

            self._om = get_om_backend(model_key)

    def _http(self) -> httpx.Client:
        if self._client is None:
            # trust_env=False: avoid HTTP(S)_PROXY breaking private Open-Meteo hosts
            self._client = httpx.Client(timeout=120.0, trust_env=False)
        return self._client

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None
        # Keep process-cached OmBackend; drop per-request slab only.
        self._slab = None
        self._om = None

    def __enter__(self) -> WindField:
        return self

    def __exit__(self, *args) -> None:
        self.close()

    @staticmethod
    def detect_w_variable(
        model_key: str = "icon_eu",
        client: httpx.Client | None = None,
        *,
        backend: str | None = None,
    ) -> str | None:
        kind = backend or config.resolve_backend(model_key)
        if kind == "om":
            from .om_backend import get_om_backend

            try:
                om = get_om_backend(model_key)
            except Exception:
                return None
            return "wind_w" if om.has_w() else None

        model = config.MODELS[model_key]
        owns = client is None
        http = client or httpx.Client(timeout=60.0, trust_env=False)
        try:
            for prefix in ("wind_w", "vertical_velocity", "w", "wind_w_component"):
                try:
                    var_name = f"{prefix}_level{model['nLevels'] - 5}"
                    url = (
                        f"{config.API_BASE}/v1/forecast?latitude=50&longitude=10"
                        f"&hourly={var_name}&models={model['apiModel']}&forecast_days=1"
                    )
                    resp = http.get(url)
                    if not resp.is_success:
                        continue
                    d = resp.json()
                    if d.get("error"):
                        continue
                    vals = (d.get("hourly") or {}).get(var_name)
                    if isinstance(vals, list) and any(v is not None and _isfinite(v) for v in vals):
                        return prefix
                    continue
                except Exception:
                    continue
            return None
        finally:
            if owns:
                http.close()

    def in_bbox(self, lat: float, lon: float) -> bool:
        b = self.model["bbox"]
        return b["latMin"] <= lat <= b["latMax"] and b["lonMin"] <= lon <= b["lonMax"]

    def init(
        self,
        lat0: float,
        lon0: float,
        max_height_m: float,
        t_min_ms: float,
        t_max_ms: float,
        vmotion: str | list[str] = "height",
        met_extras: bool = False,
        *,
        include_w: bool = False,
    ) -> None:
        lst = list(vmotion) if isinstance(vmotion, (list, tuple)) else [vmotion]
        # z3d trajectories require w; include_w loads it when present (point wind).
        self._w_required = "z3d" in lst
        want_w = self._w_required or include_w
        if want_w and not self.w_var_prefix:
            if self._w_required:
                raise RuntimeError("Server liefert (noch) keine Modell-Vertikalgeschwindigkeit")
            want_w = False
        self.needs = {
            "p": any(v in ("pressure", "theta") for v in lst),
            "t": "theta" in lst,
            "w": want_w,
            "met": met_extras,
        }
        if self.needs["p"] or met_extras:
            self.needs["p"] = True
            self.needs["t"] = True

        n = self.model["nLevels"]
        from datetime import datetime, timezone

        d0 = datetime.fromtimestamp((min(t_min_ms, t_max_ms) - 3600e3) / 1000, tz=timezone.utc)
        d1 = datetime.fromtimestamp((max(t_min_ms, t_max_ms) + 3600e3) / 1000, tz=timezone.utc)
        self.start_date = d0.strftime("%Y-%m-%d")
        self.end_date = d1.strftime("%Y-%m-%d")
        duration_h = abs(t_max_ms - t_min_ms) / 3600e3

        buffer = 1200 if all(v == "height" for v in lst) else 2500
        required_top = (max_height_m + buffer) * 1.3

        if self.backend_kind == "om" and self._om is not None:
            from .om_backend import BAND_HIGH_M, height_band_ceiling_m

            profile = self._om.height_agl_profile(lat0, lon0)
            band_ceil = height_band_ceiling_m(max_height_m)
            if required_top > band_ceil:
                band_ceil = BAND_HIGH_M
            target_top = min(required_top, band_ceil)
            levels: list[int] = []
            for l in range(n, 0, -1):
                hl = profile.get(l)
                levels.append(l)
                if hl is not None and math.isfinite(hl) and hl >= target_top:
                    break
            self.levels = levels
            # Preload padded slab for selected levels + needed vars.
            self._slab = self._om.load_slab(
                lat0,
                lon0,
                duration_h,
                self.start_date,
                self.end_date,
                levels,
                self.level_vars(),
                t_min_ms=t_min_ms,
                t_max_ms=t_max_ms,
            )
        else:
            vars_ = [f"height_agl_level{l}" for l in range(1, n + 1)]
            probe = self.request([[lat0, lon0]], vars_)
            h = probe[0]
            levels = []
            for l in range(n, 0, -1):
                hl = first_finite(h.get(f"height_agl_level{l}"))
                levels.append(l)
                if hl is not None and hl >= required_top:
                    break
            self.levels = levels

    def level_vars(self) -> list[str]:
        assert self.levels is not None
        vars_: list[str] = []
        # cloud_cover_levelN / weather_code: only confirmed present on the HTTP
        # (Michael's hosted Open-Meteo-compatible) API so far. The local "om"
        # dataset only ever ingested what wind trajectories needed (u/v/w,
        # height_agl, pressure, temperature, specific_humidity) — fetching an
        # absent variable there raises (missing chunk directory) and would
        # break the whole run, so skip them for that backend rather than guess.
        want_surface = self.needs["met"] and self.backend_kind != "om"
        for l in self.levels:
            vars_.extend([
                f"wind_u_component_level{l}",
                f"wind_v_component_level{l}",
                f"height_agl_level{l}",
            ])
            if self.needs["p"]:
                vars_.append(f"pressure_level{l}")
            if self.needs["t"]:
                vars_.append(f"temperature_level{l}")
            if self.needs["met"]:
                # RH is derived from q+p+T (Magnus); no model relative_humidity fetch.
                vars_.append(f"specific_humidity_level{l}")
            if want_surface:
                vars_.append(f"cloud_cover_level{l}")
            if self.needs["w"]:
                vars_.append(f"{self.w_var_prefix}_level{l}")
        if want_surface:
            vars_.append("weather_code")
        return vars_

    def key(self, i_lat: int, i_lon: int) -> str:
        return f"{i_lat},{i_lon}"

    def corner_indices(self, lat: float, lon: float) -> tuple[int, int]:
        g = self.model["grid"]
        return math.floor(lat / g + 1e-9), math.floor(lon / g + 1e-9)

    def ensure_corners(self, lat: float, lon: float) -> None:
        with self._points_lock:
            i_lat, i_lon = self.corner_indices(lat, lon)
            wanted = [
                (i_lat, i_lon),
                (i_lat + 1, i_lon),
                (i_lat, i_lon + 1),
                (i_lat + 1, i_lon + 1),
            ]
            any_missing = any(
                self.key(a, b) not in self.points and self.key(a, b) not in self._pending
                for a, b in wanted
            )
            if not any_missing:
                return
            g = self.model["grid"]
            b0 = self.model["bbox"]
            block: list[tuple[int, int]] = []
            for a in range(i_lat - 1, i_lat + 3):
                for b in range(i_lon - 1, i_lon + 3):
                    in_core = (a, b) in wanted
                    in_box = (
                        b0["latMin"] <= a * g <= b0["latMax"]
                        and b0["lonMin"] <= b * g <= b0["lonMax"]
                    )
                    k = self.key(a, b)
                    if (in_core or in_box) and k not in self.points and k not in self._pending:
                        block.append((a, b))
            coords = [[a * g, b * g] for a, b in block]
            for a, b in block:
                self._pending[self.key(a, b)] = True
            try:
                self.fetch_points(coords, block)
            finally:
                for a, b in block:
                    self._pending.pop(self.key(a, b), None)

    def fetch_points(self, coords: list[list[float]], indices: list[tuple[int, int]]) -> None:
        vars_ = self.level_vars()
        for i in range(0, len(coords), MAX_POINTS_PER_REQUEST):
            chunk = coords[i : i + MAX_POINTS_PER_REQUEST]
            idx = indices[i : i + MAX_POINTS_PER_REQUEST]
            results = self.request(chunk, vars_, with_meta=True)
            for j, r in enumerate(results):
                self.store_point(idx[j][0], idx[j][1], r)

    def store_point(self, i_lat: int, i_lon: int, r: dict) -> None:
        assert self.levels is not None
        L = len(self.levels)
        if self.times is None:
            self.times = r["__times"]
        T = len(self.times)
        w_unit = (
            unit_factor(self.units.get(f"{self.w_var_prefix}_level{self.levels[0]}"))
            if self.needs["w"]
            else 1
        )
        q_unit = (
            1e-3
            if self.units.get(f"specific_humidity_level{self.levels[0]}") == "g/kg"
            else 1
        )
        # HTTP forecast API returns horizontal wind in km/h; local OM is m/s.
        # Missing hourly_units already default to "km/h" via .get(..., "km/h").
        u_unit = (
            1.0
            if self.backend_kind == "om"
            else unit_factor(self.units.get(f"wind_u_component_level{self.levels[0]}", "km/h"))
        )
        want_surface = self.needs["met"] and self.backend_kind != "om"
        point: dict[str, Any] = {
            "elevation": r["__elevation"],
            "hAgl": [float("nan")] * L,
            "u": [],
            "v": [],
            "p": [] if self.needs["p"] else None,
            "T": [] if self.needs["t"] else None,
            "w": [] if self.needs["w"] else None,
            "q": [] if self.needs["met"] else None,
            "rh": [] if self.needs["met"] else None,
            "clc": [] if want_surface else None,
            "ww": to_array(r.get("weather_code"), T, 1) if want_surface else None,
        }
        for k in range(L):
            l = self.levels[k]
            point["u"].append(to_array(r.get(f"wind_u_component_level{l}"), T, u_unit))
            point["v"].append(to_array(r.get(f"wind_v_component_level{l}"), T, u_unit))
            if point["p"] is not None:
                point["p"].append(to_array(r.get(f"pressure_level{l}"), T, 1))
            if point["T"] is not None:
                point["T"].append(to_array(r.get(f"temperature_level{l}"), T, 1, 273.15))
            if point["w"] is not None:
                point["w"].append(to_array(r.get(f"{self.w_var_prefix}_level{l}"), T, w_unit))
            if point["q"] is not None:
                point["q"].append(to_array(r.get(f"specific_humidity_level{l}"), T, q_unit))
            if point["rh"] is not None:
                point["rh"].append(to_array(r.get(f"relative_humidity_level{l}"), T, 1))
            if point["clc"] is not None:
                point["clc"].append(to_array(r.get(f"cloud_cover_level{l}"), T, 1))
            h = first_finite(r.get(f"height_agl_level{l}"))
            point["hAgl"][k] = float("nan") if h is None else h
        self.points[self.key(i_lat, i_lon)] = point

    def request(
        self,
        coords: list[list[float]],
        vars_: list[str],
        with_meta: bool = False,
    ) -> list[dict]:
        if self.backend_kind == "om":
            assert self._om is not None
            assert self.start_date and self.end_date
            self.units.update(self._om.units_for(vars_))
            return self._om.request(
                coords,
                vars_,
                self.start_date,
                self.end_date,
                with_meta=with_meta,
                slab=self._slab,
            )

        params = {
            "latitude": ",".join(str(round5(c[0])) for c in coords),
            "longitude": ",".join(str(round5(c[1])) for c in coords),
            "hourly": ",".join(vars_),
            "models": self.model["apiModel"],
            "timeformat": "unixtime",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "cell_selection": "nearest",
        }
        url = f"{config.API_BASE}/v1/forecast"
        resp = self._http().get(url, params=params)
        body = resp.text
        try:
            data = resp.json()
        except Exception as exc:
            raise RuntimeError(f"Serverfehler: {body[:180]}") from exc
        if not resp.is_success or (isinstance(data, dict) and data.get("error")):
            reason = data.get("reason", "") if isinstance(data, dict) else ""
            raise RuntimeError(
                f"API-Fehler: {reason[:180]}" if reason else f"API-Fehler {resp.status_code}"
            )
        arr = data if isinstance(data, list) else [data]
        out_list = []
        for d in arr:
            self.units.update(d.get("hourly_units") or {})
            out = dict(d.get("hourly") or {})
            if with_meta:
                out["__times"] = d["hourly"]["time"]
                out["__elevation"] = d["elevation"]
            out_list.append(out)
        return out_list

    def time_weights(self, t_ms: float) -> dict | None:
        assert self.times is not None
        t = t_ms / 1000
        times = self.times
        if t < times[0] or t > times[-1]:
            return None
        ti = min(math.floor((t - times[0]) / 3600), len(times) - 2)
        return {"ti": ti, "tw": (t - times[ti]) / 3600}

    def bilinear_weights(self, lat: float, lon: float) -> list[tuple[float, int, int]]:
        g = self.model["grid"]
        i_lat, i_lon = self.corner_indices(lat, lon)
        fy = lat / g - i_lat
        fx = lon / g - i_lon
        return [
            ((1 - fy) * (1 - fx), i_lat, i_lon),
            (fy * (1 - fx), i_lat + 1, i_lon),
            ((1 - fy) * fx, i_lat, i_lon + 1),
            (fy * fx, i_lat + 1, i_lon + 1),
        ]

    def wind_at(self, lat: float, lon: float, target: dict, t_ms: float) -> dict:
        if not self.in_bbox(lat, lon):
            return {"error": "Rand des Modellgebiets erreicht"}
        self.ensure_corners(lat, lon)
        tt = self.time_weights(t_ms)
        if not tt:
            return {"error": "Ende des Datenzeitraums erreicht"}

        U = V = W = Z = P = TK = Q = RH = CLC = 0.0
        weights = self.bilinear_weights(lat, lon)
        for wt, a, b in weights:
            p = self.points.get(self.key(a, b))
            if not p:
                return {"error": "Datenlücke im Gitter"}
            c = resolve_on_target(p, target, tt)
            if c.get("error"):
                return c
            U += wt * c["u"]
            V += wt * c["v"]
            W += wt * (c.get("w") or 0)
            Z += wt * (p["elevation"] + c["hAgl"])
            P += wt * (c.get("p") or 0)
            TK += wt * (c.get("tK") or 0)
            Q += wt * (c.get("q") or 0)
            RH += wt * (c.get("rh") or 0)
            CLC += wt * (c.get("clc") or 0)

        if not (_isfinite(U) and _isfinite(V)):
            return {"error": "Fehlende Winddaten (Modelllauf unvollständig)"}
        if self.needs["w"] and not _isfinite(W) and getattr(self, "_w_required", False):
            return {"error": "Modell-w fehlt am Rechenpunkt (null-Werte)"}

        met = None
        if self.needs["met"]:
            t_c = TK - 273.15
            rh = relative_humidity_pct(Q, P, t_c)
            if rh is None and _isfinite(RH):
                rh = RH
            met = {
                "t": t_c, "td": dewpoint_c(Q, P, t_c, RH), "rh": rh, "p": P,
                "clc": CLC if _isfinite(CLC) else None,
                "ww": self._weather_code_at(weights, tt),
            }

        out: dict[str, Any] = {"u": U, "v": V, "zAmsl": Z, "met": met}
        if self.needs["w"]:
            out["w"] = float(W) if _isfinite(W) else None
        return out

    def _weather_code_at(
        self, weights: list[tuple[float, int, int]], tt: dict
    ) -> int | None:
        """WMO weather code at the ground — a category, not a physical
        quantity, so nearest grid point and nearest hour instead of the
        bilinear/time-linear blending used for the continuous fields."""
        _, a, b = max(weights, key=lambda w: w[0])
        p = self.points.get(self.key(a, b))
        if not p or p.get("ww") is None:
            return None
        ww = p["ww"]
        ti = tt["ti"] + (1 if tt["tw"] >= 0.5 else 0)
        ti = min(ti, len(ww) - 1)
        v = ww[ti]
        return int(v) if _isfinite(v) else None

    def elevation_at(self, lat: float, lon: float) -> float | None:
        e = 0.0
        for wt, a, b in self.bilinear_weights(lat, lon):
            p = self.points.get(self.key(a, b))
            if not p:
                return None
            e += wt * p["elevation"]
        return e

    def diagnose_at(
        self, lat: float, lon: float, height_m: float, mode: str, t_ms: float
    ) -> dict:
        self.ensure_corners(lat, lon)
        tt = self.time_weights(t_ms)
        if not tt:
            return {"error": "Startzeit außerhalb des Datenzeitraums"}

        P = TH = Z = 0.0
        for wt, a, b in self.bilinear_weights(lat, lon):
            pt = self.points.get(self.key(a, b))
            if not pt:
                return {"error": "Datenlücke im Gitter"}
            h_target = height_m - pt["elevation"] if mode == "amsl" else height_m
            br = height_bracket(pt["hAgl"], h_target)
            if br.get("error"):
                return br
            Z += wt * (pt["elevation"] + max(h_target, pt["hAgl"][0]))
            if pt["p"] is not None:
                p0 = level_value_at_t(pt["p"][br["k0"]], tt)
                p1 = level_value_at_t(pt["p"][br["k1"]], tt)
                P += wt * math.exp(math.log(p0) + br["hw"] * (math.log(p1) - math.log(p0)))
                if pt["T"] is not None:
                    th0 = theta(level_value_at_t(pt["T"][br["k0"]], tt), p0)
                    th1 = theta(level_value_at_t(pt["T"][br["k1"]], tt), p1)
                    TH += wt * (th0 + br["hw"] * (th1 - th0))
        return {"p": P or None, "theta": TH or None, "zAmsl": Z}


def resolve_on_target(pt: dict, target: dict, tt: dict) -> dict:
    if target["type"] in ("height", "z3d"):
        h_target = (
            target["value"] - pt["elevation"]
            if target["type"] == "z3d" or target.get("mode") == "amsl"
            else target["value"]
        )
        if target["type"] == "z3d" and h_target < 0:
            return {"error": "Trajektorie erreicht den Boden"}
        try:
            from .interp_fast import resolve_height_fast

            fast = resolve_height_fast(pt, h_target, tt)
        except Exception:
            fast = None
        if fast is not None and fast.get("error"):
            return fast
        if fast is not None:
            k0, k1, hw = fast["k0"], fast["k1"], fast["hw"]
            out = dict(fast)
            if pt["w"] is not None:
                w0 = level_value_at_t(pt["w"][k0], tt)
                w1 = level_value_at_t(pt["w"][k1], tt)
                out["w"] = w0 + hw * (w1 - w0)

            def lin(arr):
                a = level_value_at_t(arr[k0], tt)
                b = level_value_at_t(arr[k1], tt)
                return a + hw * (b - a)

            if pt["p"] is not None:
                p0 = level_value_at_t(pt["p"][k0], tt)
                p1 = level_value_at_t(pt["p"][k1], tt)
                out["p"] = math.exp(math.log(p0) + hw * (math.log(p1) - math.log(p0)))
            if pt["T"] is not None:
                out["tK"] = lin(pt["T"])
            if pt["q"] is not None:
                out["q"] = lin(pt["q"])
            if pt["rh"] is not None:
                out["rh"] = lin(pt["rh"])
            if pt["clc"] is not None:
                out["clc"] = lin(pt["clc"])
            return out
        br = height_bracket(pt["hAgl"], h_target)
        if br.get("error"):
            return br
    elif target["type"] == "pressure":
        br = pressure_bracket(pt, target["value"], tt)
    elif target["type"] == "theta":
        br = theta_bracket(pt, target["value"], tt)
    else:
        return {"error": f"Unbekannte Zielfläche: {target['type']}"}
    if br.get("error"):
        return br

    k0, k1, hw = br["k0"], br["k1"], br["hw"]
    u0 = level_value_at_t(pt["u"][k0], tt)
    u1 = level_value_at_t(pt["u"][k1], tt)
    v0 = level_value_at_t(pt["v"][k0], tt)
    v1 = level_value_at_t(pt["v"][k1], tt)
    out: dict[str, Any] = {
        "u": u0 + hw * (u1 - u0),
        "v": v0 + hw * (v1 - v0),
        "hAgl": pt["hAgl"][k0] + hw * (pt["hAgl"][k1] - pt["hAgl"][k0]),
        "k0": k0,
        "k1": k1,
        "hw": hw,
    }
    if pt["w"] is not None:
        w0 = level_value_at_t(pt["w"][k0], tt)
        w1 = level_value_at_t(pt["w"][k1], tt)
        out["w"] = w0 + hw * (w1 - w0)

    def lin(arr):
        a = level_value_at_t(arr[k0], tt)
        b = level_value_at_t(arr[k1], tt)
        return a + hw * (b - a)

    if pt["p"] is not None:
        p0 = level_value_at_t(pt["p"][k0], tt)
        p1 = level_value_at_t(pt["p"][k1], tt)
        out["p"] = math.exp(math.log(p0) + hw * (math.log(p1) - math.log(p0)))
    if pt["T"] is not None:
        out["tK"] = lin(pt["T"])
    if pt["q"] is not None:
        out["q"] = lin(pt["q"])
    if pt["rh"] is not None:
        out["rh"] = lin(pt["rh"])
    if pt["clc"] is not None:
        out["clc"] = lin(pt["clc"])
    return out


def height_bracket(h_agl: list[float], h_target: float) -> dict:
    if not _isfinite(h_target):
        return {"error": "Ungültige Zielhöhe (Datenlücke)"}
    L = len(h_agl)
    k1 = 0
    while k1 < L and h_agl[k1] < h_target:
        k1 += 1
    if k1 >= L:
        return {"error": "Oberhalb des geladenen Höhenfensters"}
    k0 = max(0, k1 - 1)
    hw = 0 if k1 == k0 or h_target <= h_agl[k0] else (h_target - h_agl[k0]) / (h_agl[k1] - h_agl[k0])
    return {"k0": k0, "k1": k1, "hw": hw}


def pressure_bracket(pt: dict, p_target: float, tt: dict) -> dict:
    L = len(pt["hAgl"])
    p_bottom = level_value_at_t(pt["p"][0], tt)
    if p_target > p_bottom:
        return {"error": "Druckfläche schneidet das Gelände"}
    for k in range(1, L):
        pk = level_value_at_t(pt["p"][k], tt)
        if pk <= p_target:
            p_prev = level_value_at_t(pt["p"][k - 1], tt)
            hw = (math.log(p_target) - math.log(p_prev)) / (math.log(pk) - math.log(p_prev))
            return {"k0": k - 1, "k1": k, "hw": hw}
    return {"error": "Druckfläche oberhalb des geladenen Höhenfensters"}


def theta_bracket(pt: dict, th_target: float, tt: dict) -> dict:
    L = len(pt["hAgl"])
    th_prev = theta(level_value_at_t(pt["T"][0], tt), level_value_at_t(pt["p"][0], tt))
    if th_target < th_prev:
        return {
            "error": "Boden-θ über Ziel-θ: Isentrope im Gelände oder Grenzschicht durchmischt"
        }
    for k in range(1, L):
        th = theta(level_value_at_t(pt["T"][k], tt), level_value_at_t(pt["p"][k], tt))
        if (th_prev <= th_target <= th) or (th <= th_target <= th_prev):
            hw = 0 if th == th_prev else (th_target - th_prev) / (th - th_prev)
            return {"k0": k - 1, "k1": k, "hw": hw}
        th_prev = th
    return {"error": "Isentrope oberhalb des geladenen Höhenfensters"}


def theta(t_k: float, p_hpa: float) -> float:
    return t_k * (1000 / p_hpa) ** KAPPA


def dewpoint_c(q_kgkg: float, p_hpa: float, t_c: float, rh_pct: float) -> float | None:
    e_pa = None
    if _isfinite(q_kgkg) and q_kgkg > 0 and _isfinite(p_hpa) and p_hpa > 0:
        e_pa = (q_kgkg * p_hpa * 100) / (0.622 + 0.378 * q_kgkg)
    elif _isfinite(rh_pct) and rh_pct > 0 and _isfinite(t_c):
        es_pa = 611.2 * math.exp((17.62 * t_c) / (243.12 + t_c))
        e_pa = (rh_pct / 100) * es_pa
    if not e_pa or e_pa <= 0:
        return None
    ln = math.log(e_pa / 611.2)
    return (243.12 * ln) / (17.62 - ln)


def relative_humidity_pct(q_kgkg: float, p_hpa: float, t_c: float) -> float | None:
    """Relative humidity (%) over water via Magnus from specific humidity, p, T."""
    if not (
        _isfinite(q_kgkg)
        and q_kgkg >= 0
        and _isfinite(p_hpa)
        and p_hpa > 0
        and _isfinite(t_c)
    ):
        return None
    e_pa = (q_kgkg * p_hpa * 100) / (0.622 + 0.378 * q_kgkg)
    es_pa = 611.2 * math.exp((17.62 * t_c) / (243.12 + t_c))
    if not (e_pa > 0 and es_pa > 0):
        return None
    return min(100.0, max(0.0, (100.0 * e_pa) / es_pa))


def level_value_at_t(arr: list[float], tt: dict) -> float:
    ti, tw = tt["ti"], tt["tw"]
    return arr[ti] + tw * (arr[ti + 1] - arr[ti])


def to_array(src, T: int, factor: float, offset: float = 0) -> list[float]:
    out = []
    for t in range(T):
        v = None if src is None else src[t]
        out.append(float("nan") if v is None else v * factor + offset)
    return out


def unit_factor(unit: str | None) -> float:
    if unit == "km/h":
        return KMH_TO_MS
    if unit == "cm/s":
        return 0.01
    return 1


def first_finite(arr) -> float | None:
    if not arr:
        return None
    for x in arr:
        if x is not None and _isfinite(x):
            return float(x)
    return None


def round5(x: float) -> float:
    return round(x * 1e5) / 1e5


def _isfinite(x) -> bool:
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False
