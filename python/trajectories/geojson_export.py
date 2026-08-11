"""GeoJSON FeatureCollection builder — port of buildGeoJSON in src/app.js."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any


def build_geojson(
    *,
    runs: list[dict],
    model_key: str,
    mode: str,
    t0_ms: float,
    duration: float,
    direction: int,
) -> dict[str, Any]:
    def rd(x: float) -> float:
        return round(x * 1e5) / 1e5

    def round1(x) -> float | None:
        return round(x * 10) / 10 if x is not None and math.isfinite(x) else None

    def iso(ms: float) -> str:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3] + "Z"

    def coord(p: dict) -> list:
        z = p.get("z")
        if z is not None and math.isfinite(z):
            return [rd(p["lon"]), rd(p["lat"]), round(z)]
        return [rd(p["lon"]), rd(p["lat"])]

    features: list[dict] = []
    for run in runs:
        r = run["r"]
        color = run["color"]
        label = run["label"]
        height_m = run["heightM"]
        method = run["method"]
        n_pts = len(r["points"])
        terrain = run.get("terrain")
        if terrain is None or len(terrain) != n_pts:
            terrain_m = [None] * n_pts
        else:
            terrain_m = [round1(e) for e in terrain]
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [coord(p) for p in r["points"]],
            },
            "properties": {
                "kind": "trajectory",
                "label": label,
                "start_height_m": height_m,
                "height_reference": mode,
                "vertical_motion": method,
                "model": model_key,
                "direction": "forward" if direction > 0 else "backward",
                "start_time": iso(t0_ms),
                "end_time": iso(r["points"][-1]["tMs"]),
                "duration_requested_h": duration,
                "status": r["status"],
                "stop_reason": r["reason"],
                "color": color,
                "stroke": color,
                "stroke-width": 2,
                "times": [iso(p["tMs"]) for p in r["points"]],
                "terrain_m": terrain_m,
            },
        })
        for m in r["markers"]:
            spd = math.hypot(m["u"], m["v"]) * 3.6
            direction_deg = (math.atan2(-m["u"], -m["v"]) * 180 / math.pi + 360) % 360
            props: dict[str, Any] = {
                "kind": "marker",
                "label": label,
                "time": iso(m["tMs"]),
                "wind_speed_kmh": round(spd),
                "wind_direction_deg": round(direction_deg),
                "color": color,
                "marker-color": color,
            }
            met = m.get("met")
            if met:
                props.update({
                    "temperature_c": round1(met.get("t")),
                    "dewpoint_c": round1(met.get("td")),
                    "relative_humidity_pct": (
                        round(met["rh"]) if met.get("rh") is not None and math.isfinite(met["rh"]) else None
                    ),
                    "pressure_hpa": round1(met.get("p")),
                })
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coord(m)},
                "properties": props,
            })
    return {"type": "FeatureCollection", "features": features}
