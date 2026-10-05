// Hindcast-/Diagnoseseite: gefahrene Strecke (GPX) gegen die reine
// Modellwind-Trajektorie mit denselben Zeiten und Höhen.
//
// Rechenkern ist bewusst derselbe wie auf der Vorhersageseite (WindField aus
// src/windfield.js, Petterssen aus src/integrator.js) -- geprüft wird so die
// App selbst, nicht ein Nachbau. Nur die Zielhöhe ist hier keine konstante
// Fläche, sondern folgt dem GPS-Höhenprofil (computeAlongProfile).

import { API_BASE, DEV_PROXY_BASE, MODELS } from "../config.js";
import { getApiSources, onApiSourceChange } from "meteokit/apifetch";
import { WindField } from "../windfield.js";
import { computeAlongProfile } from "../integrator.js";
import { probeArchive, bboxCenter } from "./archive.js";
import {
  parseTrackGPX, detectFlight, obsVel, dist, speedDir, diagStats,
} from "./track.js";
import {
  Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Legend, Tooltip,
} from "chart.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Legend, Tooltip);

/* global L */

const el = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const R = 6371000;

// GPS = Wirklichkeit, daher neutral dunkel und durchgezogen; Modelle farbig
// und gestrichelt (Strichmuster als Zweitkodierung neben der Farbe).
// Palette mit dem dataviz-Validator geprüft (CVD/Normalsicht bestanden).
const GPS_COLOR = "#1f2933";
const MODEL_STYLE = {
  icon_d2: { color: "#d55181", dash: "10 6" },
  icon_eu: { color: "#c98500", dash: "4 6" },
  icon_global: { color: "#4a3aa7", dash: "14 4 3 4" },
};
const MODEL_ORDER = ["icon_d2", "icon_eu", "icon_global"];
const SHORT = { icon_d2: "ICON-D2", icon_eu: "ICON-EU", icon_global: "ICON Global" };
// Spaltenköpfe der Kennzahlen-Tabelle (schmales Panel).
const TINY = { icon_d2: "D2", icon_eu: "EU", icon_global: "Global" };
// Bei einer GPS-Höhe unter dem geglätteten Modellgelände (Start/Landung im
// Tal, Mittelgebirge im Global-Modell) meldet WindField diesen Fehler --
// hier wird dann das unterste Modelllevel genommen statt abzubrechen.
const BELOW_GROUND = /Gelände über Zielhöhe/;

// --- Einstellungen (nur Komfort) --------------------------------------------
const STORAGE_KEY = "diagnoseSettings";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { /* egal */ }
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      models: [...selected], showArrows: el("showArrows").checked, baseLayer: activeBaseLayer,
    }));
  } catch { /* Speichern ist Komfort, nie Fehlerquelle */ }
}

// --- Karte ------------------------------------------------------------------
const map = L.map("map", { center: [48.5, 11], zoom: 7 });
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: ["a", "b", "c"],
  }),
  "Esri Satellit (hybrid)": L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, pane: "overlayPane", zIndex: 2,
    }),
  ], { attribution: "© Esri, USDA, USGS © OpenStreetMap contributors, and the GIS user community" }),
};
let activeBaseLayer = baseLayers[saved.baseLayer] ? saved.baseLayer : "OpenStreetMap";
baseLayers[activeBaseLayer].addTo(map);
map.on("baselayerchange", (e) => { activeBaseLayer = e.name; persist(); });
L.control.scale({ imperial: false }).addTo(map);

const gpsLayer = L.layerGroup().addTo(map);
const cursorLayer = L.layerGroup().addTo(map);
const modelLayers = {}; // key -> {track, arrows}
const overlays = { "GPS-Track": gpsLayer };
for (const k of MODEL_ORDER) {
  modelLayers[k] = { track: L.layerGroup().addTo(map), arrows: L.layerGroup().addTo(map) };
  overlays[`${SHORT[k]}: Modellspur`] = modelLayers[k].track;
  overlays[`${SHORT[k]}: Windpfeile`] = modelLayers[k].arrows;
}
L.control.layers(baseLayers, overlays, { position: "topleft" }).addTo(map);

