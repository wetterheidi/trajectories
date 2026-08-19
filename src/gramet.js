/**
 * GRAMET-Wetterquerschnitt entlang einer berechneten Trajektorie.
 *
 * Einzige Stelle der App, die die Komponentenbibliothek `meteokit` anfasst --
 * app.js kennt nur die Exporte hier unten. Genutzt werden genau drei
 * Einstiegspunkte: die Web Component `<gramet-panel>`, `meteokit/gramet`
 * (Fetch + X-Achsen-Positionen) und `meteokit/units` (Einheiten-Singleton der
 * Bibliothek). Was die Bibliothek sonst noch enthält, ist intern -- verbindlich
 * ist allein ihre `exports`-Map (s. meteokit/package.json).
 *
 * Eingebunden als `file:`-Abhängigkeit auf das Nachbar-Repo (s. package.json);
 * beide müssen nebeneinander ausgecheckt sein, auch beim Deploy-Build.
 *
 * Das Modul wird von app.js erst beim ersten Klick nachgeladen (lazy) --
 * es zieht die gesamte GRAMET-Renderkette mit.
 */

import "meteokit/components/gramet-panel";
import { fetchGridForPath, posOfPath } from "meteokit/gramet";
import { setUnits as setKitUnits } from "meteokit/units";
import * as cursorSync from "./cursorsync.js";

const STORAGE_KEY = "trajectories.gramet.v1";

// Zeitliche Auflösung des interpolierten Gitters (`resampleIntervalSec`):
// zwischen den tatsächlich gefetchten Säulen wird interpoliert, das kostet
// kein Netzwerk, nur Rechenzeit und Spaltenzahl. Längere Pfade gröber, damit
// der Canvas nicht ins Extrem wächst.
function resampleSec(durationH) {
  if (durationH <= 12) return 600;
  if (durationH <= 36) return 900;
  return 1800;
}

// Ein Fetch-Ergebnis je Trajektorie. Schlüssel ist das `r`-Objekt des Laufs:
// jede Neuberechnung erzeugt neue Objekte, der Cache invalidiert sich also
// selbst; Pins bleiben über Live-Scrubs hinweg objektstabil und damit im
// Cache. Wichtig, weil ein Pfad ~12–16 volle Modellsäulen kostet.
const gridCache = new WeakMap();

// Höhenwechsel während eines laufenden Fetches: nur die jüngste Anfrage darf
// das Panel noch anfassen.
let seq = 0;

function panelEl() {
  return document.querySelector("#gramet gramet-panel");
}

