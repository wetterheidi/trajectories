import { computeTrajectory } from "../src/integrator.js";

const R = 6371000;
const DEG = 180 / Math.PI;
let failures = 0;

const H1500 = { type: "height", mode: "agl", value: 1500 };

function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

function distMeters(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) / DEG * R;
  const dx = (lon2 - lon1) / DEG * R * Math.cos(((lat1 + lat2) / 2) / DEG);
  return Math.hypot(dx, dy);
}

// --- Test 1: homogener Westwind 10 m/s, 6 h -> 216 km nach Osten -------------
{
  const windAt = async () => ({ u: 10, v: 0 });
  const r = await computeTrajectory({
    windAt, lat0: 45, lon0: 10, target: H1500, t0Ms: 0,
    durationHours: 6, direction: 1, gridMeters: 6500,
  });
  const last = r.points.at(-1);
  const d = distMeters(45, 10, last.lat, last.lon);
  check("Homogener Wind: Distanz 216 km", Math.abs(d - 216000) < 500, `d=${(d / 1000).toFixed(1)} km`);
  check("Homogener Wind: keine Breitenänderung", Math.abs(last.lat - 45) < 1e-6, `lat=${last.lat}`);
  check("Homogener Wind: 6 Stundenmarken", r.markers.length === 6, `n=${r.markers.length}`);

  // Markenabstand 30 min -> 12 Marken; Marken exakt auf Vielfachen ab Start.
  const r30 = await computeTrajectory({
    windAt, lat0: 45, lon0: 10, target: H1500, t0Ms: 900e3,
    durationHours: 6, direction: 1, gridMeters: 6500, markerIntervalSec: 1800,
  });
  check("Markenabstand 30 min: 12 Marken", r30.markers.length === 12, `n=${r30.markers.length}`);
  const offGrid = r30.markers.some((m) => Math.abs((m.tMs - 900e3) % 1800e3) > 1);
  check("Markenabstand: Marken auf Startzeit-Raster", !offGrid);
}

// --- Test 2: Rückwärts ist exakte Umkehr des Vorwärtslaufs -------------------
{
  const windAt = async (lat, lon) => ({ u: 8 + 0.5 * (lat - 45), v: 3 + 0.3 * (lon - 10) });
  const fwd = await computeTrajectory({
    windAt, lat0: 45, lon0: 10, target: H1500, t0Ms: 0,
    durationHours: 12, direction: 1, gridMeters: 6500,
  });
  const end = fwd.points.at(-1);
  const bwd = await computeTrajectory({
    windAt, lat0: end.lat, lon0: end.lon, target: H1500, t0Ms: end.tMs,
    durationHours: 12, direction: -1, gridMeters: 6500,
  });
  const back = bwd.points.at(-1);
  const err = distMeters(45, 10, back.lat, back.lon);
  const total = distMeters(45, 10, end.lat, end.lon);
  check("Rückwärts: Rückkehr zum Start < 0.5 % der Strecke", err < 0.005 * total,
    `err=${(err / 1000).toFixed(2)} km von ${(total / 1000).toFixed(0)} km`);
}

// --- Test 3: Starre Rotation -> geschlossener Kreis --------------------------
{
  const omega = (2 * Math.PI) / (24 * 3600);
  const windAt = async (lat, lon) => {
    const y = (lat - 45) / DEG * R;
    const x = (lon - 10) / DEG * R * Math.cos(45 / DEG);
    return { u: -omega * y, v: omega * x };
  };
  const r = await computeTrajectory({
    windAt, lat0: 45.9, lon0: 10, target: H1500, t0Ms: 0,
    durationHours: 24, direction: 1, gridMeters: 6500, maxStepSec: 300,
  });
  const last = r.points.at(-1);
  const radius = distMeters(45, 10, 45.9, 10);
  const err = distMeters(45.9, 10, last.lat, last.lon);
  check("Rotation: Kreisschluss < 2 % des Radius", err < 0.02 * radius,
    `err=${(err / 1000).toFixed(2)} km, Radius=${(radius / 1000).toFixed(0)} km`);
}

// --- Test 4: Sauberer Stopp bei Datenende ------------------------------------
{
  const windAt = async (lat, lon, tg, t) =>
    t > 3 * 3600e3 ? { error: "Ende des Datenzeitraums erreicht" } : { u: 10, v: 0 };
  const r = await computeTrajectory({
    windAt, lat0: 45, lon0: 10, target: H1500, t0Ms: 0,
    durationHours: 6, direction: 1, gridMeters: 6500,
  });
  check("Stopp: Status und Grund gesetzt", r.status === "stopped" && !!r.reason, r.reason);
  check("Stopp: ~3 h gerechnet", Math.abs(r.points.at(-1).tMs - 3 * 3600e3) < 3600e3 / 2);
}

// --- Test 5: 3D mit Modell-w — Höhe wird mitintegriert -----------------------
{
  // Konstantes Aufsteigen 0.5 m/s: nach 2 h muss z um 3600 m gestiegen sein.
  const windAt = async (lat, lon, tg) => ({ u: 10, v: 0, w: 0.5, zAmsl: tg.value });
  const r = await computeTrajectory({
    windAt, lat0: 45, lon0: 10, target: { type: "z3d", value: 1000 }, t0Ms: 0,
    durationHours: 2, direction: 1, gridMeters: 6500,
  });
  const zEnd = r.points.at(-1).z;
  check("3D: Endhöhe 4600 m", Math.abs(zEnd - 4600) < 1, `z=${zEnd?.toFixed(1)}`);
  check("3D: Marken tragen Höhe", r.markers.every((m) => Number.isFinite(m.z)));

  // Höhenabhängige Scherung: 3D-Lauf rückwärts kehrt zum Start zurück.
  const shear = async (lat, lon, tg) => ({
    u: 5 + tg.value / 500, v: 2, w: 0.3, zAmsl: tg.value,
  });
  const fwd = await computeTrajectory({
    windAt: shear, lat0: 45, lon0: 10, target: { type: "z3d", value: 800 }, t0Ms: 0,
    durationHours: 6, direction: 1, gridMeters: 6500,
  });
  const e = fwd.points.at(-1);
  const bwd = await computeTrajectory({
    windAt: shear, lat0: e.lat, lon0: e.lon, target: { type: "z3d", value: e.z }, t0Ms: e.tMs,
    durationHours: 6, direction: -1, gridMeters: 6500,
  });
  const b = bwd.points.at(-1);
  const err = distMeters(45, 10, b.lat, b.lon) + Math.abs(b.z - 800);
  check("3D: Rückwärts-Umkehr (Ort+Höhe) < 1 km", err < 1000, `err=${err.toFixed(0)} m`);
}

process.exit(failures ? 1 : 0);
