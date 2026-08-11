#!/usr/bin/env python3
"""
Call GET /v1/trajectory with a kinematic AGL flight profile (Gneixendorf sketch).

Defaults to https://trajectory.mah.priv.at (override with TRAJECTORIES_API_URL).

  source python/.venv/bin/activate
  python python/examples/api_flight_profile.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode

import httpx

BASE = os.environ.get("TRAJECTORIES_API_URL", "https://trajectory.mah.priv.at").rstrip("/")
OUT = Path(__file__).resolve().parent / "out_api_flight_profile.geojson"

# Sketch: low level → climb → cruise → descend (edit freely).
PARAMS = {
    "latitude": 48.4375,
    "longitude": 15.6181,
    "models": "icon_eu",
    "time": "2026-08-02T11:00:00Z",
    "timeformat": "iso8601",
    "forecast_hours": 2,
    "profile_time": "0,1200,3600,5400,7200",
    "profile_height": "150,150,1800,1800,400",
    "vertical_motion": "height",
    "direction": "forward",
    "marker_interval": 60,
    "marker_interval_climbing": 10,
    "clearance_m": 0,
    "met_extras": "false",
    "backend": "http",
    "format": "geojson",
}


def main() -> int:
    url = f"{BASE}/v1/trajectory?{urlencode(PARAMS)}"
    print(f"# GET {url}", file=sys.stderr)
    try:
        with httpx.Client(timeout=180.0, trust_env=False) as client:
            resp = client.get(f"{BASE}/v1/trajectory", params=PARAMS)
    except httpx.ConnectError:
        print(
            f"error: cannot connect to {BASE} — start with:\n"
            "  uvicorn trajectories.api:app --host 127.0.0.1 --port 8010",
            file=sys.stderr,
        )
        return 1

    if not resp.is_success:
        print(f"error: HTTP {resp.status_code}: {resp.text[:500]}", file=sys.stderr)
        return 1

    data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        print(f"error: {data.get('reason')}", file=sys.stderr)
        return 1

    OUT.write_text(json.dumps(data, indent=2), encoding="utf-8")
    feats = data.get("features") or []
    lines = [f for f in feats if f.get("geometry", {}).get("type") == "LineString"]
    print(f"# wrote {OUT}", file=sys.stderr)
    print(f"# {len(lines)} track(s), {len(feats)} feature(s)", file=sys.stderr)
    for line in lines:
        props = line.get("properties") or {}
        print(
            f"# status={props.get('status')} stop_reason={props.get('stop_reason')}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
