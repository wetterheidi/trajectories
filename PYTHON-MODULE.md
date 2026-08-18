# Python trajectories module

Port of the web app compute pipeline to an installable Python package + CLI.
Same inputs → same GeoJSON trajectories (Petterssen integration over Open-Meteo ICON fields).

## Goals

- Functional parity with the browser app (`src/windfield.js`, `src/integrator.js`, `src/app.js` export).
- Library API (`compute_trajectories`, `compute_point_wind`), CLI (`trajectories`), and HTTP API (`GET /v1/trajectory`, `GET /v1/wind`).
- GeoJSON FeatureCollection with SimpleStyle (`stroke` / `marker-color`) for Placemark tools.
- Trajectory features include `properties.terrain_m` (model orography m AMSL, parallel to coordinates) for Querschnitt / 3D after API fetch.
- Tests that prove the port: unit (offline), near-exact vs web UI, rough vs Windy.

## Layout

```text
deploy/
  trajectories-api.service      # systemd (user openmeteo-api, :8010)
  Caddyfile.trajectory.snippet  # trajectory.mah.priv.at → reverse_proxy
  trajectories-api.env.example
  README.md                     # install checklist
python/
  pyproject.toml          # package trajectories, CLI entry, pytest markers
  README.md               # install / CLI / API / test recipes
  examples/
    basic_trajectory.py   # library smoke
    api_trajectory.py     # HTTP client (default https://trajectory.mah.priv.at)
    api_point_wind.py     # GET /v1/wind client
    api_flight_profile.py # GET /v1/trajectory with AGL profile
  trajectories/
    config.py             # models, methods, API/OM backend resolution
    windfield.py          # HTTP or local OM client + 4-D interpolation
    om_backend.py         # omfiles reader + OmSlab preload / warm get_om_backend()
    integrator.py         # Petterssen + adaptive dt + markers
    compute.py            # height × method orchestration → FeatureCollection
    geojson_export.py     # port of web buildGeoJSON
    api.py                # FastAPI app (OpenAPI / Swagger)
    cli.py / __main__.py
  tests/
    test_integrator_unit.py   # fake-wind Petterssen (always on)
    test_backend_resolve.py   # OM/HTTP resolution (always on)
    test_api.py               # FastAPI TestClient (mocked compute)
    test_om_backend.py        # local OM smoke + OM↔HTTP (opt-in)
    test_web_python.py        # web download vs Python (opt-in)
    test_windy_visual.py      # Python vs Windy paths (opt-in)
    web_driver.py             # Vite + Playwright → #download GeoJSON
    windy_driver.py           # Playwright → Windy Wind trajectories API → GPX
    compare_metrics.py        # pairing + haversine / along-track metrics
```

Default API: `https://open-meteo.mah.priv.at` (`TRAJECTORIES_API_BASE` / `--api-base`).
`httpx` uses `trust_env=False` so system proxies do not 403 the private host.

## Design choices (locked)

| Topic | Choice |
|--------|--------|
| Shape | Installable package + library + CLI + FastAPI under `python/` |
| Fidelity | 1:1 JS port (pure Python floats + httpx) |
| Methods | Full set: `height`, `pressure`, `theta`, `z3d` |
| Series | Multi-height × multi-method Cartesian product |
| I/O | stdout GeoJSON; optional `--output`; HTTP returns bare GeoJSON |
| HTTP | Open-Meteo-style query names; OM-style `{"error","reason"}` errors |
| Met extras | `--met-extras` / `met_extras` off by default |

## Install & run

```bash
python3 -m venv python/.venv
source python/.venv/bin/activate
pip install -e "python/[dev]"   # omfiles + FastAPI/uvicorn + test deps
playwright install chromium   # for opt-in visual tests
npm install                   # Vite — web↔Python compare only

# Standalone library example (AGL ≤3 km, 10 min markers, met extras):
python python/examples/basic_trajectory.py

# HTTP client example (default base: https://trajectory.mah.priv.at):
python python/examples/api_trajectory.py
python python/examples/api_point_wind.py
# local: TRAJECTORIES_API_URL=http://127.0.0.1:8010 python python/examples/api_trajectory.py

trajectories \
  --lat 47.23 --lon 15.82 \
  --time 2026-08-02T11:00:00Z \
  --model icon_d2 \
  --duration 2 \
  --height 500 --height 1500 --height 3000 \
  --method height \
  -o out.geojson
```

### Local OM files (preferred when present)

