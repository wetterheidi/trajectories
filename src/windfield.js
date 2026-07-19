import { API_BASE, MODELS } from "./config.js";

const KMH_TO_MS = 1 / 3.6;
const MAX_POINTS_PER_REQUEST = 10;
const KAPPA = 0.2854; // R/cp trockene Luft

/**
 * Windfeld eines Modells: holt u/v (und je nach Vertikaloption p, T, w) auf
 * nativen ICON-Modellleveln, cacht sie je Gitterpunkt und liefert horizontal
 * bilinear, vertikal und zeitlich linear interpolierten Wind.
 *
 * Vertikal-Zielflächen (target):
 *   {type:"height",   mode:"agl"|"amsl", value: m}  konstante Höhe
 *   {type:"pressure", value: hPa}                   isobar
 *   {type:"theta",    value: K}                     isentrop
 *   {type:"z3d",      value: m AMSL}                3D mit Modell-w
 */
export class WindField {
  constructor(modelKey, { fetchImpl, wVarPrefix = null, debug = false } = {}) {
    this.model = MODELS[modelKey];
    if (!this.model) throw new Error(`Unbekanntes Modell: ${modelKey}`);
    this.modelKey = modelKey;
    this.fetch = fetchImpl || fetch.bind(globalThis);
    this.wVarPrefix = wVarPrefix; // z. B. "vertical_velocity", sobald verfügbar
    this.debug = debug; // Konsolen-Monitor: loggt jeden Interpolationsaufruf
    this.points = new Map();
    this.levels = null;
    this.times = null;
    this.units = {};
    this.needs = { p: false, t: false, w: false };
    this.startDate = null;
    this.endDate = null;
    this.pending = new Map();
  }

  /** Prüft je Modell, ob der Server Modell-Vertikalgeschwindigkeit anbietet.
   *  Zählt nur, wenn auch echte Werte kommen — eine Variable, die (noch)
   *  ausschließlich null liefert, gilt als nicht verfügbar. */
  static async detectWVariable(modelKey = "icon_eu", fetchImpl = fetch.bind(globalThis)) {
    const model = MODELS[modelKey];
    for (const prefix of ["vertical_velocity", "w", "wind_w_component", "wz", "omega"]) {
      try {
        const varName = `${prefix}_level${model.nLevels - 5}`;
        const url = `${API_BASE}/v1/forecast?latitude=50&longitude=10` +
          `&hourly=${varName}&models=${model.apiModel}&forecast_days=1`;
        const resp = await fetchImpl(url);
        if (!resp.ok) continue;
        const d = await resp.json();
        if (d.error) continue;
        const vals = d.hourly?.[varName];
        if (Array.isArray(vals) && vals.some((v) => v != null && Number.isFinite(v))) {
          return prefix;
        }
      } catch {
        /* Kandidat nicht verfügbar */
      }
    }
    return null;
  }

  inBBox(lat, lon) {
    const b = this.model.bbox;
    return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
  }

  /**
   * Levelfenster aus Sondierung am Startpunkt, Zeitfenster fixieren und
   * anhand der Vertikaloption festlegen, welche Variablen geholt werden.
   */
  async init(lat0, lon0, maxHeightM, tMinMs, tMaxMs, vmotion = "height") {
    this.needs = {
      p: vmotion === "pressure" || vmotion === "theta",
      t: vmotion === "theta",
      w: vmotion === "z3d",
    };
    if (this.needs.w && !this.wVarPrefix) {
      throw new Error("Server liefert (noch) keine Modell-Vertikalgeschwindigkeit");
    }
    // Diagnose von p0/θ0 am Start braucht p und T auch bei anderen Optionen.
    if (vmotion === "pressure" || vmotion === "theta") {
      this.needs.p = true;
      this.needs.t = true;
    }

    const n = this.model.nLevels;
    const d0 = new Date(Math.min(tMinMs, tMaxMs) - 3600e3);
    const d1 = new Date(Math.max(tMinMs, tMaxMs) + 3600e3);
    this.startDate = d0.toISOString().slice(0, 10);
    this.endDate = d1.toISOString().slice(0, 10);

    const vars = [];
    for (let l = 1; l <= n; l++) vars.push(`height_agl_level${l}`);
    const probe = await this.request([[lat0, lon0]], vars);
    const h = probe[0];

    // Isobare/isentrope Flächen können absinken/aufsteigen: großzügigerer
    // Puffer als bei konstanter Höhe. Faktor 1.3 für Geländeeinfluss.
    const buffer = vmotion === "height" ? 1200 : 2500;
    const requiredTop = (maxHeightM + buffer) * 1.3;
    const levels = [];
    for (let l = n; l >= 1; l--) {
      const hl = firstFinite(h[`height_agl_level${l}`]);
      levels.push(l);
      if (hl != null && hl >= requiredTop) break;
    }
    this.levels = levels; // levels[0] = unterstes Level
  }

