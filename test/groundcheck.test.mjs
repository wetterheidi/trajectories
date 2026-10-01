// Abbruch absoluter Zielhöhen (konstant NN, 3D) unter dem Modellgelände --
// Gegenstück zu python/tests/test_ground_check.py. Offline: die Gitterpunkte
// werden direkt in den Cache gelegt (Hang steigt nach Osten an).
import { WindField } from "../src/windfield.js";
import { computeTrajectory } from "../src/integrator.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const G = 0.02, LAT = 50, LON = 10;
const H_AGL = [10, 150, 300, 600, 1200];
const series = (x) => Float64Array.from([x, x, x]);

function point(elevation, w) {
  return {
    elevation,
    hAgl: Float64Array.from(H_AGL),
    u: H_AGL.map(() => series(5)), // Westwind 5 m/s -> nach Osten
    v: H_AGL.map(() => series(0)),
    p: null, T: null, q: null, rh: null, clc: null, ww: null,
    w: w == null ? null : H_AGL.map(() => series(w)),
  };
}

/** Westliche Ecken 400 m NN, östliche 1200 m NN. */
function slopeField(w = null) {
  const wf = new WindField("icon_d2", { wVarPrefix: w == null ? null : "wind_w" });
  wf.levels = [5, 4, 3, 2, 1];
  wf.times = [0, 3600, 7200];
  wf.needs = { p: false, t: false, w: w != null, met: false };
  const iLat = Math.floor(LAT / G + 1e-9), iLon = Math.floor(LON / G + 1e-9);
  for (const a of [iLat, iLat + 1]) {
    wf.points.set(wf.key(a, iLon), point(400, w));
    wf.points.set(wf.key(a, iLon + 1), point(1200, w));
  }
  return wf;
}

const AMSL_700 = { type: "height", mode: "amsl", value: 700 };

{
  const wf = slopeField();
  const ok = await wf.windAt(LAT, LON + 0.25 * G, AMSL_700, 0);
  check("NN: über interpolierter Orographie läuft (auch wenn eine Ecke höher ist)", !ok.error && ok.u === 5, ok.error);
  check("NN: Höhe = Zielhöhe, auch mit geklemmter Ecke", ok.zAmsl === 700, `z=${ok.zAmsl}`);
  const stop = await wf.windAt(LAT, LON + 0.5 * G, AMSL_700, 0);
  check("NN: unter interpolierter Orographie stoppt", stop.error === "Gelände über Zielhöhe (Höhe über NN)", stop.error);
  const agl = await wf.windAt(LAT, LON + 0.9 * G, { type: "height", mode: "agl", value: 100 }, 0);
  check("AGL: unberührt", !agl.error, agl.error);
}

{
  const wf = slopeField(0);
  const ok = await wf.windAt(LAT, LON + 0.25 * G, { type: "z3d", value: 700 }, 0);
  check("3D: gleiches Kriterium, Ecke über Zielhöhe stoppt nicht mehr", !ok.error, ok.error);
  const stop = await wf.windAt(LAT, LON + 0.5 * G, { type: "z3d", value: 700 }, 0);
  check("3D: unter Orographie stoppt", stop.error === "Trajektorie erreicht den Boden", stop.error);
}

{
  const wf = slopeField();
  const r = await computeTrajectory({
    windAt: (la, lo, tg, t) => wf.windAt(la, lo, tg, t),
    lat0: LAT, lon0: LON + 0.05 * G, target: AMSL_700, t0Ms: 0, durationHours: 1,
    gridMeters: 200, // Δt = 60 s -> 300 m je Schritt, bleibt in der Testzelle
    markerIntervalSec: 600,
  });
  check("NN-Trajektorie: Stopp mit Grund", r.status === "stopped" && r.reason === "Gelände über Zielhöhe (Höhe über NN)", r.reason);
  check("NN-Trajektorie: kein Punkt hinter der 700-m-Linie", r.points.every((p) => p.lon < LON + 0.375 * G));
}

process.exit(failures ? 1 : 0);
