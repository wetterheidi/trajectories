/**
 * Positions-Eingabe als Text: Dezimalgrad oder MGRS, als Alternative zur
 * Ortssuche über Photon.
 */
import * as mgrs from "mgrs";

const DECIMAL_RE = /^(-?\d{1,3}(?:\.\d+)?)\s+(-?\d{1,3}(?:\.\d+)?)$/;
const MGRS_RE = /^[0-9]{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d{2}|\d{4}|\d{6}|\d{8}|\d{10})$/;

/** @returns {{lat:number, lon:number}|null} */
export function parseCoordInput(raw) {
  const s = (raw || "").trim();
  if (!s) return null;

  const cleaned = s.replace(/[,;\t]+/g, " ").trim();
  const m = cleaned.match(DECIMAL_RE);
  if (m) {
    const lat = Number(m[1]), lon = Number(m[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
    return null;
  }

  const g = s.replace(/\s/g, "").toUpperCase();
  if (MGRS_RE.test(g)) {
    try {
      const [lon, lat] = mgrs.toPoint(g);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    } catch { /* ungültige MGRS-Zeichenkette */ }
  }
  return null;
}
