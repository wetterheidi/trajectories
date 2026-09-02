"""Unit tests for cloud_cover/weather_code sampling in WindField.wind_at
(no network — points are seeded directly)."""

from __future__ import annotations

import threading

from trajectories.windfield import WindField


def _make_point(elevation, h_agl, clc_vals, ww_vals):
    T = 3
    return {
        "elevation": elevation,
        "hAgl": h_agl,
        "u": [[5.0] * T for _ in h_agl],
        "v": [[2.0] * T for _ in h_agl],
        "p": [[900.0 - 10 * i] * T for i in range(len(h_agl))],
        "T": [[280.0 - i] * T for i in range(len(h_agl))],
        "w": None,
        "q": [[0.005] * T for _ in h_agl],
        "rh": None,
        "clc": [[c] * T for c in clc_vals],
        "ww": ww_vals,
    }


def _seeded_windfield():
    wf = WindField.__new__(WindField)
    wf.model = {
        "grid": 0.02,
        "bbox": {"latMin": 40, "latMax": 60, "lonMin": 0, "lonMax": 20},
    }
    wf.model_key = "icon_d2"
    wf.backend_kind = "http"
    wf.w_var_prefix = None
    wf.needs = {"p": True, "t": True, "w": False, "met": True}
    wf.levels = [10, 9, 8]
    wf.times = [0.0, 3600.0, 7200.0]
    wf.units = {}
    wf._w_required = False
    wf._points_lock = threading.Lock()
    wf._pending = {}
    wf.points = {}
    i_lat, i_lon = round(50.0 / 0.02), round(10.0 / 0.02)
    for a in (i_lat, i_lat + 1):
        for b in (i_lon, i_lon + 1):
            wf.points[f"{a},{b}"] = _make_point(
                400.0, [50.0, 150.0, 300.0], [80.0, 40.0, 10.0], [61.0, 61.0, 3.0]
            )
    return wf


def test_cloud_cover_interpolated_between_levels():
    wf = _seeded_windfield()
    out = wf.wind_at(50.0, 10.0, {"type": "height", "mode": "agl", "value": 100.0}, 0)
    # Halfway between the 50 m (80%) and 150 m (40%) levels.
    assert out["met"]["clc"] == 60.0


def test_cloud_cover_clamped_at_top_level():
    wf = _seeded_windfield()
    out = wf.wind_at(50.0, 10.0, {"type": "height", "mode": "agl", "value": 300.0}, 0)
    assert out["met"]["clc"] == 10.0


def test_weather_code_is_nearest_hour_not_interpolated():
    wf = _seeded_windfield()
    target = {"type": "height", "mode": "agl", "value": 100.0}
    at_start = wf.wind_at(50.0, 10.0, target, 0)
    at_end = wf.wind_at(50.0, 10.0, target, 7_200_000)
    assert at_start["met"]["ww"] == 61
    assert at_end["met"]["ww"] == 3
