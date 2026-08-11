"""FastAPI /v1/trajectory unit tests (mocked compute; no network)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

from trajectories.api import app

client = TestClient(app)

TINY_GJ = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[15.82, 47.23, 500], [15.83, 47.24, 500]],
            },
            "properties": {"start_height_m": 500, "vertical_motion": "height"},
        }
    ],
}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "icon_d2" in body["models"]


def test_trajectory_validation_bad_model():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_global",
            "time": "2026-08-02T11:00:00Z",
        },
    )
    assert r.status_code == 400
    body = r.json()
    assert body.get("error") is True
    assert "reason" in body


def test_trajectory_both_height_refs():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": "500",
            "height_amsl": "1000",
        },
    )
    assert r.status_code == 400
    assert r.json()["error"] is True


def test_trajectory_bad_vertical_motion():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "vertical_motion": "banana",
        },
    )
    assert r.status_code == 400
    assert "vertical_motion" in r.json()["reason"]


@patch("trajectories.api.compute_trajectories", return_value=TINY_GJ)
def test_trajectory_happy_path(mock_compute):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "forecast_hours": 2,
            "height_agl": "500,1500",
            "vertical_motion": "height",
            "backend": "http",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 1
    mock_compute.assert_called_once()
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["lat"] == 47.23
    assert kwargs["lon"] == 15.82
    assert kwargs["model"] == "icon_d2"
    assert kwargs["duration_h"] == 2
    assert kwargs["heights"] == [500.0, 1500.0]
    assert kwargs["methods"] == ["height"]
    assert kwargs["height_ref"] == "agl"
    assert kwargs["backend"] == "http"


@patch("trajectories.api.compute_trajectories", return_value=TINY_GJ)
def test_trajectory_unixtime(mock_compute):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_eu",
            "time": "1754132400",
            "timeformat": "unixtime",
            "height_amsl": "1500",
        },
    )
    assert r.status_code == 200
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["time"] == 1754132400.0
    assert kwargs["height_ref"] == "amsl"
    assert kwargs["heights"] == [1500.0]


@patch("trajectories.api.compute_trajectories", side_effect=ValueError("Point outside domain"))
def test_trajectory_compute_value_error(_mock):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
        },
    )
    assert r.status_code == 400
    assert "outside" in r.json()["reason"]


TINY_WIND = {
    "latitude": 47.23,
    "longitude": 15.82,
    "time": "2026-08-02T11:00:00.000Z",
    "height_reference": "agl",
    "height_m": 550.0,
    "models": [
        {
            "model": "icon_eu",
            "wind_u_ms": 1.2,
            "wind_v_ms": -1.5,
            "wind_w_ms": 0.02,
            "wind_speed_ms": 1.921,
            "wind_speed_kmh": 6.9,
            "wind_direction_deg": 321,
            "z_amsl_m": 858,
            "terrain_m": 308,
        }
    ],
}


def test_wind_both_height_refs():
    r = client.get(
        "/v1/wind",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": 500,
            "height_amsl": 1000,
        },
    )
    assert r.status_code == 400
    assert r.json()["error"] is True


def test_wind_missing_height():
    r = client.get(
        "/v1/wind",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
        },
    )
    assert r.status_code == 400
    assert "height" in r.json()["reason"]


def test_wind_bad_model():
    r = client.get(
        "/v1/wind",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_global",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": 550,
        },
    )
    assert r.status_code == 400
    assert "model" in r.json()["reason"].lower()


@patch("trajectories.api.compute_point_wind", return_value=TINY_WIND)
def test_wind_happy_path(mock_compute):
    r = client.get(
        "/v1/wind",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_eu,icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": 550,
            "backend": "http",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["height_reference"] == "agl"
    assert body["height_m"] == 550.0
    assert body["models"][0]["wind_direction_deg"] == 321
    assert "wind_w_ms" in body["models"][0]
    mock_compute.assert_called_once()
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["models"] == ["icon_eu", "icon_d2"]
    assert kwargs["height_m"] == 550.0
    assert kwargs["height_ref"] == "agl"
    assert kwargs["backend"] == "http"


@patch("trajectories.api.compute_point_wind", return_value=TINY_WIND)
def test_wind_amsl_unixtime(mock_compute):
    r = client.get(
        "/v1/wind",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "1754132400",
            "timeformat": "unixtime",
            "height_amsl": 1500,
        },
    )
    assert r.status_code == 200
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["time"] == 1754132400.0
    assert kwargs["height_ref"] == "amsl"
    assert kwargs["height_m"] == 1500.0


def test_openapi_has_wind_path():
    r = client.get("/openapi.json")
    assert r.status_code == 200
    paths = r.json().get("paths") or {}
    assert "/v1/wind" in paths


def test_trajectory_nan_height():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": "nan",
        },
    )
    assert r.status_code == 400
    assert r.json()["error"] is True


def test_trajectory_profile_exclusive_with_height():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 48.4375,
            "longitude": 15.6181,
            "models": "icon_eu",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": "500",
            "profile_time": "0,3600",
            "profile_height": "150,500",
        },
    )
    assert r.status_code == 400
    assert "exclusive" in r.json()["reason"].lower() or "mutually" in r.json()["reason"].lower()


def test_trajectory_profile_partial_params():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 48.4375,
            "longitude": 15.6181,
            "models": "icon_eu",
            "time": "2026-08-02T11:00:00Z",
            "profile_time": "0,3600",
        },
    )
    assert r.status_code == 400
    assert "profile" in r.json()["reason"].lower()


@patch("trajectories.api.compute_trajectories", return_value=TINY_GJ)
def test_trajectory_profile_happy_path(mock_compute):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 48.4375,
            "longitude": 15.6181,
            "models": "icon_eu",
            "time": "2026-08-02T11:00:00Z",
            "forecast_hours": 2,
            "profile_time": "0,1200,3600,5400,7200",
            "profile_height": "150,150,1800,1800,400",
            "marker_interval": 60,
            "marker_interval_climbing": 10,
            "clearance_m": 0,
            "backend": "http",
        },
    )
    assert r.status_code == 200
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["height_profile"] == [
        (0.0, 150.0),
        (1200.0, 150.0),
        (3600.0, 1800.0),
        (5400.0, 1800.0),
        (7200.0, 400.0),
    ]
    assert kwargs["marker_interval_climbing_min"] == 10
    assert kwargs["clearance_m"] == 0
    assert kwargs["methods"] == ["height"]
