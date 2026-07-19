import {
  API_BASE, MODELS, SERIES_COLORS, DEFAULT_HEIGHTS,
  HEIGHT_MIN, HEIGHT_MAX, MARKER_INTERVALS,
} from "./config.js";
import { WindField } from "./windfield.js";
import { computeTrajectory } from "./integrator.js";
import { renderCrossSection } from "./crosssection.js";

/* global L */

const el = (id) => document.getElementById(id);

// --- Einstellungen in localStorage ------------------------------------------
const STORAGE_KEY = "trajectories.settings.v1";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

const saved = loadSettings();
let settingsReady = false; // erst nach vollständiger Wiederherstellung speichern

function persist() {
  if (!settingsReady) return;
  const s = {
    model: el("model").value,
    refmode: el("refmode").value,
    vmotion: el("vmotion").value,
    markerIntervalSec: +el("markerint").value || 3600,
    duration: +el("duration").value || 12,
    direction: el("direction").value,
    heights: [...heightColors].map(([m, color]) => ({ m, color })),
    heightInput: +el("heightinput").value || 1000,
    start: state.start,
    timeHour: +el("timeslider").value || null,
    view: { center: map.getCenter(), zoom: map.getZoom() },
    baseLayer: activeBaseLayer,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

const map = L.map("map", {
  center: saved.view?.center ? [saved.view.center.lat, saved.view.center.lng] : [50.5, 10.5],
  zoom: saved.view?.zoom ?? 6,
});
map.on("moveend", () => persist());

// Basiskarten: OSM und Esri-Hybrid (Satellitenbild + Beschriftung), wie in
// DZMaster. Die Wahl wird mitgespeichert.
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: ["a", "b", "c"],
  }),
  "Esri Satellit (hybrid)": L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
    }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      pane: "overlayPane",
      zIndex: 2,
    }),
  ], {
    attribution: "© Esri, USDA, USGS © OpenStreetMap contributors, and the GIS user community",
  }),
};
let activeBaseLayer = baseLayers[saved.baseLayer] ? saved.baseLayer : "OpenStreetMap";
baseLayers[activeBaseLayer].addTo(map);
L.control.layers(baseLayers, null, { position: "topleft" }).addTo(map);
map.on("baselayerchange", (e) => {
  activeBaseLayer = e.name;
  persist();
});

const state = {
  start: null,
  meta: null, // {t0, t1} Epochensekunden des verfügbaren Zeitraums
  layers: L.layerGroup().addTo(map),
  startMarker: null,
  running: false,
};

// --- Höhen-Auswahl: freie Höhen per Schieber, feste Farb-Slots --------------
// Map Höhe(m) -> Farbe. Eine Höhe behält ihre Farbe, solange sie in der Liste
// ist; beim Entfernen wird der Slot wieder frei.
const heightColors = new Map();

function addHeight(m) {
  m = Math.round(Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, m)));
  if (heightColors.has(m)) return;
  if (heightColors.size >= SERIES_COLORS.length) {
    return setStatus(`Maximal ${SERIES_COLORS.length} Höhen gleichzeitig.`, true);
  }
  const used = new Set(heightColors.values());
  heightColors.set(m, SERIES_COLORS.find((c) => !used.has(c)));
  renderHeightList();
  persist();
}

function removeHeight(m) {
  heightColors.delete(m);
  renderHeightList();
  persist();
}

function renderHeightList() {
  const list = el("heightlist");
  list.innerHTML = "";
  for (const m of [...heightColors.keys()].sort((a, b) => a - b)) {
    const item = document.createElement("div");
    item.className = "height-item";
    item.innerHTML =
      `<span class="chip" style="background:${heightColors.get(m)}"></span>` +
      `<span class="mono">${fmtHeight(m)}</span>` +
      `<button class="rm" title="Entfernen">×</button>`;
    item.querySelector(".rm").addEventListener("click", () => removeHeight(m));
    list.appendChild(item);
  }
  el("addheight").disabled = heightColors.size >= SERIES_COLORS.length;
}

