import {
  API_BASE, MODELS, SERIES_COLORS, DEFAULT_HEIGHTS,
  HEIGHT_MIN, HEIGHT_MAX, MARKER_INTERVALS, METHODS,
} from "./config.js";
import { WindField } from "./windfield.js";
import { computeTrajectory } from "./integrator.js";
import { renderCrossSection } from "./crosssection.js";
import {
  setUnits, unitState, fmtHeight, fmtWind, heightUnit,
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
    activeHeight,
    barMax,
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
  // Live-Modus: die „gepinnten" (inaktiven) Trajektorien bleiben stehen,
  // während nur die aktive Linie live neu gezeichnet wird. pinLayers wird
  // zuerst zur Karte gefügt, damit die aktive Linie (layers) darüber liegt.
  pinLayers: L.layerGroup().addTo(map),
  layers: L.layerGroup().addTo(map),
  pinRuns: new Map(), // Höhe(m) -> berechneter Run, damit Pins beim Scrubben nicht neu rechnen
  pinKey: "",         // Satz der aktuell gezeichneten Pin-Höhen (für „nur bei Änderung neu zeichnen")
  startMarker: null,
  running: false,
};

// --- Höhen-Auswahl: Höhenbalken mit anklickbaren Punkten --------------------
// Map Höhe(m) -> Farbe. Eine Höhe behält ihre Farbe, solange sie am Balken
// ist; beim Entfernen wird der Farb-Slot wieder frei. `activeHeight` ist der
// hervorgehobene Punkt — er entscheidet beim Methodenvergleich, an welcher
// Höhe verglichen wird.
const heightColors = new Map();
let activeHeight = null;
const bar = el("heightbar");

// Oberes Ende der Höhenbalken-Skala, in den Einstellungen wählbar (Default
// 6 km). HEIGHT_MAX bleibt die absolute Obergrenze für diese Auswahl.
const BAR_MAX_OPTIONS = [3000, 4000, 5000, 6000, 8000, 10000];
let barMax = BAR_MAX_OPTIONS.includes(saved.barMax) ? saved.barMax : 6000;

function addHeight(m) {
  m = Math.round(Math.min(barMax, Math.max(HEIGHT_MIN, m)));
  if (heightColors.has(m)) { activeHeight = m; renderBar(); return true; }
  if (heightColors.size >= SERIES_COLORS.length) {
    setStatus(`Maximal ${SERIES_COLORS.length} Höhen gleichzeitig.`, true);
    return false;
  }
  const used = new Set(heightColors.values());
  heightColors.set(m, SERIES_COLORS.find((c) => !used.has(c)));
  activeHeight = m;
  renderBar();
  persist();
  return true;
}

function removeHeight(m) {
  heightColors.delete(m);
  if (activeHeight === m) {
    const keys = [...heightColors.keys()].sort((a, b) => a - b);
    activeHeight = keys.length ? keys[0] : null;
  }
  renderBar();
  persist();
}

// --- Höhenbalken: Skala, Umrechnung Pixel<->Höhe, Rendern -------------------
// Der Balken bildet 0…barMax mit einer Wurzel-Skala ab (Grund unten, hohe
// Werte oben): der häufig genutzte untere Bereich wird gespreizt, oben wird
// gestaucht. Die beschrifteten Ticks machen die Abstände transparent.
function metersToFrac(m) {
  return Math.sqrt(Math.min(1, Math.max(0, m / barMax)));
}

// Oben und unten einen Rand freilassen, damit die Endbeschriftungen („Grund",
// „10 km") nicht vom overflow:hidden des Lineals angeschnitten werden. Die
// nutzbare Skala liegt so zwischen BAR_PAD und (1 − BAR_PAD) der Balkenhöhe.
const BAR_PAD = 0.05;
function posPct(m) {
  return (BAR_PAD + metersToFrac(m) * (1 - 2 * BAR_PAD)) * 100;
}

// Rastert eine Höhe auf die Schrittweite der aktuellen Einheit und begrenzt
// sie auf den zulässigen Bereich.
function snapMeters(m) {
  const cfg = heightSliderCfg();
  const disp = Math.round(heightToDisplay(m) / cfg.step) * cfg.step;
  const mm = heightFromDisplay(Math.min(Math.max(disp, cfg.min), cfg.inputMax));
  return Math.round(Math.min(barMax, Math.max(HEIGHT_MIN, mm)));
}

function yToMeters(clientY) {
  const r = bar.getBoundingClientRect();
  const raw = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
  // Rand herausrechnen, dann Wurzel-Skala umkehren.
  const frac = Math.min(1, Math.max(0, (raw - BAR_PAD) / (1 - 2 * BAR_PAD)));
  return snapMeters(frac * frac * barMax);
}

// Gitterlinien passend zu barMax: „Grund" und Maximum immer, dazwischen runde
// Werte mit ~5 Linien Zielabstand. Werte in der Anzeige-Einheit.
function niceStep(maxDisp) {
  const steps = unitState.height === "ft" ? [1000, 2500, 5000, 10000] : [500, 1000, 2000, 2500, 5000];
  const raw = maxDisp / 5;
  return steps.find((s) => raw <= s) ?? steps[steps.length - 1];
}

