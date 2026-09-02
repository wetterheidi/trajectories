/**
 * Vertikalprofil der aktiven Trajektorie — Wetterparameter exakt auf
 * Trajektorienhöhe statt am Boden oder auf festem Modelllevel. Ersetzt die
 * frühere Small-Multiples-Ansicht (`crosssection.js`, gestapelt für ALLE
 * Läufe): zeigt nur EINEN Lauf (die aktive Höhe), dafür mit allen
 * Modellwerten, die an den Marken bereits höhenkonsistent vorliegen (s.
 * `python/trajectories/geojson_export.py`).
 *
 * Eine von zwei bewusst getrennten Stellen der App, die die Komponenten-
 * bibliothek `meteokit` anfassen (die andere ist `gramet.js`) — importiert
 * NICHT `<gramet-panel>` (der schwere Webkomponenten-Bundle bleibt GRAMETs
 * Lazy-Load vorbehalten), sondern nur die generischen, komponentenfreien
 * Bausteine `meteokit/windbarb`, `meteokit/wwsymbols` und `fetchTerrainProfile`/
 * `posOfPath` aus `meteokit/gramet`.
 *
 * Reines SVG + kleine DOM-Steuerelemente im Kopf, kein Web-Component-Shadow-
 * DOM — im Stil des bisherigen `crosssection.js`, das dieses Modul ersetzt.
 */

import { placeWindBarb, CHART_BARB_SIZE } from "meteokit/windbarb";
import { placeWxSymbol, wmoWeatherCodeToWx } from "meteokit/wwsymbols";
import { fetchTerrainProfile, posOfPath } from "meteokit/gramet";
import { fmtHeight, heightToDisplay, heightFromDisplay, heightUnit, fmtWind, unitState } from "./units.js";
import { waypointsFromRun } from "./pathgeo.js";
import * as cursorSync from "./cursorsync.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const KT_PER_MS = 1.94384;

const INK = "#0b0b0b";
const INK_MUTED = "#52514e";
const GRID = "#e8e7e3";
const TERRAIN_FILL = "#e3e1dc";      // Modellorographie
const TERRAIN_EDGE = "#9c9b95";
const TERRAIN_HI_FILL = "rgba(74,71,64,0.35)"; // Mapterhorn, dunkler Schatten
const TERRAIN_HI_EDGE = "#332f28";
const T_COLOR = "#c0492f";
const TD_COLOR = "#2f7dc9";
const SPREAD_FILL = "rgba(120,120,120,0.14)";
const WIND_FILL = "#cfe0f2";
const WIND_EDGE = "#3d6fa0";
const CLOUD_FILL = "#b7c9dc";
const CLOUD_EDGE = "#7e93ab";
const POS_FILL = "rgba(47,143,70,0.28)", POS_EDGE = "#2f8f46";   // steigend/Hebung
const NEG_FILL = "rgba(192,57,43,0.24)", NEG_EDGE = "#c0392b";   // fallend/Sinken

const STORAGE_KEY = "trajectories.altprofile.v1";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

// --- Modul-Zustand -----------------------------------------------------------
// Reicht aus, das komplette Panel aus dem letzten `update()`-Aufruf plus
// Kopfzeilen-Einstellungen (x-Achse, Δp/w-Override) neu zu zeichnen, ohne
// erneut zu fetchen (Resize, Achsen-/Override-Umschalten) — Muster wie
// `gramet.js`s Prefs, aber komplett modul-lokal statt an eine Komponente
// durchgereicht.
let lastData = null;
let lastWaypoints = null;
let lastPos = null;
let lastRunR = null;
let lastHiRes = null; // { pos, elevation, gaps } | null, s. fetchTerrainProfile
let cursorIndex = null; // Index in run.r.markers, oder null
let seq = 0;
const terrainCache = new WeakMap();

async function terrainFor(run, waypoints) {
  let entry = terrainCache.get(run.r);
  if (!entry) {
    entry = fetchTerrainProfile(waypoints);
    terrainCache.set(run.r, entry);
    entry.catch(() => terrainCache.delete(run.r));
  }
  return entry;
}

function el(id) {
  return document.getElementById(id);
}

export function isOpen() {
  const host = el("altprofile");
  return !!host && !host.hidden;
}

// --- Dock: Karte und Vertikalprofil gleichzeitig ----------------------------
// Identisches Muster zu `gramet.js`s Dock (s. dort für die ausführliche
// Begründung): angedockt schlägt das Panel unten an, die Karte bleibt darüber
// sichtbar und bedienbar; die Vollansicht ist die bisherige Anordnung über
// der ganzen Kartenfläche.

const DOCK_MIN_H = 220;
const DOCK_DEFAULT_H = 420;
let dockInit = false;

function shellEl() {
  return el("altprofile");
}

/** Aktuelle Anordnung auf die Hülle anwenden. `reason`: "open" (Panel wird
 *  gezeigt), "mode" (Umschaltung), "resize" (Ziehgriff losgelassen) --
 *  jeweils gefolgt von einem Re-Render, da die SVG-Maße (anders als bei
 *  GRAMETs Web Component) nicht von selbst auf die neue Größe reagieren. */
function applyDock({ docked, height }) {
  const shell = shellEl();
  shell.classList.toggle("docked", docked);
  shell.style.setProperty("--ap-dock-h", `${Math.round(height)}px`);
  const btn = el("altprofile-dockmode");
  btn.textContent = docked ? "⤢" : "⤡";
  btn.title = docked ? "Vollansicht (Karte verdecken)" : "Andocken (Karte darüber zeigen)";
  if (lastData) render();
}

