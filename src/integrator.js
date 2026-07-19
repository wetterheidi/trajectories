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
    const w0 = await windAt(lat, lon, tgt, t);
    if (w0.error) { status = "stopped"; reason = w0.error; break; }
    if (points[0].z == null) points[0].z = w0.zAmsl ?? null;

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
      if (!w.error) markers.push({ lat, lon, tMs: t, u: w.u, v: w.v, z: w.zAmsl ?? null, met: w.met });
    }
  }

  return { points, markers, status, reason, target, direction };
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
