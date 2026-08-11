#!/usr/bin/env python3
"""
Call GET /v1/wind and print flat JSON.

Defaults to https://trajectory.mah.priv.at (override with TRAJECTORIES_API_URL).

Setup (from repo root):
  source python/.venv/bin/activate
  pip install -e "python/[api]"
  python python/examples/api_point_wind.py

Local uvicorn instead:
  uvicorn trajectories.api:app --host 127.0.0.1 --port 8010
  TRAJECTORIES_API_URL=http://127.0.0.1:8010 python python/examples/api_point_wind.py

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
OUT = Path(__file__).resolve().parent / "out_api_point_wind.json"

PARAMS = {
    "latitude": 47.23,
    "longitude": 15.82,
    "models": "icon_eu,icon_d2",
    "time": "2026-08-02T11:00:00Z",
    "timeformat": "iso8601",
    "height_agl": 550,
    "backend": "http",
    "format": "json",
}


def main() -> int:
    url = f"{BASE}/v1/wind?{urlencode(PARAMS)}"
    print(f"# GET {url}", file=sys.stderr)
    try:
        with httpx.Client(timeout=120.0, trust_env=False) as client:
            resp = client.get(f"{BASE}/v1/wind", params=PARAMS)
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
    models = data.get("models") or []
    ok = sum(1 for m in models if not m.get("error"))
    print(f"# wrote {OUT}", file=sys.stderr)
    print(f"# {ok}/{len(models)} model(s) ok", file=sys.stderr)
    print(json.dumps(data, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
