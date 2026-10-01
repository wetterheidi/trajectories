"""Abbruch absoluter Zielhöhen (konstant NN, 3D) unter dem Modellgelände
(no network — points are seeded directly, Hang steigt nach Osten an)."""

from __future__ import annotations

import threading

from trajectories.integrator import compute_trajectory
from trajectories.windfield import WindField

G = 0.02
LAT, LON = 50.0, 10.0


def _make_point(elevation, w=None):
    T = 3
    h_agl = [10.0, 150.0, 300.0, 600.0, 1200.0]
    return {
        "elevation": elevation,
        "hAgl": h_agl,
        "u": [[5.0] * T for _ in h_agl],  # Westwind 5 m/s -> nach Osten
        "v": [[0.0] * T for _ in h_agl],
        "p": None,
        "T": None,
        "w": None if w is None else [[w] * T for _ in h_agl],
        "q": None,
        "rh": None,
        "clc": None,
        "ww": None,
    }


def _slope_windfield(w=None):
    """Westliche Ecken 400 m NN, östliche 1200 m NN."""
    wf = WindField.__new__(WindField)
    wf.model = {"grid": G, "bbox": {"latMin": 40, "latMax": 60, "lonMin": 0, "lonMax": 20}}
    wf.model_key = "icon_d2"
    wf.backend_kind = "http"
    wf.w_var_prefix = None if w is None else "wind_w"
    wf.needs = {"p": False, "t": False, "w": w is not None, "met": False}
    wf.levels = [5, 4, 3, 2, 1]
    wf.times = [0.0, 3600.0, 7200.0]
    wf.units = {}
    wf._w_required = w is not None
    wf._points_lock = threading.Lock()
    wf._pending = {}
    wf.points = {}
    i_lat, i_lon = round(LAT / G), round(LON / G)
    for a in (i_lat, i_lat + 1):
        wf.points[f"{a},{i_lon}"] = _make_point(400.0, w)
        wf.points[f"{a},{i_lon + 1}"] = _make_point(1200.0, w)
    return wf


AMSL_700 = {"type": "height", "mode": "amsl", "value": 700.0}


def test_amsl_above_interpolated_terrain_runs_even_if_a_corner_is_higher():
    wf = _slope_windfield()
    # fx = 0.25 -> Orographie 600 m; östliche Ecken (1200 m) liegen über 700 m.
    out = wf.wind_at(LAT, LON + 0.25 * G, AMSL_700, 0)
    assert "error" not in out
    assert out["u"] == 5.0
    assert out["zAmsl"] == 700.0  # nicht durch die geklemmte Ecke angehoben


def test_amsl_below_interpolated_terrain_stops():
    wf = _slope_windfield()
    # fx = 0.5 -> Orographie 800 m > 700 m
    out = wf.wind_at(LAT, LON + 0.5 * G, AMSL_700, 0)
    assert out == {"error": "Gelände über Zielhöhe (Höhe über NN)"}


def test_agl_unaffected():
    wf = _slope_windfield()
    out = wf.wind_at(LAT, LON + 0.9 * G, {"type": "height", "mode": "agl", "value": 100.0}, 0)
    assert "error" not in out


def test_z3d_uses_same_criterion():
    wf = _slope_windfield(w=0.0)
    ok = wf.wind_at(LAT, LON + 0.25 * G, {"type": "z3d", "value": 700.0}, 0)
    assert "error" not in ok  # früher: Abbruch, weil eine Ecke über 700 m lag
    stop = wf.wind_at(LAT, LON + 0.5 * G, {"type": "z3d", "value": 700.0}, 0)
    assert stop == {"error": "Trajektorie erreicht den Boden"}


def test_amsl_trajectory_stops_at_terrain_with_reason():
    wf = _slope_windfield()
    r = compute_trajectory(
        wind_at=wf.wind_at, lat0=LAT, lon0=LON + 0.05 * G, target=AMSL_700,
        t0_ms=0, duration_hours=1, marker_interval_sec=600,
        grid_meters=200,  # Δt = 60 s -> 300 m je Schritt, bleibt in der Testzelle
    )
    assert r["status"] == "stopped"
    assert r["reason"] == "Gelände über Zielhöhe (Höhe über NN)"
    # Gelände erreicht 700 m bei fx = 0.375; kein Punkt darf dahinter liegen.
    assert all(p["lon"] < LON + 0.375 * G for p in r["points"])
