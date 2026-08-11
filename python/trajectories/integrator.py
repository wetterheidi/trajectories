"""Petterssen trajectory integrator — port of src/integrator.js."""

from __future__ import annotations

import math
from typing import Any, Callable, Sequence

R_EARTH = 6_371_000
DEG = 180 / math.pi

WindAt = Callable[[float, float, dict, float], dict]
# (t_sec_from_start, height_agl_m)
HeightProfile = Sequence[tuple[float, float]]


def profile_height_at(profile: HeightProfile, t_sec: float) -> float:
    """Piecewise-linear AGL height at time t_sec (seconds from start)."""
    if not profile:
        raise ValueError("empty height profile")
    if t_sec <= profile[0][0]:
        return float(profile[0][1])
    if t_sec >= profile[-1][0]:
        return float(profile[-1][1])
    for i in range(len(profile) - 1):
        t0, h0 = profile[i]
        t1, h1 = profile[i + 1]
        if t0 <= t_sec <= t1:
            if t1 <= t0:
                return float(h1)
            w = (t_sec - t0) / (t1 - t0)
            return float(h0 + w * (h1 - h0))
    return float(profile[-1][1])


def profile_segment_index(profile: HeightProfile, t_sec: float) -> int:
    """Index i of segment [profile[i], profile[i+1]] containing t_sec (clamped)."""
    if len(profile) < 2:
        return 0
    if t_sec <= profile[0][0]:
        return 0
    if t_sec >= profile[-1][0]:
        return len(profile) - 2
    for i in range(len(profile) - 1):
        if profile[i][0] <= t_sec <= profile[i + 1][0]:
            # At exact waypoint, prefer the outgoing segment (except at end).
            if t_sec == profile[i + 1][0] and i + 1 < len(profile) - 1:
                return i + 1
            return i
    return len(profile) - 2


def profile_is_level_segment(profile: HeightProfile, seg_i: int) -> bool:
    h0 = profile[seg_i][1]
    h1 = profile[seg_i + 1][1]
    return abs(h0 - h1) < 1e-9


def profile_marker_interval_sec(
    profile: HeightProfile,
    t_sec: float,
    *,
    level_sec: float,
    climb_sec: float,
) -> float:
    i = profile_segment_index(profile, t_sec)
    return level_sec if profile_is_level_segment(profile, i) else climb_sec


def build_profile_marker_times_sec(
    profile: HeightProfile,
    *,
    t_end_sec: float,
    level_sec: float,
    climb_sec: float,
) -> list[float]:
    """
    Marker times (seconds from start) in (0, t_end_sec].

    Within each segment, marks are placed every level/climb interval measured
    from the segment start (not from global t=0), matching denser sampling on
    climb/descent legs.
    """
    marks: set[float] = set()
    for i in range(len(profile) - 1):
        t_a, h_a = profile[i]
        t_b, h_b = profile[i + 1]
        if t_b <= t_a:
            continue
        iv = level_sec if abs(h_a - h_b) < 1e-9 else climb_sec
        if iv <= 0:
            continue
        t = t_a + iv
        while t < t_b - 1e-6:
            if 0 < t <= t_end_sec + 1e-9:
                marks.add(round(t, 6))
            t += iv
        # Land exactly on segment end if it aligns with an interval step from t_a
        # or is the trajectory end — include t_b when it falls on the grid.
        rem = abs((t_b - t_a) % iv)
        if (rem < 1e-6 or iv - rem < 1e-6) and 0 < t_b <= t_end_sec + 1e-9:
            marks.add(round(t_b, 6))
    if t_end_sec > 0:
        # Ensure end time can be a mark if it coincides with a grid (integrator
        # also snaps steps to next mark; include t_end when on any segment grid).
        pass
    return sorted(marks)