export function isOpen() {
  const host = document.getElementById("gramet");
  return !!host && !host.hidden;
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

let prefsBound = false;
function bindPrefs(panel) {
  if (prefsBound) return;
  prefsBound = true;
  // Mergen statt ersetzen: in derselben Ablage liegen auch die Dock-Werte
  // unten, die die Komponente nicht kennt.
  panel.addEventListener("settingschange", (e) => savePrefs({ ...loadPrefs(), ...e.detail }));
}

// --- Positionssynchronisierung mit der Karte --------------------------------
// Zwei Richtungen, ein Vermittler (s. cursorsync.js): das Panel meldet die
// gehoverte Wegposition als `poshover`, und was die Karte meldet, kommt als
// `cursor` zurück ins Panel.
let syncBound = false;
function bindSync(panel) {
  if (syncBound) return;
  syncBound = true;
  panel.addEventListener("poshover", (e) => cursorSync.setCursor(e.detail.pos, "gramet"));
  cursorSync.subscribe(({ s, source }) => {
    // Beim Hovern im Chart selbst zeigt der Mauszeiger schon auf die Stelle --
    // eine zweite Linie darunter wäre nur Unruhe, und das Nachscrollen würde
    // den Chart unter dem Zeiger wegziehen. Trotzdem löschen: sonst bliebe die
    // zuletzt von der Karte gesetzte Linie stehen, während man im Chart
    // weiterfährt.
    if (source === "gramet") return panel.setCursor(null);
    panel.setCursor(s, { reveal: true });
  });
}

// --- Dock: Karte und GRAMET gleichzeitig ------------------------------------
// Zwei Anordnungen für dieselbe Hülle. "Angedockt" schlägt das Panel unten an,
// darüber bleibt die Karte sichtbar und bedienbar -- Voraussetzung dafür, dass
// Karte und Querschnitt sich gegenseitig eine Position zeigen können. Die
// Vollansicht ist die bisherige Anordnung über der ganzen Kartenfläche.
// Beides ist Sache der App: die Komponente weiß nichts von einer Karte.

const DOCK_MIN_H = 220;
const DOCK_DEFAULT_H = 420;
// Mindesthöhe der GRAMET-Hauptfläche im Dock (`minMainHeight`, s. Bibliothek).
// Rechnung: von der Dockhöhe gehen rund 300 px für Dockleiste, Komponentenkopf,
// Bodenzeilen und Achsen ab. Bei 420 px Dockhöhe blieben also ~120 px
// Wetterfläche -- unlesbar. Stattdessen behält die Hauptfläche 360 px und der
// Panel-Body scrollt vertikal; wer mehr sehen will, zieht das Dock größer und
// scrollt entsprechend weniger.
const DOCK_MIN_MAIN_H = 360;

let dockInit = false;

function shellEl() {
  return document.getElementById("gramet");
}

/** Aktuelle Anordnung auf die Hülle anwenden und die App informieren.
 *  `reason`: "open" (Panel wird gezeigt), "mode" (Umschaltung), "resize"
 *  (Ziehgriff losgelassen) -- die Karte zieht nur bei den ersten beiden nach,
 *  sonst spränge der Ausschnitt beim Ziehen dauernd. */
function applyDock({ docked, height }, reason) {
  const shell = shellEl();
  shell.classList.toggle("docked", docked);
  shell.style.setProperty("--gm-dock-h", `${Math.round(height)}px`);
  const btn = document.getElementById("gramet-dockmode");
  btn.textContent = docked ? "⤢" : "⤡";
  btn.title = docked ? "Vollansicht (Karte verdecken)" : "Andocken (Karte darüber zeigen)";
  // Im Dock nicht stauchen, sondern scrollen (s. DOCK_MIN_MAIN_H) -- aber nur,
  // wenn die Hülle tatsächlich als Streifen sitzt. Auf schmalen Geräten macht
  // das CSS aus dem Dock wieder eine Vollansicht (kein Platz für beides
  // nebeneinander); gemessen statt den Breakpoint hier nachzubauen.
  const panel = panelEl();
  const asStrip = shell.getBoundingClientRect().top > window.innerHeight / 3;
  if (panel) panel.minMainHeight = asStrip ? DOCK_MIN_MAIN_H : null;
  shell.dispatchEvent(new CustomEvent("grametlayout", {
    bubbles: true,
    detail: { docked, height, reason },
  }));
}

function dockPrefs() {
  const p = loadPrefs();
  return {
    // Voreinstellung ist das Dock: die parallele Ansicht ist der Grund, warum
    // es sie gibt. Wer lieber die volle Fläche will, schaltet einmal um.
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
  const bar = document.getElementById("gramet-dockbar");
  const btn = document.getElementById("gramet-dockmode");

  btn.addEventListener("click", () => {
    // Ausgangszustand aus dem DOM, nicht aus den Prefs: was zu sehen ist,
    // entscheidet, wohin geschaltet wird -- auch wenn das Speichern mal
    // fehlschlägt (Privatmodus, volle Ablage).
    const next = { docked: !shellEl().classList.contains("docked"), height: dockPrefs().height };
    savePrefs({ ...loadPrefs(), docked: next.docked, dockHeight: next.height });
    applyDock(next, "mode");
  });

  // Höhe ziehen. Die Hülle wächst nach oben (sie ist unten angeschlagen),
  // also wird die Zeigerbewegung negativ aufgerechnet.
  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (!shellEl().classList.contains("docked")) return;
    if (e.target.closest("button")) return; // Klick auf den Umschalter
    drag = { y: e.clientY, h: shellEl().getBoundingClientRect().height };
    bar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const h = clampDockHeight(drag.h - (e.clientY - drag.y));
    shellEl().style.setProperty("--gm-dock-h", `${Math.round(h)}px`);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    if (bar.hasPointerCapture?.(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    const height = clampDockHeight(shellEl().getBoundingClientRect().height);
    savePrefs({ ...loadPrefs(), dockHeight: Math.round(height) });
    applyDock({ docked: true, height }, "resize");
  };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);

  // Fenstergröße/Drehung kann das Dock über den CSS-Breakpoint schieben --
  // dann stimmt die Mindesthöhe der Hauptfläche nicht mehr (s. `asStrip`).
  // Grund "resize": die Karte soll dabei nicht neu einpassen.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!isOpen()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applyDock(dockPrefs(), "resize"), 200);
  });
}

