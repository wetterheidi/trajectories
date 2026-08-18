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
  panel.addEventListener("settingschange", (e) => savePrefs(e.detail));
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

  const my = ++seq;
  const { run, modelKey, duration, direction } = data;
  const waypoints = waypointsFromRun(run, direction);
  if (waypoints.length < 2) {
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
    panel.busy = null;
    panel.loading = `GRAMET: ${err.message}`;
    return;
  }
  if (my !== seq) return; // inzwischen wurde eine andere Höhe angefordert

  const prefs = loadPrefs();
  panel.update({
    grid: result.grid,
    terrain: result.terrain,
    pathStop: result.pathStop,
    // Positionen aus derselben Funktion wie die Wetterspalten (verstrichene
    // Sekunden seit dem ersten Wegpunkt) — so kann die Profillinie
    // konstruktionsbedingt nicht gegen die Wetterachse verrutschen.
    profile: {
      pos: posOfPath(waypoints),
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
  const host = document.getElementById("gramet");
  host.hidden = false;
  await update(data);
}

export function hide() {
  document.getElementById("gramet").hidden = true;
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
