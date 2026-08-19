/**
 * Gemeinsame Positionsanzeige für Karte und GRAMET.
 *
 * Beide Ansichten zeigen dieselbe Trajektorie, aber in verschiedenen Räumen:
 * die Karte in Länge/Breite, das GRAMET auf einer Wegachse. Verbindendes
 * Element ist `pos` — verstrichene Sekunden seit dem ersten Wegpunkt, also
 * genau die Größe, die `posOfPath()` für die Profillinie liefert und die die
 * GRAMET-Komponente als `cursor` annimmt und als `poshover` meldet. Der
 * Cursor ist damit EINDIMENSIONAL: eine Stelle auf dem Weg, keine Höhe. Die
 * Höhe dazu ist die der Trajektorie, nicht die des Mauszeigers.
 *
 * Die Wegpunktliste wird bewusst NICHT zweimal abgeleitet: `waypointsFromRun()`
 * in gramet.js filtert unbrauchbare Punkte weg und dreht Rückwärtsläufe um
 * (dort läuft `pos` mit fallender Uhrzeit). Beide Seiten arbeiten deshalb auf
 * derselben Instanz, die hier hinterlegt wird — sonst liefen Indizes und
 * Zeitrichtung auseinander, und zwar lautlos.
 *
 * Ohne Abhängigkeiten, damit app.js das Modul statisch laden kann, während das
 * schwergewichtige gramet.js weiter erst beim ersten Klick dazukommt.
 */

// { run, waypoints, pos } — gesetzt von gramet.js, sobald ein Chart steht.
let path = null;
// { s, source } — `source` ist die Ansicht, in der gezeigt wird ("map" |
// "gramet"). Jeder Abnehmer ignoriert seine eigene Quelle; sonst schaukelten
// sich die beiden Ansichten gegenseitig auf.
let cursor = null;
const subs = new Set();

/** Aktive Pfad-Session setzen. Ein Wechsel löscht den Cursor: er zeigte auf
 *  eine Strecke, die es so nicht mehr gibt. */
export function setPath(next) {
  path = next?.waypoints?.length > 1 && next.pos?.length === next.waypoints.length ? next : null;
  cursor = null;
  emit();
}

export function clearPath() {
  setPath(null);
}

export function getPath() {
  return path;
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

let queued = false;

/**
 * Position anzeigen. `s` in `pos`-Einheiten, `null` blendet aus.
 * Zeigerbewegungen kommen deutlich häufiger als Bilder — die Benachrichtigung
 * wird deshalb auf den nächsten Frame zusammengefasst; der letzte Wert gewinnt.
 */
export function setCursor(s, source) {
  const next = path && Number.isFinite(s)
    ? { s: Math.max(path.pos[0], Math.min(s, path.pos[path.pos.length - 1])), source }
    : null;
  if (!next && !cursor) return;
  cursor = next;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; emit(); });
}

function emit() {
  const at = cursor ? sampleAt(cursor.s) : null;
  const detail = cursor ? { s: cursor.s, source: cursor.source, at } : { s: null, source: null, at: null };
  for (const fn of subs) fn(detail);
}

/**
 * Ort, Höhe und Zeit an der Wegposition `s` — linear zwischen den beiden
 * umliegenden Wegpunkten interpoliert (sie liegen Sekunden auseinander, eine
 * feinere Interpolation gäbe nichts her). `pos` ist aufsteigend, also
 * binäre Suche.
 */
export function sampleAt(s) {
  if (!path) return null;
  const { waypoints, pos } = path;
  const last = pos.length - 1;
  if (s <= pos[0]) return at(0, 0);
  if (s >= pos[last]) return at(last, 0);
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pos[mid] <= s) lo = mid; else hi = mid;
  }
  const span = pos[hi] - pos[lo];
  return at(lo, span > 0 ? (s - pos[lo]) / span : 0);

  function at(i, f) {
    const a = waypoints[i], b = waypoints[Math.min(i + 1, last)];
    const mix = (u, v) => (Number.isFinite(u) && Number.isFinite(v) ? u + f * (v - u) : u);
    return {
      lat: mix(a.lat, b.lat),
      lon: mix(a.lon, b.lon),
      z: mix(a.z, b.z),
      t: mix(a.t, b.t),
      index: f < 0.5 ? i : Math.min(i + 1, last),
    };
  }
}