  levelVars() {
    const vars = [];
    for (const l of this.levels) {
      vars.push(`wind_u_component_level${l}`, `wind_v_component_level${l}`, `height_agl_level${l}`);
      if (this.needs.p) vars.push(`pressure_level${l}`);
      if (this.needs.t) vars.push(`temperature_level${l}`);
      if (this.needs.w) vars.push(`${this.wVarPrefix}_level${l}`);
    }
    return vars;
  }

  key(iLat, iLon) {
    return `${iLat},${iLon}`;
  }

  cornerIndices(lat, lon) {
    const g = this.model.grid;
    return { iLat: Math.floor(lat / g + 1e-9), iLon: Math.floor(lon / g + 1e-9) };
  }

  async ensureCorners(lat, lon) {
    const { iLat, iLon } = this.cornerIndices(lat, lon);
    const wanted = [
      [iLat, iLon], [iLat + 1, iLon], [iLat, iLon + 1], [iLat + 1, iLon + 1],
    ];
    const anyMissing = wanted.some(([a, b]) =>
      !this.points.has(this.key(a, b)) && !this.pending.has(this.key(a, b)));
    if (anyMissing) {
      // Block-Prefetch: gleich die 4x4-Umgebung holen — die Trajektorie
      // kommt ohnehin dorthin, und ein großer Request schlägt viele kleine.
      const g = this.model.grid;
      const b0 = this.model.bbox;
      const block = [];
      for (let a = iLat - 1; a <= iLat + 2; a++) {
        for (let b = iLon - 1; b <= iLon + 2; b++) {
          const inCore = wanted.some(([wa, wb]) => wa === a && wb === b);
          const inBox = a * g >= b0.latMin && a * g <= b0.latMax &&
            b * g >= b0.lonMin && b * g <= b0.lonMax;
          if ((inCore || inBox) && !this.points.has(this.key(a, b)) && !this.pending.has(this.key(a, b))) {
            block.push([a, b]);
          }
        }
      }
      const coords = block.map(([a, b]) => [a * g, b * g]);
      const p = this.fetchPoints(coords, block);
      for (const [a, b] of block) this.pending.set(this.key(a, b), p);
      try {
        await p;
      } finally {
        for (const [a, b] of block) this.pending.delete(this.key(a, b));
      }
    }
    const stillPending = wanted
      .map(([a, b]) => this.pending.get(this.key(a, b)))
      .filter(Boolean);
    if (stillPending.length) await Promise.all(stillPending);
  }

  async fetchPoints(coords, indices) {
    const vars = this.levelVars();
    const jobs = [];
    for (let i = 0; i < coords.length; i += MAX_POINTS_PER_REQUEST) {
      const chunk = coords.slice(i, i + MAX_POINTS_PER_REQUEST);
      const idx = indices.slice(i, i + MAX_POINTS_PER_REQUEST);
      jobs.push(this.request(chunk, vars, true).then((results) => {
        results.forEach((r, j) => this.storePoint(idx[j][0], idx[j][1], r));
      }));
    }
    await Promise.all(jobs);
  }

