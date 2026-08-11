"""Unit tests for along-track terrain_m in GeoJSON export."""

from __future__ import annotations

from trajectories.geojson_export import build_geojson


def test_terrain_m_parallel_to_coordinates():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.23, "lon": 15.82, "z": 900.0, "tMs": 1.0e12},
                    {"lat": 47.24, "lon": 15.83, "z": 910.0, "tMs": 1.0e12 + 600_000},
                ],
                "markers": [],
                "status": "ok",
                "reason": None,
            },
            "color": "#2a78d6",
            "label": "500 m AGL",
            "heightM": 500,
            "method": "height",
            "terrain": [400.0, 412.5],
        }
    ]
    gj = build_geojson(
        runs=runs,
        model_key="icon_d2",
        mode="agl",
        t0_ms=1.0e12,
        duration=2.0,
        direction=1,
    )
    line = next(
        f for f in gj["features"]
        if f["geometry"]["type"] == "LineString"
    )
    coords = line["geometry"]["coordinates"]
    terrain = line["properties"]["terrain_m"]
    assert len(terrain) == len(coords) == 2
    assert terrain == [400.0, 412.5]


def test_terrain_m_missing_padded_with_null():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.0, "lon": 15.0, "z": 100.0, "tMs": 1.0e12},
                    {"lat": 47.1, "lon": 15.1, "z": 110.0, "tMs": 1.0e12 + 60_000},
                ],
                "markers": [],
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
    line = gj["features"][0]
    assert line["properties"]["terrain_m"] == [None, None]
