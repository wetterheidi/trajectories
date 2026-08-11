"""FastAPI HTTP API for ICON wind trajectories (Open-Meteo-shaped query params)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
import math

from fastapi import FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config
from .compute import compute_point_wind, compute_trajectories, parse_flight_profile
from .response_cache import cache_key, get_response_cache, wind_cache_key

MODELS = Literal["icon_d2", "icon_eu"]
VERTICAL = Literal["height", "pressure", "theta", "z3d"]
DIRECTION = Literal["forward", "backward"]
BACKEND = Literal["auto", "om", "http"]
TIMEFORMAT = Literal["iso8601", "unixtime"]
FORMAT = Literal["geojson"]
WIND_FORMAT = Literal["json"]

app = FastAPI(
    title="Trajectories API",
    description=(
        "Petterssen ICON wind trajectories over Open-Meteo fields. "
        "Query parameters follow Open-Meteo naming; successful trajectory responses "
        "are GeoJSON FeatureCollections (SimpleStyle). Trajectory LineStrings include "
        "properties.terrain_m (model orography m AMSL, parallel to coordinates). "
        "Point wind samples are available at GET /v1/wind (flat JSON). "
        "Optional kinematic AGL flight profiles via profile_time + profile_height."
    ),
    version="0.1.0",
    openapi_tags=[
        {"name": "trajectory", "description": "Compute wind trajectories"},
        {"name": "wind", "description": "Sample wind at a single point"},
        {"name": "meta", "description": "Health and service metadata"},
    ],
)

# Browser UI (Vite / static host) calls this API cross-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def _om_error(status: int, reason: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": True, "reason": reason},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request, exc: RequestValidationError):
    parts = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err.get("loc", ()) if x != "query")
        msg = err.get("msg", "invalid")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return _om_error(400, "; ".join(parts) or "Invalid request")


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and detail.get("reason"):
        reason = str(detail["reason"])
    else:
        reason = str(detail)
    return _om_error(exc.status_code, reason)


@app.get("/health", tags=["meta"])
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "api_base": config.API_BASE,
        "om_root": str(config.OM_ROOT) if config.OM_ROOT else None,
        "backend": config.BACKEND,
        "models": sorted(config.MODELS),
    }


def _parse_csv_floats(raw: str | None, *, name: str) -> list[float] | None:
    if raw is None or not str(raw).strip():
        return None
    out: list[float] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            val = float(part)
        except ValueError as exc:
            raise ValueError(f"Invalid {name} value: {part!r}") from exc
        if not math.isfinite(val):
            raise ValueError(f"Invalid {name} value: {part!r}")
        out.append(val)
    return out or None


def _parse_csv_methods(raw: str | None) -> list[str] | None:
    if raw is None or not str(raw).strip():
        return None
    allowed = {m["key"] for m in config.METHODS}
    out: list[str] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        if part not in allowed:
            raise ValueError(
                f"Invalid vertical_motion: {part!r} "
                f"(allowed: {', '.join(sorted(allowed))})"
            )
        out.append(part)
    return out or None


def _parse_csv_models(raw: str | None) -> list[str]:
    if raw is None or not str(raw).strip():
        raise ValueError("Parameter models is required")
    allowed = set(config.MODELS)
    out: list[str] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        if part not in allowed:
            raise ValueError(
                f"Unknown model: {part!r} (allowed: {', '.join(sorted(allowed))})"
            )
        if part not in out:
            out.append(part)
    if not out:
        raise ValueError("Parameter models is required")
    return out


def _resolve_time(time: str | None, timeformat: str) -> str | float:
    if time is None or not str(time).strip():
        raise ValueError("Parameter time is required")
    raw = str(time).strip()
    if timeformat == "unixtime":
        try:
            val = float(raw)
        except ValueError as exc:
            raise ValueError(f"Invalid unix time: {raw!r}") from exc
        if not math.isfinite(val):
            raise ValueError(f"Invalid unix time: {raw!r}")
        return val
    # iso8601 — normalize; compute_trajectories accepts ISO strings
    try:
        s = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except ValueError as exc:
        raise ValueError(f"Invalid ISO8601 time: {raw!r}") from exc


@app.get(
    "/v1/trajectory",
    tags=["trajectory"],
    summary="Compute wind trajectories",
    response_description="GeoJSON FeatureCollection",
    responses={
        200: {
            "description": "GeoJSON FeatureCollection with LineString tracks and Point markers",
            "content": {
                "application/json": {
                    "example": {
                        "type": "FeatureCollection",
                        "features": [],
                    }
                }
            },
        },
        400: {
            "description": "Open-Meteo-style error",
            "content": {
                "application/json": {
                    "example": {"error": True, "reason": "Unknown model: foo"}
                }
            },
        },
    },
)
def trajectory(
    latitude: float = Query(..., description="WGS84 latitude (°)", ge=-90, le=90),
    longitude: float = Query(..., description="WGS84 longitude (°)", ge=-180, le=180),
    models: MODELS = Query(
        "icon_eu",
        description="Open-Meteo model id (single model in v1)",
    ),
    time: str = Query(
        ...,
        description="Start time: ISO-8601 (default) or unix seconds when timeformat=unixtime",
    ),
    timeformat: TIMEFORMAT = Query(
        "iso8601",
        description="How to interpret `time` (Open-Meteo-style)",
    ),
    forecast_hours: float = Query(
        12,
        ge=1,
        le=72,
        description="Trajectory duration in hours (1–72)",
    ),
    height_agl: str | None = Query(
        None,
        description="Comma-separated start heights in metres AGL (default 500,1500,3000)",
        examples=["500,1500,3000"],
    ),
    height_amsl: str | None = Query(
        None,
        description="Comma-separated start heights in metres AMSL (mutually exclusive with height_agl)",
    ),
    vertical_motion: str | None = Query(
        "height",
        description="Comma-separated methods: height,pressure,theta,z3d",
        examples=["height"],
    ),
    direction: DIRECTION = Query("forward"),
    marker_interval: float = Query(
        60,
        ge=1,
        description="Marker interval in minutes (level-flight segments when using a profile)",
    ),
    marker_interval_climbing: float = Query(
        10,
        ge=1,
        description="Marker interval in minutes on climb/descent profile segments (default 10)",
    ),
    profile_time: str | None = Query(
        None,
        description=(
            "Flight profile times in seconds from `time` (CSV). "
            "Requires profile_height; exclusive with height_agl/height_amsl"
        ),
        examples=["0,1200,3600,5400,7200"],
    ),
    profile_height: str | None = Query(
        None,
        description="Flight profile heights in metres AGL (CSV, same length as profile_time)",
        examples=["150,150,1800,1800,400"],
    ),
    clearance_m: float = Query(
        0,
        ge=0,
        description="Stop when AGL falls below this clearance (m); default 0",
    ),
    met_extras: bool = Query(
        False,
        description="Include T/Td/RH/p on marker points",
    ),
    backend: BACKEND | None = Query(
        None,
        description="Wind data source override (default: server auto/om/http config)",
    ),
    format: FORMAT = Query(
        "geojson",
        description="Response format (only geojson in v1)",
    ),
) -> dict[str, Any]:
    if format != "geojson":
        return _om_error(400, f"Unsupported format: {format}")

    if height_agl and height_amsl:
        return _om_error(400, "Specify only one of height_agl or height_amsl")

    has_profile_t = profile_time is not None and str(profile_time).strip() != ""
    has_profile_h = profile_height is not None and str(profile_height).strip() != ""
    if has_profile_t != has_profile_h:
        return _om_error(400, "Specify both profile_time and profile_height")
    if has_profile_t and (height_agl or height_amsl):
        return _om_error(
            400,
            "flight profile is mutually exclusive with height_agl and height_amsl",
        )

    try:
        t0 = _resolve_time(time, timeformat)
        profile = None
        if has_profile_t:
            times = _parse_csv_floats(profile_time, name="profile_time")
            heights_p = _parse_csv_floats(profile_height, name="profile_height")
            if times is None or heights_p is None:
                raise ValueError("profile_time and profile_height are required")
            profile = parse_flight_profile(times, heights_p)
            heights = None
            height_ref = "agl"
            methods = _parse_csv_methods(vertical_motion)
            if methods is None:
                methods = ["height"]
            if methods != ["height"]:
                raise ValueError("flight profile only supports vertical_motion=height")
        else:
            if height_amsl:
                heights = _parse_csv_floats(height_amsl, name="height_amsl")
                height_ref = "amsl"
            else:
                heights = _parse_csv_floats(height_agl, name="height_agl")
                height_ref = "agl"
            methods = _parse_csv_methods(vertical_motion)
    except ValueError as exc:
        return _om_error(400, str(exc))

    key = cache_key(
        model=models,
        lat=latitude,
        lon=longitude,
        time=t0,
        duration=forecast_hours,
        heights=heights,
        methods=methods,
        height_ref=height_ref,
        direction=direction,
        marker=marker_interval,
        met_extras=met_extras,
        backend=backend,
        profile=profile,
        marker_climb=marker_interval_climbing if profile else None,
        clearance_m=clearance_m if profile else 0.0,
    )
    cache = get_response_cache()
    cached = cache.get(key)
    if cached is not None:
        return cached

    try:
        result = compute_trajectories(
            lat=latitude,
            lon=longitude,
            time=t0,
            model=models,
            duration_h=forecast_hours,
            heights=heights,
            methods=methods,
            height_ref=height_ref,
            direction=direction,
            marker_interval_min=marker_interval,
            met_extras=met_extras,
            backend=backend,
            height_profile=profile,
            marker_interval_climbing_min=marker_interval_climbing,
            clearance_m=clearance_m,
        )
    except ValueError as exc:
        return _om_error(400, str(exc))
    except RuntimeError as exc:
        return _om_error(500, str(exc))
    except Exception as exc:  # noqa: BLE001 — surface as OM error
        return _om_error(500, f"Internal error: {exc}")

    cache.put(key, result)
    return result


@app.get(
    "/v1/wind",
    tags=["wind"],
    summary="Sample wind at a point",
    response_description="Flat JSON with per-model wind components",
    responses={
        200: {
            "description": "Point wind sample (partial model failures allowed)",
            "content": {
                "application/json": {
                    "example": {
                        "latitude": 40.126,
                        "longitude": 16.419,
                        "time": "2026-08-03T08:00:00.000Z",
                        "height_reference": "agl",
                        "height_m": 550,
                        "models": [
                            {
                                "model": "icon_eu",
                                "wind_u_ms": 1.2,
                                "wind_v_ms": -1.5,
                                "wind_w_ms": 0.02,
                                "wind_speed_ms": 1.92,
                                "wind_speed_kmh": 6.9,
                                "wind_direction_deg": 321,
                                "z_amsl_m": 858,
                                "terrain_m": 308,
                            }
                        ],
                    }
                }
            },
        },
        400: {
            "description": "Open-Meteo-style error",
            "content": {
                "application/json": {
                    "example": {"error": True, "reason": "Specify only one of height_agl or height_amsl"}
                }
            },
        },
    },
)
def wind(
    latitude: float = Query(..., description="WGS84 latitude (°)", ge=-90, le=90),
    longitude: float = Query(..., description="WGS84 longitude (°)", ge=-180, le=180),
    models: str = Query(
        "icon_eu",
        description="Comma-separated Open-Meteo model ids (icon_d2, icon_eu)",
        examples=["icon_eu", "icon_eu,icon_d2"],
    ),
    time: str = Query(
        ...,
        description="Sample time: ISO-8601 (default) or unix seconds when timeformat=unixtime",
    ),
    timeformat: TIMEFORMAT = Query(
        "iso8601",
        description="How to interpret `time` (Open-Meteo-style)",
    ),
    height_agl: float | None = Query(
        None,
        description="Height in metres AGL (mutually exclusive with height_amsl)",
        examples=[550],
    ),
    height_amsl: float | None = Query(
        None,
        description="Height in metres AMSL (mutually exclusive with height_agl)",
    ),
    backend: BACKEND | None = Query(
        None,
        description="Wind data source override (default: server auto/om/http config)",
    ),
    format: WIND_FORMAT = Query(
        "json",
        description="Response format (only json in v1)",
    ),
) -> dict[str, Any]:
    if format != "json":
        return _om_error(400, f"Unsupported format: {format}")

    if height_agl is not None and height_amsl is not None:
        return _om_error(400, "Specify only one of height_agl or height_amsl")
    if height_agl is None and height_amsl is None:
        return _om_error(400, "Specify height_agl or height_amsl")

    try:
        t0 = _resolve_time(time, timeformat)
        model_list = _parse_csv_models(models)
    except ValueError as exc:
        return _om_error(400, str(exc))

    if height_amsl is not None:
        height_m = float(height_amsl)
        height_ref = "amsl"
    else:
        height_m = float(height_agl)
        height_ref = "agl"

    key = wind_cache_key(
        models=model_list,
        lat=latitude,
        lon=longitude,
        time=t0,
        height_m=height_m,
        height_ref=height_ref,
        backend=backend,
    )
    cache = get_response_cache()
    cached = cache.get(key)
    if cached is not None:
        return cached

    try:
        result = compute_point_wind(
            lat=latitude,
            lon=longitude,
            time=t0,
            models=model_list,
            height_m=height_m,
            height_ref=height_ref,
            backend=backend,
        )
    except ValueError as exc:
        return _om_error(400, str(exc))
    except RuntimeError as exc:
        return _om_error(500, str(exc))
    except Exception as exc:  # noqa: BLE001 — surface as OM error
        return _om_error(500, f"Internal error: {exc}")

    cache.put(key, result)
    return result
