#!/usr/bin/env python3
"""
Standalone example: Petterssen trajectories via the `trajectories` package.

Setup (from repo root):
  source python/.venv/bin/activate   # or: pip install -e python/
  python python/examples/basic_trajectory.py

What this run uses
  - Location / time / model / AGL heights (up to 3 km)
  - Method: constant height (Petterssen scheme in the integrator)
  - Wind: bilinear in space, linear in height & time (Open-Meteo ICON field)
  - Markers every 10 minutes with met extras (T, Td, RH, p)
  - Output: GeoJSON FeatureCollection (stdout + optional file)
"""

from __future__ import annotations

import json
from pathlib import Path

from trajectories import compute_trajectories

# --- inputs -----------------------------------------------------------------
LAT = 47.23
LON = 15.82
TIME = "2026-08-02T11:00:00Z"  # UTC ISO-8601
MODEL = "icon_d2"  # or "icon_eu"
DURATION_H = 2
HEIGHTS_M_AGL = [500.0, 1500.0, 3000.0]  # up to 3 km AGL
MARKER_INTERVAL_MIN = 10
OUT = Path(__file__).resolve().parent / "out_example.geojson"


def main() -> None:
    gj = compute_trajectories(
        lat=LAT,
        lon=LON,
        time=TIME,
        model=MODEL,
        duration_h=DURATION_H,
        heights=HEIGHTS_M_AGL,
        methods=["height"],  # constant height; Petterssen integration
        height_ref="agl",
        direction="forward",
        marker_interval_min=MARKER_INTERVAL_MIN,
        met_extras=True,  # T, Td, RH, pressure on markers
    )

    text = json.dumps(gj, indent=2)
    OUT.write_text(text, encoding="utf-8")
    print(text)
    print(f"\n# wrote {OUT}", file=__import__("sys").stderr)

    # Quick summary
    tracks = [
        f
        for f in gj["features"]
        if f.get("geometry", {}).get("type") == "LineString"
    ]
    print(
        f"# {len(tracks)} track(s), model={MODEL}, "
        f"heights={HEIGHTS_M_AGL}, markers every {MARKER_INTERVAL_MIN} min",
        file=__import__("sys").stderr,
    )


if __name__ == "__main__":
    main()