function dockPrefs() {
  const p = loadPrefs();
  return {
    // Voreinstellung ist das Dock: die parallele Ansicht ist der Grund, warum
    // es sie gibt (gleiche Begründung wie GRAMET).
    docked: p.docked !== false,
    height: Number.isFinite(p.dockHeight) ? p.dockHeight : DOCK_DEFAULT_H,
  };
}

function clampDockHeight(h) {
  return Math.max(DOCK_MIN_H, Math.min(h, window.innerHeight - 60));
}

/** Dockleiste einmalig verdrahten (Umschaltknopf + Ziehgriff). */
function initDock() {
  if (dockInit) return;
  dockInit = true;
  const bar = el("altprofile-dockbar");
  const btn = el("altprofile-dockmode");

  btn.addEventListener("click", () => {
    const next = { docked: !shellEl().classList.contains("docked"), height: dockPrefs().height };
    savePrefs({ ...loadPrefs(), docked: next.docked, dockHeight: next.height });
    applyDock(next);
  });

  // Höhe ziehen. Die Hülle wächst nach oben (unten angeschlagen), also wird
  // die Zeigerbewegung negativ aufgerechnet. Während des Ziehens NICHT neu
  // rendern (teurer SVG-Rebuild pro Pixel wäre ruckelig) -- der Body scrollt
  // currently einfach mit; erst beim Loslassen ein sauberer Re-Render.
  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (!shellEl().classList.contains("docked")) return;
    if (e.target.closest("button")) return;
    drag = { y: e.clientY, h: shellEl().getBoundingClientRect().height };
    bar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const h = clampDockHeight(drag.h - (e.clientY - drag.y));
    shellEl().style.setProperty("--ap-dock-h", `${Math.round(h)}px`);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    if (bar.hasPointerCapture?.(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    const height = clampDockHeight(shellEl().getBoundingClientRect().height);
    savePrefs({ ...loadPrefs(), dockHeight: Math.round(height) });
    applyDock({ docked: true, height });
  };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);
}

export async function show(data) {
  const host = shellEl();
  initDock();
  host.hidden = false;
  // Erst sichtbar machen, dann die Anordnung anwenden: der Re-Render in
  // `applyDock()` braucht eine gültige Geometrie (`clientWidth`/`clientHeight`).
  applyDock(dockPrefs());
  await update(data);
}

// `update()` bleibt bewusst `async`-förmig (API-Parität mit `show()`/mit
// `gramet.js`), löst sein Promise aber sofort nach dem ersten (schnellen,
// synchronen) Render auf -- NICHT erst nach dem Mapterhorn-Abruf. Sonst
// bliebe app.js' "Lade Vertikalprofil …"-Status samt deaktiviertem Knopf für
// die gesamte, unter Umständen mehrere Sekunden lange Kachel-Ladezeit stehen,
// obwohl der Wetterinhalt (der eigentliche Zweck des Panels) längst fertig
// ist. Das Geländeprofil kommt fire-and-forget nach und löst nur einen
// weiteren `render()` aus (Muster wie GRAMETs `terrainDeferred`).
export async function update(data) {
  if (!data?.run) return;
  const my = ++seq;
  lastData = data;
  const { run, direction } = data;
  const waypoints = waypointsFromRun(run, direction);
  if (waypoints.length < 2) {
    cursorSync.clearPath();
    el("altprofile-body").textContent = "Diese Trajektorie hat zu wenige Punkte für einen Trajektorienverlauf.";
    return;
  }
  lastWaypoints = waypoints;
  lastPos = posOfPath(waypoints);
  // Cursor nur zurücksetzen, wenn wirklich ein anderer Lauf gezeigt wird --
  // ein Resize oder Kopfzeilen-Toggle ruft `update()` mit demselben `run.r`
  // erneut auf und soll die Fadenkreuz-Position nicht verlieren.
  if (run.r !== lastRunR) {
    lastRunR = run.r;
    cursorIndex = null;
    cursorSync.setPath({ run, waypoints, pos: lastPos });
  }
  lastHiRes = null;
  render();

  terrainFor(run, waypoints)
    .then((hiRes) => {
      if (my !== seq) return;
      lastHiRes = hiRes;
      render();
    })
    .catch(() => {});
}

export function hide() {
  const host = el("altprofile");
  if (host) host.hidden = true;
  cursorSync.clearPath();
  lastRunR = null;
}

export function setStale(on) {
  const flag = el("altprofile-stale");
  if (flag) flag.hidden = !on;
}

// Anders als `gramet.js`: kein separater Bibliotheks-Einheiten-Singleton zu
// bedienen -- dieses Modul liest `./units.js` direkt, denselben Singleton,
// den app.js schon selbst pflegt. Hier bleibt also nur, ein offenes Panel
// neu zu zeichnen, wenn sich die Einheit geändert hat.
export function syncUnits() {
  if (lastData && isOpen()) render();
}

/** Kopfzeilen-Steuerelemente (Achse, Δp/w-Override) einmalig verdrahten. */
let controlsBound = false;
export function bindControls() {
  if (controlsBound) return;
  controlsBound = true;
  const prefs = () => ({ xAxis: "time", deltaP: "auto", w: "auto", ...loadPrefs() });

  el("altprofile-xaxis").addEventListener("click", () => {
    const p = prefs();
    p.xAxis = p.xAxis === "time" ? "distance" : "time";
    savePrefs(p);
    if (lastData) render();
  });
  const cycle = (key) => {
    const p = prefs();
    const order = ["auto", "on", "off"];
    p[key] = order[(order.indexOf(p[key]) + 1) % order.length];
    savePrefs(p);
    if (lastData) render();
  };
  el("altprofile-deltap").addEventListener("click", () => cycle("deltaP"));
  el("altprofile-w").addEventListener("click", () => cycle("w"));

  // Kartenseitig gesetzter Cursor -> Fadenkreuz im Chart nachziehen.
  cursorSync.subscribe(({ s, source }) => {
    if (source === "altprofile" || !lastData) return;
    if (s == null) { cursorIndex = null; render(); return; }
    const markers = lastData.run.r.markers || [];
    cursorIndex = nearestMarkerIndexByPos(markers, s);
    render();
  });
}

