"""In-process TTL/LRU cache for GeoJSON trajectory responses (bonus path)."""

from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict
from typing import Any


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


class ResponseCache:
    def __init__(self, *, max_entries: int | None = None, ttl_s: float | None = None):
        self.max_entries = (
            max_entries
            if max_entries is not None
            else _env_int("TRAJECTORIES_CACHE_MAX", 64)
        )
        self.ttl_s = (
            float(ttl_s)
            if ttl_s is not None
            else float(_env_int("TRAJECTORIES_CACHE_TTL_S", 1800))
        )
        self._lock = threading.Lock()
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self.max_entries > 0 and self.ttl_s > 0

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def get(self, key: str) -> Any | None:
        if not self.enabled:
            return None
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            ts, value = hit
            if now - ts > self.ttl_s:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    def put(self, key: str, value: Any) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        with self._lock:
            self._data[key] = (now, value)
            self._data.move_to_end(key)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)


def cache_key(
    *,
    model: str,
    lat: float,
    lon: float,
    time: str | float,
    duration: float,
    heights: list[float] | None,
    methods: list[str] | None,
    height_ref: str,
    direction: str,
    marker: float,
    met_extras: bool,
    backend: str | None,
    profile: list[tuple[float, float]] | None = None,
    marker_climb: float | None = None,
    clearance_m: float = 0.0,
) -> str:
    h = ",".join(str(x) for x in (heights or []))
    m = ",".join(methods or [])
    if profile:
        p = ";".join(f"{t}:{ht}" for t, ht in profile)
    else:
        p = ""
    return "|".join([
        model,
        f"{round(lat, 3):.3f}",
        f"{round(lon, 3):.3f}",
        str(time),
        str(duration),
        h,
        m,
        height_ref,
        direction,
        str(marker),
        "1" if met_extras else "0",
        backend or "",
        p,
        "" if marker_climb is None else str(marker_climb),
        str(clearance_m),
    ])


def wind_cache_key(
    *,
    models: list[str] | tuple[str, ...],
    lat: float,
    lon: float,
    time: str | float,
    height_m: float,
    height_ref: str,
    backend: str | None,
) -> str:
    return "|".join([
        "wind",
        ",".join(models),
        f"{round(lat, 3):.3f}",
        f"{round(lon, 3):.3f}",
        str(time),
        str(height_m),
        height_ref,
        backend or "",
    ])


_CACHE = ResponseCache()


def get_response_cache() -> ResponseCache:
    return _CACHE
