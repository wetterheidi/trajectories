"""Fake-wind Petterssen tests — port of test/integrator.test.mjs."""

from __future__ import annotations

import math

from trajectories.integrator import compute_trajectory, dist_meters

R = 6_371_000
DEG = 180 / math.pi
H1500 = {"type": "height", "mode": "agl", "value": 1500}


def test_homogeneous_west_wind():
    wind_at = lambda *a, **k: {"u": 10, "v": 0}
    r = compute_trajectory(
        wind_at=wind_at,
        lat0=45,
        lon0=10,
        target=H1500,
        t0_ms=0,
        duration_hours=6,
        direction=1,
        grid_meters=6500,
    )
    last = r["points"][-1]
    d = dist_meters(45, 10, last["lat"], last["lon"])
    assert abs(d - 216_000) < 500
    assert abs(last["lat"] - 45) < 1e-6
    # 6 Intervall-Marken (1h..6h) + 1 Marke am Startzeitpunkt selbst -- die
    # fehlte sonst, während die Höhenkurve (`points[0]`) ihn schon zeigt.
    assert len(r["markers"]) == 7
    assert r["markers"][0]["tMs"] == 0

    r30 = compute_trajectory(
        wind_at=wind_at,
        lat0=45,
        lon0=10,
        target=H1500,
        t0_ms=900e3,
        duration_hours=6,
        direction=1,
        grid_meters=6500,
        marker_interval_sec=1800,
    )
    assert len(r30["markers"]) == 13
    assert all(abs((m["tMs"] - 900e3) % 1800e3) <= 1 for m in r30["markers"])


def test_backward_inverts_forward():
    def wind_at(lat, lon, tg, t):
        return {"u": 8 + 0.5 * (lat - 45), "v": 3 + 0.3 * (lon - 10)}

    fwd = compute_trajectory(
        wind_at=wind_at,
        lat0=45,
        lon0=10,
        target=H1500,
        t0_ms=0,
        duration_hours=12,
        direction=1,
        grid_meters=6500,
    )
    end = fwd["points"][-1]
    bwd = compute_trajectory(
        wind_at=wind_at,
        lat0=end["lat"],
        lon0=end["lon"],
        target=H1500,
        t0_ms=end["tMs"],
        duration_hours=12,
        direction=-1,
        grid_meters=6500,
    )
    back = bwd["points"][-1]
    err = dist_meters(45, 10, back["lat"], back["lon"])
    total = dist_meters(45, 10, end["lat"], end["lon"])
    assert err < 0.005 * total


def test_rigid_rotation_closes():
    omega = (2 * math.pi) / (24 * 3600)

    def wind_at(lat, lon, tg, t):
        y = (lat - 45) / DEG * R
        x = (lon - 10) / DEG * R * math.cos(45 / DEG)
        return {"u": -omega * y, "v": omega * x}

    r = compute_trajectory(
        wind_at=wind_at,
        lat0=45.9,
        lon0=10,
        target=H1500,
        t0_ms=0,
        duration_hours=24,
        direction=1,
        grid_meters=6500,
        max_step_sec=300,
    )
    last = r["points"][-1]
    radius = dist_meters(45, 10, 45.9, 10)
    err = dist_meters(45.9, 10, last["lat"], last["lon"])
    assert err < 0.02 * radius


def test_stop_on_data_end():
    def wind_at(lat, lon, tg, t):
        if t > 3 * 3600e3:
            return {"error": "Ende des Datenzeitraums erreicht"}
        return {"u": 10, "v": 0}

    r = compute_trajectory(
        wind_at=wind_at,
        lat0=45,
        lon0=10,
        target=H1500,
        t0_ms=0,
        duration_hours=6,
        direction=1,
        grid_meters=6500,
    )
    assert r["status"] == "stopped" and r["reason"]
    assert abs(r["points"][-1]["tMs"] - 3 * 3600e3) < 3600e3 / 2


def test_z3d_integrates_height():
    def wind_at(lat, lon, tg, t):
        return {"u": 10, "v": 0, "w": 0.5, "zAmsl": tg["value"]}

    r = compute_trajectory(
        wind_at=wind_at,
        lat0=45,
        lon0=10,
        target={"type": "z3d", "value": 1000},
        t0_ms=0,
        duration_hours=2,
        direction=1,
        grid_meters=6500,
    )
    assert abs(r["points"][-1]["z"] - 4600) < 1
    assert all(math.isfinite(m["z"]) for m in r["markers"])
    assert all(m["w"] == 0.5 for m in r["markers"])

    def shear(lat, lon, tg, t):
        return {"u": 5 + tg["value"] / 500, "v": 2, "w": 0.3, "zAmsl": tg["value"]}

    fwd = compute_trajectory(
        wind_at=shear,
        lat0=45,
        lon0=10,
        target={"type": "z3d", "value": 800},
        t0_ms=0,
        duration_hours=6,
        direction=1,
        grid_meters=6500,
    )
    e = fwd["points"][-1]
    bwd = compute_trajectory(
        wind_at=shear,
        lat0=e["lat"],
        lon0=e["lon"],
        target={"type": "z3d", "value": e["z"]},
        t0_ms=e["tMs"],
        duration_hours=6,
        direction=-1,
        grid_meters=6500,
    )
    b = bwd["points"][-1]
    err = dist_meters(45, 10, b["lat"], b["lon"]) + abs(b["z"] - 800)
    assert err < 1000
