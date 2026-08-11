"""Local Open-Meteo `.om` chunk reader (omfiles) for WindField."""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from . import config
from .om_reader_cache import (
    SlabStaleError,
    clear_om_reader_cache,
    get_om_reader_cache,
)

# Process-wide warm backends (meta / grid / fs).
_BACKEND_LOCK = threading.Lock()
_BACKEND_CACHE: dict[str, "OmBackend"] = {}
# Reuse identical slabs across requests (warm unique-request path).
_SLAB_LOCK = threading.Lock()
_SLAB_CACHE: OrderedDict[tuple, "OmSlab"] = OrderedDict()
_SLAB_CACHE_MAX = 8

# Half-extent from start: characteristic wind × duration, clamped for IO.
SLAB_SPEED_KMH = 40.0
SLAB_PAD_KM_MIN = 50.0
SLAB_PAD_KM_MAX = 120.0
SLAB_LOAD_WORKERS = 16
SLAB_LOAD_RETRIES = 3
BAND_LOW_M = 2500.0
BAND_HIGH_M = 6500.0
BAND_HIGH_THRESHOLD_M = 2000.0


def get_om_backend(model_key: str, root: Path | None = None) -> "OmBackend":
    """Return a process-cached OmBackend for meta/grid reuse."""
    key = f"{model_key}:{root or config.OM_ROOT}"
    with _BACKEND_LOCK:
        hit = _BACKEND_CACHE.get(key)
        if hit is not None:
            return hit
        backend = OmBackend(model_key, root=root)
        _BACKEND_CACHE[key] = backend
        return backend


def clear_om_backend_cache() -> None:
    with _BACKEND_LOCK:
        _BACKEND_CACHE.clear()
    with _SLAB_LOCK:
        _SLAB_CACHE.clear()
    clear_om_reader_cache()


def clear_om_slab_cache() -> None:
    with _SLAB_LOCK:
        _SLAB_CACHE.clear()


def height_band_ceiling_m(max_height_m: float) -> float:
    """AGL ceiling for slab level selection (low 2.5 km / high 6.5 km)."""
    return BAND_LOW_M if max_height_m <= BAND_HIGH_THRESHOLD_M else BAND_HIGH_M


def spatial_pad_deg(lat: float, duration_h: float, speed_kmh: float = SLAB_SPEED_KMH) -> tuple[float, float]:
    km = speed_kmh * max(float(duration_h), 1.0)
    km = min(max(km, SLAB_PAD_KM_MIN), SLAB_PAD_KM_MAX)
    dlat = km / 111.0
    coslat = max(0.2, abs(math.cos(math.radians(lat))))
    dlon = km / (111.0 * coslat)
    return dlat, dlon


def _require_omfiles():
    try:
        from omfiles import OmFileReader
        from omfiles.chunk_reader import OmChunkFileReader
        from omfiles.meta import OmChunksMeta
    except ImportError as exc:
        raise RuntimeError(
            "omfiles is required for the local backend "
            "(pip install 'trajectories[om]')"
        ) from exc
    return OmFileReader, OmChunkFileReader, OmChunksMeta


@dataclass
class OmSlab:
    """In-memory lat/lon/time window for one trajectory compute."""

    x0: int
    x1: int  # inclusive
    y0: int
    y1: int  # inclusive
    times_unix: list[float]
    hsurf: np.ndarray  # [ny, nx]
    hhl: np.ndarray  # [ny, nx, nHalf]
    fields: dict[str, np.ndarray] = field(default_factory=dict)  # [ny, nx, nt]

    @property
    def ny(self) -> int:
        return self.y1 - self.y0 + 1

    @property
    def nx(self) -> int:
        return self.x1 - self.x0 + 1

    def contains_xy(self, x: int, y: int) -> bool:
        return self.x0 <= x <= self.x1 and self.y0 <= y <= self.y1

    def local_yx(self, x: int, y: int) -> tuple[int, int]:
        return y - self.y0, x - self.x0