// --- Zustand ----------------------------------------------------------------
const state = {
  track: null,      // {name, points:[{tMs,lat,lon,z}]}
  archive: {},      // key -> {startSec, endSec} | {error}
  results: null,    // {i0, i1, models: {key: {...}}}
  running: null,    // AbortController
};
const selected = new Set(
  Array.isArray(saved.models) ? saved.models.filter((k) => MODELS[k]) : ["icon_d2", "icon_eu"],
);
if (typeof saved.showArrows === "boolean") el("showArrows").checked = saved.showArrows;

// --- Formatierung -----------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
const fmtT = (ms) => new Date(ms).toISOString().slice(11, 19);
const fmtHM = (ms) => new Date(ms).toISOString().slice(11, 16);
const fmtDay = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}. ${pad2(d.getUTCHours())} UTC`;
};
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};
const toInput = (ms) => new Date(ms).toISOString().slice(0, 19);
const fromInput = (v) => Date.parse(v.length === 16 ? `${v}:00Z` : `${v}Z`);
const km = (m, d = 2) => `${(m / 1000).toFixed(d)} km`;

function setStatus(msg, isError = false) {
  el("status").textContent = msg;
  el("status").className = isError ? "error" : "";
}

// --- Modellliste + Archiv ---------------------------------------------------
function renderModelList() {
  const box = el("modellist");
  box.innerHTML = "";
  for (const k of MODEL_ORDER) {
    const avail = availability(k);
    const row = document.createElement("label");
    row.className = `model-row${avail.ok ? "" : " off"}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(k) && avail.ok;
    cb.disabled = !avail.ok;
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(k); else selected.delete(k);
      persist();
      updateRunButton();
    });
    const chip = document.createElement("span");
    chip.className = "chip dash";
    chip.style.setProperty("--c", MODEL_STYLE[k].color);
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = SHORT[k];
    const note = document.createElement("span");
    note.className = "hint model-note mono";
    note.textContent = avail.note;
    row.append(cb, chip, name, note);
    box.append(row);
  }
  updateRunButton();
}

/** Kann das Modell den gewählten Fahrtabschnitt rechnen? */
function availability(k) {
  const a = state.archive[k];
  if (!a) return { ok: false, note: "prüfe Archiv …" };
  if (a.error) return { ok: false, note: "Server nicht erreichbar" };
  const archiveNote = `Archiv ab ${fmtDay(a.startSec * 1000)}`;
  const seg = segment();
  if (!seg) return { ok: true, note: archiveNote };
  const b = MODELS[k].bbox;
  const pts = state.track.points.slice(seg.i0, seg.i1 + 1);
  if (!pts.every((p) => p.lat >= b.latMin && p.lat <= b.latMax && p.lon >= b.lonMin && p.lon <= b.lonMax)) {
    return { ok: false, note: "außerhalb des Modellgebiets" };
  }
  const t0 = pts[0].tMs / 1000, t1 = pts.at(-1).tMs / 1000;
  if (t0 < a.startSec) return { ok: false, note: `nicht mehr im Archiv (ab ${fmtDay(a.startSec * 1000)})` };
  if (t1 > a.endSec) return { ok: false, note: "noch keine Daten" };
  return { ok: true, note: archiveNote };
}

async function loadArchives() {
  await Promise.all(MODEL_ORDER.map(async (k) => {
    try {
      const c = bboxCenter(k);
      state.archive[k] = await probeArchive(k, c.lat, c.lon);
    } catch (err) {
      state.archive[k] = { error: err.message };
    }
  }));
  const ok = MODEL_ORDER.filter((k) => !state.archive[k].error);
  el("archivehint").textContent = ok.length
    ? `Rückblick möglich bis ${fmtDay(Math.min(...ok.map((k) => state.archive[k].startSec)) * 1000)} ` +
      "(Archiv des Servers, live abgefragt)"
    : "Datenarchiv nicht erreichbar – bitte später erneut versuchen.";
  el("archivehint").classList.toggle("error", !ok.length);
  renderModelList();
}