// --- Geometrie-Hilfsfunktionen ------------------------------------------------

function distMeters(lat1, lon1, lat2, lon2) {
  const DEG = 180 / Math.PI, R = 6371000;
  const dy = (lat2 - lat1) / DEG * R;
  const dx = (lon2 - lon1) / DEG * R * Math.cos(((lat1 + lat2) / 2) / DEG);
  return Math.hypot(dx, dy);
}

/** Sekunden seit `waypoints[0]` (dieselbe Größe wie `posOfPath()`/
 *  `cursorSync`s `s`) für einen beliebigen Zeitstempel. */
function sFor(tMs, waypoints) {
  return Math.round(tMs / 1000) - waypoints[0].t;
}

function nearestMarkerIndexByPos(markers, s) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < markers.length; i++) {
    const d = Math.abs(sFor(markers[i].tMs, lastWaypoints) - s);
    if (d < bd) { bd = d; best = i; }
  }
  return markers.length ? best : null;
}

/** Modellorographie parallel zu `waypoints`/`pos` — gleicher Filter+Reverse
 *  wie `waypointsFromRun()` (`pathgeo.js`), hier separat gehalten, weil
 *  zusätzlich `run.terrain` (parallel zu `run.r.points`, VOR dem Filtern)
 *  mitgeführt werden muss. Kleine lokale Kopie statt geteilter Abstraktion —
 *  gleiches Muster wie `inBBox()` in meteokit/path.js. */
function terrainAlongWaypoints(run, direction) {
  const zipped = run.r.points
    .map((p, i) => ({ p, g: run.terrain ? run.terrain[i] : null }))
    .filter(({ p }) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.tMs));
  if (direction < 0) zipped.reverse();
  return zipped.map(({ g }) => (Number.isFinite(g) ? g : null));
}

/** Lineare Interpolation von `ys` über `xs` (aufsteigend) an der Stelle `x`. */
function interpAt(xs, ys, x) {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const a = ys[lo], b = ys[hi];
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const span = xs[hi] - xs[lo];
  return span > 0 ? a + ((x - xs[lo]) / span) * (b - a) : a;
}

function niceStep(raw) {
  for (const s of [50, 100, 200, 250, 500, 1000, 2000, 5000]) if (raw <= s) return s;
  return 10000;
}

function windUnitLabel() {
  return unitState.wind === "ms" ? "m/s" : unitState.wind === "kt" ? "kt" : "km/h";
}

// --- Δp / w Ableitung ----------------------------------------------------------

/** Zentrierte Differenz p[i+1]-p[i-1] über Δt, auf hPa/3h normiert
 *  (synoptische Drucktendenz-Konvention). `null` an den Rändern. */
function deltaPSeries(markers) {
  return markers.map((m, i) => {
    const a = markers[i - 1], b = markers[i + 1];
    if (!a || !b || !Number.isFinite(a.met?.p) || !Number.isFinite(b.met?.p)) return null;
    const dtH = (b.tMs - a.tMs) / 3600e3;
    if (!(dtH > 0)) return null;
    return ((b.met.p - a.met.p) / dtH) * 3;
  });
}

/** Zeitfensterbasierter gleitender Mittelwert von `w` (nicht indexbasiert,
 *  da Marker-Abstände variieren können, z. B. bei Profilflügen). */
function smoothW(markers, windowSec) {
  return markers.map((m) => {
    let sum = 0, n = 0;
    for (const o of markers) {
      if (!Number.isFinite(o.w)) continue;
      if (Math.abs(o.tMs - m.tMs) <= windowSec * 500) { sum += o.w; n++; }
    }
    return n ? sum / n : null;
  });
}
const W_SMOOTH_WINDOW_SEC = 1200; // 20 min

// --- SVG-Hilfsfunktionen -------------------------------------------------------

function mk(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function text(x, y, s, { anchor = "start", size = 10, fill = INK_MUTED, weight = 400 } = {}) {
  const t = mk("text", { x, y, "text-anchor": anchor, fill, "font-size": size, "font-weight": weight, "font-family": "inherit" });
  t.textContent = s;
  return t;
}

/** Signierte Fläche um die Nulllinie (Δp, w): über y0 eine Farbe, darunter
 *  die andere — als zwei geclippte Polygone statt eines Farbverlaufs. */
// xs/ys dürfen echte Datenlücken enthalten (`ys[i]` nicht endlich, z. B. Rand
// der Marken-Reihe ohne zentrierte Differenz) -- die werden NICHT
// überbrückt (separate `pts`-Gruppen je zusammenhängendem Abschnitt).
// Innerhalb eines Abschnitts wird der Nulldurchgang linear interpoliert,
// statt die Fläche einfach an der letzten/nächsten Marke abzuschneiden --
// sonst entsteht bei jedem Vorzeichenwechsel eine kleine, unmotiviert
// wirkende Lücke im Band (Feedback: "Sprünge im Verlauf").
function signedArea(svg, xs, ys, x, y, y0, posFill, negFill, posEdge, negEdge) {
  const base = y(y0);
  const groups = [[]];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(ys[i])) groups.at(-1).push([x(xs[i]), y(ys[i])]);
    else if (groups.at(-1).length) groups.push([]);
  }
  let dAbove = "", dBelow = "";
  for (const pts of groups) {
    if (pts.length < 2) continue;
    dAbove += sidePath(pts, base, (v) => v <= base);
    dBelow += sidePath(pts, base, (v) => v >= base);
  }
  if (dBelow) svg.append(mk("path", { d: dBelow, fill: negFill }));
  if (dAbove) svg.append(mk("path", { d: dAbove, fill: posFill }));
  if (dBelow) svg.append(mk("path", { d: dBelow, fill: "none", stroke: negEdge, "stroke-width": 1 }));
  if (dAbove) svg.append(mk("path", { d: dAbove, fill: "none", stroke: posEdge, "stroke-width": 1 }));
}

