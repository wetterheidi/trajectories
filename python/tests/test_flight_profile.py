"""Unit tests for kinematic AGL flight profiles."""

from __future__ import annotations

import pytest

from trajectories.compute import parse_flight_profile
from trajectories.integrator import (
    build_profile_marker_times_sec,
    compute_trajectory,
    profile_height_at,
)


PROFILE = [
    (0.0, 150.0),
    (1200.0, 150.0),
    (3600.0, 1800.0),
    (5400.0, 1800.0),
    (7200.0, 400.0),
]


def test_parse_flight_profile_ok():
    p = parse_flight_profile([0, 60, 120], [100, 100, 500])
    assert p == [(0.0, 100.0), (60.0, 100.0), (120.0, 500.0)]


def test_parse_flight_profile_rejects_bad():
    with pytest.raises(ValueError, match="same length"):
        parse_flight_profile([0, 1], [10])
    with pytest.raises(ValueError, match="strictly increasing"):
        parse_flight_profile([0, 0], [10, 20])
    with pytest.raises(ValueError, match="at least 2"):
        parse_flight_profile([0], [10])


def test_profile_height_linear_interp():
    assert profile_height_at(PROFILE, 0) == 150
    assert profile_height_at(PROFILE, 1200) == 150
    # Mid climb 1200→3600: 150→1800
    assert profile_height_at(PROFILE, 2400) == pytest.approx(975.0)
    assert profile_height_at(PROFILE, 7200) == 400


def test_marker_times_level_vs_climb():
    marks = build_profile_marker_times_sec(
        PROFILE,
        t_end_sec=7200,
        level_sec=3600,
        climb_sec=600,
    )
    # Level [0,1200): no mark before 1200 with 3600s interval from segment start
    # Climb [1200,3600): 1800,2400,3000,(3600 if on grid from 1200: 1200+600*4=3600)
    assert 1800 in marks
    assert 2400 in marks
    assert 3000 in marks
    assert 3600 in marks
    # Level [3600,5400): 3600+3600=7200 beyond segment; no interior level marks
    # Descent [5400,7200): 6000,6600,(7200)
    assert 6000 in marks
    assert 6600 in marks
    assert 7200 in marks
    assert 600 not in marks  # would be climb grid but in level segment


def test_profile_trajectory_height_and_clearance():
    wind_at = lambda lat, lon, tg, t: {
        "u": 5,
        "v": 0,
        "zAmsl": 300 + tg["value"],
        "w": 0,
    }
    elev = lambda lat, lon: 300.0

    # Clearance stop: profile dips below clearance
    bad = [(0.0, 100.0), (600.0, 0.0)]
    r = compute_trajectory(
        wind_at=wind_at,
        lat0=48.44,
        lon0=15.62,
        target={"type": "height", "mode": "agl", "value": 100},
        t0_ms=0,
        duration_hours=600 / 3600,
        direction=1,
        grid_meters=6500,
        marker_interval_sec=3600,
        height_profile=bad,
        marker_interval_climb_sec=300,
        clearance_m=50,
        elevation_at=elev,
        min_step_sec=60,
        max_step_sec=120,
    )
    assert r["status"] == "stopped"
    assert "Bodenfreiheit" in (r["reason"] or "")

    r2 = compute_trajectory(
        wind_at=wind_at,
        lat0=48.44,
        lon0=15.62,
        target={"type": "height", "mode": "agl", "value": 150},
        t0_ms=0,
        duration_hours=2,
        direction=1,
        grid_meters=6500,
        marker_interval_sec=3600,
        height_profile=PROFILE,
        marker_interval_climb_sec=600,
        clearance_m=0,
        elevation_at=elev,
        min_step_sec=60,
        max_step_sec=300,
    )
    assert r2["status"] == "ok"
    assert len(r2["points"]) >= 2
    # Mid climb marker denser than 1h
    climb_marks = [m for m in r2["markers"] if 1200e3 < m["tMs"] < 3600e3]
    assert len(climb_marks) >= 2
