// Tests für den Hindcast (diagnose/): Rechnen entlang eines Höhen-Zeit-
// Profils (computeAlongProfile) und die reinen Track-Helfer.
import { computeAlongProfile } from "../src/integrator.js";
import { detectFlight, diagStats, obsVel, dist, angleDiff } from "../src/diagnose/track.js";

const R = 6371000;
const DEG = 180 / Math.PI;
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const eastMeters = (lon, lat) => (lon / DEG) * R * Math.cos(lat / DEG);

/** Profil: n+1 Punkte im Abstand dtSec, Höhe nach zOf(t in s). */
function profile(n, dtSec, zOf = () => 1000) {
  return Array.from({ length: n + 1 }, (_, i) => ({ tMs: i * dtSec * 1000, z: zOf(i * dtSec) }));
}

// --- 1: homogener Westwind 10 m/s, 600 s -> 6 km Ost --------------------------
{
  const r = await computeAlongProfile({
    windAt: async () => ({ u: 10, v: 0 }), lat0: 0, lon0: 0, profile: profile(200, 3),
  });
  const d = eastMeters(r.points.at(-1).lon, 0);
  check("Homogen: 6 km nach Osten", Math.abs(d - 6000) < 1, `d=${d.toFixed(2)} m`);
  check("Homogen: ein Punkt je Profilpunkt", r.points.length === 201, `n=${r.points.length}`);
  check("Homogen: Status ok", r.status === "ok");
}

// --- 2: Wind wächst mit der Höhe, Ballon steigt 1 m/s ------------------------
// u = z/100, z = t  ->  x = ∫ t/100 dt über 0..1000 s = 5000 m. Die Höhe muss
// also zu jedem Zeitpunkt die des Profils sein, nicht die Starthöhe.
{
  const r = await computeAlongProfile({
    windAt: async (lat, lon, z) => ({ u: z / 100, v: 0 }),
    lat0: 0, lon0: 0, profile: profile(250, 4, (t) => t),
  });
  const d = eastMeters(r.points.at(-1).lon, 0);
  check("Höhenprofil: 5000 m (Wind folgt GPS-Höhe)", Math.abs(d - 5000) < 1, `d=${d.toFixed(2)} m`);
  check("Höhenprofil: z der Punkte = Profil", r.points.at(-1).z === 1000);
}

// --- 3: lange Lücke wird unterteilt (zeitabhängiger Wind) --------------------
// v = 10·sin(πt/600), ein einziger 600-s-Profilschritt. Exakt: ∫ = 12000/π m
// ≈ 3819,7 m. Ein ungeteilter Heun-Schritt sähe nur v(0)=v(600)=0 und
// bliebe stehen -- unterteilt (maxStepSec) muss er das Integral treffen.
{
  const windAt = async (lat, lon, z, tMs) => ({ u: 0, v: 10 * Math.sin((Math.PI * tMs) / 600e3) });
  const prof = [{ tMs: 0, z: 0 }, { tMs: 600e3, z: 0 }];
  const coarse = await computeAlongProfile({ windAt, lat0: 0, lon0: 0, profile: prof, maxStepSec: 1e9 });
  const fine = await computeAlongProfile({ windAt, lat0: 0, lon0: 0, profile: prof });
  const exact = 12000 / Math.PI;
  const dC = coarse.points.at(-1).lat / DEG * R, dF = fine.points.at(-1).lat / DEG * R;
  check("Lücke unterteilt: fein ≈ exakt (< 0,5 %)", Math.abs(dF - exact) < 0.005 * exact, `fein=${dF.toFixed(1)} m, exakt=${exact.toFixed(1)} m`);
  check("Lücke ungeteilt wäre falsch", Math.abs(dC - exact) > 1000, `grob=${dC.toFixed(1)} m`);
}

// --- 4: Abbruch bei Fehler, Punkte bis dahin ---------------------------------
{
  const r = await computeAlongProfile({
    windAt: async (lat, lon, z, tMs) => (tMs > 30e3 ? { error: "Rand des Modellgebiets erreicht" } : { u: 5, v: 0 }),
    lat0: 0, lon0: 0, profile: profile(20, 3),
  });
  check("Abbruch: Status stopped", r.status === "stopped" && /Rand/.test(r.reason), r.reason);
  check("Abbruch: Punkte bis 30 s", r.points.at(-1).tMs === 30e3, `t=${r.points.at(-1).tMs}`);
}

// --- 5: Doppelte Zeitstempel überspringen, Fortschritt bis 1 ------------------
{
  let last = 0;
  const r = await computeAlongProfile({
    windAt: async () => ({ u: 1, v: 0 }), lat0: 0, lon0: 0,
    profile: [{ tMs: 0, z: 0 }, { tMs: 0, z: 0 }, { tMs: 10e3, z: 0 }],
    onProgress: (f) => { last = f; },
  });
  check("Gleiche Zeit: Punkt bleibt stehen", r.points[1].lon === 0 && r.points.length === 3);
  check("Fortschritt endet bei 1", last === 1);
}

// --- Track-Helfer -------------------------------------------------------------
{
  // Am Boden 10 Punkte, dann Steigen, Fahrt nach Osten, Landung, Stehen.
  const pts = [];
  let t = 0;
  for (let i = 0; i < 10; i++) pts.push({ tMs: (t += 10e3), lat: 48, lon: 11, z: 600 });
  for (let i = 1; i <= 50; i++) pts.push({ tMs: (t += 10e3), lat: 48, lon: 11 + i * 0.001, z: 600 + Math.min(i, 25) * 40 });
  for (let i = 0; i < 10; i++) pts.push({ tMs: (t += 10e3), lat: 48, lon: 11.05, z: 610 });
  const [i0, i1] = detectFlight(pts);
  check("Start erkannt (letzter Bodenpunkt)", i0 === 9, `i0=${i0}`);
  check("Landung erkannt (vor dem Stehen)", i1 >= 59 && i1 <= 61, `i1=${i1}`);

  const ov = obsVel(pts, 30);
  check("Beobachtete Fahrt nach Osten", ov && Math.abs(ov.dir - 90) < 1, `dir=${ov?.dir.toFixed(1)}`);

  const gps = pts.slice(i0, i1 + 1);
  const same = diagStats(gps, gps);
  check("Kennzahlen: identische Spur -> 0 Ablage", same.endSep === 0 && same.maxSep === 0);
  const shifted = gps.map((p) => ({ ...p, lat: p.lat + 0.001 }));
  const s = diagStats(gps, shifted);
  const expect = dist(48, 11, 48.001, 11);
  check("Kennzahlen: konstante Ablage", Math.abs(s.meanSep - expect) < 1 && Math.abs(s.endSep - expect) < 1,
    `mean=${s.meanSep.toFixed(1)} m`);
  const w = diagStats(gps, gps, gps.map(() => ({ spd: 10, dir: 90 })), gps.map(() => ({ spd: 12, dir: 100 })));
  check("Kennzahlen: Bias +2 m/s, Richtung 10°", Math.abs(w.biasSpd - 2) < 1e-9 && Math.abs(w.meanAbsDir - 10) < 1e-9);
  check("Winkeldifferenz über 0°", angleDiff(5, 355) === 10 && angleDiff(355, 5) === -10);
}

if (failures) {
  console.error(`\n${failures} Test(s) fehlgeschlagen`);
  process.exit(1);
}
console.log("\nAlle Diagnose-Tests bestanden.");