class OmBackend:
    """Point / slab reads from a rolling Open-Meteo timeseries tree."""

    def __init__(self, model_key: str, root: Path | None = None):
        OmFileReader, OmChunkFileReader, OmChunksMeta = _require_omfiles()
        self._OmFileReader = OmFileReader
        self._OmChunkFileReader = OmChunkFileReader

        if model_key not in config.MODELS:
            raise ValueError(f"Unbekanntes Modell: {model_key}")
        self.model_key = model_key
        self.model = config.MODELS[model_key]
        ds = Path(root) if root is not None else config.dataset_path(model_key)
        if ds is None or not ds.is_dir():
            raise RuntimeError(f"OM dataset not found for {model_key}")
        self.dataset = ds

        meta_path = self.dataset / "static" / "meta.json"
        self.meta = OmChunksMeta.from_metajson_string(meta_path.read_text())
        self.ny, self.nx = self._discover_shape()
        self.grid = self.meta.get_grid((self.ny, self.nx))

        import fsspec

        self.fs = fsspec.filesystem("file")
        self._xy_cache: dict[tuple[float, float], Any] = {}
        self._readers = get_om_reader_cache()

    def _discover_shape(self) -> tuple[int, int]:
        level = self.model["nLevels"]
        var_dir = self.dataset / f"wind_u_component_level{level}"
        chunks = sorted(var_dir.glob("chunk_*.om"))
        if not chunks:
            raise RuntimeError(f"No OM chunks under {var_dir}")
        cache = get_om_reader_cache()
        entry = cache.get(str(chunks[0]))
        with entry.lock:
            ny, nx, _nt = entry.reader.shape
        return int(ny), int(nx)

    def has_w(self) -> bool:
        level = self.model["nLevels"] - 5
        return (self.dataset / f"wind_w_level{level}").is_dir()

    def _xy(self, lat: float, lon: float):
        key = (round(lat, 5), round(lon, 5))
        hit = self._xy_cache.get(key)
        if hit is not None:
            return hit
        xy = self.grid.find_point_xy(lat, lon)
        self._xy_cache[key] = xy
        return xy

    def elevation_at(self, lat: float, lon: float) -> float:
        xy = self._xy(lat, lon)
        path = str(self.dataset / "static" / "HSURF.om")
        return float(np.asarray(self._readers.read_array(path, (xy.y, xy.x))))

    def height_agl_profile(self, lat: float, lon: float) -> dict[int, float]:
        """Model-level AGL heights (level 1 = TOA … nLevels ≈ 10 m)."""
        xy = self._xy(lat, lon)
        hsurf = float(
            np.asarray(
                self._readers.read_array(str(self.dataset / "static" / "HSURF.om"), (xy.y, xy.x))
            )
        )
        hhl = np.asarray(
            self._readers.read_array(str(self.dataset / "static" / "hhl.om"), (xy.y, xy.x, slice(None))),
            dtype=np.float32,
        )
        n = self.model["nLevels"]
        out: dict[int, float] = {}
        for level in range(1, n + 1):
            out[level] = float(0.5 * (hhl[level - 1] + hhl[level]) - hsurf)
        return out

    def _load_chunk_slice(
        self,
        chunk_path: str,
        chunk_index: int,
        spatial_xy: tuple,
        t0: np.datetime64,
        t1: np.datetime64,
        *,
        ticket: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Load time-masked spatial slice from one chunk file via reader cache."""
        chunk_times = self.meta.get_chunk_time_range(chunk_index)
        time_mask = (chunk_times >= t0) & (chunk_times <= t1)
        if not np.any(time_mask):
            return np.array([], dtype="datetime64[ns]"), np.array([], dtype=np.float32)

        indices = np.where(time_mask)[0]
        time_slice = slice(int(indices[0]), int(indices[-1]) + 1)
        x, y = spatial_xy
        data = np.asarray(
            self._readers.read_array(chunk_path, (y, x, time_slice), ticket=ticket),
            dtype=np.float32,
        )
        times = chunk_times[time_mask]
        if times.shape[-1] != 1 and times.shape[-1] != data.shape[-1]:
            raise RuntimeError(
                f"Expected {times.shape[-1]} timestamps but got {data.shape[-1]}"
            )
        self._readers.check_ticket(ticket)
        return times, data

    def _load_var_chunks(
        self,
        var: str,
        x0: int,
        x1: int,
        y0: int,
        y1: int,
        t0: np.datetime64,
        t1: np.datetime64,
        *,
        ticket: int,
    ) -> tuple[str, np.ndarray, list[float]]:
        var_dir = self.dataset / var
        if not var_dir.is_dir():
            raise RuntimeError(f"OM variable missing: {var_dir}")
        chunk_reader = self._OmChunkFileReader(self.meta, self.fs, str(var_dir), t0, t1)
        spatial = (slice(x0, x1 + 1), slice(y0, y1 + 1))
        ny_s, nx_s = y1 - y0 + 1, x1 - x0 + 1

        tasks = list(chunk_reader.iter_files())
        if not tasks:
            return var, np.zeros((ny_s, nx_s, 0), dtype=np.float32), []

        parts: list[tuple[int, np.ndarray, np.ndarray]] = []
        for chunk_index, chunk_path in tasks:
            times, data = self._load_chunk_slice(
                chunk_path, chunk_index, spatial, t0, t1, ticket=ticket
            )
            if len(times) == 0:
                continue
            arr = np.asarray(data, dtype=np.float32)
            # reader[y, x, t] → [ny, nx, nt] when y,x are slices
            if arr.ndim == 1:
                arr = arr.reshape(1, 1, -1)
            elif arr.ndim == 2:
                # ambiguous; assume [n_spatial, nt] — shouldn't happen for 2D slice
                arr = arr.reshape(arr.shape[0], 1, arr.shape[1])
            if arr.shape[0] != ny_s or arr.shape[1] != nx_s:
                if arr.shape[0] == nx_s and arr.shape[1] == ny_s:
                    arr = np.transpose(arr, (1, 0, 2))
                else:
                    raise RuntimeError(
                        f"Slab shape mismatch for {var} chunk {chunk_index}: "
                        f"{arr.shape} vs ny={ny_s} nx={nx_s}"
                    )
            parts.append((chunk_index, times, arr))

        if not parts:
            return var, np.zeros((ny_s, nx_s, 0), dtype=np.float32), []

        parts.sort(key=lambda p: p[0])
        time_array = np.concatenate([p[1] for p in parts], axis=-1)
        data_array = np.concatenate([p[2] for p in parts], axis=-1)
        return var, data_array, [_dt64_to_unix(t) for t in time_array]

    def load_slab(
        self,
        lat0: float,
        lon0: float,
        duration_h: float,
        start_date: str,
        end_date: str,
        levels: list[int],
        vars_: list[str],
        *,
        t_min_ms: float | None = None,
        t_max_ms: float | None = None,
    ) -> OmSlab:
        """Preload a padded spatial/time window; retry if ingest invalidates files."""
        # Approximate cache key from request geometry (exact xy after first load).
        file_vars = tuple(v for v in vars_ if not v.startswith("height_agl_level"))
        pre_key = (
            self.model_key,
            round(lat0, 3),
            round(lon0, 3),
            round(duration_h, 3),
            start_date,
            end_date,
            None if t_min_ms is None else int(t_min_ms),
            None if t_max_ms is None else int(t_max_ms),
            tuple(levels),
            file_vars,
        )
        with _SLAB_LOCK:
            hit = _SLAB_CACHE.get(pre_key)
            if hit is not None:
                _SLAB_CACHE.move_to_end(pre_key)
                return hit

        last_err: Exception | None = None
        for _ in range(SLAB_LOAD_RETRIES):
            try:
                slab = self._load_slab_once(
                    lat0, lon0, duration_h, start_date, end_date, levels, vars_,
                    t_min_ms=t_min_ms, t_max_ms=t_max_ms,
                )
                with _SLAB_LOCK:
                    _SLAB_CACHE[pre_key] = slab
                    _SLAB_CACHE.move_to_end(pre_key)
                    while len(_SLAB_CACHE) > _SLAB_CACHE_MAX:
                        _SLAB_CACHE.popitem(last=False)
                return slab
            except SlabStaleError as exc:
                last_err = exc
                clear_om_slab_cache()
                continue
        raise RuntimeError(
            f"OM slab load failed after {SLAB_LOAD_RETRIES} retries: {last_err}"
        )

    def _load_slab_once(
        self,
        lat0: float,
        lon0: float,
        duration_h: float,
        start_date: str,
        end_date: str,
        levels: list[int],
        vars_: list[str],
        *,
        t_min_ms: float | None = None,
        t_max_ms: float | None = None,
    ) -> OmSlab:
        dlat, dlon = spatial_pad_deg(lat0, duration_h)
        b = self.model["bbox"]
        corners = [
            (min(max(lat0 - dlat, b["latMin"]), b["latMax"]), min(max(lon0 - dlon, b["lonMin"]), b["lonMax"])),
            (min(max(lat0 - dlat, b["latMin"]), b["latMax"]), min(max(lon0 + dlon, b["lonMin"]), b["lonMax"])),
            (min(max(lat0 + dlat, b["latMin"]), b["latMax"]), min(max(lon0 - dlon, b["lonMin"]), b["lonMax"])),
            (min(max(lat0 + dlat, b["latMin"]), b["latMax"]), min(max(lon0 + dlon, b["lonMin"]), b["lonMax"])),
        ]
        xs, ys = [], []
        for lat, lon in corners:
            xy = self._xy(lat, lon)
            xs.append(xy.x)
            ys.append(xy.y)
        x0, x1 = max(0, min(xs)), min(self.nx - 1, max(xs))
        y0, y1 = max(0, min(ys)), min(self.ny - 1, max(ys))

        if t_min_ms is not None and t_max_ms is not None:
            t_lo = min(t_min_ms, t_max_ms) / 1000.0 - 3600.0
            t_hi = max(t_min_ms, t_max_ms) / 1000.0 + 3600.0
            t0 = np.datetime64(int(t_lo), "s")
            t1 = np.datetime64(int(t_hi), "s")
        else:
            t0 = np.datetime64(f"{start_date}T00:00")
            t1 = np.datetime64(f"{end_date}T23:00")

        file_vars = [v for v in vars_ if not v.startswith("height_agl_level")]
        ticket = self._readers.begin_ticket()
        try:
            hsurf = np.asarray(
                self._readers.read_array(
                    str(self.dataset / "static" / "HSURF.om"),
                    (slice(y0, y1 + 1), slice(x0, x1 + 1)),
                    ticket=ticket,
                ),
                dtype=np.float32,
            )
            hhl = np.asarray(
                self._readers.read_array(
                    str(self.dataset / "static" / "hhl.om"),
                    (slice(y0, y1 + 1), slice(x0, x1 + 1), slice(None)),
                    ticket=ticket,
                ),
                dtype=np.float32,
            )

            fields: dict[str, np.ndarray] = {}
            times_unix: list[float] | None = None

            if file_vars:
                # Expand to per-var tasks; each var may touch multiple chunks.
                # Parallelize across variables (chunks inside each var stay ordered).
                workers = min(SLAB_LOAD_WORKERS, len(file_vars))

                def _job(var: str):
                    return self._load_var_chunks(
                        var, x0, x1, y0, y1, t0, t1, ticket=ticket
                    )

                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futs = [pool.submit(_job, v) for v in file_vars]
                    for fut in as_completed(futs):
                        var, arr, times = fut.result()
                        fields[var] = arr
                        if times_unix is None:
                            times_unix = times

            self._readers.check_ticket(ticket)
        finally:
            self._readers.end_ticket(ticket)

        if times_unix is None:
            times_unix = _hourly_unix(start_date, end_date)

        return OmSlab(
            x0=x0,
            x1=x1,
            y0=y0,
            y1=y1,
            times_unix=times_unix,
            hsurf=hsurf,
            hhl=hhl,
            fields=fields,
        )

    def request_from_slab(
        self,
        slab: OmSlab,
        coords: list[list[float]],
        vars_: list[str],
        *,
        with_meta: bool = False,
    ) -> list[dict] | None:
        """
        Build HTTP-shaped point dicts from a slab.
        Returns None if any coordinate falls outside the slab (caller falls back).
        """
        file_vars = [v for v in vars_ if not v.startswith("height_agl_level")]
        height_levels = [
            int(v.removeprefix("height_agl_level"))
            for v in vars_
            if v.startswith("height_agl_level")
        ]
        T = len(slab.times_unix)
        out_list: list[dict] = []
        for lat, lon in coords:
            xy = self._xy(lat, lon)
            if not slab.contains_xy(xy.x, xy.y):
                return None
            iy, ix = slab.local_yx(xy.x, xy.y)
            elev = float(slab.hsurf[iy, ix])
            row: dict[str, Any] = {}
            for var in file_vars:
                arr = slab.fields.get(var)
                if arr is None:
                    return None
                series = arr[iy, ix, :]
                row[var] = [
                    None if not np.isfinite(v) else float(v) for v in series
                ]
            if height_levels:
                hhl_col = slab.hhl[iy, ix, :]
                for level in height_levels:
                    h = float(0.5 * (hhl_col[level - 1] + hhl_col[level]) - elev)
                    row[f"height_agl_level{level}"] = [h] * T
            if with_meta:
                row["__times"] = list(slab.times_unix)
                row["__elevation"] = elev
            out_list.append(row)
        return out_list

    def request(
        self,
        coords: list[list[float]],
        vars_: list[str],
        start_date: str,
        end_date: str,
        *,
        with_meta: bool = False,
        slab: OmSlab | None = None,
    ) -> list[dict]:
        if slab is not None:
            hit = self.request_from_slab(slab, coords, vars_, with_meta=with_meta)
            if hit is not None:
                return hit

        t0 = np.datetime64(f"{start_date}T00:00")
        t1 = np.datetime64(f"{end_date}T23:00")

        file_vars = [v for v in vars_ if not v.startswith("height_agl_level")]
        height_levels = [
            int(v.removeprefix("height_agl_level"))
            for v in vars_
            if v.startswith("height_agl_level")
        ]

        series: dict[str, list[np.ndarray]] = {v: [] for v in file_vars}
        times_unix: list[float] | None = None
        for attempt in range(SLAB_LOAD_RETRIES):
            ticket = self._readers.begin_ticket()
            try:
                series = {v: [] for v in file_vars}
                times_unix = None
                for var in file_vars:
                    var_dir = self.dataset / var
                    if not var_dir.is_dir():
                        raise RuntimeError(f"OM variable missing: {var_dir}")
                    for lat, lon in coords:
                        xy = self._xy(lat, lon)
                        _v, arr, times = self._load_var_chunks(
                            var, xy.x, xy.x, xy.y, xy.y, t0, t1, ticket=ticket
                        )
                        if times_unix is None:
                            times_unix = times
                        series[var].append(np.asarray(arr[0, 0, :], dtype=np.float32))
                self._readers.check_ticket(ticket)
                break
            except SlabStaleError:
                if attempt + 1 >= SLAB_LOAD_RETRIES:
                    raise
            finally:
                self._readers.end_ticket(ticket)

        assert times_unix is not None or not file_vars
        if times_unix is None:
            times_unix = _hourly_unix(start_date, end_date)

        T = len(times_unix)
        out_list: list[dict] = []
        for i, (lat, lon) in enumerate(coords):
            elev = self.elevation_at(lat, lon)
            row: dict[str, Any] = {}
            for var in file_vars:
                arr = series[var][i]
                row[var] = [None if not np.isfinite(v) else float(v) for v in arr]
            if height_levels:
                profile = self.height_agl_profile(lat, lon)
                for level in height_levels:
                    h = profile[level]
                    row[f"height_agl_level{level}"] = [h] * T
            if with_meta:
                row["__times"] = times_unix
                row["__elevation"] = elev
            out_list.append(row)
        return out_list

    def units_for(self, vars_: list[str]) -> dict[str, str]:
        """Unit metadata so WindField.store_point applies the right scales."""
        units: dict[str, str] = {}
        for v in vars_:
            if v.startswith("wind_u_component_") or v.startswith("wind_v_component_"):
                units[v] = "m/s"
            elif v.startswith("wind_w_"):
                units[v] = "m/s"
            elif v.startswith("temperature_"):
                units[v] = "°C"
            elif v.startswith("pressure_"):
                units[v] = "hPa"
            elif v.startswith("specific_humidity_"):
                units[v] = "g/kg"
            elif v.startswith("height_agl_"):
                units[v] = "m"
        return units


def _dt64_to_unix(t: np.datetime64) -> float:
    return float(t.astype("datetime64[s]").astype(np.int64))


def _hourly_unix(start_date: str, end_date: str) -> list[float]:
    t0 = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
    t1 = datetime.fromisoformat(end_date).replace(
        hour=23, minute=0, second=0, tzinfo=timezone.utc
    )
    out: list[float] = []
    t = t0.timestamp()
    end = t1.timestamp()
    while t <= end:
        out.append(t)
        t += 3600
    return out
