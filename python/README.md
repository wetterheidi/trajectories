# trajectories (Python)

Installable port of the web app compute pipeline: Open-Meteo ICON-EU / ICON-D2
→ Petterssen trajectories → GeoJSON (SimpleStyle).

## Install

```bash
python3 -m venv python/.venv
source python/.venv/bin/activate
pip install -e "python/[dev]"
playwright install chromium   # for Windy / web↔Python visual tests
npm install                   # Vite — required for web↔Python compare
```

For local `.om` reads and/or the HTTP API (optional):

```bash
pip install -e "python/[om]"    # omfiles
pip install -e "python/[api]"   # FastAPI + uvicorn
# or: pip install -e "python/[dev]"  # includes om + api + test deps
```

## Data backends

| Mode | How |
|------|-----|
| `auto` (default) | Prefer local OM under `TRAJECTORIES_OM_ROOT` (default `/open-meteo` if present); else HTTP |
| `om` | Require local files + `omfiles` |
| `http` | Open-Meteo forecast API only |

```bash
# force HTTP even when /open-meteo exists
trajectories ... --backend http

# force local
trajectories ... --backend om --om-root /open-meteo
```

Env: `TRAJECTORIES_BACKEND`, `TRAJECTORIES_OM_ROOT` (empty string disables auto-detect), `TRAJECTORIES_API_BASE`.

**Note:** With `--met-extras`, marker dewpoint and relative humidity are derived from specific humidity **q**, pressure, and temperature (Magnus over water). Model `relative_humidity_level*` is not fetched (local OM trees do not provide it).

## CLI

```bash
trajectories \
  --lat 47.23 --lon 15.82 \
  --time 2026-07-23T05:00:00Z \
  --model icon_d2 \
  --duration 2 \
  --height 500 --height 1500 \
  --method height \
  --height-ref agl \
  -o out.geojson
```

Stdout by default. Override API with `--api-base` or `TRAJECTORIES_API_BASE`.

## Library

```python
from trajectories import compute_trajectories

gj = compute_trajectories(
    lat=47.23, lon=15.82,
    time="2026-07-23T05:00:00Z",
    model="icon_d2",
    duration_h=2,
    heights=[500, 1500],
    methods=["height"],
    backend="auto",  # or "om" / "http"
)
```

## HTTP API (FastAPI / OpenAPI)

Open-Meteo-shaped query params; response is a GeoJSON FeatureCollection.
Errors: `{"error": true, "reason": "..."}`.

```bash
pip install -e "python/[api]"
uvicorn trajectories.api:app --host 127.0.0.1 --port 8000
# Swagger try-it: http://127.0.0.1:8000/docs
# ReDoc:        http://127.0.0.1:8000/redoc
```

```bash
curl -sG 'http://127.0.0.1:8000/v1/trajectory' \
  --data-urlencode 'latitude=47.23' \
  --data-urlencode 'longitude=15.82' \
  --data-urlencode 'models=icon_d2' \
  --data-urlencode 'time=2026-08-02T11:00:00Z' \
  --data-urlencode 'forecast_hours=2' \
  --data-urlencode 'height_agl=500,1500,3000' \
  --data-urlencode 'vertical_motion=height' \
  --data-urlencode 'backend=http'
```

Client example (server must be running):

```bash
python python/examples/api_trajectory.py
# local uvicorn: TRAJECTORIES_API_URL=http://127.0.0.1:8010 python python/examples/api_trajectory.py
```

VPS deploy (systemd + Caddy sketch for `trajectory.mah.priv.at`): see [`deploy/README.md`](../deploy/README.md).

## Tests

```bash
pytest python/tests/test_integrator_unit.py
pytest python/tests/test_backend_resolve.py
pytest python/tests/test_api.py

# Local OM smoke + loose OM↔HTTP compare (needs /open-meteo + omfiles)
RUN_OM_TESTS=1 pytest python/tests/test_om_backend.py -m om

# Rough visual equivalence vs Windy built-in trajectories (ICON-D2 + ICON-EU).
# Driver: wind layer → model → right-click → "Wind trajectories" → capture API paths.
RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy
# Debug UI: WINDY_HEADED=1 RUN_WINDY_TESTS=1 pytest ... -m windy

# Near-exact web app GeoJSON download vs Python (≤50 m). Spawns Vite + Playwright.
RUN_WEB_PY_TESTS=1 pytest python/tests/test_web_python.py -m web_py
# Debug UI: WEB_PY_HEADED=1 RUN_WEB_PY_TESTS=1 pytest ... -m web_py
```