const slider = el("heightslider"), input = el("heightinput");
slider.min = input.min = HEIGHT_MIN;
slider.max = 6000; // Feinbereich; größere Werte über das Zahlenfeld
slider.step = 10;
input.max = HEIGHT_MAX;
input.step = 10;
slider.value = input.value = saved.heightInput ?? 1000;
slider.addEventListener("input", () => { input.value = slider.value; });
slider.addEventListener("change", persist);
input.addEventListener("input", () => { slider.value = Math.min(+input.value || HEIGHT_MIN, +slider.max); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter") addHeight(+input.value); });
el("addheight").addEventListener("click", () => addHeight(+input.value));

// Gespeicherte Höhenliste wiederherstellen (Farben nur, wenn sie noch zur
// Palette gehören und eindeutig sind — sonst neu zuweisen), sonst Standard.
const savedHeights = Array.isArray(saved.heights) ? saved.heights : null;
if (savedHeights?.length) {
  const validColors = savedHeights.every(({ m, color }, i) =>
    Number.isFinite(m) && SERIES_COLORS.includes(color) &&
    savedHeights.findIndex((h) => h.color === color) === i);
  if (validColors) {
    for (const { m, color } of savedHeights.slice(0, SERIES_COLORS.length)) {
      heightColors.set(Math.round(m), color);
    }
    renderHeightList();
  } else {
    savedHeights.forEach(({ m }) => addHeight(m));
  }
} else {
  DEFAULT_HEIGHTS.forEach(addHeight);
}

// --- Markenabstand ----------------------------------------------------------
for (const min of MARKER_INTERVALS) {
  const opt = document.createElement("option");
  opt.value = min * 60;
  opt.textContent = min < 60 ? `${min} min` : `${min / 60} h`;
  if (min * 60 === (saved.markerIntervalSec ?? 3600)) opt.selected = true;
  el("markerint").appendChild(opt);
}

// --- Übrige Einstellungen wiederherstellen und Änderungen speichern ---------
if (MODELS[saved.model]) el("model").value = saved.model;
if (["agl", "amsl"].includes(saved.refmode)) el("refmode").value = saved.refmode;
if (["height", "pressure", "theta"].includes(saved.vmotion)) el("vmotion").value = saved.vmotion;
if (["1", "-1"].includes(saved.direction)) el("direction").value = saved.direction;
if (Number.isFinite(saved.duration)) el("duration").value = saved.duration;
for (const id of ["refmode", "vmotion", "markerint", "direction", "duration", "heightinput"]) {
  el(id).addEventListener("change", persist);
}

// Modell-Vertikalgeschwindigkeit: Option freischalten, sobald der Server
// die Variable anbietet (Michael arbeitet daran).
let wVarPrefix = null;
(async () => {
  wVarPrefix = await WindField.detectWVariable("icon_eu");
  const opt = el("vmotion").querySelector('option[value="z3d"]');
  if (wVarPrefix) {
    opt.disabled = false;
    if (saved.vmotion === "z3d") {
      el("vmotion").value = "z3d";
    }
  } else {
    opt.textContent = "Modell-Vertikalbewegung (Server liefert noch kein w)";
  }
})();
if (saved.start && Number.isFinite(saved.start.lat) && Number.isFinite(saved.start.lon)) {
  setStart(saved.start.lat, saved.start.lon);
}
settingsReady = true;

// --- Startpunkt per Klick / Marker ziehen -----------------------------------
map.on("click", (e) => setStart(e.latlng.lat, e.latlng.lng));

function setStart(lat, lon) {
  state.start = { lat, lon };
  el("startpos").textContent = `${lat.toFixed(3)}°N ${lon.toFixed(3)}°E`;
  if (!state.startMarker) {
    state.startMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    state.startMarker.on("dragend", () => {
      const p = state.startMarker.getLatLng();
      setStart(p.lat, p.lng);
    });
  } else {
    state.startMarker.setLatLng([lat, lon]);
  }
  updateRunButton();
  persist();
}

// --- Zeitschieber aus meta.json des gewählten Modells -----------------------
async function loadMeta() {
  const model = MODELS[el("model").value];
  el("status").textContent = "Lade Modelllauf-Info …";
  el("status").className = "";
  try {
    const meta = await (await fetch(`${API_BASE}/data/${model.dataset}/static/meta.json`)).json();
    const t0 = meta.last_run_initialisation_time - 24 * 3600; // Vorlauf für Rückwärts/ältere Starts
    const t1 = meta.data_end_time;
    state.meta = { t0, t1 };
    const slider = el("timeslider");
    const prev = +slider.value || null;
    slider.min = Math.ceil(t0 / 3600);
    slider.max = Math.floor(t1 / 3600);
    // Beim ersten Laden gespeicherte Startzeit übernehmen, bei Modellwechsel
    // die aktuelle behalten — jeweils auf den verfügbaren Zeitraum begrenzt.
    const want = prev ?? (Number.isFinite(saved.timeHour) ? saved.timeHour : null)
      ?? Math.round(Date.now() / 3600e3);
    slider.value = Math.min(Math.max(want, +slider.min), +slider.max);
    el("runinfo").textContent =
      ` · Lauf ${fmtTime(meta.last_run_initialisation_time * 1000)}, Daten bis ${fmtTime(t1 * 1000)}`;
    updateTimeLabel();
    el("status").textContent = "";
  } catch (err) {
    el("status").textContent = `Modelllauf-Info nicht erreichbar: ${err.message}`;
    el("status").className = "error";
    state.meta = null;
  }
  updateRunButton();
}

function updateTimeLabel() {
  el("timelabel").textContent = fmtTime(+el("timeslider").value * 3600e3);
}

el("timeslider").addEventListener("input", updateTimeLabel);
el("timeslider").addEventListener("change", persist);
el("model").addEventListener("change", () => {
  persist();
  loadMeta();
});

function updateRunButton() {
  el("run").disabled = state.running || !state.start || !state.meta;
}

// --- Berechnung -------------------------------------------------------------
el("run").addEventListener("click", runTrajectories);

async function runTrajectories() {
  const modelKey = el("model").value;
  const model = MODELS[modelKey];
  const { lat, lon } = state.start;
  const heights = [...heightColors.keys()].sort((a, b) => a - b);
  const markerIntervalSec = +el("markerint").value;
  const mode = el("refmode").value;
  const vmotion = el("vmotion").value;
  const direction = +el("direction").value;
  const duration = Math.min(72, Math.max(1, +el("duration").value || 12));
  const t0Ms = +el("timeslider").value * 3600e3;

  if (!heights.length) return setStatus("Bitte mindestens eine Höhe wählen.", true);
  const b = model.bbox;
  if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) {
    return setStatus(`Startpunkt liegt außerhalb des ${model.label}-Gebiets.`, true);
  }

  state.running = true;
  updateRunButton();
  state.layers.clearLayers();
  el("results").innerHTML = "";
  el("download").disabled = true;
  el("xsecbtn").disabled = true;
  el("xsec").hidden = true;
  state.lastRuns = null;
  state.xsec = null;
  setStatus("Berechne …");

  try {
    const wf = new WindField(modelKey, { wVarPrefix });
    const tEnd = t0Ms + direction * duration * 3600e3;
    await wf.init(lat, lon, Math.max(...heights), Math.min(t0Ms, tEnd), Math.max(t0Ms, tEnd), vmotion);

    const runs = [];
    for (const heightM of heights) {
      setStatus(`Berechne ${fmtHeight(heightM)} …`);
      const { target, label } = await makeTarget(wf, lat, lon, heightM, mode, vmotion, t0Ms);
      const r = await computeTrajectory({
        windAt: wf.windAt.bind(wf),
        lat0: lat, lon0: lon, target, t0Ms,
        durationHours: duration, direction, gridMeters: model.gridMeters,
        markerIntervalSec,
      });
      const color = colorFor(heightM);
      drawTrajectory(r, color, label);
      reportResult(r, heightM, color, label);
      runs.push({ r, color, label, heightM });
    }
    state.lastRuns = { runs, modelKey, mode, vmotion, t0Ms, duration, direction };
    el("download").disabled = runs.length === 0;

    // Querschnitt: Modellgelände entlang jedes Pfades aus dem Punkt-Cache.
    state.xsec = {
      runs: runs.map((run) => ({
        ...run,
        terrain: run.r.points.map((p) => wf.elevationAt(p.lat, p.lon)),
      })),
      t0Ms,
      direction,
    };
    el("xsecbtn").disabled = runs.length === 0;
    if (runs.length) showCrossSection(true);
    setStatus("");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, true);
  } finally {
    state.running = false;
    updateRunButton();
  }
}

