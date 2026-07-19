/** Anzeige-Einheiten (intern wird durchgehend SI gerechnet: m, m/s). */

const FT_PER_M = 3.28084;
const KT_PER_MS = 1.94384;

export const unitState = { height: "m", wind: "kmh" };

export function setUnits({ height, wind } = {}) {
  if (["m", "ft"].includes(height)) unitState.height = height;
  if (["kmh", "ms", "kt"].includes(wind)) unitState.wind = wind;
}

export function fmtHeight(m) {
  return unitState.height === "ft" ? `${Math.round(m * FT_PER_M)} ft` : `${Math.round(m)} m`;
}

export function heightUnit() {
  return unitState.height;
}

export function heightToDisplay(m) {
  return unitState.height === "ft" ? m * FT_PER_M : m;
}

export function heightFromDisplay(v) {
  return unitState.height === "ft" ? v / FT_PER_M : v;
}

export function heightSliderCfg() {
  return unitState.height === "ft"
    ? { min: 50, max: 20000, step: 50, inputMax: 33000 }
    : { min: 10, max: 6000, step: 10, inputMax: 10000 };
}

export function fmtWind(ms) {
  switch (unitState.wind) {
    case "ms": return `${ms.toFixed(1)} m/s`;
    case "kt": return `${Math.round(ms * KT_PER_MS)} kt`;
    default: return `${Math.round(ms * 3.6)} km/h`;
  }
}