// --- Track laden ------------------------------------------------------------
async function loadFile(file) {
  if (!file) return;
  try {
    const tr = parseTrackGPX(await file.text());
    state.track = tr;
    state.results = null;
    clearResults();
    const [i0, i1] = detectFlight(tr.points);
    el("tstart").value = toInput(tr.points[i0].tMs);
    el("tend").value = toInput(tr.points[i1].tMs);
    for (const id of ["tstart", "tend"]) {
      el(id).disabled = false;
      el(id).min = toInput(tr.points[0].tMs);
      el(id).max = toInput(tr.points.at(-1).tMs);
    }
    const p0 = tr.points[0];
    const skipped = tr.skipped.noTime + tr.skipped.noEle;
    el("trackinfo").textContent =
      `${file.name} · ${fmtDate(p0.tMs)} · ${tr.points.length} Punkte` +
      (skipped ? ` (${skipped} ohne Zeit/Höhe übersprungen)` : "");
    drawGps();
    updateLegend();
    updateFlightHint();
    renderModelList();
    setStatus("Track geladen. Fahrtabschnitt prüfen und berechnen.");
  } catch (err) {
    setStatus(`GPX nicht lesbar: ${err.message}`, true);
  }
}

el("gpxfile").addEventListener("change", (e) => loadFile(e.target.files[0]));
// Datei auch per Ziehen auf das Feld oder die Karte annehmen.
for (const target of [el("dropzone"), el("map")]) {
  target.addEventListener("dragover", (e) => { e.preventDefault(); el("dropzone").classList.add("over"); });
  target.addEventListener("dragleave", () => el("dropzone").classList.remove("over"));
  target.addEventListener("drop", (e) => {
    e.preventDefault();
    el("dropzone").classList.remove("over");
    loadFile(e.dataTransfer.files[0]);
  });
}

/** Gewählter Fahrtabschnitt als Indizes in den Track. */
function segment() {
  if (!state.track) return null;
  const pts = state.track.points;
  const tA = fromInput(el("tstart").value), tB = fromInput(el("tend").value);
  if (!Number.isFinite(tA) || !Number.isFinite(tB)) return null;
  const i0 = pts.findIndex((p) => p.tMs >= tA);
  let i1 = pts.length - 1;
  while (i1 > 0 && pts[i1].tMs > tB) i1--;
  if (i0 < 0 || i1 <= i0) return null;
  return { i0, i1 };
}

function updateFlightHint() {
  const seg = segment();
  if (!seg) { el("flighthint").textContent = state.track ? "Beginn/Ende ungültig." : ""; return; }
  const pts = state.track.points;
  const a = pts[seg.i0], b = pts[seg.i1];
  const zMax = Math.max(...pts.slice(seg.i0, seg.i1 + 1).map((p) => p.z));
  el("flighthint").textContent =
    `${Math.round((b.tMs - a.tMs) / 60000)} min · ${seg.i1 - seg.i0 + 1} Punkte · ` +
    `max. ${Math.round(zMax)} m NN · vorbelegt: Start bis Landung`;
}

for (const id of ["tstart", "tend"]) {
  el(id).addEventListener("change", () => {
    updateFlightHint();
    renderModelList();
    drawGps();
    if (state.results) {
      el("run").textContent = "Diagnose neu berechnen";
      el("run").classList.add("stale");
    }
  });
}

// --- GPS-Track zeichnen -----------------------------------------------------
function drawGps() {
  gpsLayer.clearLayers();
  const pts = state.track.points;
  const all = pts.map((p) => [p.lat, p.lon]);
  const seg = segment();
  // Ganzer Track blass (Vorbereitung/Bergung), gewählter Abschnitt kräftig.
  L.polyline(all, { color: GPS_COLOR, weight: 2, opacity: 0.35 }).addTo(gpsLayer);
  if (seg) {
    const part = all.slice(seg.i0, seg.i1 + 1);
    L.polyline(part, { color: "#fff", weight: 7, opacity: 0.8 }).addTo(gpsLayer);
    L.polyline(part, { color: GPS_COLOR, weight: 4 }).addTo(gpsLayer)
      .bindTooltip("GPS-Track (gefahren)", { sticky: true });
    L.circleMarker(part[0], { radius: 6, color: "#fff", weight: 2, fillColor: GPS_COLOR, fillOpacity: 1 })
      .addTo(gpsLayer).bindTooltip(`Start ${fmtT(pts[seg.i0].tMs)} UTC`);
    L.circleMarker(part.at(-1), { radius: 6, color: "#fff", weight: 2, fillColor: GPS_COLOR, fillOpacity: 1 })
      .addTo(gpsLayer).bindTooltip(`GPS-Ende ${fmtT(pts[seg.i1].tMs)} UTC`);
    addTimeMarks(pts.slice(seg.i0, seg.i1 + 1), GPS_COLOR, gpsLayer);
  }
  if (!state.results) fitVisible(L.latLngBounds(all).pad(0.1));
}

