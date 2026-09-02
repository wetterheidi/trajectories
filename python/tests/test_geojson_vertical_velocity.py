"""Unit tests for vertical_velocity_ms (Modell-w) at GeoJSON markers."""

from __future__ import annotations

from trajectories.geojson_export import build_geojson


def test_marker_vertical_velocity_present():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.0, "lon": 15.0, "z": 500.0, "tMs": 1.0e12},
                    {"lat": 47.1, "lon": 15.1, "z": 510.0, "tMs": 1.0e12 + 600_000},
                ],
                "markers": [
                    {"lat": 47.0, "lon": 15.0, "tMs": 1.0e12, "u": 3.0, "v": 4.0,
                     "z": 500.0, "met": None, "w": 1.234},
                ],
                "status": "ok",
                "reason": None,
            },
            "color": "#eda100",
            "label": "500 m z3d",
            "heightM": 500,
            "method": "z3d",
        }
    ]
    gj = build_geojson(
        runs=runs,
        model_key="icon_d2",
        mode="agl",
        t0_ms=1.0e12,
        duration=1.0,
        direction=1,
    )
    markers = [f["properties"] for f in gj["features"] if f["properties"]["kind"] == "marker"]
    assert markers[0]["vertical_velocity_ms"] == 1.23


def test_marker_vertical_velocity_absent_when_not_computed():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.0, "lon": 15.0, "z": 500.0, "tMs": 1.0e12},
                    {"lat": 47.1, "lon": 15.1, "z": 500.0, "tMs": 1.0e12 + 600_000},
                ],
                "markers": [
                    # height/pressure/theta runs never set "w" at all.
                    {"lat": 47.0, "lon": 15.0, "tMs": 1.0e12, "u": 3.0, "v": 4.0,
                     "z": 500.0, "met": None},
                ],
                "status": "ok",
                "reason": None,
            },
            "color": "#2a78d6",
            "label": "500 m AGL",
            "heightM": 500,
            "method": "height",
        }
    ]
    gj = build_geojson(
        runs=runs,
        model_key="icon_d2",
        mode="agl",
        t0_ms=1.0e12,
        duration=1.0,
        direction=1,
    )
    markers = [f["properties"] for f in gj["features"] if f["properties"]["kind"] == "marker"]
    assert "vertical_velocity_ms" not in markers[0]
