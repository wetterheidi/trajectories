import {
  API_BASE, MODELS, SERIES_COLORS, DEFAULT_HEIGHTS,
  HEIGHT_MIN, HEIGHT_MAX, MARKER_INTERVALS, METHODS,
} from "./config.js";
import { WindField } from "./windfield.js";
import { computeTrajectory } from "./integrator.js";
import { renderCrossSection } from "./crosssection.js";
import {
  setUnits, unitState, fmtHeight, fmtWind,
  heightToDisplay, heightFromDisplay, heightSliderCfg,
} from "./units.js";

// Konsolen-Monitor: ?debug=1 an der URL oder localStorage.trajDebug = "1".
const DEBUG = new URLSearchParams(location.search).has("debug") ||
  localStorage.getItem("trajDebug") === "1";

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
setUnits(saved.units || {});
let settingsReady = false; // erst nach vollständiger Wiederherstellung speichern

function persist() {
  if (!settingsReady) return;
  const s = {
    model: el("model").value,
    refmode: el("refmode").value,
    markerIntervalSec: +el("markerint").value || 3600,
    duration: +el("duration").value || 12,
    direction: el("direction").value,
    heights: [...heightColors].map(([m, color]) => ({ m, color })),
    heightInput: +el("heightinput").value || 1000,
    start: state.start,
    timeHour: +el("timeslider").value || null,
    view: { center: map.getCenter(), zoom: map.getZoom() },
    baseLayer: activeBaseLayer,
    units: { ...unitState },
    liveMode: el("livemode").checked,
    methods: selectedMethods(),
    metExtras: el("metextras").checked,
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

// Schieber/Zahlenfeld arbeiten in der Anzeige-Einheit (m oder ft);
// intern wird alles in Metern geführt.
function applySliderCfg() {
  const cfg = heightSliderCfg();
  slider.min = cfg.min;
  slider.max = cfg.max; // Feinbereich; größere Werte über das Zahlenfeld
  slider.step = cfg.step;
  input.min = cfg.min;
  input.max = cfg.inputMax;
  input.step = cfg.step;
}
applySliderCfg();
slider.value = input.value = saved.heightInput ?? Math.round(heightToDisplay(1000));
slider.addEventListener("input", () => {
  input.value = slider.value;
  updateHeightContext();
  liveRunDebounced();
});
slider.addEventListener("change", persist);
input.addEventListener("input", () => {
  slider.value = Math.min(+input.value || +slider.min, +slider.max);
  updateHeightContext();
  liveRunDebounced();
});
input.addEventListener("keydown", (e) => { if (e.key === "Enter") addHeight(heightFromDisplay(+input.value)); });
el("addheight").addEventListener("click", () => addHeight(heightFromDisplay(+input.value)));

// --- Live-Modus: eine Trajektorie folgt dem Höhenschieber -------------------
// Das Windfeld (samt Punkt-Cache) bleibt zwischen den Läufen erhalten,
// solange Modell, Vertikaloption, Zeit und Richtung gleich bleiben — nach
// der ersten Bewegung rechnet der Schieber dann ohne Netzwerkzugriffe.
let liveDirty = false;

function liveRun() {
  if (!el("livemode").checked || !state.start || !state.meta) return;
  if (state.running) { liveDirty = true; return; }
  runTrajectories();
}

const liveRunDebounced = debounce(liveRun, 200);

function applyModeUI() {
  const live = el("livemode").checked;
  el("heightlist").hidden = live;
  el("addheight").hidden = live;
  el("heightslabel").innerHTML = live
    ? 'Starthöhe <span class="hint">(Live-Modus)</span>'
    : 'Starthöhen <span class="hint">(max. 8)</span>';
}

el("livemode").addEventListener("change", () => {
  applyModeUI();
  state.live = null;
  persist();
  liveRun();
});

// --- Methoden (Berechnungsarten): eine oder mehrere per Häkchen -------------
for (const m of METHODS) {
  const label = document.createElement("label");
  label.dataset.key = m.key;
  label.innerHTML =
    `<input type="checkbox" value="${m.key}" ${m.key === "height" ? "checked" : ""}>` +
    `<span class="chip" style="background:${m.color}"></span>${m.label}`;
  label.querySelector("input").addEventListener("change", () => {
    state.live = null; // andere Methoden brauchen ggf. andere Variablen
    persist();
  });
  el("methodlist").appendChild(label);
}

function selectedMethods() {
  return [...el("methodlist").querySelectorAll("input:checked:not(:disabled)")]
    .map((c) => c.value);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

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
if (["1", "-1"].includes(saved.direction)) el("direction").value = saved.direction;
if (Number.isFinite(saved.duration)) el("duration").value = saved.duration;
for (const id of ["refmode", "markerint", "direction", "duration", "heightinput"]) {
  el(id).addEventListener("change", persist);
}

// Modell-Vertikalgeschwindigkeit: je Modell prüfen, ob der Server die
// Variable anbietet, und die 3D-Option entsprechend schalten. Läuft beim
// Start und bei jedem Modellwechsel (Ergebnis wird je Modell gecacht).
let wVarPrefix = null;
const wPrefixByModel = new Map();

async function updateWDetection() {
  const modelKey = el("model").value;
  if (!wPrefixByModel.has(modelKey)) {
    wPrefixByModel.set(modelKey, await WindField.detectWVariable(modelKey));
  }
  wVarPrefix = wPrefixByModel.get(modelKey);
  if (modelKey !== el("model").value) return; // Modell wurde inzwischen gewechselt
  const mLabel = el("methodlist").querySelector('label[data-key="z3d"]');
  if (mLabel) {
    mLabel.querySelector("input").disabled = !wVarPrefix;
    mLabel.classList.toggle("off", !wVarPrefix);
    mLabel.title = wVarPrefix ? "" : "Server liefert noch kein w für dieses Modell";
  }
}

updateWDetection();
if (saved.start && Number.isFinite(saved.start.lat) && Number.isFinite(saved.start.lon)) {
  setStart(saved.start.lat, saved.start.lon);
}

// Einheiten-Auswahl: Wert des Höhenfelds in die neue Einheit umrechnen,
// Höhenliste und (falls offen) Querschnitt neu beschriften.
el("unitheight").value = unitState.height;
el("unitwind").value = unitState.wind;
function onUnitsChange() {
  const meters = heightFromDisplay(+input.value || 0);
  setUnits({ height: el("unitheight").value, wind: el("unitwind").value });
  applySliderCfg();
  const cfg = heightSliderCfg();
  const disp = Math.round(heightToDisplay(meters) / cfg.step) * cfg.step;
  input.value = Math.min(Math.max(disp, cfg.min), cfg.inputMax);
  slider.value = Math.min(+input.value, cfg.max);
  renderHeightList();
  updateHeightContext();
  if (!el("xsec").hidden && state.xsec) renderCrossSection(el("xsec-body"), state.xsec);
  persist();
}
el("unitheight").addEventListener("change", onUnitsChange);
el("unitwind").addEventListener("change", onUnitsChange);

if (saved.liveMode) el("livemode").checked = true;
if (Array.isArray(saved.methods) && saved.methods.length) {
  for (const c of el("methodlist").querySelectorAll("input")) {
    c.checked = saved.methods.includes(c.value);
  }
} else if (["pressure", "theta"].includes(saved.vmotion)) {
  // Migration: früher gab es statt der Häkchen ein Vertikalbewegungs-Menü.
  for (const c of el("methodlist").querySelectorAll("input")) {
    c.checked = c.value === saved.vmotion;
  }
}
applyModeUI();

if (saved.metExtras) el("metextras").checked = true;
el("metextras").addEventListener("change", () => {
  state.live = null; // Zusatzvariablen erfordern einen frischen Daten-Cache
  persist();
});

updateHeightContext();

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
  fetchStartElevation();
}

// Modell-Geländehöhe am Startort — bewusst aus der Forecast-Antwort des
// gewählten Modells (Modellorographie), damit die Anzeige zu dem passt,
// womit die Trajektorien rechnen.
async function fetchStartElevation() {
  const s = state.start;
  if (!s) return;
  const model = MODELS[el("model").value];
  state.startElevation = null;
  updateHeightContext();
  try {
    const params = new URLSearchParams({
      latitude: s.lat.toFixed(5),
      longitude: s.lon.toFixed(5),
      hourly: `wind_speed_level${model.nLevels}`,
      models: model.apiModel,
      forecast_days: "1",
    });
    const d = await (await fetch(`${API_BASE}/v1/forecast?${params}`)).json();
    if (Number.isFinite(d.elevation) && state.start === s) {
      state.startElevation = d.elevation;
      updateHeightContext();
    }
  } catch {
    /* Anzeige bleibt leer */
  }
}

/** Macht den Bezug der Starthöhe sichtbar: Einheit+Referenz am Eingabefeld,
 *  Geländehöhe am Start und die Umrechnung AGL <-> NN für den aktuellen
 *  Reglerwert. */
function updateHeightContext() {
  const mode = el("refmode").value;
  el("heightsuffix").textContent = `${heightUnit()} ${mode === "agl" ? "AGL" : "NN"}`;
  const elev = state.startElevation;
  el("startelev").textContent = elev == null ? "–" : `${fmtHeight(elev)} NN`;
  const hint = el("heighthint");
  if (elev == null) {
    hint.textContent = "";
    hint.classList.remove("error");
    return;
  }
  const h = heightFromDisplay(+input.value || 0);
  if (mode === "agl") {
    hint.textContent = `${fmtHeight(h)} über Grund ≈ ${fmtHeight(h + elev)} NN am Startort`;
    hint.classList.remove("error");
  } else if (h < elev) {
    hint.textContent = `${fmtHeight(h)} NN liegt am Startort unter Grund!`;
    hint.classList.add("error");
  } else {
    hint.textContent = `${fmtHeight(h)} NN ≈ ${fmtHeight(h - elev)} über Grund am Startort`;
    hint.classList.remove("error");
  }
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
  updateWDetection();
  fetchStartElevation(); // Modellorographie unterscheidet sich je Modell
});
el("refmode").addEventListener("change", updateHeightContext);

function updateRunButton() {
  el("run").disabled = state.running || !state.start || !state.meta;
}

// --- Berechnung -------------------------------------------------------------
el("run").addEventListener("click", runTrajectories);

async function runTrajectories() {
  const modelKey = el("model").value;
  const model = MODELS[modelKey];
  const { lat, lon } = state.start;
  const liveMode = el("livemode").checked;
  const heights = liveMode
    ? [Math.max(1, Math.round(heightFromDisplay(+input.value) || 1000))]
    : [...heightColors.keys()].sort((a, b) => a - b);
  const methods = selectedMethods();
  // Mehrere Methoden ergeben nur bei genau einer Starthöhe eine lesbare
  // Darstellung (Farbe kodiert dann die Methode statt der Höhe).
  const compareMode = methods.length > 1;
  const markerIntervalSec = +el("markerint").value;
  const mode = el("refmode").value;
  if (!methods.length) {
    return setStatus("Bitte mindestens eine Methode wählen.", true);
  }
  if (compareMode && heights.length > 1) {
    return setStatus("Mehrere Methoden bitte mit genau einer Starthöhe kombinieren.", true);
  }
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
  const xsecWasOpen = !el("xsec").hidden;
  el("xsec").hidden = true;
  state.lastRuns = null;
  state.xsec = null;
  setStatus("Berechne …");

  try {
    // Im Live-Modus das Windfeld über Läufe hinweg behalten, solange die
    // Signatur (Modell, Vertikaloption, Zeitfenster, Richtung, Startregion)
    // gleich bleibt und die Höhe ins geladene Levelfenster passt.
    const metExtras = el("metextras").checked;
    const sig = [modelKey, methods.join("+"), t0Ms, duration, direction, metExtras,
      Math.round(lat), Math.round(lon)].join("|");
    let wf;
    if (liveMode && state.live?.sig === sig && heights[0] <= state.live.spanTop) {
      wf = state.live.wf;
    } else {
      wf = new WindField(modelKey, { wVarPrefix, debug: DEBUG });
      const tEnd = t0Ms + direction * duration * 3600e3;
      const spanTop = liveMode ? Math.max(6000, ...heights) : Math.max(...heights);
      await wf.init(lat, lon, spanTop, Math.min(t0Ms, tEnd), Math.max(t0Ms, tEnd), methods, metExtras);
      state.live = liveMode ? { wf, sig, spanTop } : null;
      if (DEBUG) {
        console.debug(`[traj] Modell ${modelKey}, Methoden ${methods.join("+")}, ` +
          `Levelfenster ${wf.levels.at(-1)}–${wf.levels[0]} (${wf.levels.length} Level), ` +
          `Zeitfenster ${wf.startDate}…${wf.endDate}`);
      }
    }

    // Entweder mehrere Höhen × eine Methode oder eine Höhe × mehrere
    // Methoden (oben abgesichert).
    const jobs = heights.flatMap((heightM) => methods.map((method) => ({ heightM, method })));

    const runs = [];
    for (const { heightM, method } of jobs) {
      const style = METHODS.find((m) => m.key === method);
      const color = compareMode ? style.color : liveMode ? SERIES_COLORS[0] : colorFor(heightM);
      const dash = compareMode ? style.dash : null;
      setStatus(`Berechne ${compareMode ? style.label : fmtHeight(heightM)} …`);
      try {
        const { target, label } = await makeTarget(wf, lat, lon, heightM, mode, method, t0Ms);
        const r = await computeTrajectory({
          windAt: wf.windAt.bind(wf),
          lat0: lat, lon0: lon, target, t0Ms,
          durationHours: duration, direction, gridMeters: model.gridMeters,
          markerIntervalSec,
        });
        reportResult(r, heightM, color, label);
        runs.push({ r, color, label, heightM, method, dash });
      } catch (err) {
        // Eine scheiternde Methode/Höhe soll die übrigen nicht mitreißen.
        const line = document.createElement("div");
        line.className = "result-line";
        line.innerHTML = `<span class="chip" style="background:${color}"></span>` +
          `${compareMode ? style.label : fmtHeight(heightM)} ` +
          `<span class="note">Fehler: ${err.message}</span>`;
        el("results").appendChild(line);
      }
    }

    // Zwei Zeichen-Durchgänge: erst alle weißen Unterlagen, dann alle
    // Farblinien — sonst übermalt die Unterlage einer späteren Trajektorie
    // die früheren, wo die Pfade (fast) übereinanderliegen, und in
    // Strichlücken erschiene Weiß statt der darunterliegenden Linie.
    for (const run of runs) drawCasing(run.r);
    for (const run of runs) drawTrajectory(run.r, run.color, run.label, run.dash);
    state.lastRuns = { runs, modelKey, mode, t0Ms, duration, direction };
    el("download").disabled = runs.length === 0;

    // Querschnitt: Modellgelände entlang jedes Pfades aus dem Punkt-Cache.
    // Im Vergleichsmodus als Overlay (ein Streifen, Gelände der Referenz).
    state.xsec = {
      runs: runs.map((run) => ({
        ...run,
        terrain: run.r.points.map((p) => wf.elevationAt(p.lat, p.lon)),
      })),
      t0Ms,
      direction,
      overlay: compareMode,
    };
    // Querschnitt standardmäßig zu — nur der Knopf wird aktiv. Im
    // Live-Modus bleibt ein geöffneter Querschnitt offen und läuft mit.
    el("xsecbtn").disabled = runs.length === 0;
    if (liveMode && xsecWasOpen && runs.length) showCrossSection(true);
    setStatus("");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, true);
  } finally {
    state.running = false;
    updateRunButton();
    if (liveDirty && el("livemode").checked) {
      liveDirty = false;
      setTimeout(liveRun, 0);
    }
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

// Weiße Unterlage als Kontrast-Ausgleich auf Kartenkacheln (eigener
// Durchgang vor allen Farblinien, siehe runTrajectories).
function drawCasing(r) {
  if (r.points.length < 2) return;
  L.polyline(r.points.map((p) => [p.lat, p.lon]), {
    color: "#ffffff", weight: 6, opacity: 0.85, interactive: false,
  }).addTo(state.layers);
}

function drawTrajectory(r, color, label, dash = null) {
  if (r.points.length < 2) return;
  const latlngs = r.points.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color, weight: 3, opacity: 1, dashArray: dash }).addTo(state.layers)
    .bindTooltip(label, { sticky: true });

  for (const m of r.markers) {
    const dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
    const zLine = Number.isFinite(m.z) ? `<br>${fmtHeight(m.z)} NN` : "";
    const marker = L.circleMarker([m.lat, m.lon], {
      radius: 4, color, weight: 2, fillColor: "#ffffff", fillOpacity: 1,
    }).addTo(state.layers).bindTooltip(
      `<div class="marker-tip">${fmtTime(m.tMs)}<br>${label}<br>` +
      `${fmtWind(Math.hypot(m.u, m.v))} aus ${Math.round(dir)}°${zLine}` +
      `${m.met ? "<br><em>klicken für Details</em>" : ""}</div>`,
    );
    if (m.met) {
      const rows = [
        `<strong>${fmtTime(m.tMs)}</strong>`,
        label,
        Number.isFinite(m.z) ? `Höhe: ${fmtHeight(m.z)} NN` : null,
        `Wind: ${fmtWind(Math.hypot(m.u, m.v))} aus ${Math.round(dir)}°`,
        Number.isFinite(m.met.t) ? `T: ${m.met.t.toFixed(1)} °C` : null,
        Number.isFinite(m.met.td) ? `Td: ${m.met.td.toFixed(1)} °C` : null,
        Number.isFinite(m.met.rh) ? `RH: ${Math.round(m.met.rh)} %` : null,
        Number.isFinite(m.met.p) ? `p: ${m.met.p.toFixed(0)} hPa` : null,
        `${m.lat.toFixed(4)}°N ${m.lon.toFixed(4)}°E`,
      ];
      marker.bindPopup(`<div class="marker-tip">${rows.filter(Boolean).join("<br>")}</div>`);
    }
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
    // Ein Streifen je Trajektorie; im Overlay (Methodenvergleich) einer.
    const n = state.xsec.overlay ? 2 : state.xsec.runs.length;
    const h = Math.min(110 * n + 62, Math.round(window.innerHeight * 0.55));
    el("xsec").style.height = `${Math.max(h, 190)}px`;
    el("xsec-hint").textContent = state.xsec.overlay
      ? "Höhe über NN · Gelände entlang des Referenzpfads"
      : "Höhe über NN · Gelände entlang des jeweiligen Pfades";
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

function buildGeoJSON({ runs, modelKey, mode, t0Ms, duration, direction }) {
  const rd = (x) => Math.round(x * 1e5) / 1e5;
  const round1 = (x) => Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
  const iso = (ms) => new Date(ms).toISOString();
  const coord = (p) => Number.isFinite(p.z)
    ? [rd(p.lon), rd(p.lat), Math.round(p.z)]
    : [rd(p.lon), rd(p.lat)];
  const features = [];
  for (const { r, color, label, heightM, method } of runs) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.points.map(coord) },
      properties: {
        kind: "trajectory",
        label,
        start_height_m: heightM,
        height_reference: mode,
        vertical_motion: method,
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
          ...(m.met ? {
            temperature_c: round1(m.met.t),
            dewpoint_c: round1(m.met.td),
            relative_humidity_pct: Number.isFinite(m.met.rh) ? Math.round(m.met.rh) : null,
            pressure_hpa: round1(m.met.p),
          } : {}),
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

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function setStatus(msg, isError = false) {
  el("status").textContent = msg;
  el("status").className = isError ? "error" : "";
}

loadMeta();