def _next_mark_ms(
    t_ms: float,
    t0_ms: float,
    t_end_ms: float,
    direction: int,
    mark_times_sec: list[float] | None,
    interval_ms: float,
) -> float:
    if mark_times_sec is not None:
        rel = (t_ms - t0_ms) * direction / 1000.0
        for ts in mark_times_sec:
            if direction > 0 and ts * 1000 > (t_ms - t0_ms) + 0.5:
                return t0_ms + ts * 1000
            if direction < 0 and ts * 1000 > (t0_ms - t_ms) + 0.5:
                return t0_ms - ts * 1000
        return t_end_ms
    rel = t_ms - t0_ms
    if direction > 0:
        return t0_ms + math.floor(rel / interval_ms + 1) * interval_ms
    return t0_ms + math.ceil(rel / interval_ms - 1) * interval_ms


def compute_trajectory(
    *,
    wind_at: WindAt,
    lat0: float,
    lon0: float,
    target: dict,
    t0_ms: float,
    duration_hours: float,
    direction: int = 1,
    grid_meters: float,
    marker_interval_sec: float = 3600,
    max_step_sec: float = 900,
    min_step_sec: float = 60,
    height_profile: HeightProfile | None = None,
    marker_interval_climb_sec: float | None = None,
    clearance_m: float = 0.0,
    elevation_at: Callable[[float, float], float | None] | None = None,
) -> dict[str, Any]:
    interval_ms = marker_interval_sec * 1000
    is3d = target["type"] == "z3d"
    use_profile = height_profile is not None and len(height_profile) >= 2
    if use_profile and is3d:
        raise ValueError("height_profile cannot be combined with z3d")
    if use_profile and target.get("type") != "height":
        raise ValueError("height_profile requires a height target")

    climb_sec = float(
        marker_interval_climb_sec
        if marker_interval_climb_sec is not None
        else marker_interval_sec
    )
    mark_times_sec: list[float] | None = None
    if use_profile:
        t_end_sec = abs(duration_hours) * 3600.0
        mark_times_sec = build_profile_marker_times_sec(
            height_profile,
            t_end_sec=t_end_sec,
            level_sec=marker_interval_sec,
            climb_sec=climb_sec,
        )

    tgt = dict(target)
    if use_profile:
        tgt = {
            "type": "height",
            "mode": "agl",
            "value": profile_height_at(height_profile, 0.0),
        }

    lat, lon, t = lat0, lon0, t0_ms
    t_end = t0_ms + direction * duration_hours * 3600e3
    points: list[dict] = [{"lat": lat, "lon": lon, "tMs": t, "z": None}]
    markers: list[dict] = []
    status, reason = "ok", None

    def _apply_profile_height(t_now: float) -> None:
        nonlocal tgt
        if not use_profile:
            return
        rel = abs(t_now - t0_ms) / 1000.0
        tgt = {**tgt, "value": profile_height_at(height_profile, rel)}

    def _clearance_ok(lat_c: float, lon_c: float, h_agl: float, z_amsl: float | None) -> bool:
        if h_agl < clearance_m:
            return False
        if elevation_at is not None and z_amsl is not None and math.isfinite(z_amsl):
            elev = elevation_at(lat_c, lon_c)
            if elev is not None and math.isfinite(elev):
                if (z_amsl - elev) < clearance_m:
                    return False
        return True

    while direction * (t_end - t) > 1:
        _apply_profile_height(t)
        if use_profile and tgt["value"] < clearance_m:
            status, reason = "stopped", "Bodenfreiheit unterschritten"
            break

        w0 = wind_at(lat, lon, tgt, t)
        if w0.get("error"):
            status, reason = "stopped", w0["error"]
            break
        if points[0]["z"] is None:
            points[0]["z"] = w0.get("zAmsl")
        if use_profile and not _clearance_ok(lat, lon, tgt["value"], w0.get("zAmsl")):
            status, reason = "stopped", "Bodenfreiheit unterschritten"
            break

        speed = math.hypot(w0["u"], w0["v"])
        dt_sec = clamp((0.75 * grid_meters) / max(speed, 0.5), min_step_sec, max_step_sec)
        next_mark = _next_mark_ms(t, t0_ms, t_end, direction, mark_times_sec, interval_ms)
        limit_ms = direction * min(direction * (t_end - t), direction * (next_mark - t))
        dt_sec = min(dt_sec, abs(limit_ms) / 1000)
        dt = direction * dt_sec

        lat1, lon1 = advect(lat, lon, w0["u"], w0["v"], dt)
        z1 = tgt["value"] + w0["w"] * dt if is3d else tgt["value"]
        w_last = w0
        failed = None
        for _ in range(5):
            if use_profile:
                rel1 = abs((t + dt * 1000) - t0_ms) / 1000.0
                tgt1 = {**tgt, "value": profile_height_at(height_profile, rel1)}
            else:
                tgt1 = {**tgt, "value": z1} if is3d else tgt
            w1 = wind_at(lat1, lon1, tgt1, t + dt * 1000)
            if w1.get("error"):
                failed = w1["error"]
                break
            w_last = w1
            lat_n, lon_n = advect(
                lat, lon,
                0.5 * (w0["u"] + w1["u"]),
                0.5 * (w0["v"] + w1["v"]),
                dt,
            )
            if use_profile:
                z_n = tgt1["value"]
            else:
                z_n = tgt["value"] + 0.5 * (w0["w"] + w1["w"]) * dt if is3d else tgt["value"]
            move = dist_meters(lat1, lon1, lat_n, lon_n) + abs(z_n - z1)
            lat1, lon1, z1 = lat_n, lon_n, z_n
            if move < 10:
                break
        if failed:
            status, reason = "stopped", failed
            break

        lat, lon, t = lat1, lon1, t + dt * 1000
        _apply_profile_height(t)
        if is3d:
            tgt = {**tgt, "value": z1}
        if use_profile and not _clearance_ok(lat, lon, tgt["value"], w_last.get("zAmsl")):
            # Keep last in-air point if we already appended? Stop without adding
            # underground point when the new position violates clearance.
            status, reason = "stopped", "Bodenfreiheit unterschritten"
            break
        points.append({"lat": lat, "lon": lon, "tMs": t, "z": w_last.get("zAmsl")})

        on_mark = False
        if mark_times_sec is not None:
            rel = abs(t - t0_ms) / 1000.0
            on_mark = any(abs(rel - ts) < 1e-3 for ts in mark_times_sec)
        else:
            mrem = abs((t - t0_ms) % interval_ms)
            on_mark = mrem < 1 or interval_ms - mrem < 1
        if on_mark:
            w = wind_at(lat, lon, tgt, t)
            if not w.get("error"):
                markers.append({
                    "lat": lat, "lon": lon, "tMs": t,
                    "u": w["u"], "v": w["v"],
                    "z": w.get("zAmsl"), "met": w.get("met"),
                })

    return {
        "points": points,
        "markers": markers,
        "status": status,
        "reason": reason,
        "target": tgt,
        "direction": direction,
    }


def advect(lat: float, lon: float, u: float, v: float, dt_sec: float) -> tuple[float, float]:
    lat_mid = (lat + (lat + (v * dt_sec / R_EARTH) * DEG)) / 2
    d_lat = (v * dt_sec / R_EARTH) * DEG
    d_lon = (u * dt_sec / (R_EARTH * math.cos(lat_mid / DEG))) * DEG
    return lat + d_lat, normalize_lon(lon + d_lon)


def dist_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dy = (lat2 - lat1) / DEG * R_EARTH
    dx = (lon2 - lon1) / DEG * R_EARTH * math.cos(((lat1 + lat2) / 2) / DEG)
    return math.hypot(dx, dy)


def normalize_lon(lon: float) -> float:
    return ((lon + 540) % 360) - 180


def clamp(x: float, a: float, b: float) -> float:
    return min(b, max(a, x))
