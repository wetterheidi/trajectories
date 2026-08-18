"""
Near-exact equivalence: web app GeoJSON download vs Python compute_trajectories.

Opt-in: RUN_WEB_PY_TESTS=1 pytest python/tests/test_web_python.py -m web_py

Requires network, Chromium (playwright install chromium), npm deps (vite), and
Open-Meteo API reachability.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from trajectories.compute import compute_trajectories

from compare_metrics import max_separation_m, parse_mine_geojson
from web_driver import WebRunSpec, fetch_web_geojson, headed_from_env, vite_server

MAX_SEP_M = 50.0

LAT, LON = 47.23, 15.82  # Stubenberg — ICON-D2 domain
DURATION_H = 2
HEIGHTS = [500.0, 1500.0, 3000.0]


def _web_py_enabled() -> bool:
    return os.environ.get("RUN_WEB_PY_TESTS", "").strip() in ("1", "true", "yes")


pytestmark = pytest.mark.skipif(
    not _web_py_enabled(),
    reason="Set RUN_WEB_PY_TESTS=1 to run web ↔ Python GeoJSON compare",
)


@pytest.fixture(scope="module")
def vite_base_url():
    with vite_server() as base:
        yield base


def _start_time_from_geojson(gj: dict) -> str:
    for f in gj.get("features") or []:
        if f.get("geometry", {}).get("type") != "LineString":
            continue
        props = f.get("properties") or {}
        t = props.get("start_time")
        if t:
            return str(t)
    raise AssertionError("no start_time on web GeoJSON LineString features")


@pytest.mark.web_py
@pytest.mark.parametrize("model", ["icon_eu", "icon_d2"])
def test_web_vs_python_near_exact(model: str, vite_base_url: str, tmp_path: Path):
    artifacts = Path(__file__).resolve().parent / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    dl = tmp_path / "dl"

    spec = WebRunSpec(
        lat=LAT,
        lon=LON,
        model=model,
        duration_h=DURATION_H,
        heights=HEIGHTS,
        methods=["height"],
        height_ref="agl",
        direction="forward",
    )
    try:
        web_gj = fetch_web_geojson(
            spec,
            dl,
            base_url=vite_base_url,
            headless=not headed_from_env(),
        )
    except Exception as exc:
        pytest.fail(f"Web driver failed for {model}: {exc}")

    # Persist for manual inspection
    (artifacts / f"web_{model}.geojson").write_text(
        (dl / f"web_{model}.geojson").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    start = _start_time_from_geojson(web_gj)
    py_gj = compute_trajectories(
        lat=LAT,
        lon=LON,
        time=start,
        model=model,
        duration_h=DURATION_H,
        heights=HEIGHTS,
        methods=["height"],
        height_ref="agl",
        direction="forward",
        marker_interval_min=60,
    )
    (artifacts / f"py_{model}.geojson").write_text(
        json.dumps(py_gj), encoding="utf-8",
    )

    web_tracks = parse_mine_geojson(web_gj)
    py_tracks = parse_mine_geojson(py_gj)
    assert len(web_tracks) >= 1, "no web trajectories"
    assert len(py_tracks) >= 1, "no python trajectories"

    report = max_separation_m(web_tracks, py_tracks, minutes=list(range(0, 130, 10)))
    assert report["pairs"] == len(HEIGHTS), (
        f"expected {len(HEIGHTS)} pairs, got {report['pairs']}: {report['per_pair']}"
    )
    for row in report["per_pair"]:
        assert row["status_match"], (
            f"status mismatch {row['status_a']!r} vs {row['status_b']!r} "
            f"for {row['a']}"
        )
        assert row["max_m"] is not None
        assert row["max_m"] <= MAX_SEP_M, (
            f"{model} start={start} pair={row['a']}: max_m={row['max_m']:.1f} > {MAX_SEP_M}"
        )

    msg = (
        f"{model} start={start} pairs={report['pairs']} "
        f"max_m={report['max_m']:.1f} detail={report['per_pair']}"
    )
    print(msg)
    assert report["max_m"] is not None
    assert report["max_m"] <= MAX_SEP_M, msg