  storePoint(iLat, iLon, r) {
    const L = this.levels.length;
    if (!this.times) this.times = r.__times;
    const T = this.times.length;
    const wUnit = this.needs.w ? unitFactor(this.units[`${this.wVarPrefix}_level${this.levels[0]}`]) : 1;
    const point = {
      elevation: r.__elevation,
      hAgl: new Float64Array(L),
      u: [], v: [],
      p: this.needs.p ? [] : null,
      T: this.needs.t ? [] : null,
      w: this.needs.w ? [] : null,
    };
    for (let k = 0; k < L; k++) {
      const l = this.levels[k];
      point.u.push(toArray(r[`wind_u_component_level${l}`], T, KMH_TO_MS));
      point.v.push(toArray(r[`wind_v_component_level${l}`], T, KMH_TO_MS));
      if (point.p) point.p.push(toArray(r[`pressure_level${l}`], T, 1));
      if (point.T) point.T.push(toArray(r[`temperature_level${l}`], T, 1, 273.15));
      if (point.w) point.w.push(toArray(r[`${this.wVarPrefix}_level${l}`], T, wUnit));
      const h = firstFinite(r[`height_agl_level${l}`]);
      point.hAgl[k] = h == null ? NaN : h;
    }
    this.points.set(this.key(iLat, iLon), point);
  }

  async request(coords, vars, withMeta = false) {
    const params = new URLSearchParams({
      latitude: coords.map((c) => round5(c[0])).join(","),
      longitude: coords.map((c) => round5(c[1])).join(","),
      hourly: vars.join(","),
      models: this.model.apiModel,
      timeformat: "unixtime",
      start_date: this.startDate,
      end_date: this.endDate,
      cell_selection: "nearest",
    });
    const url = `${API_BASE}/v1/forecast?${params}`;
    const resp = await this.fetch(url);
    if (!resp.ok) throw new Error(`API-Fehler ${resp.status} für ${url.slice(0, 120)}…`);
    const data = await resp.json();
    const arr = Array.isArray(data) ? data : [data];
    return arr.map((d) => {
      Object.assign(this.units, d.hourly_units || {});
      const out = d.hourly || {};
      if (withMeta) {
        out.__times = d.hourly.time;
        out.__elevation = d.elevation;
      }
      return out;
    });
  }

  timeWeights(tMs) {
    const t = tMs / 1000;
    const times = this.times;
    if (t < times[0] || t > times[times.length - 1]) return null;
    const ti = Math.min(Math.floor((t - times[0]) / 3600), times.length - 2);
    return { ti, tw: (t - times[ti]) / 3600 };
  }

  bilinearWeights(lat, lon) {
    const g = this.model.grid;
    const { iLat, iLon } = this.cornerIndices(lat, lon);
    const fy = lat / g - iLat;
    const fx = lon / g - iLon;
    return [
      [(1 - fy) * (1 - fx), iLat, iLon],
      [fy * (1 - fx), iLat + 1, iLon],
      [(1 - fy) * fx, iLat, iLon + 1],
      [fy * fx, iLat + 1, iLon + 1],
    ];
  }

  /**
   * Wind (u, v [, w] in m/s) auf der Zielfläche `target` samt diagnostizierter
   * absoluter Höhe zAmsl. Liefert {error} an Gebiets-/Zeit-/Datengrenzen.
   */
  async windAt(lat, lon, target, tMs) {
    if (!this.inBBox(lat, lon)) return { error: "Rand des Modellgebiets erreicht" };
    await this.ensureCorners(lat, lon);
    const tt = this.timeWeights(tMs);
    if (!tt) return { error: "Ende des Datenzeitraums erreicht" };

    let U = 0, V = 0, W = 0, Z = 0;
    const dbg = this.debug ? [] : null;
    for (const [wt, a, b] of this.bilinearWeights(lat, lon)) {
      const p = this.points.get(this.key(a, b));
      if (!p) return { error: "Datenlücke im Gitter" };
      const c = resolveOnTarget(p, target, tt);
      if (c.error) return c;
      U += wt * c.u;
      V += wt * c.v;
      W += wt * (c.w ?? 0);
      Z += wt * (p.elevation + c.hAgl);
      if (dbg) dbg.push(this.debugCorner(p, c, wt, a, b, tt));
    }
    if (!Number.isFinite(U) || !Number.isFinite(V)) return { error: "Fehlende Winddaten (Modelllauf unvollständig)" };
    if (dbg) {
      const tgt = `${target.type}=${Math.round(target.value)}${target.mode ? ` ${target.mode}` : ""}`;
      console.debug(
        `[traj] ${new Date(tMs).toISOString().slice(0, 16)}Z ` +
        `${lat.toFixed(4)}°N ${lon.toFixed(4)}°E  ${tgt}  ` +
        `u=${U.toFixed(2)} v=${V.toFixed(2)}${this.needs.w ? ` w=${W.toFixed(3)}` : ""} m/s  ` +
        `z=${Math.round(Z)} m NN`,
      );
      console.table(dbg);
    }
    return { u: U, v: V, w: this.needs.w ? W : undefined, zAmsl: Z };
  }