/** Zielfläche je Starthöhe: bei isobar/isentrop wird p0 bzw. θ0 am
 *  Startpunkt diagnostiziert und dann konstant gehalten. */
async function makeTarget(wf, lat, lon, heightM, mode, vmotion, t0Ms) {
  const ref = mode.toUpperCase();
  if (vmotion === "height") {
    return { target: { type: "height", mode, value: heightM }, label: `${fmtHeight(heightM)} ${ref}` };
  }
  const d = await wf.diagnoseAt(lat, lon, heightM, mode, t0Ms);
  if (d.error) throw new Error(d.error);
  if (vmotion === "pressure") {
    return { target: { type: "pressure", value: d.p }, label: `${fmtHeight(heightM)} → ${d.p.toFixed(0)} hPa` };
  }
  if (vmotion === "theta") {
    return { target: { type: "theta", value: d.theta }, label: `${fmtHeight(heightM)} → θ ${d.theta.toFixed(1)} K` };
  }
  return { target: { type: "z3d", value: d.zAmsl }, label: `${fmtHeight(heightM)} ${ref} (3D)` };
}

function drawTrajectory(r, color, label) {
  if (r.points.length < 2) return;
  const latlngs = r.points.map((p) => [p.lat, p.lon]);
  // Weiße Unterlage als Kontrast-Ausgleich auf Kartenkacheln.
  L.polyline(latlngs, { color: "#ffffff", weight: 6, opacity: 0.85, interactive: false })
    .addTo(state.layers);
  L.polyline(latlngs, { color, weight: 3, opacity: 1 }).addTo(state.layers)
    .bindTooltip(label, { sticky: true });

  for (const m of r.markers) {
    const spd = Math.hypot(m.u, m.v) * 3.6;
    const dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
    const zLine = Number.isFinite(m.z) ? `<br>${Math.round(m.z)} m NN` : "";
    L.circleMarker([m.lat, m.lon], {
      radius: 4, color, weight: 2, fillColor: "#ffffff", fillOpacity: 1,
    }).addTo(state.layers).bindTooltip(
      `<div class="marker-tip">${fmtTime(m.tMs)}<br>${label}<br>` +
      `${Math.round(spd)} km/h aus ${Math.round(dir)}°${zLine}</div>`,
    );
  }
}

