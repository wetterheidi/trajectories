// Live-Test gegen open-meteo.mah.priv.at: 6-h-Vorwärtstrajektorien ab München
// in allen verfügbaren Vertikaloptionen + w-Erkennung.
import { WindField } from "../src/windfield.js";
import { computeTrajectory } from "../src/integrator.js";
import { MODELS, API_BASE } from "../src/config.js";

const lat0 = 48.14, lon0 = 11.57, heightM = 3000, mode = "amsl";

const meta = await (await fetch(`${API_BASE}/data/dwd_icon_eu/static/meta.json`)).json();
const t0 = (meta.last_run_initialisation_time + 6 * 3600) * 1000;
console.log("Lauf:", new Date(meta.last_run_initialisation_time * 1000).toISOString(),
  "| Daten bis:", new Date(meta.data_end_time * 1000).toISOString());

const wPrefix = await WindField.detectWVariable("icon_eu");
console.log("Modell-w verfügbar:", wPrefix ?? "nein");

const vmotions = ["height", "pressure", "theta", ...(wPrefix ? ["z3d"] : [])];
for (const vmotion of vmotions) {
  const wf = new WindField("icon_eu", { wVarPrefix: wPrefix });
  await wf.init(lat0, lon0, heightM, t0, t0 + 6 * 3600e3, vmotion);

  let target, label;
  if (vmotion === "height") {
    target = { type: "height", mode, value: heightM };
    label = `${heightM} m ${mode}`;
  } else {
    const d = await wf.diagnoseAt(lat0, lon0, heightM, mode, t0);
    if (d.error) throw new Error(d.error);
    target = vmotion === "pressure" ? { type: "pressure", value: d.p }
      : vmotion === "theta" ? { type: "theta", value: d.theta }
      : { type: "z3d", value: d.zAmsl };
    label = vmotion === "pressure" ? `${d.p.toFixed(0)} hPa`
      : vmotion === "theta" ? `θ ${d.theta.toFixed(1)} K`
      : `z0 ${d.zAmsl.toFixed(0)} m (3D)`;
  }

  const tStart = Date.now();
  const r = await computeTrajectory({
    windAt: wf.windAt.bind(wf), lat0, lon0, target,
    t0Ms: t0, durationHours: 6, direction: 1, gridMeters: MODELS.icon_eu.gridMeters,
  });
  const end = r.points.at(-1);
  console.log(`\n[${vmotion}] ${label}  Status: ${r.status}${r.reason ? ` (${r.reason})` : ""}` +
    `  ${Date.now() - tStart} ms`);
  for (const m of r.markers) {
    const spd = Math.hypot(m.u, m.v) * 3.6;
    console.log(`  ${new Date(m.tMs).toISOString().slice(11, 16)}  ` +
      `${m.lat.toFixed(3)}°N ${m.lon.toFixed(3)}°E  ${spd.toFixed(0)} km/h` +
      (Number.isFinite(m.z) ? `  z=${m.z.toFixed(0)} m NN` : ""));
  }
  if (r.status !== "ok") process.exitCode = 1;
}
