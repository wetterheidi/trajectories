"""
Playwright driver for Windy's built-in wind trajectories.

User flow:
  1. Wind layer
  2. Select model (ICON-EU / ICON-D2)
  3. Right-click map → "Wind trajectories"
  4. Capture GET node.windy.com/rplanner/v1/trajectory/paths → write GPX
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

# Our model key → Windy store product + UI label fragments
WINDY_MODELS = {
    "icon_eu": {
        "product": "iconEu",
        "labels": ["ICON-EU", "ICON-EU7km", "ICON EU"],
        "open_more": True,
    },
    "icon_d2": {
        "product": "iconD2",
        "labels": ["ICON-D2", "ICON-D22.2km", "ICON D2"],
        "open_more": True,
    },
}


@dataclass
class WindyRunSpec:
    lat: float
    lon: float
    model: str  # icon_eu | icon_d2
    duration_h: float = 2
    # Optional UTC start (ms since epoch) — synced onto Windy's time slider
    start_ms: float | None = None
    # Windy altitude checkboxes (metres AGL-ish labels in the panel)
    level_labels: tuple[str, ...] = ("600m", "1,500m", "3,000m")


def windy_map_url(spec: WindyRunSpec) -> str:
    m = WINDY_MODELS[spec.model]["product"]
    return f"https://www.windy.com/{spec.lat}/{spec.lon}?{m},{spec.lat},{spec.lon},9"


def fetch_windy_gpx(spec: WindyRunSpec, download_dir: Path, *, headless: bool = True) -> Path:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("playwright not installed; pip install -e 'python/[dev]'") from exc

    download_dir.mkdir(parents=True, exist_ok=True)
    captured: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        page.set_viewport_size({"width": 1400, "height": 900})

        def on_response(resp):
            try:
                if "trajectory/paths" in resp.url and resp.status == 200:
                    captured.append(resp.json())
            except Exception:
                pass

        page.on("response", on_response)

        page.goto(windy_map_url(spec), wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(5000)
        _dismiss_consent(page)

        _ensure_wind_layer(page)
        _select_model(page, spec.model)
        if spec.start_ms is not None:
            page.evaluate(
                "(ms) => { try { W.store.set('timestamp', ms); } catch (e) {} }",
                int(spec.start_ms),
            )
            page.wait_for_timeout(500)
        page.wait_for_timeout(1000)

        _open_wind_trajectories(page, spec)
        _configure_levels(page, spec)
        _set_duration(page, spec)
        page.wait_for_timeout(2000)

        # Nudge picker / recompute: left-click map center
        page.mouse.click(800, 450, button="left")
        _wait_for_paths(captured, timeout_s=25)

        browser.close()

    if not captured:
        raise RuntimeError(
            "No Windy trajectory/paths response. "
            "Run with WINDY_HEADED=1 to inspect the Wind trajectories panel."
        )

    gpx_path = download_dir / f"windy_{spec.model}.gpx"
    gpx_path.write_text(paths_json_to_gpx(captured[-1], spec), encoding="utf-8")
    return gpx_path


def _dismiss_consent(page) -> None:
    page.evaluate(
        """() => {
          for (const b of document.querySelectorAll('button')) {
            const t = (b.innerText || '').toLowerCase();
            if (/accept|agree|understand|got it|ok|continue/.test(t)) b.click();
          }
        }"""
    )
    page.wait_for_timeout(400)


def _ensure_wind_layer(page) -> None:
    page.evaluate("() => { try { W.store.set('overlay', 'wind'); } catch (e) {} }")
    # Also click right-side Wind entry if present
    page.evaluate(
        """() => {
          const a = Array.from(document.querySelectorAll('a'))
            .find(el => (el.innerText || '').trim() === 'Wind');
          if (a) a.click();
        }"""
    )
    page.wait_for_timeout(600)


def _select_model(page, model: str) -> None:
    """Select ICON-EU / ICON-D2 via DOM .click() (Playwright visibility checks fail)."""
    cfg = WINDY_MODELS[model]
    product = cfg["product"]
    # Step 1: open model overflow ("7 more...") — NOT "More layers..."
    page.evaluate(
        """() => {
          const more = Array.from(document.querySelectorAll('a'))
            .find(a => /^\\d+\\s*more/i.test((a.innerText || '').trim()));
          if (more) more.click();
        }"""
    )
    page.wait_for_timeout(800)
    # Step 2: click regional ICON entry (prefer exact 7km / 2.2km labels)
    page.evaluate(
        """(product) => {
          const prefer = product === 'iconD2'
            ? [/ICON-D2\\s*2\\.2km/i, /ICON-D22\\.2km/i, /ICON-D2/i]
            : [/ICON-EU\\s*7km/i, /ICON-EU7km/i, /ICON-EU/i];
          const links = Array.from(document.querySelectorAll('a'));
          for (const re of prefer) {
            const el = links.find(a => re.test((a.innerText || '').replace(/\\s+/g, '')))
              || links.find(a => re.test((a.innerText || '').trim()));
            if (el) { el.click(); return el.innerText.trim(); }
          }
          return null;
        }""",
        product,
    )
    page.wait_for_timeout(1500)
    got = page.evaluate("() => W.store.get('product')")
    if got != product:
        raise RuntimeError(
            f"Could not select Windy model {product} (got {got!r}). "
            "Model switcher UI may have changed."
        )


def _open_wind_trajectories(page, spec: WindyRunSpec) -> None:
    """Right-click map → Wind trajectories (fallback: broadcast open)."""
    page.mouse.click(800, 450, button="right")
    page.wait_for_timeout(1000)

    if page.locator("a:has-text('Wind trajectories')").count() == 0:
        page.evaluate(
            """({lat, lon}) => {
              try { W.broadcast.fire('rqstOpen', 'contextmenu', {lat, lon}); } catch (e) {}
            }""",
            {"lat": spec.lat, "lon": spec.lon},
        )
        page.wait_for_timeout(800)

    # Avoid plugin panes intercepting the context-menu link
    page.evaluate(
        """() => {
          document.querySelectorAll('section.plugin__content').forEach(e => {
            const t = e.innerText || '';
            if (!t.includes('Wind trajectories')) e.style.pointerEvents = 'none';
          });
        }"""
    )

    loc = page.locator("a:has-text('Wind trajectories')")
    if loc.count():
        loc.first.click(force=True)
    else:
        page.evaluate("() => W.broadcast.fire('rqstOpen', 'wind-trajectories')")

    page.wait_for_timeout(2000)
    # Ensure picker at target
    page.evaluate(
        """({lat, lon}) => {
          try { W.broadcast.fire('rqstOpen', 'picker', {lat, lon}); } catch (e) {}
        }""",
        {"lat": spec.lat, "lon": spec.lon},
    )
    page.wait_for_timeout(1500)

    open_ = page.evaluate(
        "() => !!(W.plugins['wind-trajectories'] && W.plugins['wind-trajectories'].isOpen)"
    )
    if not open_:
        raise RuntimeError("Wind trajectories panel did not open")


def _configure_levels(page, spec: WindyRunSpec) -> None:
    panel = page.locator("#plugin-wind-trajectories")
    if panel.count() == 0:
        return
    # Expand More so 3,000m etc. are listed
    try:
        more = panel.locator("button.more, button:has-text('More')")
        if more.count() and "Less" not in (panel.inner_text() or ""):
            more.first.click(force=True)
            page.wait_for_timeout(400)
    except Exception:
        pass

    want = set(spec.level_labels)
    # Known checkbox labels in the panel
    all_labels = [
        "Surface", "100m", "600m", "750m", "900m", "1,500m", "2,000m", "3,000m",
        "4,200m", "5,500m", "7,000m", "9,000m", "10km", "11.7km", "13.5km",
    ]
    for level in all_labels:
        box = panel.locator(".checkbox", has_text=level).first
        try:
            if box.count() == 0:
                continue
            cls = box.get_attribute("class") or ""
            is_off = "checkbox--off" in cls
            should_on = level in want
            if should_on and is_off:
                box.click(force=True)
            elif (not should_on) and (not is_off):
                box.click(force=True)
            page.wait_for_timeout(150)
        except Exception:
            continue


def _set_duration(page, spec: WindyRunSpec) -> None:
    """Set duration hours via the panel range/number input when present."""
    page.evaluate(
        """(hours) => {
          const root = document.querySelector('#plugin-wind-trajectories');
          if (!root) return;
          const inp = root.querySelector('input[type=range], input[type=number]');
          if (!inp) return;
          const v = String(Math.max(1, Math.min(6, Math.round(hours))));
          inp.value = v;
          inp.dispatchEvent(new Event('input', {bubbles: true}));
          inp.dispatchEvent(new Event('change', {bubbles: true}));
        }""",
        spec.duration_h,
    )
    page.wait_for_timeout(800)


def _wait_for_paths(captured: list, timeout_s: float) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if captured and captured[-1].get("paths"):
            return
        time.sleep(0.4)


def paths_json_to_gpx(data: dict, spec: WindyRunSpec) -> str:
    """Convert Windy trajectory/paths JSON to GPX for compare_metrics."""
    paths = data.get("paths") or []
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="windy_driver">',
    ]
    for path in paths:
        level = str(path.get("level") or "?")
        # Derive a rough start height (m) from level token for pairing
        alt_m = _level_to_meters(level)
        name = escape(f"{level}")
        parts.append(f"<trk><name>{name}</name><level>{escape(level)}</level>")
        if alt_m is not None:
            parts.append(f"<alt_m>{alt_m}</alt_m>")
        parts.append("<trkseg>")
        for pt in path.get("path") or []:
            # [lat, lon, timeISO, distance_m]
            if len(pt) < 3:
                continue
            lat, lon, t = pt[0], pt[1], pt[2]
            parts.append(
                f'<trkpt lat="{lat}" lon="{lon}">'
                f"<time>{escape(str(t))}</time></trkpt>"
            )
        parts.append("</trkseg></trk>")
    parts.append("</gpx>")
    if len(paths) == 0:
        # keep file valid but empty of tracks — caller should fail pairing
        pass
    return "\n".join(parts)


# Windy's metre checkboxes resolve to pressure levels in the API; nominal
# AMSL heights for pairing with our constant-height runs (mid-Europe).
_PRESSURE_NOMINAL_M = {
    "surface": 10,
    "surf": 10,
    "1000h": 100,
    "950h": 500,
    "925h": 750,
    "900h": 1000,
    "850h": 1500,
    "800h": 2000,
    "700h": 3000,
    "600h": 4200,
    "500h": 5500,
    "400h": 7000,
    "300h": 9000,
    "250h": 10000,
    "200h": 11700,
    "150h": 13500,
}


def _level_to_meters(level: str) -> float | None:
    """Map Windy level id / label to metres for height pairing."""
    s = level.strip().lower().replace(",", "").replace(" ", "")
    if s in _PRESSURE_NOMINAL_M:
        return float(_PRESSURE_NOMINAL_M[s])
    if s.endswith("h") and s[:-1].replace(".", "", 1).isdigit():
        return float(_PRESSURE_NOMINAL_M.get(s, 0) or 0) or None
    if s.endswith("m"):
        try:
            return float(s[:-1])
        except ValueError:
            return None
    if s.endswith("km"):
        try:
            return float(s[:-2]) * 1000
        except ValueError:
            return None
    try:
        return float(s)
    except ValueError:
        return None


def model_heights_for_pressure_compare() -> list[float]:
    """Heights paired with Windy 950h / 850h / 700h (from 600m/1.5km/3km boxes)."""
    return [500, 1500, 3000]
