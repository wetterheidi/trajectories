#!/usr/bin/env python3
"""
Benchmark local-OM trajectory strategies (manual; not in default pytest).

  cd python && TRAJECTORIES_CACHE_MAX=0 python benchmarks/bench_om_strategies.py

Success metric: warm unique-request wall time (cache off), Stubenberg smoke case.
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Allow `python benchmarks/bench_om_strategies.py` from python/
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("TRAJECTORIES_CACHE_MAX", "0")
os.environ.setdefault("TRAJECTORIES_BACKEND", "om")

from trajectories.compute import compute_trajectories  # noqa: E402
from trajectories.om_backend import clear_om_backend_cache  # noqa: E402

# PYTHON-MODULE.md timing table inputs
SMOKE = dict(
    lat=47.23,
    lon=15.82,
    time="2026-08-02T11:00:00Z",
    model="icon_d2",
    duration_h=2,
    heights=[500.0, 1500.0, 3000.0],
    methods=["height"],
    height_ref="agl",
    marker_interval_min=10,
    met_extras=True,
    backend="om",
)


def _one(**overrides) -> float:
    kw = {**SMOKE, **overrides}
    t0 = time.perf_counter()
    compute_trajectories(**kw)
    return time.perf_counter() - t0


def _pct(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    s = sorted(xs)
    k = min(len(s) - 1, max(0, int(round((p / 100) * (len(s) - 1)))))
    return s[k]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--concurrent", type=int, default=0, help="N concurrent identical runs")
    ap.add_argument("--nearby", action="store_true", help="jitter lat/lon for concurrent")
    ap.add_argument("--repeats", type=int, default=1)
    args = ap.parse_args()

    print("backend=om cache_max=", os.environ.get("TRAJECTORIES_CACHE_MAX"))
    clear_om_backend_cache()

    cold = _one()
    print(f"cold_s={cold:.3f}")

    warms = [_one() for _ in range(max(1, args.repeats))]
    print(
        f"warm_s n={len(warms)} p50={_pct(warms, 50):.3f} "
        f"p95={_pct(warms, 95):.3f} mean={statistics.mean(warms):.3f}"
    )

    if args.concurrent > 0:
        def job(i: int) -> float:
            if args.nearby:
                return _one(lat=SMOKE["lat"] + 0.01 * (i % 5), lon=SMOKE["lon"] + 0.01 * (i % 3))
            return _one()

        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.concurrent) as pool:
            futs = [pool.submit(job, i) for i in range(args.concurrent)]
            xs = [f.result() for f in as_completed(futs)]
        wall = time.perf_counter() - t0
        print(
            f"concurrent n={args.concurrent} nearby={args.nearby} "
            f"wall_s={wall:.3f} per_req_p50={_pct(xs, 50):.3f} "
            f"req_per_s={args.concurrent / wall:.2f}"
        )

    target = 1.0
    warm_best = min(warms)
    status = "PASS" if warm_best <= target else "MISS"
    print(f"success_metric warm_unique<={target}s → {status} (best={warm_best:.3f})")
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
