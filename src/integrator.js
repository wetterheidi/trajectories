const R_EARTH = 6371000;
const DEG = 180 / Math.PI;

/**
 * Trajektorienberechnung nach dem Petterssen-Schema (iterativ-implizit,
 * wie HYSPLIT): erster Schätzpunkt mit dem Wind am Ausgangsort, dann
 * Mittelung mit dem Wind am Schätzpunkt zur Zeit t+dt, iteriert bis zur
 * Konvergenz. Adaptiver Zeitschritt: Verschiebung <= 0.75 Gitterweiten.
 *
 * direction = +1 (vorwärts) oder -1 (rückwärts) — sonst identische Mathematik.
 * Zeitmarken alle markerIntervalSec ab Startzeit; der Schritt landet exakt
 * auf diesen Marken.
 *
 * target beschreibt die Vertikalfläche (siehe windfield.js). Bei type "z3d"
 * wird die Höhe mit der Modell-Vertikalgeschwindigkeit mitintegriert —
 * ebenfalls Petterssen-gemittelt.
 *
 * windAt(lat, lon, target, tMs) -> {u, v, w?, zAmsl?} in m/s oder {error}.
 */
export async function computeTrajectory({
  windAt,
  lat0,
  lon0,
  target,
  t0Ms,
  durationHours,
  direction = 1,
  gridMeters,
  markerIntervalSec = 3600,
  maxStepSec = 900,
  minStepSec = 60,
  signal = null,
}) {
  const intervalMs = markerIntervalSec * 1000;
  const is3d = target.type === "z3d";
  let tgt = { ...target };
  let lat = lat0, lon = lon0, t = t0Ms;
  const tEnd = t0Ms + direction * durationHours * 3600e3;
  const points = [{ lat, lon, tMs: t, z: null }];
  const markers = [];
  let status = "ok", reason = null;

  while (direction * (tEnd - t) > 1) {
    if (signal?.aborted) throw abortError();
    const w0 = await windAt(lat, lon, tgt, t);
    if (w0.error) { status = "stopped"; reason = w0.error; break; }
    if (points[0].z == null) points[0].z = w0.zAmsl ?? null;
    // Marken entstehen sonst nur beim Übertreten eines Intervall-Vielfachen
    // NACH dem ersten Schritt (Prüfung unten läuft auf der Zeit nach der
    // Advektion, nie auf dem Startpunkt selbst) -- ohne diese Sonder-
    // behandlung fehlt die erste Marke am Startzeitpunkt, während `points[0]`
    // (Höhe/Gelände) ihn schon zeigt. `w0` ist exakt die Windprobe bei
    // (lat, lon, t0Ms), kein zusätzlicher Abruf nötig.
    if (t === t0Ms) markers.push({ lat, lon, tMs: t, u: w0.u, v: w0.v, z: w0.zAmsl ?? null, met: w0.met, w: w0.w ?? null });

    const speed = Math.hypot(w0.u, w0.v);
    let dtSec = clamp((0.75 * gridMeters) / Math.max(speed, 0.5), minStepSec, maxStepSec);
    // Exakt auf die Zeitmarken (relativ zur Startzeit) und das Ende treffen.
    const rel = t - t0Ms;
    const nextMark = t0Ms + (direction > 0
      ? Math.floor(rel / intervalMs + 1) * intervalMs
      : Math.ceil(rel / intervalMs - 1) * intervalMs);
    const limitMs = direction * Math.min(direction * (tEnd - t), direction * (nextMark - t));
    dtSec = Math.min(dtSec, Math.abs(limitMs) / 1000);
    const dt = direction * dtSec;

    let [lat1, lon1] = advect(lat, lon, w0.u, w0.v, dt);
    let z1 = is3d ? tgt.value + w0.w * dt : tgt.value;
    let wLast = w0;
    let failed = null;
    for (let it = 0; it < 5; it++) {
      const tgt1 = is3d ? { ...tgt, value: z1 } : tgt;
      const w1 = await windAt(lat1, lon1, tgt1, t + dt * 1000);
      if (w1.error) { failed = w1.error; break; }
      wLast = w1;
      const [latN, lonN] = advect(lat, lon, 0.5 * (w0.u + w1.u), 0.5 * (w0.v + w1.v), dt);
      const zN = is3d ? tgt.value + 0.5 * (w0.w + w1.w) * dt : tgt.value;
      const move = distMeters(lat1, lon1, latN, lonN) + Math.abs(zN - z1);
      lat1 = latN; lon1 = lonN; z1 = zN;
      if (move < 10) break;
    }
    if (failed) { status = "stopped"; reason = failed; break; }

    lat = lat1; lon = lon1; t = t + dt * 1000;
    if (is3d) tgt = { ...tgt, value: z1 };
    points.push({ lat, lon, tMs: t, z: wLast.zAmsl ?? null });
    const mrem = Math.abs((t - t0Ms) % intervalMs);
    if (mrem < 1 || intervalMs - mrem < 1) {
      const w = await windAt(lat, lon, tgt, t);
      if (!w.error) markers.push({ lat, lon, tMs: t, u: w.u, v: w.v, z: w.zAmsl ?? null, met: w.met, w: w.w ?? null });
    }
  }

  return { points, markers, status, reason, target, direction };
}