// Kartenlegende statt Endbeschriftungen an den Spuren -- die Modellspuren
// enden oft dicht beieinander, Beschriftungen überlappten dort.
const legend = L.control({ position: "bottomleft" });
legend.onAdd = () => L.DomUtil.create("div", "diag-legend");
legend.addTo(map);
function updateLegend(keys = []) {
  const line = (color, dash, w = 3) =>
    `<svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="${color}" ` +
    `stroke-width="${w}"${dash ? ` stroke-dasharray="${dash.split(" ").map((x) => x / 2).join(" ")}"` : ""}/></svg>`;
  const c = legend.getContainer();
  c.hidden = !state.track;
  c.innerHTML = [`${line(GPS_COLOR, null, 4)} GPS-Track (gefahren)`,
    ...keys.map((k) => `${line(MODEL_STYLE[k].color, MODEL_STYLE[k].dash)} Modellspur ${SHORT[k]}`)]
    .map((x) => `<div>${x}</div>`).join("");
}

/** Auf den Teil der Karte einpassen, den das Bedienfeld nicht verdeckt
 *  (rechts am Desktop, unten als Bottom-Sheet am Handy). */
function fitVisible(bounds) {
  const mapR = el("map").getBoundingClientRect(), pr = el("panel").getBoundingClientRect();
  const bottomSheet = pr.width > mapR.width * 0.8;
  map.fitBounds(bounds, {
    paddingTopLeft: [20, 20],
    paddingBottomRight: bottomSheet ? [20, pr.height + 20] : [pr.width + 30, 20],
  });
}

