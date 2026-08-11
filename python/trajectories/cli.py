"""CLI entry point: trajectories → GeoJSON."""

from __future__ import annotations

import argparse
import json
import sys

from . import config
from .compute import compute_trajectories


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="trajectories",
        description="Compute ICON wind trajectories (Open-Meteo) and emit GeoJSON.",
    )
    p.add_argument("--lat", type=float, required=True, help="Latitude (°)")
    p.add_argument("--lon", type=float, required=True, help="Longitude (°)")
    p.add_argument(
        "--time",
        required=True,
        help="Start time UTC (ISO-8601, e.g. 2026-07-23T05:00:00Z)",
    )
    p.add_argument(
        "--model",
        choices=sorted(config.MODELS),
        default="icon_eu",
        help="Forecast model (default: icon_eu)",
    )
    p.add_argument("--duration", type=float, default=12, help="Duration hours (1–72)")
    p.add_argument(
        "--height",
        type=float,
        action="append",
        dest="heights",
        help="Start height metres (repeatable; default 500 1500 3000)",
    )
    p.add_argument(
        "--method",
        action="append",
        dest="methods",
        choices=[m["key"] for m in config.METHODS],
        help="Vertical method (repeatable; default: height)",
    )
    p.add_argument(
        "--height-ref",
        choices=("agl", "amsl"),
        default="agl",
        help="Height reference for --height (default: agl)",
    )
    p.add_argument(
        "--direction",
        choices=("forward", "backward"),
        default="forward",
    )
    p.add_argument(
        "--marker-interval",
        type=float,
        default=60,
        metavar="MIN",
        help="Marker interval in minutes (default: 60)",
    )
    p.add_argument(
        "--met-extras",
        action="store_true",
        help="Include T/Td/RH/p on marker points",
    )
    p.add_argument(
        "--api-base",
        default=None,
        help=f"Open-Meteo base URL (default: {config.API_BASE})",
    )
    p.add_argument(
        "--om-root",
        default=None,
        help="Local Open-Meteo data root (default: TRAJECTORIES_OM_ROOT or /open-meteo)",
    )
    p.add_argument(
        "--backend",
        choices=("auto", "om", "http"),
        default=None,
        help="Wind data source: auto (local OM preferred), om, or http",
    )
    p.add_argument(
        "-o",
        "--output",
        default=None,
        help="Write GeoJSON to file (default: stdout)",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        gj = compute_trajectories(
            lat=args.lat,
            lon=args.lon,
            time=args.time,
            model=args.model,
            duration_h=args.duration,
            heights=args.heights,
            methods=args.methods,
            height_ref=args.height_ref,
            direction=args.direction,
            marker_interval_min=args.marker_interval,
            met_extras=args.met_extras,
            api_base=args.api_base,
            om_root=args.om_root,
            backend=args.backend,
        )
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    text = json.dumps(gj, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
            f.write("\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