function tickValues() {
  const maxDisp = Math.round(heightToDisplay(barMax));
  const step = niceStep(maxDisp);
  const ticks = [];
  for (let v = 0; v < maxDisp - step * 0.35; v += step) ticks.push(v);
  ticks.push(maxDisp);
  return ticks;
}

function tickLabel(v) {
  // Der Skalen-Nullpunkt ist bei AGL der Boden, bei AMSL der Meeresspiegel.
  if (v === 0) return el("refmode").value === "amsl" ? "NN" : "Grund";
  const k = Math.round(v / 100) / 10; // Tausender mit einer Nachkommastelle
  return unitState.height === "ft" ? `${k}k ft` : `${k} km`;
}

function renderBar() {
  const live = el("livemode").checked;
  const compare = selectedMethods().length > 1;
  const cfg = heightSliderCfg();
  const editMax = Math.min(cfg.inputMax, Math.round(heightToDisplay(barMax)));
  const mode = el("refmode").value;
  const elev = state.startElevation;
  let html = "";

  // Modellgelände (nur bei NN-Bezug sinnvoll): schraffierte Fläche vom
  // Meeresspiegel bis zur Geländehöhe, deren Oberkante als „Grund" markiert.
  if (mode === "amsl" && elev != null) {
    const bottom = posPct(0);
    const top = posPct(elev);
    html += `<div class="bar-terrain" style="bottom:${bottom}%;height:${top - bottom}%"></div>` +
      `<div class="bar-groundline" style="bottom:${top}%"></div>` +
      `<div class="bar-ticklabel bar-groundlabel" style="bottom:${top}%">Grund</div>`;
  }

  for (const v of tickValues()) {
    const pos = posPct(heightFromDisplay(v));
    html += `<div class="bar-tick" style="bottom:${pos}%"></div>` +
      `<div class="bar-ticklabel" style="bottom:${pos}%">${tickLabel(v)}</div>`;
  }

  // Im Lineal nur die farbigen Striche (Klick-/Ziehziel), die Beschriftung
  // steht in einer eigenen Spalte rechts daneben. Der aktive Punkt trägt dort
  // ein Editierfeld für den genauen Wert.
  const entries = [...heightColors.entries()].sort((a, b) => a[0] - b[0]);
  let labelHtml = "";
  for (const [m, color] of entries) {
    const pos = posPct(m);
    const isActive = m === activeHeight;
    const dim = compare && !isActive;
    const cls = `${isActive ? " active" : ""}${dim ? " dim" : ""}`;
    html += `<div class="bar-marker${cls}" data-m="${m}" style="bottom:${pos}%">` +
      `<span class="bar-line" style="background:${color}"></span></div>`;
    const value = isActive
      ? `<input type="number" class="bar-edit mono" value="${Math.round(heightToDisplay(m))}" ` +
        `min="${cfg.min}" max="${editMax}" step="${cfg.step}">` +
        `<span class="bar-unit hint">${heightUnit()}</span>`
      : `<span class="bar-label mono">${fmtHeight(m)}</span>`;
    labelHtml += `<div class="bar-labelrow${cls}" data-m="${m}" style="bottom:${pos}%">` +
      `<span class="bar-swatch" style="background:${color}"></span>${value}` +
      `<button class="bar-rm" data-m="${m}" title="Entfernen" tabindex="-1">×</button>` +
      `</div>`;
  }
  // Modell-Geländehöhe rechts neben der Grundlinie (bei AGL am unteren Rand,
  // bei AMSL an der Geländeoberkante).
  if (elev != null) {
    const groundPos = posPct(mode === "amsl" ? elev : 0);
    labelHtml += `<div class="bar-groundinfo" style="bottom:${groundPos}%">${fmtHeight(elev)} NN</div>`;
  }
  bar.innerHTML = html;
  el("heightbar-labels").innerHTML = labelHtml;

  updateActiveHint();
}

// Hinweis, welcher Punkt beim Methodenvergleich verglichen wird.
function updateActiveHint() {
  const hint = el("activehint");
  if (selectedMethods().length <= 1) {
    hint.textContent = "";
    hint.classList.remove("accent");
    return;
  }
  hint.textContent = activeHeight != null
    ? `Vergleich bei ${fmtHeight(activeHeight)} — anderen Balkenpunkt anklicken zum Wechseln`
    : "Bitte einen Höhenpunkt für den Vergleich wählen";
  hint.classList.add("accent");
}

// --- Balken-Interaktion: klicken = anlegen/aktivieren, ziehen = verschieben,
// Wert in der aktiven Beschriftung direkt editierbar ------------------------
let drag = null;

// Im Live-Modus zieht jede Änderung der aktiven Höhe eine sofortige
// Neuberechnung nach sich.
function maybeLive() {
  if (el("livemode").checked) liveRunDebounced();
}

// Höhe eines Punkts ändern, ohne einen bereits belegten Wert zu überschreiben.
function moveHeight(fromM, toM) {
  if (toM === fromM || heightColors.has(toM)) return false;
  const color = heightColors.get(fromM);
  heightColors.delete(fromM);
  heightColors.set(toM, color);
  if (activeHeight === fromM) activeHeight = toM;
  return true;
}

