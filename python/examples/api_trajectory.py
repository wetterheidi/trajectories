#!/usr/bin/env python3
"""
Call the Trajectories HTTP API and write GeoJSON.

Defaults to https://trajectory.mah.priv.at (override with TRAJECTORIES_API_URL).

Setup (from repo root):
  source python/.venv/bin/activate
  pip install -e "python/[api]"
  python python/examples/api_trajectory.py

Local uvicorn instead:
  uvicorn trajectories.api:app --host 127.0.0.1 --port 8010
  TRAJECTORIES_API_URL=http://127.0.0.1:8010 python python/examples/api_trajectory.py

Swagger: https://trajectory.mah.priv.at/docs
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode

import httpx

BASE = os.environ.get("TRAJECTORIES_API_URL", "https://trajectory.mah.priv.at").rstrip("/")
OUT = Path(__file__).resolve().parent / "out_api_example.geojson"

PARAMS = {
    "latitude": 47.23,
    "longitude": 15.82,
    "models": "icon_d2",
    "time": "2026-08-02T11:00:00Z",
    "timeformat": "iso8601",
    "forecast_hours": 2,
    "height_agl": "500,1500,3000",
    "vertical_motion": "height",
    "direction": "forward",
    "marker_interval": 60,
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