/** Ein zusammenhängender Punktzug (keine Datenlücken), in Segmente zerlegt,
 *  die auf `keep(y)` zutreffen -- Ein-/Austrittspunkte werden linear auf
 *  `base` interpoliert, damit benachbarte Segmente (`keep`/`!keep`) exakt an
 *  derselben Stelle aneinanderstoßen statt eine Lücke zu lassen. */
function sidePath(pts, base, keep) {
  let d = "";
  let seg = [];
  const crossing = (p0, p1) => {
    const t = (base - p0[1]) / (p1[1] - p0[1]);
    return [p0[0] + t * (p1[0] - p0[0]), base];
  };
  const flush = () => {
    if (seg.length > 1) {
      d += `M${seg[0][0].toFixed(1)},${base.toFixed(1)} `;
      for (const p of seg) d += `L${p[0].toFixed(1)},${p[1].toFixed(1)} `;
      d += `L${seg.at(-1)[0].toFixed(1)},${base.toFixed(1)} Z `;
    }
    seg = [];
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const on = keep(p[1]);
    if (on) seg.push(p);
    if (i < pts.length - 1) {
      const on1 = keep(pts[i + 1][1]);
      if (on !== on1) {
        seg.push(crossing(p, pts[i + 1]));
        if (on) flush(); // Segment verlassen -> schließen; beim Betreten offen lassen
      }
    }
  }
  flush();
  return d;
}

// --- Render --------------------------------------------------------------------