/**
 * Wegpunkte für den Path-Modus aus einem Lauf. `fetchGridForPath` erwartet
 * aufsteigende Zeiten — Rückwärtstrajektorien laufen in der Berechnung von
 * der Startzeit rückwärts, werden hier also umgedreht: links im Chart steht
 * dann die Herkunft, rechts der gewählte Startzeitpunkt.
 * `z` (m NN) reist als Höhenprofil mit, damit Wetterspalten und Profillinie
 * garantiert aus derselben Punktliste stammen.
 */
function waypointsFromRun(run, direction) {
  const wp = run.r.points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.tMs))
    .map((p) => ({
      lat: p.lat,
      lon: p.lon,
      t: Math.round(p.tMs / 1000),
      z: Number.isFinite(p.z) ? p.z : NaN,
    }));
  if (direction < 0) wp.reverse();
  return wp;
}

/** Kopfzeile des Panels. Kurz halten — der Komponentenkopf trägt daneben noch
 *  Ebenenschalter und Bereichsumschalter und bricht sonst um. Die X-Achse
 *  zählt verstrichene Zeit ab dem linken Rand; welcher Zeitpunkt das ist,
 *  steht deshalb hier (bei Rückwärtsläufen ist links die Herkunft). */
function subtitleFor({ run, modelKey, direction }, waypoints) {
  const t0 = new Date(waypoints[0].t * 1000);
  const t1 = new Date(waypoints[waypoints.length - 1].t * 1000);
  const dm = (d) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.`;
  const hm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  // Gleicher Tag → Datum nur einmal.
  const span = dm(t0) === dm(t1)
    ? `${dm(t0)} ${hm(t0)}→${hm(t1)}Z`
    : `${dm(t0)} ${hm(t0)}Z→${dm(t1)} ${hm(t1)}Z`;
  const dir = direction < 0 ? "rückw." : "vorw.";
  return `${modelKey.replace("_", "-").toUpperCase()} · ${run.label} · ${dir} · ${span}`;
}

async function gridFor(run, modelKey, duration, waypoints) {
  let entry = gridCache.get(run.r);
  if (!entry) {
    entry = fetchGridForPath(waypoints, modelKey, 3, undefined, {
      terrain: true,
      // Wetter zuerst zeichnen, Geländevergleich nachreichen — die
      // Mapterhorn-Kacheln eines langen Pfades brauchen im Browser länger als
      // der gesamte Wetterabruf.
      terrainDeferred: true,
      // Etwas mehr Spalten als der Bibliotheks-Default (12): Trajektorien
      // laufen bis 72 h, sonst läge zwischen zwei Säulen ein halber Tag.
      maxCols: 16,
      resampleIntervalSec: resampleSec(duration),
    });
    gridCache.set(run.r, entry);
    // Ein gescheiterter Fetch darf sich nicht als Dauerergebnis festsetzen —
    // beim nächsten Öffnen soll es einen echten neuen Versuch geben.
    entry.catch(() => gridCache.delete(run.r));
  }
  return entry;
}

/** Panel mit der Cross-Section zum übergebenen Lauf füllen.
 *  `data = { run, modelKey, t0Ms, duration, direction }` (s. app.js). */
export async function update(data) {
  const panel = panelEl();
  if (!panel || !data?.run) return;
  bindPrefs(panel);
  bindSync(panel);

  const my = ++seq;
  const { run, modelKey, duration, direction } = data;
  const waypoints = waypointsFromRun(run, direction);
  if (waypoints.length < 2) {
    cursorSync.clearPath();
    panel.loading = "Diese Trajektorie hat zu wenige Punkte für einen Querschnitt.";
    return;
  }

  panel.subtitle = subtitleFor(data, waypoints);
  // Ein Datenwechsel kostet bis zu 16 Säulenabrufe und dauert spürbar. Steht
  // schon ein Chart, bleibt er sichtbar und bekommt nur den Ladehinweis
  // obendrauf — sonst wirkt jeder Höhen-/Parameterwechsel wie ein Neustart
  // und man sieht sekundenlang nur Text.
  if (panel.grid) panel.busy = "Lade Wetterdaten entlang des Pfades …";
  else panel.loading = "Lade Wetterdaten entlang des Pfades …";

  let result;
  try {
    result = await gridFor(run, modelKey, duration, waypoints);
  } catch (err) {
    if (my !== seq) return;
    cursorSync.clearPath();
    panel.busy = null;
    panel.loading = `GRAMET: ${err.message}`;
    return;
  }
  if (my !== seq) return; // inzwischen wurde eine andere Höhe angefordert

  // Genau diese Liste bekommen Wetterspalten, Profillinie UND die Karte (s.
  // cursorsync.js): eine zweite Ableitung wäre die naheliegendste Art, sich
  // bei Rückwärtsläufen lautlos zu vertun.
  const pos = posOfPath(waypoints);
  cursorSync.setPath({ run, waypoints, pos });

  const prefs = loadPrefs();
  panel.update({
    grid: result.grid,
    terrain: result.terrain,
    pathStop: result.pathStop,
    // Positionen aus derselben Funktion wie die Wetterspalten (verstrichene
    // Sekunden seit dem ersten Wegpunkt) — so kann die Profillinie
    // konstruktionsbedingt nicht gegen die Wetterachse verrutschen.
    profile: {
      pos,
      z: waypoints.map((w) => w.z),
      color: run.color,
      label: run.label,
    },
    // Diese App kennt keine vorgegebene Flughöhe (droneforecast setzt sie per
    // Eingabefeld und zeichnet daraus eine Deckellinie) — die Höhe ist hier
    // das Ergebnis der Trajektorienrechnung. Also keine Deckellinie, und der
    // Zoombereich folgt dem Profil statt einer Vorgabe; der Knopf heißt
    // entsprechend anders.
    maxHeight: null,
    zoomLabel: "um die Trajektorie",
    range: prefs.range ?? "zoom",
    layers: prefs.layers,
    exportNameParts: ["gramet", modelKey, run.label],
  });

  // Geländevergleich nachreichen, sobald die Kacheln da sind — nur, wenn
  // inzwischen keine andere Trajektorie angefordert wurde.
  const terrain = await result.terrainPromise;
  if (terrain && my === seq) panel.update({ terrain });
}

export async function show(data) {
  const host = shellEl();
  initDock();
  host.hidden = false;
  // Erst sichtbar machen, dann die Anordnung anwenden: das Layout-Event soll
  // die Karte auf eine bereits gültige Geometrie einpassen können.
  applyDock(dockPrefs(), "open");
  await update(data);
}

export function hide() {
  document.getElementById("gramet").hidden = true;
  cursorSync.clearPath();
}

/** „Zeigt den vorigen Lauf“-Band im Panel setzen/löschen (s. `stale` in
 *  app.js). Der Hinweis überlebt bewusst einen Datenwechsel: wer bei
 *  veralteten Einstellungen die aktive Höhe wechselt, bekommt eine andere
 *  Trajektorie DESSELBEN alten Laufs — der Hinweis gilt weiter. */
export function setStale(on) {
  const panel = panelEl();
  if (panel) panel.notice = on ? "Einstellungen geändert — zeigt den vorigen Lauf. Neu berechnen." : null;
}

/** Einheiten der App an die Bibliothek durchreichen: sie führt ihren eigenen
 *  `unitState` (eigenes Modul, eigener Singleton), der sonst bei Metern
 *  stünde, während die App längst in Fuß beschriftet. Temperatur kennt diese
 *  App nicht, sie bleibt beim Bibliotheks-Default (°C). */
export function syncUnits(units) {
  setKitUnits(units);
  const panel = panelEl();
  // Nur neu zeichnen, wenn wirklich ein Chart steht — `update({})` würde
  // sonst eine stehende Fehler-/Lademeldung löschen.
  if (panel?.grid && isOpen()) panel.update({});
}