When `/open-meteo` (or `TRAJECTORIES_OM_ROOT`) contains `dwd_icon_d2` / `dwd_icon_eu` and `omfiles` is installed, the Python package reads wind fields from local `.om` chunks instead of HTTP (`--backend auto`). Force with `--backend om` / `--backend http`.

- AGL heights derived from `static/hhl.om` − `HSURF.om` (no `height_agl_*` on disk).
- Horizontal wind already m/s (HTTP path still converts km/h).
- `--met-extras`: RH and dewpoint derived from specific humidity **q**+`p`+`T` (Magnus); no model `relative_humidity_level*` fetch.
- Fidelity vs HTTP: same physics, not bit-identical (`RUN_OM_TESTS=1`).
- I/O strategy: **per-request OM slab preload** (padded bbox × tight time × height-band levels into RAM; `wind_at` served from the slab). Process-warmed `OmBackend` meta/grid via `get_om_backend()`. Keep-open `OmReaderCache` (mmap + per-path mutex + inotify invalidation). Outside-slab corners fall back to point-fetch.

### Timing — `basic_trajectory` inputs (2026-08-02)

Stubenberg `47.23, 15.82`; ICON-D2; start `2026-08-02T11:00:00Z`; 2 h; heights 500/1500/3000 m AGL; markers 10 min; `met_extras=True`. Wall time for `compute_trajectories` only (GeoJSON dump omitted); response cache **off** (`TRAJECTORIES_CACHE_MAX=0`):

| Backend | Before slab | Slab (early) | Reader cache + Numba (2026-08-02) |
|---------|-------------|--------------|-------------------------------------|
| `om`    | **47.7 s**  | ~8.6 s cold / ~5.9 s warm | **~1.9 s cold / ~0.92 s warm** |
| `http`  | **8.9 s**   | ~9.0 s       | (unchanged) |

Success bar for unique warm requests: **≤ ~1 s** (cache miss / disabled). Benchmark:

```bash
cd python
TRAJECTORIES_CACHE_MAX=0 TRAJECTORIES_BACKEND=om \
  python benchmarks/bench_om_strategies.py --repeats 3
```

Opt-in fidelity (`RUN_OM_TESTS=1`): same-physics vs HTTP with widened bound (**median &lt; 6 km**, **max &lt; 18 km**) to allow float32 slabs + Numba interp.

## HTTP API (`GET /v1/trajectory`)

Open-Meteo taxonomy for queries; response is the same GeoJSON FeatureCollection as the library/CLI.

| Query | Role |
|-------|------|
| `latitude`, `longitude` | start point |
| `models` | `icon_d2` \| `icon_eu` |
| `time` + `timeformat` | ISO-8601 (default) or `unixtime` |
| `forecast_hours` | duration 1–72 h |
| `height_agl` / `height_amsl` | comma-separated metres |
| `vertical_motion` | comma-list of methods |
| `direction`, `marker_interval`, `met_extras`, `backend` | as CLI |
| `profile_time` + `profile_height` | kinematic AGL flight profile (CSV seconds / m AGL); exclusive with `height_*` |
| `marker_interval_climbing` | denser markers on climb/descent (minutes, default 10) |
| `clearance_m` | stop when AGL &lt; clearance (default 0) |

Duration with a profile is `min(forecast_hours, last_profile_time/3600)`. One profile → one track. Browser UI is not wired yet.

```bash
curl -sG 'https://trajectory.mah.priv.at/v1/trajectory' \
  --data-urlencode 'latitude=48.4375' \
  --data-urlencode 'longitude=15.6181' \
  --data-urlencode 'models=icon_eu' \
  --data-urlencode 'time=2026-08-02T11:00:00Z' \
  --data-urlencode 'forecast_hours=2' \
  --data-urlencode 'profile_time=0,1200,3600,5400,7200' \
  --data-urlencode 'profile_height=150,150,1800,1800,400' \
  --data-urlencode 'marker_interval=60' \
  --data-urlencode 'marker_interval_climbing=10'
# or: python python/examples/api_flight_profile.py
```

```bash
uvicorn trajectories.api:app --host 127.0.0.1 --port 8000
# Swagger: /docs   ReDoc: /redoc   Health: /health
pytest python/tests/test_api.py
```

## HTTP API (`GET /v1/wind`)

Single-point wind sample (flat JSON, not GeoJSON). No trajectory integration.

| Query | Role |
|-------|------|
| `latitude`, `longitude` | sample point |
| `models` | CSV: `icon_d2`, `icon_eu` |
| `time` + `timeformat` | ISO-8601 (default) or `unixtime` |
| `height_agl` XOR `height_amsl` | single height (metres) |
| `backend`, `format=json` | optional |