  /** Eine Zeile des Konsolen-Monitors: welcher Gitterpunkt mit welchem
   *  Gewicht, welche ICON-Level als Bracket, und p/T dort (falls geladen). */
  debugCorner(p, c, wt, iLat, iLon, tt) {
    const g = this.model.grid;
    const row = {
      Gitterpunkt: `${(iLat * g).toFixed(3)},${(iLon * g).toFixed(3)}`,
      Gewicht: +wt.toFixed(3),
      Level: `${this.levels[c.k1]}–${this.levels[c.k0]}`,
      "hAGL-Bracket": `${Math.round(p.hAgl[c.k0])}–${Math.round(p.hAgl[c.k1])} m`,
      hw: +c.hw.toFixed(3),
      "u/v [m/s]": `${c.u.toFixed(2)}/${c.v.toFixed(2)}`,
    };
    const at = (arr) => levelValueAtT(arr[c.k0], tt) + c.hw * (levelValueAtT(arr[c.k1], tt) - levelValueAtT(arr[c.k0], tt));
    if (p.p) row["p [hPa]"] = +at(p.p).toFixed(1);
    if (p.T) row["T [°C]"] = +(at(p.T) - 273.15).toFixed(1);
    if (p.w) row["w [m/s]"] = +at(p.w).toFixed(3);
    return row;
  }

  /** Modell-Geländehöhe (bilinear) aus dem Cache — nur für Positionen, an
   *  denen bereits Wind interpoliert wurde (z. B. Trajektorienpunkte). */
  elevationAt(lat, lon) {
    let E = 0;
    for (const [wt, a, b] of this.bilinearWeights(lat, lon)) {
      const p = this.points.get(this.key(a, b));
      if (!p) return null;
      E += wt * p.elevation;
    }
    return E;
  }

  /** Druck, potentielle Temperatur und absolute Höhe in gegebener Höhe —
   *  zum Festlegen von p0/θ0/z0 am Startpunkt. */
  async diagnoseAt(lat, lon, heightM, mode, tMs) {
    await this.ensureCorners(lat, lon);
    const tt = this.timeWeights(tMs);
    if (!tt) return { error: "Startzeit außerhalb des Datenzeitraums" };

    let P = 0, TH = 0, Z = 0;
    for (const [wt, a, b] of this.bilinearWeights(lat, lon)) {
      const pt = this.points.get(this.key(a, b));
      if (!pt) return { error: "Datenlücke im Gitter" };
      const hTarget = mode === "amsl" ? heightM - pt.elevation : heightM;
      const br = heightBracket(pt.hAgl, hTarget);
      if (br.error) return br;
      Z += wt * (pt.elevation + Math.max(hTarget, pt.hAgl[0]));
      if (pt.p) {
        const p0 = levelValueAtT(pt.p[br.k0], tt), p1 = levelValueAtT(pt.p[br.k1], tt);
        // Druck logarithmisch in der Höhe interpolieren.
        P += wt * Math.exp(Math.log(p0) + br.hw * (Math.log(p1) - Math.log(p0)));
        if (pt.T) {
          const th0 = theta(levelValueAtT(pt.T[br.k0], tt), p0);
          const th1 = theta(levelValueAtT(pt.T[br.k1], tt), p1);
          TH += wt * (th0 + br.hw * (th1 - th0));
        }
      }
    }
    return { p: P || null, theta: TH || null, zAmsl: Z };
  }
}

/** Zielfläche in einer Gitterpunkt-Säule finden und u/v (und w) dort
 *  interpolieren. Immer komponentenweise, zeitlich linear je Level. */
