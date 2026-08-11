"""
Playwright driver for the local Vite web app → GeoJSON download.

Flow:
  1. Serve repo root with Vite
  2. Seed localStorage (start, model, heights, methods, duration)
  3. Wait for meta + Run enabled → compute → download GeoJSON
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

REPO_ROOT = Path(__file__).resolve().parents[2]
SERIES_COLORS = [
    "#2a78d6", "#008300", "#e87ba4", "#eda100",
    "#1baf7a", "#eb6834", "#4a3aa7", "#e34948",
]


@dataclass
class WebRunSpec:
    lat: float
    lon: float
    model: str  # icon_eu | icon_d2
    duration_h: float = 2
    heights: list[float] = field(default_factory=lambda: [500.0, 1500.0, 3000.0])
    methods: list[str] = field(default_factory=lambda: ["height"])
    height_ref: str = "agl"
    direction: str = "forward"  # forward | backward


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _vite_bin() -> Path:
    local = REPO_ROOT / "node_modules" / ".bin" / "vite"
    if local.is_file():
        return local
    raise RuntimeError(
        f"Vite not found at {local}. Run `bun install` in the repo root."
    )


@contextmanager
def vite_server(*, host: str = "127.0.0.1", port: int | None = None) -> Iterator[str]:
    """Start Vite; yield base URL; kill on exit."""
    port = port or _free_port()
    base = f"http://{host}:{port}"
    cmd = [str(_vite_bin()), "--host", host, "--port", str(port), "--strictPort"]
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise RuntimeError(f"Vite exited early (code {proc.returncode}): {out}")
            try:
                with urllib.request.urlopen(base, timeout=1) as resp:
                    if resp.status < 500:
                        break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(0.25)
        else:
            proc.kill()
            raise RuntimeError(f"Vite did not become ready at {base}")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _settings_payload(spec: WebRunSpec) -> dict[str, Any]:
    heights = [
        {"m": int(round(h)), "color": SERIES_COLORS[i % len(SERIES_COLORS)]}
        for i, h in enumerate(spec.heights)
    ]
    direction = "1" if spec.direction in ("forward", "fwd", "1", 1, "+1") else "-1"
    return {
        "model": spec.model,
        "refmode": spec.height_ref,
        "markerIntervalSec": 3600,
        "duration": int(spec.duration_h),
        "direction": direction,
        "heights": heights,
        "activeHeight": heights[0]["m"] if heights else 500,
        "barMax": 6000,
        "start": {"lat": spec.lat, "lon": spec.lon},
        "view": {"center": {"lat": spec.lat, "lng": spec.lon}, "zoom": 9},
        "baseLayer": "OpenStreetMap",
        "units": {"height": "m", "wind": "kmh"},
        "liveMode": False,
        "methods": list(spec.methods),
        "metExtras": False,
    }


def fetch_web_geojson(
    spec: WebRunSpec,
    download_dir: Path,
    *,
    base_url: str,
    headless: bool = True,
) -> dict[str, Any]:
    """
    Drive the web UI and return the downloaded FeatureCollection.

    Also writes `web_{model}.geojson` under download_dir.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("playwright not installed; pip install -e 'python/[dev]'") from exc

    download_dir.mkdir(parents=True, exist_ok=True)
    settings = _settings_payload(spec)
    # Double-encode: JS string literal whose value is the JSON settings blob.
    init_js = (
        "localStorage.setItem("
        "'trajectories.settings.v1',"
        f"{json.dumps(json.dumps(settings))}"
        ");"
    )

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(accept_downloads=True)
        context.add_init_script(init_js)
        page = context.new_page()
        page.set_viewport_size({"width": 1400, "height": 900})
        page.goto(base_url + "/", wait_until="domcontentloaded", timeout=90_000)

        # Wait until meta loaded and start set → Run enabled
        page.wait_for_function(
            """() => {
              const run = document.querySelector('#run');
              return run && !run.disabled;
            }""",
            timeout=90_000,
        )

        # Ensure form matches spec (defensive — localStorage should already)
        page.select_option("#model", spec.model)
        page.fill("#duration", str(int(spec.duration_h)))
        page.select_option("#refmode", spec.height_ref)
        page.select_option("#direction", "1" if settings["direction"] == "1" else "-1")
        page.evaluate(
            """(methods) => {
              for (const c of document.querySelectorAll('#methodlist input')) {
                c.checked = methods.includes(c.value);
              }
            }""",
            list(spec.methods),
        )
        # Model change reloads meta — wait again
        page.wait_for_function(
            """() => {
              const run = document.querySelector('#run');
              return run && !run.disabled;
            }""",
            timeout=90_000,
        )
        page.wait_for_timeout(500)

        page.click("#run")
        page.wait_for_function(
            """() => {
              const dl = document.querySelector('#download');
              return dl && !dl.disabled;
            }""",
            timeout=180_000,
        )

        page.select_option("#downloadfmt", "geojson")
        with page.expect_download(timeout=30_000) as dl_info:
            page.click("#download")
        download = dl_info.value
        dest = download_dir / f"web_{spec.model}.geojson"
        download.save_as(str(dest))
        browser.close()

    data = json.loads(dest.read_text(encoding="utf-8"))
    if data.get("type") != "FeatureCollection":
        raise RuntimeError(f"Downloaded file is not a FeatureCollection: {dest}")
    return data


def headed_from_env() -> bool:
    return os.environ.get("WEB_PY_HEADED", "").strip() in ("1", "true", "yes")