Response: top-level lat/lon/time/height plus `models[]` with `wind_u_ms`, `wind_v_ms`, `wind_w_ms` (null if unavailable), speeds, met “from” direction, `z_amsl_m`, `terrain_m`. Multi-model requests may return per-model `{error, reason}` entries (HTTP 200) when at least one model succeeds.

```bash
curl -sG 'https://trajectory.mah.priv.at/v1/wind' \
  --data-urlencode 'latitude=47.23' \
  --data-urlencode 'longitude=15.82' \
  --data-urlencode 'models=icon_eu,icon_d2' \
  --data-urlencode 'time=2026-08-02T11:00:00Z' \
  --data-urlencode 'height_agl=550'
```

### Production on this VPS (`trajectory.mah.priv.at`)

Artifacts under [`deploy/`](deploy/) (full steps also in [`deploy/README.md`](deploy/README.md)):

| File | Role |
|------|------|
| `trajectories-api.service` | systemd — uvicorn as user **`openmeteo-api`**, bind `127.0.0.1:8010` |
| `Caddyfile.trajectory.snippet` | Caddy site block → reverse_proxy + log |
| `trajectories-api.env.example` | optional `/etc/default/trajectories-api.env` |

**Prereqs on the host**

1. Editable install with API + OM extras in `python/.venv` (service `ExecStart` uses that venv).
2. `/home/mah` is mode `700` — grant traverse for the service user:
   ```bash
   sudo setfacl -m u:openmeteo-api:--x /home/mah
   ```
3. OM data readable at `/open-meteo` (already used by Open-Meteo).

**systemd**

```bash
sudo cp deploy/trajectories-api.service /etc/systemd/system/
sudo cp deploy/trajectories-api.env.example /etc/default/trajectories-api.env   # optional
sudo systemctl daemon-reload
sudo systemctl enable --now trajectories-api.service
curl -sS http://127.0.0.1:8010/health
```

Env defaults in the unit: `TRAJECTORIES_OM_ROOT=/open-meteo`, `TRAJECTORIES_BACKEND=auto`.

**Caddy** — append [`deploy/Caddyfile.trajectory.snippet`](deploy/Caddyfile.trajectory.snippet) to `/etc/caddy/Caddyfile`, then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Public URLs:** `https://trajectory.mah.priv.at/docs`, `/health`, `/v1/trajectory`, `/v1/wind`.  
Client example defaults to that host (`TRAJECTORIES_API_URL`).

## Accelerating answer processing

**Shipped (OM backend):**

1. **Slab / bbox preload** — padded window × height bands; `request` from RAM; process **slab LRU** for identical warm requests.
2. **`OmReaderCache`** — keep-open local mmap readers, **per-path mutex**, parallel var loads, **inotify** (watchdog) invalidation on cached paths only; in-flight `load_slab` **retries** on stale.
3. **Parallel height×method tracks** — `ThreadPoolExecutor` after slab load; `WindField` point-cache lock.
4. **Numba height-path interp** — optional `pip install 'trajectories[accel]'` (`interp_fast.py`); Python fallback if numba missing.
5. **API response cache** (bonus) — `TRAJECTORIES_CACHE_TTL_S` / `TRAJECTORIES_CACHE_MAX` (0 disables); not counted toward the ≤1 s unique-latency bar.

Install for production OM+API: `pip install -e "python/[om,api,accel]"`.

## Test strategies


### 1. Unit — integrator (always on)

**File:** `python/tests/test_integrator_unit.py`  
**What:** Synthetic homogeneous / rotational wind fields; no network.  
**Covers:** forward drift, backward inversion, closed rotation, stop-on-data-end, z3d height integration.  
**Port of:** `test/integrator.test.mjs`.

```bash
pytest python/tests/test_integrator_unit.py
pytest python/tests/test_backend_resolve.py
pytest python/tests/test_api.py
```

**Result:** integrator 5/5; backend resolve 8/8; API TestClient (mocked) covered in `test_api.py`.

### 2. Local OM vs HTTP — same physics (opt-in)

**File:** `python/tests/test_om_backend.py` (`@pytest.mark.om`)  
**Gate:** `RUN_OM_TESTS=1`  
**Needs:** `omfiles`, readable `{OM_ROOT}/dwd_icon_*`, and HTTP API for the compare leg.