function resolveOnTarget(pt, target, tt) {
  let br;
  if (target.type === "height" || target.type === "z3d") {
    const hTarget = target.type === "z3d" || target.mode === "amsl"
      ? target.value - pt.elevation
      : target.value;
    if (target.type === "z3d" && hTarget < 0) return { error: "Trajektorie erreicht den Boden" };
    br = heightBracket(pt.hAgl, hTarget);
    if (br.error) return br;
  } else if (target.type === "pressure") {
    br = pressureBracket(pt, target.value, tt);
  } else if (target.type === "theta") {
    br = thetaBracket(pt, target.value, tt);
  } else {
    return { error: `Unbekannte Zielfläche: ${target.type}` };
  }
  if (br.error) return br;

  const { k0, k1, hw } = br;
  const u0 = levelValueAtT(pt.u[k0], tt), u1 = levelValueAtT(pt.u[k1], tt);
  const v0 = levelValueAtT(pt.v[k0], tt), v1 = levelValueAtT(pt.v[k1], tt);
  const out = {
    u: u0 + hw * (u1 - u0),
    v: v0 + hw * (v1 - v0),
    hAgl: pt.hAgl[k0] + hw * (pt.hAgl[k1] - pt.hAgl[k0]),
    k0, k1, hw, // fürs Debug-Protokoll
  };
  if (pt.w) {
    const w0 = levelValueAtT(pt.w[k0], tt), w1 = levelValueAtT(pt.w[k1], tt);
    out.w = w0 + hw * (w1 - w0);
  }
  return out;
}

/** Höhen-Bracket; unterhalb des untersten Levels (~10 m) wird auf dieses
 *  geklammert. */
function heightBracket(hAgl, hTarget) {
  const L = hAgl.length;
  let k1 = 0;
  while (k1 < L && hAgl[k1] < hTarget) k1++;
  if (k1 >= L) return { error: "Oberhalb des geladenen Höhenfensters" };
  const k0 = Math.max(0, k1 - 1);
  const hw = k1 === k0 || hTarget <= hAgl[k0] ? 0 : (hTarget - hAgl[k0]) / (hAgl[k1] - hAgl[k0]);
  return { k0, k1, hw };
}

/** Isobare Fläche: p fällt monoton mit der Höhe; Interpolation in ln(p). */
function pressureBracket(pt, pTarget, tt) {
  const L = pt.hAgl.length;
  const pBottom = levelValueAtT(pt.p[0], tt);
  if (pTarget > pBottom) return { error: "Druckfläche schneidet das Gelände" };
  for (let k = 1; k < L; k++) {
    const pk = levelValueAtT(pt.p[k], tt);
    if (pk <= pTarget) {
      const pPrev = levelValueAtT(pt.p[k - 1], tt);
      const hw = (Math.log(pTarget) - Math.log(pPrev)) / (Math.log(pk) - Math.log(pPrev));
      return { k0: k - 1, k1: k, hw };
    }
  }
  return { error: "Druckfläche oberhalb des geladenen Höhenfensters" };
}

/** Isentrope Fläche: erster θ-Durchgang von unten (θ kann in labilen
 *  Schichten nicht-monoton sein). */
function thetaBracket(pt, thTarget, tt) {
  const L = pt.hAgl.length;
  let thPrev = theta(levelValueAtT(pt.T[0], tt), levelValueAtT(pt.p[0], tt));
  if (thTarget < thPrev) return { error: "Isentrope schneidet das Gelände" };
  for (let k = 1; k < L; k++) {
    const th = theta(levelValueAtT(pt.T[k], tt), levelValueAtT(pt.p[k], tt));
    if ((thPrev <= thTarget && thTarget <= th) || (th <= thTarget && thTarget <= thPrev)) {
      const hw = th === thPrev ? 0 : (thTarget - thPrev) / (th - thPrev);
      return { k0: k - 1, k1: k, hw };
    }
    thPrev = th;
  }
  return { error: "Isentrope oberhalb des geladenen Höhenfensters" };
}

function theta(tK, pHpa) {
  return tK * Math.pow(1000 / pHpa, KAPPA);
}

function levelValueAtT(arr, { ti, tw }) {
  return arr[ti] + tw * (arr[ti + 1] - arr[ti]);
}

function toArray(src, T, factor, offset = 0) {
  const out = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    out[t] = src?.[t] == null ? NaN : src[t] * factor + offset;
  }
  return out;
}

function unitFactor(unit) {
  if (unit === "km/h") return KMH_TO_MS;
  if (unit === "cm/s") return 0.01;
  return 1; // m/s oder unbekannt
}

function firstFinite(arr) {
  if (!arr) return null;
  for (const x of arr) if (x != null && Number.isFinite(x)) return x;
  return null;
}

function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}