bar.addEventListener("pointerdown", (e) => {
  bar.setPointerCapture(e.pointerId);
  const markerEl = e.target.closest(".bar-marker");
  const m = markerEl ? +markerEl.dataset.m : yToMeters(e.clientY);
  if (markerEl || heightColors.has(m)) {
    activeHeight = m;
    renderBar();
    updateHeightContext();
    drag = { m };
    maybeLive();
    return;
  }
  // Leere Stelle: neuen Punkt anlegen (wird aktiv) und gleich ziehbar machen.
  if (addHeight(m)) { drag = { m }; updateHeightContext(); maybeLive(); }
});

bar.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const m = yToMeters(e.clientY);
  if (!moveHeight(drag.m, m)) return;
  drag.m = m;
  renderBar();
  updateHeightContext();
  maybeLive();
});

bar.addEventListener("pointerup", () => {
  if (drag) persist();
  drag = null;
});

// Beschriftungsspalte: × entfernt den Punkt; Klick auf eine noch nicht aktive
// Zeile aktiviert sie und fokussiert das Editierfeld.
el("heightbar-labels").addEventListener("click", (e) => {
  const rm = e.target.closest(".bar-rm");
  if (rm) { removeHeight(+rm.dataset.m); maybeLive(); return; }
  const row = e.target.closest(".bar-labelrow");
  if (!row) return;
  const m = +row.dataset.m;
  if (m === activeHeight) return; // schon aktiv → nicht neu rendern (Fokus behalten)
  activeHeight = m;
  renderBar();
  updateHeightContext();
  persist();
  maybeLive();
  const edit = el("heightbar-labels").querySelector(".bar-labelrow.active .bar-edit");
  if (edit) { edit.focus(); edit.select(); }
});

// Editierfeld der aktiven Höhe: bei Enter/Verlassen den Wert übernehmen.
el("heightbar-labels").addEventListener("change", (e) => {
  if (!e.target.classList.contains("bar-edit")) return;
  const oldM = +e.target.closest(".bar-labelrow").dataset.m;
  if (moveHeight(oldM, snapMeters(heightFromDisplay(+e.target.value)))) {
    persist();
    maybeLive();
  }
  renderBar(); // Wert normalisieren bzw. bei Kollision zurücksetzen
  updateHeightContext();
});

// Tastatur: aktiven Punkt mit Pfeil hoch/runter um eine Schrittweite bewegen.
bar.addEventListener("keydown", (e) => {
  if (activeHeight == null) return;
  const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  const stepM = heightFromDisplay(heightSliderCfg().step);
  if (moveHeight(activeHeight, snapMeters(activeHeight + dir * stepM))) {
    renderBar();
    updateHeightContext();
    persist();
    maybeLive();
  }
});

// --- Live-Modus: die aktive Höhe rechnet bei jeder Änderung sofort neu -------
// Das Windfeld (samt Punkt-Cache) bleibt zwischen den Läufen erhalten,
// solange Modell, Vertikaloption, Zeit und Richtung gleich bleiben — nach
// der ersten Bewegung rechnet der aktive Punkt dann ohne Netzwerkzugriffe.
let liveDirty = false;

function liveRun() {
  if (!el("livemode").checked || !state.start || !state.meta) return;
  if (state.running) { liveDirty = true; return; }
  runTrajectories();
}

const liveRunDebounced = debounce(liveRun, 200);

function applyModeUI() {
  const live = el("livemode").checked;
  el("heightslabel").innerHTML = live
    ? 'Starthöhen <span class="hint">(Live: aktive Höhe folgt dem Balken)</span>'
    : 'Starthöhen <span class="hint">(max. 8, Balken anklicken)</span>';
  renderBar();
}

el("livemode").addEventListener("change", () => {
  applyModeUI();
  state.live = null;
  // Beim Verlassen des Live-Modus bleiben alle Trajektorien sichtbar (aktive
  // Linie + Pins). Ein späterer „echter" Lauf zeichnet ohnehin alles neu.
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
    renderBar(); // Ausgrauen/Aktiv-Hinweis hängen am Vergleichsmodus
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
  } else {
    savedHeights.forEach(({ m }) => addHeight(m));
  }
} else {
  DEFAULT_HEIGHTS.forEach(addHeight);
}
// Migration: ohne gespeichertes Lineal-Maximum das kleinste passende wählen,
// damit vorhandene Höhen sichtbar bleiben (aber mindestens den 6-km-Default).
if (!BAR_MAX_OPTIONS.includes(saved.barMax) && heightColors.size) {
  const maxH = Math.max(...heightColors.keys());
  barMax = Math.max(6000, BAR_MAX_OPTIONS.find((v) => v >= maxH) ?? HEIGHT_MAX);
}
// Aktiven Punkt wiederherstellen, sonst den untersten nehmen.
if (Number.isFinite(saved.activeHeight) && heightColors.has(Math.round(saved.activeHeight))) {
  activeHeight = Math.round(saved.activeHeight);
} else if (heightColors.size) {
  activeHeight = [...heightColors.keys()].sort((a, b) => a - b)[0];
}
renderBar();

// --- Markenabstand ----------------------------------------------------------
for (const min of MARKER_INTERVALS) {
  const opt = document.createElement("option");
  opt.value = min * 60;
  opt.textContent = min < 60 ? `${min} min` : `${min / 60} h`;
  if (min * 60 === (saved.markerIntervalSec ?? 3600)) opt.selected = true;
  el("markerint").appendChild(opt);
}