**Matrix:** Stubenberg; 2 h; heights `[500, 1500, 3000]`; method `height`; models `icon_d2` + `icon_eu`.

```bash
RUN_OM_TESTS=1 pytest python/tests/test_om_backend.py -m om
```

**Result (2026-08-02):** **4/4 passed** (smoke + OM↔HTTP compare). Loose bounds: median &lt; 5 km, max &lt; 15 km. Artifacts `python/tests/artifacts/om_*.geojson`, `http_*.geojson`.

### 3. Near-exact — web app vs Python (opt-in)

**File:** `python/tests/test_web_python.py` (`@pytest.mark.web_py`)  
**Gate:** `RUN_WEB_PY_TESTS=1`  
**Why:** Primary fidelity check — same Open-Meteo source, same algorithm; UI export path must match CLI/library.

**Flow:**

1. Spawn Vite on repo root.
2. Playwright seeds `localStorage`, opens app, clicks **Trajektorien berechnen**, downloads GeoJSON via `#download`.
3. Python `compute_trajectories` with the **web export’s** `start_time` (web is clock source of truth).
4. Pair LineStrings by `(start_height_m, vertical_motion)`; sample every 10 min for 0…120 min; assert max haversine ≤ **50 m** and matching `status`.

**Matrix:** Stubenberg `47.23, 15.82`; heights `[500, 1500, 3000]` m AGL; method `height`; duration 2 h forward; models `icon_eu` + `icon_d2`. Markers out of scope for v1.

```bash
RUN_WEB_PY_TESTS=1 pytest python/tests/test_web_python.py -m web_py
# headed: WEB_PY_HEADED=1 …
```

**Result (2026-08-02 run):** **2/2 passed.** Max separation **0 m** on all three height pairs for both ICON-EU and ICON-D2 (sampled times). Artifacts under `python/tests/artifacts/` (`web_*.geojson`, `py_*.geojson`, `web-py-compare-map.html`).

### 4. Rough visual — Python vs Windy (opt-in)

**File:** `python/tests/test_windy_visual.py` (`@pytest.mark.windy`)  
**Gate:** `RUN_WINDY_TESTS=1`  
**Why:** External sanity check against Windy’s built-in trajectories (different vertical surfaces / integrator — not bit-identical).

**Flow:**

1. Python computes constant-height AGL tracks.
2. Playwright: wind layer → model → right-click → **Wind trajectories**; capture `node.windy.com/rplanner/v1/trajectory/paths`; convert to GPX.
3. Pair by nominal height (Windy checkboxes → pressure levels 950h/850h/700h ≈ 500/1500/3000 m).
4. Assert median separation &lt; **80 km**, max &lt; **200 km**.

```bash
RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy
# headed: WINDY_HEADED=1 …
```

**Result (Stubenberg, 2 h):** **2/2 passed.** Example separations: ICON-EU median ~8 km / max ~51 km; ICON-D2 median ~2 km / max ~58 km (850h / 1500 m pair is the outlier — expected when pressure ≠ constant AGL).

## Compare tooling

| Piece | Role |
|--------|------|
| `compare_metrics.py` | Parse mine GeoJSON / Windy GPX; `pair_tracks` / `pair_tracks_by_key`; `median_separation_km`; `max_separation_m` |
| `tools/compare-trajectories.html` | Manual map drop (mine GeoJSON + Windy GPX) |
| Artifacts | `python/tests/artifacts/` — GeoJSON/GPX dumps, Leaflet maps (`web-py-compare-map.html`, `compare-map.html`) |

## Status

- Package usable as CLI/library/HTTP; GeoJSON matches web export shape (including SimpleStyle).
- FastAPI `GET /v1/trajectory` with Swagger at `/docs` (`pip install -e "python/[api]"`).
- VPS: systemd unit as `openmeteo-api` on `:8010`; Caddy sketch for `trajectory.mah.priv.at`.
- Dual backend: local OM preferred when `/open-meteo` + `omfiles` available; HTTP fallback.
- Port fidelity vs web (HTTP path): **confirmed near-exact** (0 m on sampled points for the smoke matrix).
- OM vs HTTP: same-physics opt-in tests pass; **OM slab ≤ HTTP** on `basic_trajectory` (~8.6 s cold / ~5.9 s warm vs ~9.0 s).
- Acceleration shipped: OM slab preload + warm meta, parallel tracks, response cache, Numba height interp.
- Windy: rough agreement only; useful for regression, not a bit-for-bit oracle.
- Generated compare dumps live under `python/tests/artifacts/` (not committed).
