import { API_BASES, MODELS } from "../config.js";
import { fetchWithFallback } from "meteokit/apifetch";

// Wie weit reicht das Archiv des Modelllevel-Servers zurück? meta.json nennt
// nur das Ende (data_end_time), keinen Anfang -- und die Tiefe ändert sich mit
// dem Speicherbetrieb auf dem Server (Stand 2026-10: ca. 14 Tage auf
// open-meteo.wetterheidi.de, ca. 10 auf dem Fallback). Deshalb wird live
// gefragt: das unterste Modelllevel über die maximal erlaubten past_days an
// einem Punkt im Modellgebiet holen und die erste Stunde mit Wert suchen.
// Gleiche Host-Kette und sourceKey wie die Winddaten (windfield.js), also
// derselbe Server, der später auch rechnet.
const MAX_PAST_DAYS = 92; // Obergrenze der Open-Meteo-API

/** {startSec, endSec, base} des Archivs am Punkt (lat, lon) für ein Modell. */
export async function probeArchive(modelKey, lat, lon, { signal } = {}) {
  const m = MODELS[modelKey];
  const v = `wind_u_component_level${m.nLevels}`;
  const q = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: v,
    models: m.apiModel,
    past_days: String(MAX_PAST_DAYS),
    forecast_days: "1",
    timeformat: "unixtime",
  });
  const resp = await fetchWithFallback(API_BASES, `/v1/forecast?${q}`, { signal, sourceKey: modelKey });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.error) throw new Error(data?.reason || `HTTP ${resp.status}`);
  const t = data.hourly?.time || [], val = data.hourly?.[v] || [];
  let first = -1, last = -1;
  for (let i = 0; i < t.length; i++) {
    if (val[i] == null) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) throw new Error("keine Daten");
  return { startSec: t[first], endSec: t[last], base: resp.url ? new URL(resp.url).origin : null };
}

/** Mittelpunkt des Modellgebiets (für die Sondierung vor dem ersten Track). */
export function bboxCenter(modelKey) {
  const b = MODELS[modelKey].bbox;
  return { lat: (b.latMin + b.latMax) / 2, lon: (b.lonMin + b.lonMax) / 2 };
}