// --- Lineal-Maximum (Höhenbalken) -------------------------------------------
for (const v of BAR_MAX_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = v;
  opt.textContent = `${v / 1000} km`;
  if (v === barMax) opt.selected = true;
  el("barmax").appendChild(opt);
}
el("barmax").addEventListener("change", () => {
  barMax = +el("barmax").value;
  // Höhen oberhalb des neuen Maximums fallen weg.
  for (const m of [...heightColors.keys()]) if (m > barMax) removeHeight(m);
  renderBar();
  updateHeightContext();
  persist();
});

// --- Übrige Einstellungen wiederherstellen und Änderungen speichern ---------
if (MODELS[saved.model]) el("model").value = saved.model;
if (["agl", "amsl"].includes(saved.refmode)) el("refmode").value = saved.refmode;
if (["1", "-1"].includes(saved.direction)) el("direction").value = saved.direction;
if (Number.isFinite(saved.duration)) el("duration").value = saved.duration;
updateDirectionLabels();
for (const id of ["markerint", "direction", "duration"]) {
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

// Einheiten-Auswahl: Balken (samt Editierfeld) und, falls offen, Querschnitt
// in der neuen Einheit neu beschriften.
el("unitheight").value = unitState.height;
el("unitwind").value = unitState.wind;
function onUnitsChange() {
  setUnits({ height: el("unitheight").value, wind: el("unitwind").value });
  renderBar();
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
  renderBar();
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
      renderBar(); // Terrain-Schraffur am Balken (NN-Bezug) aktualisieren
    }
  } catch {
    /* Anzeige bleibt leer */
  }
}

/** Macht den Bezug der aktiven Starthöhe sichtbar: Geländehöhe am Start und
 *  die Umrechnung AGL <-> NN für den aktiven Höhenpunkt. */
function updateHeightContext() {
  const mode = el("refmode").value;
  const elev = state.startElevation;
  const hint = el("heighthint");
  hint.classList.remove("error");
  const h = activeHeight;
  if (h == null) { hint.textContent = ""; return; }
  const ref = mode === "agl" ? "über Grund" : "NN";
  const ort = +el("direction").value === -1 ? "am Zielort" : "am Startort";
  if (elev == null) {
    hint.textContent = `Aktiv: ${fmtHeight(h)} ${ref}`;
  } else if (mode === "agl") {
    hint.textContent = `Aktiv: ${fmtHeight(h)} über Grund ≈ ${fmtHeight(h + elev)} NN ${ort}`;
  } else if (h < elev) {
    hint.textContent = `Aktiv: ${fmtHeight(h)} NN liegt ${ort} unter Grund!`;
    hint.classList.add("error");
  } else {
    hint.textContent = `Aktiv: ${fmtHeight(h)} NN ≈ ${fmtHeight(h - elev)} über Grund ${ort}`;
  }
}