/** 10-Minuten-Marken (volle 10 min UTC) entlang einer Punktfolge. */
function addTimeMarks(pts, color, layer) {
  const step = 600e3;
  let j = 0;
  for (let t = Math.ceil(pts[0].tMs / step) * step; t <= pts.at(-1).tMs; t += step) {
    while (j < pts.length - 1 && pts[j + 1].tMs <= t) j++;
    const p = pts[j];
    L.circleMarker([p.lat, p.lon], { radius: 4, color, weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${fmtHM(t)} UTC · ${Math.round(p.z)} m NN`).addTo(layer);
  }
}

// --- Berechnung -------------------------------------------------------------
function updateRunButton() {
  if (state.running) return;
  const seg = segment();
  const any = MODEL_ORDER.some((k) => selected.has(k) && availability(k).ok);
  el("run").disabled = !(seg && any);
}

function setProgress(frac) {
  el("progress").hidden = frac == null;
  el("progress").classList.toggle("indeterminate", frac === 0);
  el("progressbar").style.width = `${Math.round((frac || 0) * 100)}%`;
}

el("run").addEventListener("click", () => {
  if (state.running) { state.running.abort(); return; }
  run();
});

async function run() {
  const seg = segment();
  if (!seg) return;
  const models = MODEL_ORDER.filter((k) => selected.has(k) && availability(k).ok);
  const gps = state.track.points.slice(seg.i0, seg.i1 + 1);
  const ctrl = new AbortController();
  state.running = ctrl;
  el("run").textContent = "Abbrechen";
  el("run").classList.remove("stale");
  el("run").classList.add("running");
  setProgress(0);
  setStatus(`Lade Modellwind und rechne (${models.map((k) => SHORT[k]).join(", ")}) …`);

  const frac = Object.fromEntries(models.map((k) => [k, 0]));
  const showFrac = () => setProgress(Math.max(0.02, models.reduce((s, k) => s + frac[k], 0) / models.length));
  const out = {};
  try {
    await Promise.all(models.map(async (k) => {
      out[k] = await runModel(k, gps, ctrl.signal, (f) => { frac[k] = f; showFrac(); });
    }));
    state.results = { i0: seg.i0, i1: seg.i1, gps, models: out };
    drawResults();
    const notes = models.flatMap((k) => {
      const r = out[k], n = [];
      if (r.status !== "ok") n.push(`${SHORT[k]}: Abbruch um ${fmtT(r.points.at(-1).tMs)} UTC – ${r.reason}`);
      if (r.belowShare > 0.02) {
        n.push(`${SHORT[k]}: ${Math.round(r.belowShare * 100)} % der Schritte unter Modellgelände (unterstes Level verwendet)`);
      }
      return n;
    });
    setStatus(`Fertig.${notes.length ? `\n${notes.join("\n")}` : ""}`);
  } catch (err) {
    if (err.name === "AbortError") setStatus("Abgebrochen.");
    else { console.error(err); setStatus(err.message, true); }
  } finally {
    state.running = null;
    el("run").classList.remove("running");
    el("run").textContent = "Diagnose berechnen";
    setProgress(null);
    updateRunButton();
  }
}

/** Modellspur + Modellwind am GPS-Ort für ein Modell. */
async function runModel(k, gps, signal, onProgress) {
  const wf = new WindField(k, { signal });
  const zMax = Math.max(...gps.map((p) => p.z));
  await wf.init(gps[0].lat, gps[0].lon, zMax, gps[0].tMs, gps.at(-1).tMs, "height");
  const count = { n: 0, below: 0 };
  const windAt = async (lat, lon, z, tMs) => {
    count.n++;
    const r = await wf.windAt(lat, lon, { type: "height", mode: "amsl", value: z }, tMs);
    if (r.error && BELOW_GROUND.test(r.error)) {
      count.below++;
      return wf.windAt(lat, lon, { type: "height", mode: "agl", value: 0 }, tMs);
    }
    return r;
  };
  // Modellspur: 90 % des Fortschritts, Wind am GPS-Ort den Rest.
  const res = await computeAlongProfile({
    windAt, lat0: gps[0].lat, lon0: gps[0].lon, profile: gps, signal,
    onProgress: (f) => onProgress(0.9 * f),
  });
  const belowShare = count.n ? count.below / count.n : 0;
  // Modellwind am tatsächlichen Ballonort -- für Geschwindigkeits-/
  // Richtungsvergleich und Windpfeile (unabhängig von der Spurabweichung).
  const wind = [];
  for (let i = 0; i < gps.length; i++) {
    if (signal.aborted) throw Object.assign(new Error("Abgebrochen"), { name: "AbortError" });
    const p = gps[i];
    const w = await windAt(p.lat, p.lon, p.z, p.tMs);
    wind.push(w.error ? null : speedDir(w.u, w.v));
    if (i % 50 === 0) onProgress(0.9 + 0.1 * (i / gps.length));
  }
  onProgress(1);
  return { ...res, belowShare, wind };
}

// --- Ergebnisse -------------------------------------------------------------
const charts = {};
let cursor = null; // {gps, models:{k: marker}, lines:{k: polyline}}

function clearResults() {
  for (const k of MODEL_ORDER) { modelLayers[k].track.clearLayers(); modelLayers[k].arrows.clearLayers(); }
  cursorLayer.clearLayers();
  cursor = null;
  for (const id of Object.keys(charts)) { charts[id].destroy(); delete charts[id]; }
  el("results").hidden = true;
  el("run").classList.remove("stale");
  el("run").textContent = "Diagnose berechnen";
}

function drawResults() {
  const { gps, models } = state.results;
  clearResults();
  drawGps();
  const keys = MODEL_ORDER.filter((k) => models[k]);
  const obs = gps.map((_, i) => obsVel(gps, i));
  const bounds = L.latLngBounds(gps.map((p) => [p.lat, p.lon]));

  for (const k of keys) {
    const r = models[k], st = MODEL_STYLE[k];
    const ll = r.points.map((p) => [p.lat, p.lon]);
    ll.forEach((p) => bounds.extend(p));
    L.polyline(ll, { color: "#fff", weight: 6, opacity: 0.75 }).addTo(modelLayers[k].track);
    L.polyline(ll, { color: st.color, weight: 3.5, dashArray: st.dash }).addTo(modelLayers[k].track)
      .bindTooltip(`Modellspur ${SHORT[k]}`, { sticky: true });
    L.circleMarker(ll.at(-1), { radius: 6, color: "#fff", weight: 2, fillColor: st.color, fillOpacity: 1 })
      .addTo(modelLayers[k].track)
      .bindTooltip(`${SHORT[k]}: Ende ${fmtT(r.points.at(-1).tMs)} UTC`);
    addTimeMarks(r.points, st.color, modelLayers[k].track);
  }
  drawArrows();
  updateLegend(keys);
  fitVisible(bounds.pad(0.05));

  // Kennzahlen-Tabelle: Zeilen = Kennzahl, Spalten = Modell.
  const stats = Object.fromEntries(keys.map((k) => [k, diagStats(gps, models[k].points, obs, models[k].wind)]));
  const head = `<tr><th></th>${keys.map((k) =>
    `<th title="${SHORT[k]}"><span class="chip dash" style="--c:${MODEL_STYLE[k].color}"></span>${TINY[k]}</th>`).join("")}</tr>`;
  const s0 = stats[keys[0]];
  const rows = [
    ["Zeitraum", () => `${fmtHM(gps[0].tMs)}–${fmtHM(gps.at(-1).tMs)} UTC (${Math.round(s0.durSec / 60)} min)`, true],
    ["Start → Ende GPS", () => `${km(s0.directO, 1)} / ${Math.round(s0.brgO)}°`, true],
    ["Start → Ende Modell", (s) => `${km(s.directD, 1)} / ${Math.round(s.brgD)}°`],
    ["Ablage am Ende", (s) => km(s.endSep)],
    ["Ablage rel. zur Distanz", (s) => (s.relEnd == null ? "–" : `${Math.round(100 * s.relEnd)} %`)],
    ["Max. Ablage", (s) => km(s.maxSep)],
    ["Mittlere Ablage", (s) => km(s.meanSep)],
    ["Verlagerung GPS", () => `${(s0.vObs * 3.6).toFixed(1)} km/h`, true],
    ["Verlagerung Modell", (s) => `${(s.vMod * 3.6).toFixed(1)} km/h`],
    ["Windfehler (Vektor, RMS)", (s) => (s.rmseVec == null ? "–" : `${s.rmseVec.toFixed(1)} m/s`)],
    ["Bias Geschw. (Modell − GPS)", (s) => (s.biasSpd == null ? "–" : `${s.biasSpd >= 0 ? "+" : ""}${s.biasSpd.toFixed(1)} m/s`)],
    ["Mittl. Richtungsfehler |Δ|", (s) => (s.meanAbsDir == null ? "–" : `${Math.round(s.meanAbsDir)}°`)],
    ["Unter Modellgelände", (s, k) => `${Math.round(100 * models[k].belowShare)} %`],
  ];
  const body = rows.map(([label, f, span]) => span
    ? `<tr><td>${label}</td><td colspan="${keys.length}">${f(s0)}</td></tr>`
    : `<tr><td>${label}</td>${keys.map((k) => `<td>${f(stats[k], k)}</td>`).join("")}</tr>`).join("");
  const partial = keys.filter((k) => models[k].status !== "ok");
  el("stats").innerHTML = head + body + (partial.length
    ? `<tr class="warn"><td colspan="${keys.length + 1}">Unvollständig: ${partial.map((k) => SHORT[k]).join(", ")} – Kennzahlen nur bis zum Abbruch.</td></tr>`
    : "");

  drawCharts(keys, obs);

  // Zeitschieber + Cursor-Marker
  cursor = { gps: null, models: {}, lines: {} };
  for (const k of keys) {
    cursor.lines[k] = L.polyline([], { color: MODEL_STYLE[k].color, weight: 1.5, dashArray: "2 4" }).addTo(cursorLayer);
    cursor.models[k] = L.circleMarker([0, 0], { radius: 7, color: "#fff", weight: 2, fillColor: MODEL_STYLE[k].color, fillOpacity: 1 })
      .addTo(cursorLayer);
  }
  cursor.gps = L.circleMarker([0, 0], { radius: 8, color: "#fff", weight: 2, fillColor: GPS_COLOR, fillOpacity: 1 }).addTo(cursorLayer);
  el("tslider").max = String(gps.length - 1);
  el("tslider").value = "0";
  el("results").hidden = false;
  updateCursor();
}

function drawArrows() {
  const { gps, models } = state.results;
  for (const k of MODEL_ORDER) modelLayers[k].arrows.clearLayers();
  if (!el("showArrows").checked) return;
  for (const k of MODEL_ORDER.filter((x) => models[x])) {
    const color = MODEL_STYLE[k].color, layer = modelLayers[k].arrows;
    let last = -Infinity;
    gps.forEach((p, i) => {
      if (p.tMs - last < 120e3) return;
      last = p.tMs;
      const w = models[k].wind[i];
      if (!w) return;
      // Pfeil = Verlagerung in 2 min mit dem Modellwind
      const len = w.spd * 120;
      const [la2, lo2] = offset(p.lat, p.lon, w.dir, len);
      L.polyline([[p.lat, p.lon], [la2, lo2]], { color, weight: 2 }).addTo(layer)
        .bindTooltip(`${fmtT(p.tMs)} UTC, ${Math.round(p.z)} m NN<br>${SHORT[k]}: ${w.spd.toFixed(1)} m/s nach ${Math.round(w.dir)}°`);
      const hl = Math.max(40, len * 0.18);
      for (const b of [w.dir + 155, w.dir - 155]) {
        L.polyline([[la2, lo2], offset(la2, lo2, b, hl)], { color, weight: 2 }).addTo(layer);
      }
    });
  }
}
el("showArrows").addEventListener("change", () => { persist(); if (state.results) drawArrows(); });

function offset(lat, lon, brgDeg, meters) {
  const dLat = (meters * Math.cos(brgDeg * D2R)) / R / D2R;
  const dLon = (meters * Math.sin(brgDeg * D2R)) / (R * Math.cos(lat * D2R)) / D2R;
  return [lat + dLat, lon + dLon];
}

function drawCharts(keys, obs) {
  const { gps, models } = state.results;
  // Höchstens ~300 Stützstellen je Diagramm -- mehr sieht man nicht.
  const step = Math.max(1, Math.ceil(gps.length / 300));
  const idx = [];
  for (let i = 0; i < gps.length; i += step) idx.push(i);
  if (idx.at(-1) !== gps.length - 1) idx.push(gps.length - 1);
  const labels = idx.map((i) => fmtHM(gps[i].tMs));
  const sepOf = (k, i) => {
    const d = models[k].points[i];
    return d ? +(dist(gps[i].lat, gps[i].lon, d.lat, d.lon) / 1000).toFixed(3) : null;
  };
  const ds = (label, data, color, extra = {}) => ({
    label, data, borderColor: color, backgroundColor: color, pointBackgroundColor: color,
    borderWidth: 2, pointRadius: 0, spanGaps: false, ...extra,
  });
  const dashOf = (k) => MODEL_STYLE[k].dash.split(" ").map(Number);
  const scatter = { borderWidth: 0, pointRadius: 2, showLine: false };

  mk("chSep", labels, keys.map((k) => ds(SHORT[k], idx.map((i) => sepOf(k, i)), MODEL_STYLE[k].color, { borderDash: dashOf(k) })),
    "km", { beginAtZero: true });
  mk("chSpd", labels, [
    ds("GPS über Grund", idx.map((i) => (obs[i] ? +obs[i].spd.toFixed(2) : null)), GPS_COLOR),
    ...keys.map((k) => ds(SHORT[k], idx.map((i) => (models[k].wind[i] ? +models[k].wind[i].spd.toFixed(2) : null)),
      MODEL_STYLE[k].color, { borderDash: dashOf(k) })),
  ], "m/s", { beginAtZero: true });
  mk("chDir", labels, [
    ds("GPS-Kurs", idx.map((i) => (obs[i] && obs[i].spd > 1.5 ? Math.round(obs[i].dir) : null)), GPS_COLOR, scatter),
    ...keys.map((k) => ds(SHORT[k], idx.map((i) => (models[k].wind[i] ? Math.round(models[k].wind[i].dir) : null)),
      MODEL_STYLE[k].color, scatter)),
  ], "° (wohin)", { min: 0, max: 360, ticks: { stepSize: 90, color: "#52514e" } });
}

function mk(id, labels, datasets, yTitle, yOpt = {}) {
  charts[id]?.destroy();
  charts[id] = new Chart(el(id), {
    type: "line",
    data: { labels, datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#3a3935", boxWidth: 14, boxHeight: 2, font: { size: 11 } } },
        tooltip: { callbacks: { title: (it) => `${it[0].label} UTC` } },
      },
      scales: {
        x: { ticks: { color: "#52514e", maxTicksLimit: 7, maxRotation: 0 }, grid: { color: "#eeede9" } },
        y: {
          title: { display: true, text: yTitle, color: "#52514e" },
          ticks: { color: "#52514e" }, grid: { color: "#eeede9" }, ...yOpt,
        },
      },
    },
  });
}

function updateCursor() {
  if (!state.results || !cursor) return;
  const { gps, models } = state.results;
  const i = +el("tslider").value, p = gps[i];
  cursor.gps.setLatLng([p.lat, p.lon]);
  const ov = obsVel(gps, i);
  const lines = [
    `<b>${fmtT(p.tMs)} UTC</b> · ${Math.round(p.z)} m NN` +
    (ov ? ` · GPS ${ov.spd.toFixed(1)} m/s nach ${Math.round(ov.dir)}°` : ""),
  ];
  for (const k of MODEL_ORDER.filter((x) => models[x])) {
    const r = models[k], d = r.points[Math.min(i, r.points.length - 1)], w = r.wind[i];
    cursor.models[k].setLatLng([d.lat, d.lon]);
    cursor.lines[k].setLatLngs([[p.lat, p.lon], [d.lat, d.lon]]);
    const after = i >= r.points.length ? " (nach Abbruch)" : "";
    lines.push(`${SHORT[k]}: ` +
      (w ? `${w.spd.toFixed(1)} m/s nach ${Math.round(w.dir)}° · ` : "") +
      `Ablage <b>${km(dist(p.lat, p.lon, d.lat, d.lon))}</b>${after}`);
  }
  el("readout").innerHTML = lines.join("<br>");
}
el("tslider").addEventListener("input", updateCursor);

// --- CSV --------------------------------------------------------------------
el("download").addEventListener("click", () => {
  const { gps, models } = state.results;
  const keys = MODEL_ORDER.filter((k) => models[k]);
  const head = ["zeit_utc", "gps_lat", "gps_lon", "gps_hoehe_m_nn", "gps_v_ms", "gps_kurs_grad"];
  for (const k of keys) head.push(`${k}_lat`, `${k}_lon`, `${k}_ablage_m`, `${k}_wind_ms`, `${k}_zugrichtung_grad`);
  const rows = [head.join(",")];
  gps.forEach((p, i) => {
    const ov = obsVel(gps, i);
    const row = [new Date(p.tMs).toISOString(), p.lat.toFixed(6), p.lon.toFixed(6), p.z.toFixed(1),
      ov ? ov.spd.toFixed(2) : "", ov ? ov.dir.toFixed(0) : ""];
    for (const k of keys) {
      const d = models[k].points[i], w = models[k].wind[i];
      row.push(d ? d.lat.toFixed(6) : "", d ? d.lon.toFixed(6) : "",
        d ? dist(p.lat, p.lon, d.lat, d.lon).toFixed(0) : "",
        w ? w.spd.toFixed(2) : "", w ? w.dir.toFixed(0) : "");
    }
    rows.push(row.join(","));
  });
  const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const base = (state.track.name || "fahrt").replace(/[^\w.-]+/g, "_");
  a.download = `hindcast_${base}_${new Date(gps[0].tMs).toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// --- Datenquelle (wie Vorhersageseite) --------------------------------------
function hostLabel(base) {
  if (base === DEV_PROXY_BASE) return "open-meteo.mah.priv.at (Dev-Proxy)";
  try { return new URL(base).host; } catch { return base; }
}
function updateSourceInfo() {
  const info = el("sourceinfo");
  const used = getApiSources().filter((x) => MODELS[x.key]);
  const fb = used.filter((x) => x.base !== API_BASE);
  info.textContent = fb.length ? ` · ⚠ Fallback: ${[...new Set(fb.map((x) => hostLabel(x.base)))].join(", ")}` : "";
  info.classList.toggle("fallback", fb.length > 0);
  info.title = used.map((x) => `${MODELS[x.key].label}: ${hostLabel(x.base)}`).join("\n");
}
onApiSourceChange(updateSourceInfo);

// --- Mobiles Bedienfeld -----------------------------------------------------
el("paneltoggle").addEventListener("click", () => {
  const collapsed = !el("panel").classList.contains("collapsed");
  el("panel").classList.toggle("collapsed", collapsed);
  el("paneltoggle").textContent = collapsed ? "▴" : "▾";
  el("paneltoggle").setAttribute("aria-expanded", String(!collapsed));
});

renderModelList();
loadArchives();
