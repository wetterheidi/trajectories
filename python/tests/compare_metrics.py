"""Track comparison metrics — port of tools/compare-trajectories.html."""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class Track:
    source: str
    label: str
    start_height: float
    t0: float  # ms
    points: list[dict]  # {lat, lon, ele?, t}
    vertical_motion: str | None = None
    status: str | None = None


def haversine(a: dict, b: dict) -> float:
    R = 6_371_008.8
    rad = math.pi / 180
    d_lat = (b["lat"] - a["lat"]) * rad
    d_lon = (b["lon"] - a["lon"]) * rad
    la1 = a["lat"] * rad
    la2 = b["lat"] * rad
    h = math.sin(d_lat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(d_lon / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def pos_at_minutes(track: Track, minutes: float) -> dict | None:
    t = track.t0 + minutes * 60_000
    p = track.points
    if t < p[0]["t"] or t > p[-1]["t"]:
        return None
    for i in range(1, len(p)):
        if t <= p[i]["t"]:
            a, b = p[i - 1], p[i]
            f = 0 if b["t"] == a["t"] else (t - a["t"]) / (b["t"] - a["t"])
            return {
                "lat": a["lat"] + f * (b["lat"] - a["lat"]),
                "lon": a["lon"] + f * (b["lon"] - a["lon"]),
            }
    return {"lat": p[-1]["lat"], "lon": p[-1]["lon"]}


def to_enu(ref: dict, p: dict) -> dict:
    rad = math.pi / 180
    R = 6_371_008.8
    return {
        "e": (p["lon"] - ref["lon"]) * math.cos(ref["lat"] * rad) * rad * R,
        "n": (p["lat"] - ref["lat"]) * rad * R,
    }


def decomp(mine: Track, windy: Track, minutes: float) -> dict | None:
    M = pos_at_minutes(mine, minutes)
    W = pos_at_minutes(windy, minutes)
    if not M or not W:
        return None
    w0 = pos_at_minutes(windy, max(0, minutes - 5)) or W
    w1 = pos_at_minutes(windy, minutes + 5) or W
    hv = to_enu(w0, w1)
    L = math.hypot(hv["e"], hv["n"]) or 1
    ux, uy = hv["e"] / L, hv["n"] / L
    sep = to_enu(W, M)
    return {
        "along": (sep["e"] * ux + sep["n"] * uy) / 1000,
        "cross": (sep["e"] * (-uy) + sep["n"] * ux) / 1000,
        "dist": math.hypot(sep["e"], sep["n"]) / 1000,
    }


def parse_mine_geojson(data: dict[str, Any]) -> list[Track]:
    feats = [
        f
        for f in data.get("features") or []
        if f.get("geometry", {}).get("type") == "LineString"
    ]
    tracks: list[Track] = []
    for f in feats:
        coords = f["geometry"]["coordinates"]
        times = [
            datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
            for s in (f.get("properties") or {}).get("times") or []
        ]
        points = []
        for i, c in enumerate(coords):
            if i >= len(times):
                break
            points.append({
                "lon": c[0],
                "lat": c[1],
                "ele": c[2] if len(c) > 2 else None,
                "t": times[i],
            })
        if len(points) < 2:
            continue
        props = f.get("properties") or {}
        tracks.append(Track(
            source="mine",
            label=props.get("label") or f"Höhe {props.get('start_height_m')} m",
            start_height=float(
                props.get("start_height_m")
                if props.get("start_height_m") is not None
                else (points[0].get("ele") or 0)
            ),
            t0=points[0]["t"],
            points=points,
            vertical_motion=props.get("vertical_motion"),
            status=props.get("status"),
        ))
    return tracks


def parse_windy_gpx(text: str) -> list[Track]:
    # Strip default namespace for easier XPath-less parsing
    text = re.sub(r'\sxmlns="[^"]+"', "", text, count=1)
    root = ET.fromstring(text)
    tracks: list[Track] = []
    for trk in root.findall(".//trk"):
        name_el = trk.find("name")
        name = (name_el.text or "?").strip() if name_el is not None else "?"

        def tag(t: str) -> str | None:
            el = trk.find(t)
            return el.text.strip() if el is not None and el.text else None

        alt_m = float(tag("alt_m") or "nan")
        alt_ft = tag("alt_ft")
        level = tag("level") or name
        pts = []
        for pt in trk.findall(".//trkpt"):
            lat = float(pt.attrib["lat"])
            lon = float(pt.attrib["lon"])
            ele_el = pt.find("ele")
            time_el = pt.find("time")
            if time_el is None or not time_el.text:
                continue
            t = datetime.fromisoformat(time_el.text.replace("Z", "+00:00")).timestamp() * 1000
            ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
            pts.append({"lat": lat, "lon": lon, "ele": ele, "t": t})
        if len(pts) < 2:
            continue
        label = f"{level}{f' ({alt_ft} ft)' if alt_ft else ''}"
        start_h = alt_m if math.isfinite(alt_m) else (pts[0]["ele"] or 0)
        tracks.append(Track(
            source="windy",
            label=label,
            start_height=float(start_h),
            t0=pts[0]["t"],
            points=pts,
        ))
    return tracks


def pair_tracks(mine: list[Track], windy: list[Track]) -> list[tuple[Track, Track]]:
    m = sorted(mine, key=lambda t: t.start_height)
    w = sorted(windy, key=lambda t: t.start_height)
    n = min(len(m), len(w))
    return list(zip(m[:n], w[:n]))


def pair_tracks_by_key(
    a: list[Track],
    b: list[Track],
) -> list[tuple[Track, Track]]:
    """Pair tracks on (start_height, vertical_motion)."""
    def key(t: Track) -> tuple[float, str]:
        return (round(t.start_height), t.vertical_motion or "")

    index_b = {key(t): t for t in b}
    pairs: list[tuple[Track, Track]] = []
    for ta in sorted(a, key=key):
        tb = index_b.get(key(ta))
        if tb is not None:
            pairs.append((ta, tb))
    return pairs


def max_separation_m(
    a: list[Track],
    b: list[Track],
    minutes: list[float] | None = None,
) -> dict[str, Any]:
    """Near-exact port check: max haversine separation in metres per pair."""
    minutes = minutes or list(range(0, 130, 10))
    pairs = pair_tracks_by_key(a, b)
    if not pairs:
        return {"pairs": 0, "max_m": None, "per_pair": []}

    all_m: list[float] = []
    per_pair = []
    for ta, tb in pairs:
        dists: list[float] = []
        for min_ in minutes:
            pa, pb = pos_at_minutes(ta, min_), pos_at_minutes(tb, min_)
            if pa and pb:
                m = haversine(pa, pb)
                dists.append(m)
                all_m.append(m)
        status_match = (ta.status or "") == (tb.status or "")
        per_pair.append({
            "a": ta.label,
            "b": tb.label,
            "height": ta.start_height,
            "vertical_motion": ta.vertical_motion,
            "max_m": max(dists) if dists else None,
            "status_match": status_match,
            "status_a": ta.status,
            "status_b": tb.status,
        })
    return {
        "pairs": len(pairs),
        "max_m": max(all_m) if all_m else None,
        "per_pair": per_pair,
    }


def median_separation_km(
    mine: list[Track],
    windy: list[Track],
    minutes: list[float] | None = None,
) -> dict[str, Any]:
    """Rough visual-equivalence summary: median / max horizontal separation."""
    minutes = minutes or list(range(0, 130, 10))
    pairs = pair_tracks(mine, windy)
    if not pairs:
        return {"pairs": 0, "median_km": None, "max_km": None, "per_pair": []}

    all_km: list[float] = []
    per_pair = []
    for mi, wi in pairs:
        kms = []
        for min_ in minutes:
            a, b = pos_at_minutes(mi, min_), pos_at_minutes(wi, min_)
            if a and b:
                km = haversine(a, b) / 1000
                kms.append(km)
                all_km.append(km)
        per_pair.append({
            "mine": mi.label,
            "windy": wi.label,
            "median_km": _median(kms) if kms else None,
            "max_km": max(kms) if kms else None,
        })
    return {
        "pairs": len(pairs),
        "median_km": _median(all_km) if all_km else None,
        "max_km": max(all_km) if all_km else None,
        "per_pair": per_pair,
    }


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if n % 2:
        return s[n // 2]
    return 0.5 * (s[n // 2 - 1] + s[n // 2])
