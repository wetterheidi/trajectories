"""
Rough visual equivalence: our GeoJSON vs Windy ICON-EU / ICON-D2 trajectories.

Opt-in: RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy

Requires network, Chromium (playwright install chromium), and a working Windy UI.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from trajectories import config
from trajectories.compute import compute_trajectories

from compare_metrics import median_separation_km, parse_mine_geojson, parse_windy_gpx
from windy_driver import WindyRunSpec, fetch_windy_gpx, model_heights_for_pressure_compare

# Loose thresholds — different integrators / vertical surfaces; "rough" only.
MAX_MEDIAN_KM = 80.0
MAX_MAX_KM = 200.0

LAT, LON = 47.23, 15.82  # Stubenberg — ICON-D2 domain
DURATION_H = 2


def _windy_enabled() -> bool:
    return os.environ.get("RUN_WINDY_TESTS", "").strip() in ("1", "true", "yes")


pytestmark = pytest.mark.skipif(
    not _windy_enabled(),
    reason="Set RUN_WINDY_TESTS=1 to run Playwright ↔ Windy visual tests",
)


def _pick_start_time(model: str) -> str:
    """Use model run + 6 h (matches live-smoke), clamped to available data."""
    dataset = config.MODELS[model]["dataset"]
    url = f"{config.API_BASE}/data/{dataset}/static/meta.json"
    meta = httpx.get(url, timeout=60).json()
    t0 = datetime.fromtimestamp(
        meta["last_run_initialisation_time"] + 6 * 3600, tz=timezone.utc
    )
    # Align to whole hour
    t0 = t0.replace(minute=0, second=0, microsecond=0)
    return t0.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.mark.windy
@pytest.mark.parametrize("model", ["icon_eu", "icon_d2"])
def test_rough_equivalence_vs_windy(model: str, tmp_path: Path):
    start = _pick_start_time(model)
    heights = model_heights_for_pressure_compare()

    # Our trajectories (constant height AGL ≈ Windy pressure levels roughly)
    gj = compute_trajectories(
        lat=LAT,
        lon=LON,
        time=start,
        model=model,
        duration_h=DURATION_H,
        heights=heights,
        methods=["height"],
        height_ref="agl",
        direction="forward",
        marker_interval_min=60,
    )
    mine = parse_mine_geojson(gj)
    assert len(mine) >= 1, "no trajectories from compute_trajectories"

    # Align Windy clock with our start time
    t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
    start_ms = t0.timestamp() * 1000

    # Windy GPX via Playwright (right-click → Wind trajectories → API capture)
    spec = WindyRunSpec(
        lat=LAT, lon=LON, model=model, duration_h=DURATION_H, start_ms=start_ms,
    )
    headless = os.environ.get("WINDY_HEADED", "").strip() not in ("1", "true", "yes")
    try:
        gpx_path = fetch_windy_gpx(spec, tmp_path / "dl", headless=headless)
    except Exception as exc:
        pytest.fail(f"Windy driver failed for {model}: {exc}")

    windy = parse_windy_gpx(gpx_path.read_text(encoding="utf-8"))
    assert len(windy) >= 1, f"no tracks in Windy GPX {gpx_path}"

    report = median_separation_km(mine, windy, minutes=list(range(0, 130, 10)))
    assert report["pairs"] >= 1, "could not pair mine↔windy tracks by height"
    assert report["median_km"] is not None

    msg = (
        f"{model} start={start} pairs={report['pairs']} "
        f"median={report['median_km']:.1f} km max={report['max_km']:.1f} km "
        f"detail={report['per_pair']}"
    )
    print(msg)

    assert report["median_km"] < MAX_MEDIAN_KM, msg
    assert report["max_km"] < MAX_MAX_KM, msg