function render() {
  const host = el("altprofile-body");
  if (!host || !lastData) return;
  const { run, hiddenMethods, metExtras } = lastData;
  const waypoints = lastWaypoints, pos = lastPos;
  const markers = run.r.markers || [];
  const terrainModel = terrainAlongWaypoints(run, lastData.direction);
  const prefs = { xAxis: "time", deltaP: "auto", w: "auto", ...loadPrefs() };

  const autoDeltaP = run.method === "height" || run.method === "z3d";
  const showDeltaP = prefs.deltaP === "on" || (prefs.deltaP === "auto" && autoDeltaP);
  // w ist nicht mehr an die Methode gekoppelt (der Server liefert es jetzt
  // unabhängig davon, s. windfield.py/js `include_w`) -- die Zeile blendet
  // sich automatisch ein, sobald tatsächlich endliche w-Werte an den Marken
  // vorliegen, statt an `method === "z3d"` zu hängen.
  const autoW = markers.some((m) => Number.isFinite(m.w));
  const showW = prefs.w === "on" || (prefs.w === "auto" && autoW);
  setChipState(el("altprofile-deltap"), prefs.deltaP, showDeltaP);
  setChipState(el("altprofile-w"), prefs.w, showW);
  el("altprofile-xaxis").textContent = prefs.xAxis === "time" ? "Zeit" : "Strecke";

  const rows = [
    { key: "height", title: "Höhe über NN · Gelände", h: 150 },
    metExtras
      ? { key: "tempdew", title: "Temperatur/Taupunkt (°C)", h: 88 }
      : { key: "hint", title: "Temperatur/Taupunkt", h: 34 },
    { key: "wind", title: `Wind (${windUnitLabel()}) · Richtung`, h: 92 },
    metExtras
      ? { key: "cloud", title: "Bewölkung (%)", h: 64 }
      : { key: "hint", title: "Bewölkung · Wetter", h: 34 },
    ...(metExtras ? [{ key: "ww", title: "Wetter", h: 36 }] : []),
    ...(showDeltaP ? [{ key: "deltap", title: "Drucktendenz (hPa/3h)", h: 58 }] : []),
    ...(showW ? [{ key: "w", title: "Vertikalgeschwindigkeit (m/s)", h: 70 }] : []),
  ];
  // Luft zwischen den Zeilen -- ohne das lief der Rand einer Zeile optisch in
  // die Titelzeile der nächsten (Feedback: "gestaucht, eng gestapelt").
  const GAP = 26;

  host.innerHTML = "";
  if (!waypoints.length) { host.textContent = "Keine Daten."; return; }

  const contentH = rows.reduce((s, r) => s + r.h, 0) + GAP * (rows.length - 1);
  const W = Math.max(host.clientWidth, 320);
  const H = Math.max(host.clientHeight, contentH + 40);
  const M = { l: 54, r: 14 };
  const axisH = 22;
  const pw = W - M.l - M.r;

  // x-Domäne: Zeit (Sekunden seit waypoints[0], via `pos`) oder Strecke.
  const cumDist = new Float64Array(waypoints.length);
  for (let i = 1; i < waypoints.length; i++) {
    cumDist[i] = cumDist[i - 1] + distMeters(waypoints[i - 1].lat, waypoints[i - 1].lon, waypoints[i].lat, waypoints[i].lon);
  }
  const xValOfS = (s) => prefs.xAxis === "distance"
    ? interpAt(pos, cumDist, s) / 1000
    : s / 3600;
  const xMax = xValOfS(pos[pos.length - 1]) || 1;
  const x = (s) => M.l + (xValOfS(s) / xMax) * pw;
  x.right = M.l + pw;

  const svg = mk("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });

  // Zeilen stapeln (mit GAP dazwischen), gemeinsame Zeitachsen-Gitterlinien
  // über alle Zeilen.
  let top = 0;
  const bands = [];
  for (const r of rows) { bands.push({ ...r, top, bot: top + r.h }); top += r.h + GAP; }
  const bodyBot = top - GAP;

  const xStep = prefs.xAxis === "distance"
    ? [10, 20, 50, 100, 200, 500].find((s) => xMax / s <= 10) || 500
    : [1, 2, 3, 6, 12, 24].find((s) => xMax / s <= 10) || 24;
  for (let v = 0; v <= xMax + 1e-9; v += xStep) {
    const sAt = prefs.xAxis === "distance" ? interpAt(cumDist, pos, v * 1000) : v * 3600;
    svg.append(mk("line", { x1: x(sAt), x2: x(sAt), y1: 0, y2: bodyBot, stroke: GRID, "stroke-width": 1 }));
    svg.append(text(x(sAt), bodyBot + axisH - 7, `${lastData.direction < 0 && v > 0 ? "−" : ""}${Math.round(v)}${prefs.xAxis === "distance" ? " km" : " h"}`, { anchor: "middle" }));
  }

  bands.forEach((b, i) => {
    // Trennlinie mittig im Zwischenraum -- macht die Zeilengrenzen sichtbar,
    // statt dass Inhalt und nächster Titel ineinanderlaufen.
    if (i > 0) {
      const dividerY = b.top - GAP / 2;
      svg.append(mk("line", { x1: 0, x2: W, y1: dividerY, y2: dividerY, stroke: "#e2e0da", "stroke-width": 1 }));
    }
    svg.append(text(M.l, b.top + 12, b.title, { size: 11, fill: INK, weight: 700 }));
    if (b.key === "hint") {
      svg.append(text(M.l, b.top + b.h / 2 + 14, "Zusatzparameter nicht aktiv — in den Einstellungen einschalten.", { size: 10 }));
      return;
    }
    const innerTop = b.top + 22;
    drawRow(svg, b.key, { top: innerTop, bot: b.bot }, { run, waypoints, pos, markers, terrainModel, x, M });
  });

  // Im Methodenvergleich zeigt das Panel nur EINE Trajektorie je Höhe -- bei
  // teils deutlich auseinanderlaufenden Läufen soll das nicht unbemerkt
  // bleiben (gleiches Muster wie GRAMETs Untertitel, s. gramet.js `subtitleFor`).
  if (hiddenMethods > 0) {
    svg.append(text(x.right, 10, `+${hiddenMethods} weitere Methode${hiddenMethods > 1 ? "n" : ""} ausgeblendet`, { anchor: "end", size: 10 }));
  }

  drawHover(svg, { W, H: bodyBot + axisH, M, x, markers });
  host.append(svg);
}

function setChipState(btn, mode, effective) {
  if (!btn) return;
  btn.classList.toggle("active", effective);
  btn.title = mode === "auto"
    ? `${effective ? "automatisch an" : "automatisch aus"} (klicken zum Erzwingen)`
    : mode === "on" ? "manuell an (klicken für aus)" : "manuell aus (klicken für automatisch)";
}

function drawRow(svg, key, yr, ctx) {
  if (key === "height") return drawHeightRow(svg, yr, ctx);
  if (key === "tempdew") return drawTempDewRow(svg, yr, ctx);
  if (key === "wind") return drawWindRow(svg, yr, ctx);
  if (key === "cloud") return drawCloudRow(svg, yr, ctx);
  if (key === "ww") return drawWwRow(svg, yr, ctx);
  if (key === "deltap") return drawDeltaPRow(svg, yr, ctx);
  if (key === "w") return drawWRow(svg, yr, ctx);
}

function frame(svg, yr, xRight, M) {
  svg.append(mk("rect", { x: M.l, y: yr.top, width: xRight - M.l, height: yr.bot - yr.top, fill: "none", stroke: GRID, "stroke-width": 1 }));
}

function drawHeightRow(svg, yr, { waypoints, pos, terrainModel, x, M }) {
  const zs = waypoints.map((w) => w.z).filter(Number.isFinite);
  const gs = [...terrainModel, ...(lastHiRes ? Array.from(lastHiRes.elevation).filter(Number.isFinite) : [])];
  const zLo = Math.min(0, ...zs, ...gs.filter(Number.isFinite));
  const zHi = Math.max(...zs, ...gs.filter(Number.isFinite), zLo + 100);
  const pad = Math.max(60, (zHi - zLo) * 0.08);
  const yMin = Math.max(-450, zLo - pad * 0.3);
  const yMax = zHi + pad;
  const y = (z) => yr.bot - ((z - yMin) / (yMax - yMin)) * (yr.bot - yr.top);

  const dMin = heightToDisplay(yMin), dMax = heightToDisplay(yMax);
  const step = niceStep((dMax - dMin) / 3);
  for (let zd = Math.ceil(dMin / step) * step; zd <= dMax; zd += step) {
    const z = heightFromDisplay(zd);
    svg.append(mk("line", { x1: M.l, x2: x.right, y1: y(z), y2: y(z), stroke: GRID, "stroke-width": 1 }));
    svg.append(text(M.l - 6, y(z) + 3.5, `${Math.round(zd)}`, { anchor: "end" }));
  }
  svg.append(text(2, yr.top - 3, `${heightUnit()} NN`, { size: 9 }));

  // Modellorographie (Fläche) + Mapterhorn (Schatten darüber, falls schon da).
  const gPts = waypoints.map((w, i) => [x(pos[i]), terrainModel[i]]).filter((p) => Number.isFinite(p[1]));
  if (gPts.length > 1) {
    const line = gPts.map(([px, g]) => `${px.toFixed(1)},${y(g).toFixed(1)}`).join(" ");
    svg.append(mk("polygon", { points: `${gPts[0][0].toFixed(1)},${yr.bot} ${line} ${gPts.at(-1)[0].toFixed(1)},${yr.bot}`, fill: TERRAIN_FILL }));
    svg.append(mk("polyline", { points: line, fill: "none", stroke: TERRAIN_EDGE, "stroke-width": 1 }));
  }
  if (lastHiRes) {
    const hiPts = Array.from(lastHiRes.pos).map((s, i) => [x(s), lastHiRes.elevation[i]]).filter((p) => Number.isFinite(p[1]));
    if (hiPts.length > 1) {
      const line = hiPts.map(([px, g]) => `${px.toFixed(1)},${y(g).toFixed(1)}`).join(" ");
      svg.append(mk("polygon", { points: `${hiPts[0][0].toFixed(1)},${yr.bot} ${line} ${hiPts.at(-1)[0].toFixed(1)},${yr.bot}`, fill: TERRAIN_HI_FILL }));
      svg.append(mk("polyline", { points: line, fill: "none", stroke: TERRAIN_HI_EDGE, "stroke-width": 1 }));
    }
  }

  // Trajektorie (AMSL).
  const tPts = waypoints.map((w, i) => [x(pos[i]), w.z]).filter((p) => Number.isFinite(p[1]));
  if (tPts.length > 1) {
    svg.append(mk("polyline", {
      points: tPts.map(([px, z]) => `${px.toFixed(1)},${y(z).toFixed(1)}`).join(" "),
      fill: "none", stroke: lastData.run.color, "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
  }
  frame(svg, yr, x.right, M);
}

function drawTempDewRow(svg, yr, { markers, x, M }) {
  const ts = markers.map((m) => m.met?.t).filter(Number.isFinite);
  const tds = markers.map((m) => m.met?.td).filter(Number.isFinite);
  if (!ts.length && !tds.length) { frame(svg, yr, x.right, M); return; }
  const lo = Math.min(0, ...ts, ...tds), hi = Math.max(...ts, ...tds, lo + 4);
  const pad = Math.max(2, (hi - lo) * 0.15);
  const y = (v) => yr.bot - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (yr.bot - yr.top);
  for (const v of niceTicks(lo - pad, hi + pad, 3)) {
    svg.append(mk("line", { x1: M.l, x2: x.right, y1: y(v), y2: y(v), stroke: GRID, "stroke-width": 1 }));
    svg.append(text(M.l - 6, y(v) + 3.5, `${Math.round(v)}`, { anchor: "end" }));
  }
  if (lo - pad <= 0 && hi + pad >= 0) {
    svg.append(mk("line", { x1: M.l, x2: x.right, y1: y(0), y2: y(0), stroke: INK_MUTED, "stroke-width": 1, "stroke-dasharray": "3 2" }));
  }
  const sxOf = (m) => x(sFor(m.tMs, lastWaypoints));
  const spread = markers
    .map((m) => [sxOf(m), m.met?.t, m.met?.td])
    .filter(([, t, td]) => Number.isFinite(t) && Number.isFinite(td));
  if (spread.length > 1) {
    const top = spread.map(([px, t]) => `${px.toFixed(1)},${y(t).toFixed(1)}`).join(" L");
    const bot = spread.slice().reverse().map(([px, , td]) => `${px.toFixed(1)},${y(td).toFixed(1)}`).join(" L");
    svg.append(mk("path", { d: `M${top} L${bot} Z`, fill: SPREAD_FILL }));
  }
  const tLine = markers.map((m) => [sxOf(m), Number.isFinite(m.met?.t) ? y(m.met.t) : null]).filter((p) => p[1] != null);
  const tdLine = markers.map((m) => [sxOf(m), Number.isFinite(m.met?.td) ? y(m.met.td) : null]).filter((p) => p[1] != null);
  polyline(svg, tLine, T_COLOR);
  polyline(svg, tdLine, TD_COLOR);
  // Rechtsbündig auf Höhe des Zeilentitels statt direkt darunter -- sonst
  // rückt die Legende dem Titel zu dicht auf (Feedback: "gestaucht").
  legendChip(svg, x.right - 80, yr.top - 10, [["T", T_COLOR], ["Td", TD_COLOR]]);
  frame(svg, yr, x.right, M);
}

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function drawWindRow(svg, yr, { markers, x, M }) {
  const spds = markers.map((m) => Number.isFinite(m.u) && Number.isFinite(m.v) ? Math.hypot(m.u, m.v) : NaN).filter(Number.isFinite);
  const spdMax = Math.max(2, ...spds) * 1.15;
  const y = (v) => yr.bot - (Math.max(0, v) / spdMax) * (yr.bot - yr.top);
  for (const v of niceTicks(0, spdMax, 3)) {
    svg.append(mk("line", { x1: M.l, x2: x.right, y1: y(v), y2: y(v), stroke: GRID, "stroke-width": 1 }));
    svg.append(text(M.l - 6, y(v) + 3.5, fmtWind(v), { anchor: "end" }));
  }
  const sxOf = (m) => x(sFor(m.tMs, lastWaypoints));
  const pts = markers.map((m) => [sxOf(m), Number.isFinite(m.u) && Number.isFinite(m.v) ? Math.hypot(m.u, m.v) : null])
    .filter((p) => p[1] != null);
  if (pts.length > 1) {
    const line = pts.map(([px, v]) => `${px.toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svg.append(mk("polygon", { points: `${pts[0][0].toFixed(1)},${yr.bot} ${line} ${pts.at(-1)[0].toFixed(1)},${yr.bot}`, fill: WIND_FILL }));
    svg.append(mk("polyline", { points: line, fill: "none", stroke: WIND_EDGE, "stroke-width": 1.6 }));
  }
  // Windfiedern in festen Pixelabständen statt an jeder Marke. `CHART_BARB_SIZE`
  // ist meteokits eigene Zielgröße für Meteogramm/Chart-Kontexte (Feedback:
  // die bisherigen 20px waren schwer lesbar) -- der Abstand skaliert mit,
  // damit sich Fähnchen/Kalmenringe benachbarter Fiedern nicht berühren.
  const step = CHART_BARB_SIZE * 2.8;
  let nextPx = M.l;
  for (const m of markers) {
    if (!Number.isFinite(m.u) || !Number.isFinite(m.v)) continue;
    const px = sxOf(m);
    if (px < nextPx || px > x.right) continue;
    const spd = Math.hypot(m.u, m.v), dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
    svg.append(placeWindBarb(px, yr.top + 14, spd * KT_PER_MS, dir, { size: CHART_BARB_SIZE, color: INK }));
    nextPx = px + step;
  }
  frame(svg, yr, x.right, M);
}

function drawCloudRow(svg, yr, { markers, x, M }) {
  const y = (pct) => yr.bot - (Math.max(0, Math.min(100, pct)) / 100) * (yr.bot - yr.top);
  svg.append(text(M.l - 6, yr.top + 3.5, "100", { anchor: "end" }));
  svg.append(text(M.l - 6, yr.bot + 3.5, "0", { anchor: "end" }));
  const sxOf = (m) => x(sFor(m.tMs, lastWaypoints));
  const pts = markers.map((m) => [sxOf(m), m.met?.clc]).filter((p) => Number.isFinite(p[1]));
  if (pts.length > 1) {
    const line = pts.map(([px, v]) => `${px.toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svg.append(mk("polygon", { points: `${pts[0][0].toFixed(1)},${yr.bot} ${line} ${pts.at(-1)[0].toFixed(1)},${yr.bot}`, fill: CLOUD_FILL }));
    svg.append(mk("polyline", { points: line, fill: "none", stroke: CLOUD_EDGE, "stroke-width": 1.6 }));
  }
  frame(svg, yr, x.right, M);
}

const WW_SYMBOL_SIZE = 26;

function drawWwRow(svg, yr, { markers, x, M }) {
  const sxOf = (m) => x(sFor(m.tMs, lastWaypoints));
  // Mindestabstand wie bei den Windfiedern -- ohne Thinning würden sich die
  // größeren Symbole bei dicht stehenden Marken überlappen.
  let nextPx = M.l;
  for (const m of markers) {
    const wx = Number.isFinite(m.met?.ww) ? wmoWeatherCodeToWx(m.met.ww) : null;
    if (!wx) continue;
    const px = sxOf(m);
    if (px < nextPx || px > x.right) continue;
    const g = placeWxSymbol(px, (yr.top + yr.bot) / 2, wx, { size: WW_SYMBOL_SIZE });
    if (g) svg.append(g);
    nextPx = px + WW_SYMBOL_SIZE * 1.3;
  }
  frame(svg, yr, x.right, M);
}

function drawDeltaPRow(svg, yr, { markers, x, M }) {
  const series = deltaPSeries(markers);
  const finite = series.filter(Number.isFinite);
  if (!finite.length) {
    svg.append(text(M.l, (yr.top + yr.bot) / 2, "Kein Luftdruck an den Marken — „Zusatzparameter“ in den Einstellungen einschalten.", { size: 10 }));
    return frame(svg, yr, x.right, M);
  }
  const max = Math.max(1, ...finite.map(Math.abs)) * 1.2;
  const y = (v) => yr.bot - ((v + max) / (2 * max)) * (yr.bot - yr.top);
  svg.append(mk("line", { x1: M.l, x2: x.right, y1: y(0), y2: y(0), stroke: INK_MUTED, "stroke-width": 1 }));
  svg.append(text(M.l - 6, y(0) + 3.5, "0", { anchor: "end" }));
  svg.append(text(M.l - 6, y(max) + 3.5, `+${max.toFixed(1)}`, { anchor: "end" }));
  svg.append(text(M.l - 6, y(-max) + 3.5, `−${max.toFixed(1)}`, { anchor: "end" }));
  const xs = markers.map((m) => sFor(m.tMs, lastWaypoints));
  signedArea(svg, xs, series, x, y, 0, POS_FILL, NEG_FILL, POS_EDGE, NEG_EDGE);
  frame(svg, yr, x.right, M);
}

function drawWRow(svg, yr, { markers, x, M, run }) {
  const raw = markers.map((m) => m.w);
  const smooth = smoothW(markers, W_SMOOTH_WINDOW_SEC);
  const finite = [...raw, ...smooth].filter(Number.isFinite);
  if (!finite.length) {
    // Unterscheidet "nicht berechnet" von "tatsächlich 0" -- sonst nicht vom
    // Rand zu unterscheiden, ob ein Fehler vorliegt oder w echt null ist. w
    // wird inzwischen unabhängig von der Methode angefragt (s. windfield.js/
    // py `include_w`) -- fehlt es trotzdem, liefert entweder das Modell
    // selbst keine Vertikalgeschwindigkeit, oder (bei z3d) es ist eine
    // Datenlücke am Rechenpunkt.
    const why = run.method === "z3d"
      ? "Kein Modell-w an den Marken (Datenlücke im Modell)."
      : "Kein Modell-w verfügbar — dieses Modell liefert (noch) keine Vertikalgeschwindigkeit.";
    svg.append(text(M.l, (yr.top + yr.bot) / 2, why, { size: 10 }));
    return frame(svg, yr, x.right, M);
  }
  const max = Math.max(0.3, ...finite.map(Math.abs)) * 1.2;
  const y = (v) => yr.bot - ((v + max) / (2 * max)) * (yr.bot - yr.top);
  svg.append(mk("line", { x1: M.l, x2: x.right, y1: y(0), y2: y(0), stroke: INK_MUTED, "stroke-width": 1 }));
  svg.append(text(M.l - 6, y(0) + 3.5, "0", { anchor: "end" }));
  svg.append(text(M.l - 6, y(max) + 3.5, `+${max.toFixed(1)}`, { anchor: "end" }));
  svg.append(text(M.l - 6, y(-max) + 3.5, `−${max.toFixed(1)}`, { anchor: "end" }));
  const xs = markers.map((m) => sFor(m.tMs, lastWaypoints));
  signedArea(svg, xs, smooth, x, y, 0, POS_FILL, NEG_FILL, POS_EDGE, NEG_EDGE);
  const rawPts = markers.map((m, i) => [x(xs[i]), raw[i]]).filter((p) => Number.isFinite(p[1]));
  if (rawPts.length > 1) {
    svg.append(mk("polyline", {
      points: rawPts.map(([px, v]) => `${px.toFixed(1)},${y(v).toFixed(1)}`).join(" "),
      fill: "none", stroke: INK_MUTED, "stroke-width": 1, opacity: 0.6,
    }));
  }
  frame(svg, yr, x.right, M);
}

/** `pts` sind bereits transformierte [px, py]-Paare (Aufrufer wendet `y()`
 *  vorher an -- Zeilen haben unterschiedliche y-Skalen). */
function polyline(svg, pts, color) {
  if (pts.length < 2) return;
  svg.append(mk("polyline", {
    points: pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" "),
    fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
  }));
}

function legendChip(svg, x0, y0, entries) {
  let lx = x0;
  for (const [label, color] of entries) {
    svg.append(mk("rect", { x: lx, y: y0 - 8, width: 12, height: 3, rx: 1.5, fill: color }));
    svg.append(text(lx + 16, y0 - 3, label, { size: 10 }));
    lx += 20 + label.length * 6;
  }
}

// --- Hover / Crosshair ---------------------------------------------------------

function drawHover(svg, ctx) {
  const { W, H, M, x, markers } = ctx;
  const cursor = mk("line", { y1: 0, y2: H - 22, stroke: INK_MUTED, "stroke-width": 1, visibility: cursorIndex != null ? "visible" : "hidden" });
  svg.append(cursor);
  if (cursorIndex != null && markers[cursorIndex]) {
    cursor.setAttribute("x1", x(sFor(markers[cursorIndex].tMs, lastWaypoints)));
    cursor.setAttribute("x2", x(sFor(markers[cursorIndex].tMs, lastWaypoints)));
  }

  const tip = document.createElement("div");
  tip.className = "altprofile-tip";
  tip.hidden = cursorIndex == null;
  if (cursorIndex != null && markers[cursorIndex]) {
    tip.innerHTML = tooltipHtml(markers[cursorIndex]);
    const px = x(sFor(markers[cursorIndex].tMs, lastWaypoints));
    tip.style.left = `${Math.min(px + 12, W - 8)}px`;
    tip.style.maxWidth = `${Math.max(120, W - px - 20)}px`;
  }
  el("altprofile-body").append(tip);

  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    if (px < M.l || px > x.right || !markers.length) return;
    // Nächste Marke nach Pixel-x suchen (Marken sind zeitlich sortiert).
    let best = 0, bd = Infinity;
    for (let i = 0; i < markers.length; i++) {
      const d = Math.abs(x(sFor(markers[i].tMs, lastWaypoints)) - px);
      if (d < bd) { bd = d; best = i; }
    }
    if (best === cursorIndex) return;
    cursorIndex = best;
    cursorSync.setCursor(sFor(markers[best].tMs, lastWaypoints), "altprofile");
    render();
  });
  svg.addEventListener("mouseleave", () => {
    if (cursorIndex == null) return;
    cursorIndex = null;
    cursorSync.setCursor(null, "altprofile");
    render();
  });
}

function tooltipHtml(m) {
  const time = new Date(m.tMs).toISOString().slice(11, 16);
  const spd = Number.isFinite(m.u) && Number.isFinite(m.v) ? Math.hypot(m.u, m.v) : null;
  const dir = spd != null ? Math.round((Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360) : null;
  const lines = [`<strong>${time}Z</strong>`];
  if (Number.isFinite(m.z)) lines.push(`${fmtHeight(m.z)} NN`);
  if (Number.isFinite(m.heightAglM)) lines.push(`${fmtHeight(m.heightAglM)} AGL`);
  if (spd != null) lines.push(`${dir}° ${fmtWind(spd)}`);
  if (Number.isFinite(m.met?.t)) lines.push(`T ${m.met.t.toFixed(1)} °C${Number.isFinite(m.met.td) ? ` / Td ${m.met.td.toFixed(1)} °C` : ""}`);
  if (Number.isFinite(m.met?.rh)) lines.push(`RH ${Math.round(m.met.rh)} %`);
  if (Number.isFinite(m.met?.clc)) lines.push(`Bew. ${Math.round(m.met.clc)} %`);
  if (Number.isFinite(m.met?.p)) lines.push(`${m.met.p.toFixed(0)} hPa`);
  if (Number.isFinite(m.w)) lines.push(`w ${m.w >= 0 ? "+" : ""}${m.w.toFixed(1)} m/s`);
  return lines.join("<br>");
}