// --- Zeitschieber aus meta.json des gewählten Modells -----------------------
async function loadMeta() {
  const model = MODELS[el("model").value];
  el("status").textContent = "Lade Modelllauf-Info …";
  el("status").className = "";
  try {
    const meta = await (await fetch(`${API_BASE}/data/${model.dataset}/static/meta.json`)).json();
    // Der Server hält mehrere Tage Archiv (geprüft ≥5 d) — für Rückwärts-
    // trajektorien großzügiger Vorlauf; die echte Kante meldet der Integrator.
    const t0 = meta.last_run_initialisation_time - PAST_HOURS * 3600;
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
    updateReachHint();
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

// Vergangenheits-Horizont für den Zeitschieber (der Server hält mehrere Tage
// Archiv). Die echte Datenkante meldet ansonsten der Integrator.
const PAST_HOURS = 72;

// Bei Rückwärtstrajektorien ist der gesetzte Punkt/Zeitpunkt die Ankunft.
function updateDirectionLabels() {
  const back = +el("direction").value === -1;
  el("pointlabel").textContent = back ? "Zielpunkt" : "Startpunkt";
  el("timeheadlabel").innerHTML = `${back ? "Zielzeit" : "Startzeit"} <span class="hint">(UTC)</span>`;
}

// Vorab-Hinweis, wie weit die Daten in der gewählten Richtung ab dem
// gewählten Zeitpunkt reichen — nur Transparenz, kein harter Block.
function updateReachHint() {
  const box = el("reachhint");
  if (!state.meta) { box.textContent = ""; box.classList.remove("error"); return; }
  const dir = +el("direction").value;
  const dur = Math.min(72, Math.max(1, +el("duration").value || 12));
  const t0Ms = +el("timeslider").value * 3600e3;
  const back = dir === -1;
  const edgeMs = (back ? state.meta.t0 : state.meta.t1) * 1000;
  const availH = Math.max(0, (back ? t0Ms - edgeMs : edgeMs - t0Ms) / 3600e3);
  const word = back ? "rückwärts" : "vorwärts";
  if (availH < dur) {
    box.textContent = `Nur ${Math.floor(availH)} h Daten ${word} (bis ${fmtTime(edgeMs)}) — Trajektorie endet dort.`;
    box.classList.add("error");
  } else {
    box.textContent = `${dur} h ${word} bis ${fmtTime(t0Ms + dir * dur * 3600e3)} — innerhalb der Daten.`;
    box.classList.remove("error");
  }
}

el("timeslider").addEventListener("input", () => { updateTimeLabel(); updateReachHint(); });
el("timeslider").addEventListener("change", persist);
el("duration").addEventListener("input", updateReachHint);
el("direction").addEventListener("change", () => {
  updateDirectionLabels();
  updateHeightContext(); // „am Startort"/„am Zielort" hängt an der Richtung
  updateReachHint();
});
el("model").addEventListener("change", () => {
  persist();
  loadMeta();
  updateWDetection();
  fetchStartElevation(); // Modellorographie unterscheidet sich je Modell
});
// Beim Wechsel des Höhenbezugs die vorhandenen Höhen physisch beibehalten:
// AGL→AMSL addiert die Geländehöhe, AMSL→AGL zieht sie ab (gerundet auf die
// Schrittweite). Ohne bekannte Geländehöhe wird nur neu beschriftet.
el("refmode").addEventListener("change", () => {
  convertHeightsForRefmode(el("refmode").value);
  updateHeightContext();
  renderBar();
  persist();
  maybeLive();
});

function convertHeightsForRefmode(toMode) {
  const elev = state.startElevation;
  if (elev == null || !heightColors.size) return;
  const shift = toMode === "amsl" ? elev : -elev;
  const items = [...heightColors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, color]) => ({ raw: m + shift, color, wasActive: m === activeHeight }));
  // Lineal-Maximum bei Bedarf anheben, damit keine Höhe oben herausfällt.
  const maxRaw = Math.max(...items.map((i) => i.raw));
  if (maxRaw > barMax) {
    barMax = BAR_MAX_OPTIONS.find((v) => v >= maxRaw) ?? HEIGHT_MAX;
    el("barmax").value = barMax;
  }
  heightColors.clear();
  activeHeight = null;
  for (const it of items) {
    const m = snapMeters(it.raw); // rastert und begrenzt auf [HEIGHT_MIN, barMax]
    if (heightColors.has(m)) continue; // unter Grund geratene Höhen können zusammenfallen
    heightColors.set(m, it.color);
    if (it.wasActive) activeHeight = m;
  }
  if (activeHeight == null && heightColors.size) {
    activeHeight = [...heightColors.keys()].sort((a, b) => a - b)[0];
  }
}

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
  const methods = selectedMethods();
  // Mehrere Methoden ergeben nur bei genau einer Starthöhe eine lesbare
  // Darstellung (Farbe kodiert dann die Methode statt der Höhe). Verglichen
  // wird am aktiven Balkenpunkt; die übrigen Punkte bleiben erhalten.
  const compareMode = methods.length > 1;
  // Pin-Modus: reiner Höhen-Live-Betrieb. Die aktive Höhe rechnet bei jeder
  // Balkenbewegung neu (Scrub), die übrigen Balkenpunkte bleiben als „Pins"
  // stehen. Im Methodenvergleich gibt es keine Pins.
  const pinMode = liveMode && !compareMode;
  const allBarHeights = [...heightColors.keys()].sort((a, b) => a - b);
  // Live-Modus und Methodenvergleich rechnen an der aktiven Höhe; sonst alle
  // Höhen des Balkens.
  const activeHeights = (liveMode || compareMode)
    ? (activeHeight != null ? [activeHeight] : [])
    : allBarHeights;
  // Pins sind die übrigen Balkenhöhen (nur im Pin-Modus).
  const pinHeights = pinMode ? allBarHeights.filter((m) => m !== activeHeight) : [];
  const markerIntervalSec = +el("markerint").value;
  const mode = el("refmode").value;
  if (!methods.length) {
    return setStatus("Bitte mindestens eine Methode wählen.", true);
  }
  const direction = +el("direction").value;
  const duration = Math.min(72, Math.max(1, +el("duration").value || 12));
  const t0Ms = +el("timeslider").value * 3600e3;

  if (!activeHeights.length) {
    return setStatus(compareMode
      ? "Bitte einen Höhenpunkt am Balken für den Vergleich wählen."
      : "Bitte eine Höhe am Balken wählen.", true);
  }
  const b = model.bbox;
  if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) {
    return setStatus(`Startpunkt liegt außerhalb des ${model.label}-Gebiets.`, true);
  }

  // Signatur der Nicht-Höhen-Parameter (zugleich der Windfeld-Cache-Schlüssel:
  // Modell, Vertikaloption, Zeitfenster, Richtung, Startregion). Bleibt sie
  // gleich, hat sich nur die aktive Höhe bewegt → Scrub-Lauf: nur die aktive
  // Linie neu, die Pins bleiben. Ändert sie sich → Full-Lauf: alles neu.
  const metExtras = el("metextras").checked;
  const sig = [modelKey, methods.join("+"), t0Ms, duration, direction, metExtras,
    Math.round(lat), Math.round(lon)].join("|");
  const canReuse = liveMode && state.live?.sig === sig
    && activeHeights[0] <= state.live.spanTop;
  // Scrub (Pins behalten) nur, wenn sich wirklich ausschließlich die aktive
  // Höhe geändert hat. pinSig fasst alle übrigen pfadbestimmenden Größen exakt
  // (inkl. Höhenbezug und ungerundetem Startpunkt) — sonst wären die Pins zu
  // anderen Parametern gerechnet als die aktive Linie.
  const pinSig = [sig, mode, lat, lon].join("|");
  const scrub = pinMode && canReuse && state.live?.pinSig === pinSig;

  state.running = true;
  updateRunButton();
  state.layers.clearLayers();
  el("results").innerHTML = "";
  if (!scrub) {
    // Full-Lauf: Pins verwerfen und frisch aufbauen.
    state.pinLayers.clearLayers();
    state.pinRuns.clear();
    state.pinKey = "";
  }
  el("download").disabled = true;
  el("xsecbtn").disabled = true;
  el("view3dbtn").disabled = true;
  const xsecWasOpen = !el("xsec").hidden;
  el("xsec").hidden = true;
  state.lastRuns = null;
  state.xsec = null;
  setStatus("Berechne …");

  try {
    // Im Live-Modus das Windfeld über Läufe hinweg behalten, solange die
    // Signatur gleich bleibt und die Höhe ins geladene Levelfenster passt.
    let wf;
    if (canReuse) {
      wf = state.live.wf;
    } else {
      wf = new WindField(modelKey, { wVarPrefix, debug: DEBUG });
      const tEnd = t0Ms + direction * duration * 3600e3;
      // Im Live-Modus deckt das Windfeld den ganzen Balken ab, damit auch Pins
      // und spätere Höhenwechsel ohne Nachladen bedient werden.
      const spanTop = liveMode
        ? Math.max(barMax, ...activeHeights, ...pinHeights)
        : Math.max(...activeHeights);
      await wf.init(lat, lon, spanTop, Math.min(t0Ms, tEnd), Math.max(t0Ms, tEnd), methods, metExtras);
      state.live = liveMode ? { wf, sig, spanTop } : null;
      if (DEBUG) {
        console.debug(`[traj] Modell ${modelKey}, Methoden ${methods.join("+")}, ` +
          `Levelfenster ${wf.levels.at(-1)}–${wf.levels[0]} (${wf.levels.length} Level), ` +
          `Zeitfenster ${wf.startDate}…${wf.endDate}`);
      }
    }
    // Aktuelle Pin-Parameter merken (auch bei wiederverwendetem Windfeld), damit
    // der nächste Lauf Scrub gegen genau diesen Stand prüfen kann.
    if (state.live) state.live.pinSig = pinSig;

    // Einen Lauf (Höhe × Methode) rechnen.
    const computeOne = async (heightM, method) => {
      const style = METHODS.find((m) => m.key === method);
      const color = compareMode ? style.color : colorFor(heightM);
      const dash = compareMode ? style.dash : null;
      const { target, label } = await makeTarget(wf, lat, lon, heightM, mode, method, t0Ms);
      const r = await computeTrajectory({
        windAt: wf.windAt.bind(wf),
        lat0: lat, lon0: lon, target, t0Ms,
        durationHours: duration, direction, gridMeters: model.gridMeters,
        markerIntervalSec,
      });
      return { r, color, label, heightM, method, dash };
    };
    // Eine scheiternde Methode/Höhe soll die übrigen nicht mitreißen.
    const reportError = (labelText, color, err) => {
      const line = document.createElement("div");
      line.className = "result-line";
      line.innerHTML = `<span class="chip" style="background:${color}"></span>` +
        `${labelText} <span class="note">Fehler: ${err.message}</span>`;
      el("results").appendChild(line);
    };

    // Aktive Läufe: entweder mehrere Höhen × eine Methode oder eine Höhe ×
    // mehrere Methoden (oben abgesichert).
    const activeRuns = [];
    for (const heightM of activeHeights) {
      for (const method of methods) {
        const style = METHODS.find((m) => m.key === method);
        setStatus(`Berechne ${compareMode ? style.label : fmtHeight(heightM)} …`);
        try {
          activeRuns.push(await computeOne(heightM, method));
        } catch (err) {
          reportError(compareMode ? style.label : fmtHeight(heightM),
            compareMode ? style.color : colorFor(heightM), err);
        }
      }
    }

    // Pins: aus dem Cache halten, nur fehlende (z. B. gerade deaktivierte)
    // Höhen einmalig mit dem gecachten Windfeld nachrechnen.
    const pinRunList = [];
    if (pinMode) {
      for (const heightM of pinHeights) {
        let run = state.pinRuns.get(heightM);
        if (!run) {
          try {
            run = await computeOne(heightM, methods[0]);
            state.pinRuns.set(heightM, run);
          } catch (err) {
            reportError(fmtHeight(heightM), colorFor(heightM), err);
            continue;
          }
        }
        pinRunList.push(run);
      }
      // Cache von Höhen befreien, die nicht mehr Pin sind (weg vom Balken oder
      // jetzt aktiv).
      for (const m of [...state.pinRuns.keys()]) {
        if (!pinHeights.includes(m)) state.pinRuns.delete(m);
      }
    }

    // Zeichnen. Pins nur neu, wenn sich ihr Satz geändert hat — reines Ziehen
    // der aktiven Höhe lässt die Pins unangetastet (kein Flackern). Je Layer
    // zwei Durchgänge (erst alle weißen Unterlagen, dann alle Farblinien),
    // sonst übermalt die Unterlage einer Linie die Nachbarlinie, wo Pfade
    // (fast) übereinanderliegen, und in Strichlücken erschiene Weiß.
    const pinKey = pinHeights.join(",");
    if (!scrub || pinKey !== state.pinKey) {
      state.pinLayers.clearLayers();
      for (const run of pinRunList) drawCasing(run.r, state.pinLayers);
      for (const run of pinRunList) drawTrajectory(run.r, run.color, run.label, run.dash, state.pinLayers);
      state.pinKey = pinKey;
    }
    for (const run of activeRuns) drawCasing(run.r, state.layers);
    for (const run of activeRuns) drawTrajectory(run.r, run.color, run.label, run.dash, state.layers);

    // Alle sichtbaren Läufe (aktiv + Pins) nach Höhe sortiert — Ergebnisliste,
    // Querschnitt und 3D-Ansicht spiegeln so das gesamte Bild.
    const runs = [...activeRuns, ...pinRunList].sort((a, b) => a.heightM - b.heightM);
    for (const run of runs) reportResult(run.r, run.heightM, run.color, run.label);
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
    // Offene 3D-Ansicht läuft mit (Live-Modus, Neuberechnung).
    el("view3dbtn").disabled = runs.length === 0;
    if (view3dMod && !el("view3d").hidden && runs.length) view3dMod.update(view3dData());
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
function drawCasing(r, layer = state.layers) {
  if (r.points.length < 2) return;
  L.polyline(r.points.map((p) => [p.lat, p.lon]), {
    color: "#ffffff", weight: 6, opacity: 0.85, interactive: false,
  }).addTo(layer);
}

function drawTrajectory(r, color, label, dash = null, layer = state.layers) {
  if (r.points.length < 2) return;
  const latlngs = r.points.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color, weight: 3, opacity: 1, dashArray: dash }).addTo(layer)
    .bindTooltip(label, { sticky: true });

  for (const m of r.markers) {
    const dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
    const zLine = Number.isFinite(m.z) ? `<br>${fmtHeight(m.z)} NN` : "";
    const marker = L.circleMarker([m.lat, m.lon], {
      radius: 4, color, weight: 2, fillColor: "#ffffff", fillOpacity: 1,
    }).addTo(layer).bindTooltip(
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

// --- Mobiles Bedienfeld (Bottom-Sheet, ein-/ausklappbar) --------------------
function setPanelCollapsed(collapsed) {
  el("panel").classList.toggle("collapsed", collapsed);
  el("paneltoggle").textContent = collapsed ? "▴" : "▾";
  el("paneltoggle").setAttribute("aria-expanded", String(!collapsed));
}
el("paneltoggle").addEventListener("click", () =>
  setPanelCollapsed(!el("panel").classList.contains("collapsed")));

el("xsecbtn").addEventListener("click", () => showCrossSection(el("xsec").hidden));
el("xsec-close").addEventListener("click", () => showCrossSection(false));
window.addEventListener("resize", () => {
  if (!el("xsec").hidden && state.xsec) renderCrossSection(el("xsec-body"), state.xsec);
});

// --- 3D-Ansicht (Cesium, lazy geladen) --------------------------------------
let view3dMod = null;

// Modellorographie am Start für den Höhenabgleich Geoid vs. Ellipsoid;
// die Geländewerte entlang des Pfads liegen im Querschnitts-Zustand vor.
function view3dData() {
  return {
    runs: state.lastRuns.runs,
    start: state.start,
    modelElev: state.xsec?.runs?.[0]?.terrain?.[0] ?? state.startElevation,
  };
}

function hide3D() {
  el("view3d").hidden = true;
  el("view3dbtn").textContent = "3D-Ansicht";
}

el("view3dbtn").addEventListener("click", async () => {
  if (!el("view3d").hidden) return hide3D();
  if (!state.lastRuns?.runs?.length) return;
  el("view3dbtn").disabled = true;
  setStatus("Lade 3D-Ansicht …");
  try {
    view3dMod ??= await import("./view3d.js");
    el("view3d").hidden = false;
    await view3dMod.show(view3dData());
    el("view3dbtn").textContent = "3D-Ansicht schließen";
    setStatus("");
  } catch (err) {
    hide3D();
    setStatus(`3D-Ansicht: ${err.message}`, true);
  } finally {
    el("view3dbtn").disabled = false;
  }
});
el("v3d-close").addEventListener("click", hide3D);

// --- Export (GeoJSON / GPX / KML) -------------------------------------------
const DOWNLOAD_FORMATS = {
  geojson: { ext: "geojson", type: "application/geo+json", build: (d) => JSON.stringify(buildGeoJSON(d)) },
  gpx: { ext: "gpx", type: "application/gpx+xml", build: buildGPX },
  kml: { ext: "kml", type: "application/vnd.google-earth.kml+xml", build: buildKML },
};

el("download").addEventListener("click", () => {
  if (!state.lastRuns) return;
  const fmt = DOWNLOAD_FORMATS[el("downloadfmt").value] ?? DOWNLOAD_FORMATS.geojson;
  const blob = new Blob([fmt.build(state.lastRuns)], { type: fmt.type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const stamp = new Date(state.lastRuns.t0Ms).toISOString().slice(0, 16)
    .replace(/[-:]/g, "").replace("T", "_");
  a.download = `trajektorien_${state.lastRuns.modelKey}_${stamp}Z.${fmt.ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/** Trackname mit Start- und Zielhöhe (AMSL, in Metern wie die Höhenwerte in
 *  der Datei). Vorwärts: Start → Ziel; rückwärts: Ankunft ← Herkunft. */
function trackName({ r, label }, direction) {
  const m = (z) => Number.isFinite(z) ? `${Math.round(z)} m` : "?";
  const z0 = m(r.points[0]?.z);
  const zEnd = m(r.points.at(-1)?.z);
  return direction > 0
    ? `${label} · Start ${z0} → Ziel ${zEnd}`
    : `${label} · Ziel ${z0} ← Herkunft ${zEnd}`;
}

function xmlEsc(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

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

/** GPX 1.1 — jede Trajektorie als eigener <trk> mit Farbe (gpx_style-Extension,
 *  Hex; zusätzlich Garmins gpxx:DisplayColor als nächster Standardname). */
function buildGPX({ runs, modelKey, t0Ms, direction }) {
  const iso = (ms) => new Date(ms).toISOString();
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Windtrajektorien"' +
      ' xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2"' +
      ' xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">',
    `  <metadata><name>Trajektorien ${xmlEsc(modelKey)}</name><time>${iso(t0Ms)}</time></metadata>`,
  ];
  for (const run of runs) {
    const hex = run.color.replace("#", "").toLowerCase();
    out.push("  <trk>");
    out.push(`    <name>${xmlEsc(trackName(run, direction))}</name>`);
    out.push("    <extensions>");
    out.push(`      <gpx_style:line><gpx_style:color>${hex}</gpx_style:color></gpx_style:line>`);
    out.push(`      <gpxx:TrackExtension><gpxx:DisplayColor>${gpxNamedColor(run.color)}</gpxx:DisplayColor></gpxx:TrackExtension>`);
    out.push("    </extensions>");
    out.push("    <trkseg>");
    for (const p of run.r.points) {
      const ele = Number.isFinite(p.z) ? `<ele>${Math.round(p.z)}</ele>` : "";
      out.push(`      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}<time>${iso(p.tMs)}</time></trkpt>`);
    }
    out.push("    </trkseg>");
    out.push("  </trk>");
  }
  out.push("</gpx>");
  return out.join("\n");
}

/** KML — jede Trajektorie als eigenes Placemark mit eigenem LineStyle (Farbe
 *  als aabbggrr). Höhen absolut (AMSL); tessellate für saubere Bodenprojektion. */
function buildKML({ runs, modelKey, direction }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>Trajektorien ${xmlEsc(modelKey)}</name>`,
  ];
  for (const run of runs) {
    const pts = run.r.points;
    const has3d = pts.some((p) => Number.isFinite(p.z));
    // Fehlende Höhen (z == null) mit dem nächstbekannten Wert füllen, damit im
    // absoluten Modus kein Ausreißer auf Meereshöhe entsteht.
    const zFill = pts.map((p) => p.z);
    for (let i = 1; i < zFill.length; i++) if (!Number.isFinite(zFill[i])) zFill[i] = zFill[i - 1];
    for (let i = zFill.length - 2; i >= 0; i--) if (!Number.isFinite(zFill[i])) zFill[i] = zFill[i + 1];
    const coords = pts
      .map((p, i) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${Number.isFinite(zFill[i]) ? Math.round(zFill[i]) : 0}`)
      .join(" ");
    out.push("    <Placemark>");
    out.push(`      <name>${xmlEsc(trackName(run, direction))}</name>`);
    out.push(`      <Style><LineStyle><color>${kmlColor(run.color)}</color><width>3</width></LineStyle></Style>`);
    out.push("      <LineString>");
    out.push(`        <altitudeMode>${has3d ? "absolute" : "clampToGround"}</altitudeMode>`);
    out.push("        <tessellate>1</tessellate>");
    out.push(`        <coordinates>${coords}</coordinates>`);
    out.push("      </LineString>");
    out.push("    </Placemark>");
  }
  out.push("  </Document>", "</kml>");
  return out.join("\n");
}

/** #rrggbb → KML-Farbe aabbggrr (voll deckend). */
function kmlColor(hex) {
  const h = hex.replace("#", "");
  return `ff${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toLowerCase();
}

/** Nächster der 16 Garmin-Standardfarbnamen zu #rrggbb (für gpxx:DisplayColor,
 *  das nur benannte Farben kennt). Der exakte Hex steckt in gpx_style:color. */
function gpxNamedColor(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const palette = [
    ["Black", 0, 0, 0], ["DarkRed", 139, 0, 0], ["DarkGreen", 0, 100, 0],
    ["DarkYellow", 139, 139, 0], ["DarkBlue", 0, 0, 139], ["DarkMagenta", 139, 0, 139],
    ["DarkCyan", 0, 139, 139], ["LightGray", 211, 211, 211], ["DarkGray", 105, 105, 105],
    ["Red", 255, 0, 0], ["Green", 0, 255, 0], ["Yellow", 255, 255, 0],
    ["Blue", 0, 0, 255], ["Magenta", 255, 0, 255], ["Cyan", 0, 255, 255], ["White", 255, 255, 255],
  ];
  let best = "DarkGray", bestD = Infinity;
  for (const [name, pr, pg, pb] of palette) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
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
