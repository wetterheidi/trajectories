"""
Local OM-files backend smoke + loose OM↔HTTP compare.

Opt-in: RUN_OM_TESTS=1 pytest python/tests/test_om_backend.py -m om

Requires omfiles, readable /open-meteo (or TRAJECTORIES_OM_ROOT), and for the
compare test a reachable Open-Meteo HTTP API.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import pytest

from trajectories import config
from trajectories.compute import compute_trajectories

from compare_metrics import max_separation_m, median_separation_km, parse_mine_geojson

LAT, LON = 47.23, 15.82  # Stubenberg
TIME = "2026-08-02T06:00:00Z"
DURATION_H = 2
HEIGHTS = [500.0, 1500.0, 3000.0]

# Same-physics bar (not bit-identical): allow a few km of separation.
# Widened once for float32 slabs + optional Numba interp (accel plan).
MAX_MEDIAN_KM = 6.0
MAX_MAX_KM = 18.0


def _om_enabled() -> bool:
    return os.environ.get("RUN_OM_TESTS", "").strip() in ("1", "true", "yes")


pytestmark = [
    pytest.mark.om,
    pytest.mark.skipif(not _om_enabled(), reason="Set RUN_OM_TESTS=1 to run OM backend tests"),
]


def _om_ready(model: str) -> bool:
    return config.omfiles_available() and config.dataset_path(model) is not None


@pytest.fixture(autouse=True)
def _restore_config():
    prev_root = config.OM_ROOT
    prev_backend = config.BACKEND
    prev_api = config.API_BASE
    yield
    config.OM_ROOT = prev_root
    config.BACKEND = prev_backend
    config.API_BASE = prev_api


@pytest.mark.parametrize("model", ["icon_d2", "icon_eu"])
def test_om_smoke_height(model: str):
    if not _om_ready(model):
        pytest.skip(f"OM dataset/omfiles not available for {model}")

    gj = compute_trajectories(
        lat=LAT,
        lon=LON,
        time=TIME,
        model=model,
        duration_h=DURATION_H,
        heights=HEIGHTS,
        methods=["height"],
        backend="om",
        marker_interval_min=60,
    )
    lines = [
        f
        for f in gj["features"]
        if f.get("geometry", {}).get("type") == "LineString"
    ]
    assert len(lines) == len(HEIGHTS)
    for f in lines:
        coords = f["geometry"]["coordinates"]
        assert len(coords) >= 2
        for lon, lat, *_rest in coords:
            assert math.isfinite(lat) and math.isfinite(lon)


@pytest.mark.parametrize("model", ["icon_d2", "icon_eu"])
def test_om_vs_http_same_physics(model: str):
    if not _om_ready(model):
        pytest.skip(f"OM dataset/omfiles not available for {model}")

    kwargs = dict(
        lat=LAT,
        lon=LON,
        time=TIME,
        model=model,
        duration_h=DURATION_H,
        heights=HEIGHTS,
        methods=["height"],
        marker_interval_min=60,
    )
    gj_om = compute_trajectories(**kwargs, backend="om")
    gj_http = compute_trajectories(**kwargs, backend="http")

    om_tracks = parse_mine_geojson(gj_om)
    http_tracks = parse_mine_geojson(gj_http)
    assert len(om_tracks) == len(HEIGHTS)
    assert len(http_tracks) == len(HEIGHTS)

    report_m = max_separation_m(om_tracks, http_tracks, minutes=list(range(0, 130, 10)))
    report_km = median_separation_km(om_tracks, http_tracks, minutes=list(range(0, 130, 10)))
    assert report_m["pairs"] == len(HEIGHTS)
    assert report_km["median_km"] is not None
    assert report_km["median_km"] < MAX_MEDIAN_KM, report_km
    assert report_km["max_km"] < MAX_MAX_KM, report_km

    art = Path(__file__).resolve().parent / "artifacts"
    art.mkdir(exist_ok=True)
    import json

    (art / f"om_{model}.geojson").write_text(json.dumps(gj_om), encoding="utf-8")
    (art / f"http_{model}.geojson").write_text(json.dumps(gj_http), encoding="utf-8")