/**
 * Diagnose-/Hindcast-Trajektorie entlang eines vorgegebenen Höhen-Zeit-
 * Profils (z. B. einer gefahrenen Ballonfahrt): Start an der ersten
 * Profilposition, dann rein mit dem Modellwind verlagert -- die Höhe ist zu
 * jedem Zeitpunkt die des Profils (zwischen zwei Profilpunkten linear in der
 * Zeit), nicht eine konstante Zielfläche.
 *
 * Zeitschritte sind die Profilabstände selbst (Lücken auf maxStepSec = 30 s
 * unterteilt, das hält Schritte weit unter einer Gitterweite); jeder Schritt läuft wie computeTrajectory nach Petterssen,
 * hier aber bis zur Konvergenz auf 0,1 m iteriert -- bei Schritten von wenigen
 * Sekunden kostet das kaum etwas, der Diskretisierungsfehler bleibt so weit
 * unter der Modellunsicherheit.
 *
 * profile: [{tMs, z}] aufsteigend (z = Höhe m über NN).
 * windAt(lat, lon, z, tMs) -> {u, v} in m/s oder {error}.
 * Liefert points[k] passend zu profile[k] (bei Abbruch kürzer).
 */
export async function computeAlongProfile({
  windAt,
  lat0,
  lon0,
  profile,
  maxStepSec = 30,
  tolMeters = 0.1,
  maxIter = 10,
  signal = null,
  onProgress = null,
}) {
  let lat = lat0, lon = lon0;
  const tFirst = profile[0].tMs, tLast = profile.at(-1).tMs;
  const points = [{ lat, lon, tMs: tFirst, z: profile[0].z }];
  let status = "ok", reason = null;

  outer:
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i], b = profile[i + 1];
    const span = b.tMs - a.tMs;
    const nSub = span > 0 ? Math.max(1, Math.ceil(span / 1000 / maxStepSec)) : 0;
    for (let s = 0; s < nSub; s++) {
      if (signal?.aborted) throw abortError();
      const ta = a.tMs + (span * s) / nSub, tb = a.tMs + (span * (s + 1)) / nSub;
      const za = a.z + ((b.z - a.z) * s) / nSub, zb = a.z + ((b.z - a.z) * (s + 1)) / nSub;
      const dt = (tb - ta) / 1000;

      const w0 = await windAt(lat, lon, za, ta);
      if (w0.error) { status = "stopped"; reason = w0.error; break outer; }
      let [lat1, lon1] = advect(lat, lon, w0.u, w0.v, dt);
      for (let it = 0; it < maxIter; it++) {
        const w1 = await windAt(lat1, lon1, zb, tb);
        if (w1.error) { status = "stopped"; reason = w1.error; break outer; }
        const [latN, lonN] = advect(lat, lon, 0.5 * (w0.u + w1.u), 0.5 * (w0.v + w1.v), dt);
        const move = distMeters(lat1, lon1, latN, lonN);
        lat1 = latN; lon1 = lonN;
        if (move < tolMeters) break;
      }
      lat = lat1; lon = lon1;
    }
    points.push({ lat, lon, tMs: b.tMs, z: b.z });
    onProgress?.(tLast > tFirst ? (b.tMs - tFirst) / (tLast - tFirst) : 1);
  }

  return { points, status, reason };
}

/** Verlagerung in Kugelgeometrie; cos(Breite) im Meridianabstand. */
function advect(lat, lon, u, v, dtSec) {
  const latMid = (lat + (lat + (v * dtSec / R_EARTH) * DEG)) / 2;
  const dLat = (v * dtSec / R_EARTH) * DEG;
  const dLon = (u * dtSec / (R_EARTH * Math.cos(latMid / DEG))) * DEG;
  return [lat + dLat, normalizeLon(lon + dLon)];
}

function distMeters(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) / DEG * R_EARTH;
  const dx = (lon2 - lon1) / DEG * R_EARTH * Math.cos(((lat1 + lat2) / 2) / DEG);
  return Math.hypot(dx, dy);
}

function normalizeLon(lon) {
  return ((lon + 540) % 360) - 180;
}

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}

function abortError() {
  const e = new Error("Abgebrochen");
  e.name = "AbortError";
  return e;
}
