/**
 * Querschnitt entlang der Trajektorien als Small Multiples: ein Streifen je
 * Trajektorie, gemeinsame Zeitachse (x = Stunden seit Start) und gemeinsame
 * Höhenskala (y = m NN), damit die Streifen vergleichbar bleiben. Jeder
 * Streifen zeigt das Modellgelände entlang des eigenen Pfades als graue
 * Silhouette — so ist eindeutig, welches Gelände zu welcher Trajektorie
 * gehört. Reines SVG, ohne Abhängigkeiten.
 */

import { fmtHeight, heightToDisplay, heightFromDisplay, heightUnit } from "./units.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const INK = "#0b0b0b";
const INK_MUTED = "#52514e";
const GRID = "#e8e7e3";
const TERRAIN_FILL = "#e3e1dc";
const TERRAIN_EDGE = "#9c9b95";

export function renderCrossSection(host, data) {
  host.innerHTML = "";
  const { runs, t0Ms, direction } = data;

  const series = runs.map(({ r, color, label, terrain }) => ({
    color,
    label,
    pts: r.points
      .map((p, i) => ({ h: Math.abs(p.tMs - t0Ms) / 3600e3, z: p.z, g: terrain[i], tMs: p.tMs }))
      .filter((p) => Number.isFinite(p.z)),
    marks: r.markers
      .filter((m) => Number.isFinite(m.z))
      .map((m) => ({ h: Math.abs(m.tMs - t0Ms) / 3600e3, z: m.z })),
  })).filter((s) => s.pts.length > 1);
  if (!series.length) {
    host.textContent = "Keine Höhendaten für den Querschnitt.";
    return;
  }

  const W = Math.max(host.clientWidth, 320);
  const H = Math.max(host.clientHeight, 120);
  const M = { l: 54, r: 10 };
  const axisH = 22;
  const pw = W - M.l - M.r;
  const stripH = (H - axisH) / series.length;

  const xMax = Math.max(...series.map((s) => s.pts.at(-1).h)) || 1;
  const zAll = series.flatMap((s) => s.pts.flatMap((p) => Number.isFinite(p.g) ? [p.z, p.g] : [p.z]));
  const zLo = Math.min(...zAll);
  const zHi = Math.max(...zAll);
  const pad = Math.max(60, (zHi - zLo) * 0.06);
  const yMin = Math.max(-450, Math.min(0, zLo) - 50);
  const yMax = zHi + pad;

  const x = (h) => M.l + (h / xMax) * pw;
  const svg = mk("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });

  // Gemeinsame Zeitachse: Gitterlinien über alle Streifen, Labels unten.
  const xStep = [1, 2, 3, 6, 12, 24].find((s) => xMax / s <= 10) || 24;
  for (let h = 0; h <= xMax + 1e-9; h += xStep) {
    svg.append(
      mk("line", { x1: x(h), x2: x(h), y1: 0, y2: H - axisH, stroke: GRID, "stroke-width": 1 }),
      text(x(h), H - 7, `${direction < 0 && h > 0 ? "−" : ""}${h} h`, { anchor: "middle" }),
    );
  }

  svg.append(text(6, 11, `${heightUnit()} NN`, { anchor: "start", size: 10 }));

  // Höhenlinien in der Anzeige-Einheit (m oder ft) rastern.
  const dMin = heightToDisplay(yMin);
  const dMax = heightToDisplay(yMax);
  const yStep = niceStep((dMax - dMin) / 2.5);
  series.forEach((s, i) => {
    const top = i * stripH;
    const bottom = top + stripH;
    const innerTop = top + 14; // Platz für die Streifen-Beschriftung
    const y = (z) => bottom - ((z - yMin) / (yMax - yMin)) * (bottom - innerTop);

    // Höhenlinien + Labels je Streifen (gemeinsame Skala).
    for (let zd = Math.ceil(dMin / yStep) * yStep; zd <= dMax; zd += yStep) {
      const z = heightFromDisplay(zd);
      svg.append(
        mk("line", { x1: M.l, x2: W - M.r, y1: y(z), y2: y(z), stroke: GRID, "stroke-width": 1 }),
        text(M.l - 6, y(z) + 3.5, `${zd}`, { anchor: "end", size: 10 }),
      );
    }

    // Gelände entlang des Pfades dieser Trajektorie.
    const gPts = s.pts.filter((p) => Number.isFinite(p.g));
    if (gPts.length > 1) {
      const line = gPts.map((p) => `${x(p.h).toFixed(1)},${y(p.g).toFixed(1)}`).join(" ");
      svg.append(mk("polygon", {
        points: `${x(gPts[0].h).toFixed(1)},${bottom.toFixed(1)} ${line} ${x(gPts.at(-1).h).toFixed(1)},${bottom.toFixed(1)}`,
        fill: TERRAIN_FILL,
      }));
      svg.append(mk("polyline", { points: line, fill: "none", stroke: TERRAIN_EDGE, "stroke-width": 1 }));
    }

    // Trajektorie und Zeitmarken.
    svg.append(mk("polyline", {
      points: s.pts.map((p) => `${x(p.h).toFixed(1)},${y(p.z).toFixed(1)}`).join(" "),
      fill: "none", stroke: s.color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    for (const m of s.marks) {
      svg.append(mk("circle", {
        cx: x(m.h), cy: y(m.z), r: 2.5, fill: "#ffffff", stroke: s.color, "stroke-width": 1.5,
      }));
    }

    // Streifen-Beschriftung und Trennlinie.
    svg.append(mk("rect", { x: M.l + 6, y: top + 5, width: 14, height: 4, rx: 2, fill: s.color }));
    svg.append(text(M.l + 25, top + 11, s.label, { anchor: "start", size: 11, fill: INK }));
    if (i > 0) {
      svg.append(mk("line", { x1: 0, x2: W, y1: top, y2: top, stroke: "#c9c8c2", "stroke-width": 1 }));
    }

    s.y = y; // für die Hover-Ablesung
  });

  // Hover: Fadenkreuz über alle Streifen + Ablesung.
  const cursor = mk("line", { y1: 0, y2: H - axisH, stroke: INK_MUTED, "stroke-width": 1, visibility: "hidden" });
  svg.append(cursor);
  const tip = document.createElement("div");
  tip.className = "xsec-tip";
  tip.hidden = true;
  host.append(svg, tip);

  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    if (px < M.l || px > W - M.r) { cursor.setAttribute("visibility", "hidden"); tip.hidden = true; return; }
    const h = ((px - M.l) / pw) * xMax;
    cursor.setAttribute("x1", px);
    cursor.setAttribute("x2", px);
    cursor.setAttribute("visibility", "visible");

    const tMs = t0Ms + direction * h * 3600e3;
    const rows = series.map((s) => {
      const p = nearest(s.pts, h);
      const g = Number.isFinite(p.g) ? ` · Boden ${fmtHeight(p.g)}` : "";
      return `<div><span class="chip" style="background:${s.color}"></span>` +
        `${fmtHeight(p.z)} NN${g}</div>`;
    });
    tip.innerHTML = `<strong>${new Date(tMs).toISOString().slice(11, 16)}Z</strong>${rows.join("")}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(px + 12, W - tip.offsetWidth - 8)}px`;
    tip.style.top = "6px";
  });
  svg.addEventListener("mouseleave", () => {
    cursor.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

function nearest(pts, h) {
  let best = pts[0], bd = Infinity;
  for (const p of pts) {
    const d = Math.abs(p.h - h);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function niceStep(raw) {
  for (const s of [100, 200, 250, 500, 1000, 2000, 5000]) if (raw <= s) return s;
  return 10000;
}

function mk(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function text(xPos, yPos, str, { anchor = "start", size = 11, fill = INK_MUTED } = {}) {
  const t = mk("text", {
    x: xPos, y: yPos, "text-anchor": anchor, fill,
    "font-size": size, "font-family": "inherit",
  });
  t.textContent = str;
  return t;
}
