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


def test_marker_height_amsl_m():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.0, "lon": 15.0, "z": 100.0, "tMs": 1.0e12},
                    {"lat": 47.1, "lon": 15.1, "z": 300.0, "tMs": 1.0e12 + 600_000},
                ],
                "markers": [
                    {"lat": 47.0, "lon": 15.0, "tMs": 1.0e12, "u": 3.0, "v": 4.0, "z": 100.0, "met": None},
                    {"lat": 47.1, "lon": 15.1, "tMs": 1.0e12 + 600_000, "u": 3.0, "v": 4.0, "z": None, "met": None},
                ],
                "status": "ok",
                "reason": None,
            },
            "color": "#2a78d6",
            "label": "500 m AGL",
            "heightM": 500,
            "method": "pressure",
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
    markers = [f for f in gj["features"] if f["properties"]["kind"] == "marker"]
    assert [f["properties"]["height_amsl_m"] for f in markers] == [100, None]


def test_marker_height_agl_m():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.0, "lon": 15.0, "z": 500.0, "tMs": 1.0e12},
                    {"lat": 47.1, "lon": 15.1, "z": 500.0, "tMs": 1.0e12 + 600_000},
                    {"lat": 47.2, "lon": 15.2, "z": 500.0, "tMs": 1.0e12 + 1_200_000},
                ],
                "markers": [
                    # normal case: AMSL and terrain both known.
                    {"lat": 47.0, "lon": 15.0, "tMs": 1.0e12, "u": 3.0, "v": 4.0,
                     "z": 500.0, "met": None, "terrain": 400.0},
                    # terrain unknown (no elevation lookup available).
                    {"lat": 47.1, "lon": 15.1, "tMs": 1.0e12 + 600_000, "u": 3.0, "v": 4.0,
                     "z": 500.0, "met": None, "terrain": None},
                    # AMSL unknown (wind lookup failed for z).
                    {"lat": 47.2, "lon": 15.2, "tMs": 1.0e12 + 1_200_000, "u": 3.0, "v": 4.0,
                     "z": None, "met": None, "terrain": 400.0},
                ],
                "status": "ok",
                "reason": None,
            },
            "color": "#2a78d6",
            "label": "500 m AGL",
            "heightM": 500,
            "method": "pressure",
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
    markers = [f for f in gj["features"] if f["properties"]["kind"] == "marker"]
    assert [f["properties"]["height_agl_m"] for f in markers] == [100, None, None]


def test_marker_cloud_cover_and_weather_code():
    runs = [
        {
            "r": {
                "points": [
                    {"lat": 47.0, "lon": 15.0, "z": 500.0, "tMs": 1.0e12},
                    {"lat": 47.1, "lon": 15.1, "z": 500.0, "tMs": 1.0e12 + 600_000},
                ],
                "markers": [
                    {"lat": 47.0, "lon": 15.0, "tMs": 1.0e12, "u": 3.0, "v": 4.0,
                     "z": 500.0, "terrain": 400.0,
                     "met": {"t": 10.0, "td": 5.0, "rh": 70.0, "p": 950.0, "clc": 42.3, "ww": 61}},
                    # met_extras off (or backend without surface data): no met dict at all.
                    {"lat": 47.1, "lon": 15.1, "tMs": 1.0e12 + 600_000, "u": 3.0, "v": 4.0,
                     "z": 500.0, "terrain": 400.0, "met": None},
                ],
                "status": "ok",
                "reason": None,
            },
            "color": "#2a78d6",
            "label": "500 m AGL",
            "heightM": 500,
            "method": "pressure",
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
    assert markers[0]["cloud_cover_pct"] == 42
    assert markers[0]["weather_code"] == 61
    assert "cloud_cover_pct" not in markers[1]
    assert "weather_code" not in markers[1]
