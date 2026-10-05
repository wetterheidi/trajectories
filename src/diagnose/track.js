// Reine Hilfsfunktionen der Diagnose-Seite (ohne DOM/Leaflet) -- damit sie
// auch in den Node-Tests laufen (test/diagnose.test.mjs).

const R = 6371000;
const D2R = Math.PI / 180;

/** Großkreisabstand in Metern. */
export function dist(la1, lo1, la2, lo2) {
  const dla = (la2 - la1) * D2R, dlo = (lo2 - lo1) * D2R;
  const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Kurs (wohin, 0–360°). */
export function bearing(la1, lo1, la2, lo2) {
  const y = Math.sin((lo2 - lo1) * D2R) * Math.cos(la2 * D2R);
  const x = Math.cos(la1 * D2R) * Math.sin(la2 * D2R) -
    Math.sin(la1 * D2R) * Math.cos(la2 * D2R) * Math.cos((lo2 - lo1) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

/** Windvektor -> Betrag und Zugrichtung (wohin, wie der GPS-Kurs). */
export function speedDir(u, v) {
  return { spd: Math.hypot(u, v), dir: (Math.atan2(u, v) / D2R + 360) % 360 };
}

/** Kleinster Winkelabstand a−b in −180…180°. */
export function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/**
 * GPX-Text -> Trackpunkte [{tMs, lat, lon, z}], zeitlich sortiert. Alle
 * Tracksegmente werden aneinandergehängt; Punkte ohne Zeit oder Höhe sind
 * für die Diagnose unbrauchbar und fallen weg, doppelte Zeitstempel ebenso.
 * `parser` ist injizierbar (Node-Tests haben keinen DOMParser).
 */
export function parseTrackGPX(text, parser = new DOMParser()) {
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Die Datei ist kein gültiges GPX/XML.");
  const nodes = [...doc.getElementsByTagName("trkpt")];
  if (!nodes.length) throw new Error("Die GPX-Datei enthält keinen Track (trkpt).");
  let noTime = 0, noEle = 0;
  const pts = [];
  for (const n of nodes) {
    const lat = parseFloat(n.getAttribute("lat")), lon = parseFloat(n.getAttribute("lon"));
    const t = n.getElementsByTagName("time")[0]?.textContent?.trim();
    const e = n.getElementsByTagName("ele")[0]?.textContent?.trim();
    const tMs = t ? Date.parse(t) : NaN;
    const z = e ? parseFloat(e) : NaN;
    if (!Number.isFinite(tMs)) { noTime++; continue; }
    if (!Number.isFinite(z)) { noEle++; continue; }
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ tMs, lat, lon, z });
  }
  pts.sort((a, b) => a.tMs - b.tMs);
  const out = pts.filter((p, i) => i === 0 || p.tMs > pts[i - 1].tMs);
  if (out.length < 2) {
    const why = noTime ? "ohne Zeitstempel" : noEle ? "ohne Höhe" : "unvollständig";
    throw new Error(`Zu wenige brauchbare Trackpunkte (${nodes.length} Punkte, davon ${noTime + noEle} ${why}).`);
  }
  const name = doc.getElementsByTagName("trk")[0]?.getElementsByTagName("name")[0]?.textContent?.trim() || null;
  return { name, points: out, skipped: { noTime, noEle } };
}

/**
 * Start/Landung erkennen: Start = letzter Punkt, bevor der Track 8 m über die
 * Anfangshöhe steigt; Landung = erster Punkt, ab dem er sich weder über die
 * Endhöhe hebt noch mehr als 60 m von der Endposition entfernt (Ballon steht,
 * Logger läuft weiter). Liefert Indizes [i0, i1].
 */
export function detectFlight(tr) {
  const e0 = tr[0].z, last = tr.at(-1);
  let i0 = tr.findIndex((p) => p.z > e0 + 8);
  i0 = i0 < 1 ? 0 : i0 - 1;
  let i1 = tr.length - 1;
  while (i1 > i0 + 1 && tr[i1].z < last.z + 8 && dist(tr[i1].lat, tr[i1].lon, last.lat, last.lon) < 60) i1--;
  return [i0, Math.min(i1 + 1, tr.length - 1)];
}

/** Beobachtete Verlagerung über Grund (geglättet über ±win s um Punkt i). */
export function obsVel(tr, i, winSec = 45) {
  let a = i, b = i;
  const win = winSec * 1000;
  while (a > 0 && tr[i].tMs - tr[a - 1].tMs <= win) a--;
  while (b < tr.length - 1 && tr[b + 1].tMs - tr[i].tMs <= win) b++;
  if (b === a) return null;
  const d = dist(tr[a].lat, tr[a].lon, tr[b].lat, tr[b].lon);
  const dt = (tr[b].tMs - tr[a].tMs) / 1000;
  return { spd: d / dt, dir: bearing(tr[a].lat, tr[a].lon, tr[b].lat, tr[b].lon) };
}

/**
 * Kennzahlen eines Diagnosetracks gegen den GPS-Track.
 * gps: Teilstück des Originals; diag: points aus computeAlongProfile (gleiche
 * Indizes); obs/mod: je Index beobachtete Verlagerung bzw. Modellwind am
 * GPS-Ort ({spd, dir} oder null).
 */
export function diagStats(gps, diag, obs = [], mod = []) {
  const n = diag.length;
  let maxSep = 0, sumSep = 0;
  for (let k = 0; k < n; k++) {
    const s = dist(gps[k].lat, gps[k].lon, diag[k].lat, diag[k].lon);
    sumSep += s;
    if (s > maxSep) maxSep = s;
  }
  const g0 = gps[0], gE = gps[n - 1], dE = diag[n - 1];
  const durSec = (gE.tMs - g0.tMs) / 1000;
  const directO = dist(g0.lat, g0.lon, gE.lat, gE.lon);
  const directD = dist(g0.lat, g0.lon, dE.lat, dE.lon);
  const endSep = dist(gE.lat, gE.lon, dE.lat, dE.lon);

  // Wind entlang des GPS-Tracks: Vektorfehler, Betrags-Bias, Richtungsfehler.
  // Richtung nur bei merklicher Fahrt (> 1,5 m/s), sonst ist der GPS-Kurs Rauschen.
  let nV = 0, sumV2 = 0, sumBias = 0, nD = 0, sumAbsD = 0;
  for (let k = 0; k < n; k++) {
    const o = obs[k], m = mod[k];
    if (!o || !m) continue;
    const ou = o.spd * Math.sin(o.dir * D2R), ov = o.spd * Math.cos(o.dir * D2R);
    const mu = m.spd * Math.sin(m.dir * D2R), mv = m.spd * Math.cos(m.dir * D2R);
    sumV2 += (mu - ou) ** 2 + (mv - ov) ** 2;
    sumBias += m.spd - o.spd;
    nV++;
    if (o.spd > 1.5) { sumAbsD += Math.abs(angleDiff(m.dir, o.dir)); nD++; }
  }
  return {
    durSec,
    complete: true,
    directO, directD,
    brgO: bearing(g0.lat, g0.lon, gE.lat, gE.lon),
    brgD: bearing(g0.lat, g0.lon, dE.lat, dE.lon),
    endSep,
    relEnd: directO > 0 ? endSep / directO : null,
    maxSep,
    meanSep: sumSep / n,
    vObs: durSec > 0 ? directO / durSec : null,
    vMod: durSec > 0 ? directD / durSec : null,
    rmseVec: nV ? Math.sqrt(sumV2 / nV) : null,
    biasSpd: nV ? sumBias / nV : null,
    meanAbsDir: nD ? sumAbsD / nD : null,
  };
}