function reportResult(r, heightM, color, label) {
  const line = document.createElement("div");
  line.className = "result-line";
  const end = r.points.at(-1);
  const note = r.status === "stopped"
    ? `gestoppt ${fmtTime(end.tMs)}: ${r.reason}`
    : `bis ${fmtTime(end.tMs)}`;
  line.innerHTML =
    `<span class="chip" style="background:${color}"></span>` +
    `${label} <span class="note">${note}</span>`;
  el("results").appendChild(line);
}

// --- Querschnitt ------------------------------------------------------------
function showCrossSection(show) {
  el("xsec").hidden = !show;
  el("xsecbtn").textContent = show ? "Querschnitt ausblenden" : "Querschnitt anzeigen";
  if (show && state.xsec) {
    // Ein Streifen je Trajektorie: Panelhöhe an die Anzahl anpassen.
    const n = state.xsec.runs.length;
    const h = Math.min(110 * n + 62, Math.round(window.innerHeight * 0.55));
    el("xsec").style.height = `${Math.max(h, 190)}px`;
    renderCrossSection(el("xsec-body"), state.xsec);
  }
}

el("xsecbtn").addEventListener("click", () => showCrossSection(el("xsec").hidden));
el("xsec-close").addEventListener("click", () => showCrossSection(false));
window.addEventListener("resize", () => {
  if (!el("xsec").hidden && state.xsec) renderCrossSection(el("xsec-body"), state.xsec);
});

// --- GeoJSON-Export ---------------------------------------------------------
el("download").addEventListener("click", () => {
  if (!state.lastRuns) return;
  const blob = new Blob([JSON.stringify(buildGeoJSON(state.lastRuns))], {
    type: "application/geo+json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const stamp = new Date(state.lastRuns.t0Ms).toISOString().slice(0, 16)
    .replace(/[-:]/g, "").replace("T", "_");
  a.download = `trajektorien_${state.lastRuns.modelKey}_${stamp}Z.geojson`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function buildGeoJSON({ runs, modelKey, mode, vmotion, t0Ms, duration, direction }) {
  const rd = (x) => Math.round(x * 1e5) / 1e5;
  const iso = (ms) => new Date(ms).toISOString();
  const coord = (p) => Number.isFinite(p.z)
    ? [rd(p.lon), rd(p.lat), Math.round(p.z)]
    : [rd(p.lon), rd(p.lat)];
  const features = [];
  for (const { r, color, label, heightM } of runs) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.points.map(coord) },
      properties: {
        kind: "trajectory",
        label,
        start_height_m: heightM,
        height_reference: mode,
        vertical_motion: vmotion,
        model: modelKey,
        direction: direction > 0 ? "forward" : "backward",
        start_time: iso(t0Ms),
        end_time: iso(r.points.at(-1).tMs),
        duration_requested_h: duration,
        status: r.status,
        stop_reason: r.reason,
        color,
        times: r.points.map((p) => iso(p.tMs)),
      },
    });
    for (const m of r.markers) {
      const spd = Math.hypot(m.u, m.v) * 3.6;
      const dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coord(m) },
        properties: {
          kind: "marker",
          label,
          time: iso(m.tMs),
          wind_speed_kmh: Math.round(spd),
          wind_direction_deg: Math.round(dir),
          color,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

// --- Helfer -----------------------------------------------------------------
function colorFor(heightM) {
  return heightColors.get(heightM) || "#0b0b0b";
}

function fmtHeight(m) {
  return `${m} m`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function setStatus(msg, isError = false) {
  el("status").textContent = msg;
  el("status").className = isError ? "error" : "";
}

loadMeta();
