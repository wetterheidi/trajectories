import {
  API_BASE as KIT_API_BASE,
  LEGACY_API_BASE as KIT_LEGACY_API_BASE,
  SURFACE_API_BASE,
} from "meteokit/config";

// Modelllevel-Hosts in Prioritätsreihenfolge (Umschaltung: meteokit/apifetch):
// bevorzugt open-meteo.wetterheidi.de (CORS offen, auch im Dev-Betrieb direkt),
// Michaels bisherige Instanz als Fallback. Die lässt per CORS-Allowlist nur
// die Produktions-Origin direkt aus dem Browser durch -- im Dev-Server läuft
// sie deshalb über den Vite-Proxy (vite.config.js).
export const API_BASE = KIT_API_BASE;
export const DEV_PROXY_BASE = "/api-proxy";
export const LEGACY_API_BASE = import.meta.env?.DEV ? DEV_PROXY_BASE : KIT_LEGACY_API_BASE;
export const API_BASES = [API_BASE, LEGACY_API_BASE];
// DEM90-Geländehöhe: der neue Server hat (Stand 2026-09-27) noch kein DEM90
// und antwortet mit `{"elevation":[nan]}` -- fetchJsonWithFallback überspringt
// das, sobald dort DEM90 liegt, greift er ohne Codeänderung.
export const ELEVATION_API_BASES = [API_BASE, LEGACY_API_BASE, SURFACE_API_BASE];

/** FastAPI trajectories service (GeoJSON). Used when „API abrufen“ is checked.
 *  Seit 2026-09 primär auf trajectory.wetterheidi.de (CORS offen, auch für
 *  localhost), Michaels Instanz nur noch als Fallback (meteokit/apifetch). */
export const TRAJECTORY_API = "https://trajectory.wetterheidi.de";
export const TRAJECTORY_API_FALLBACK = "https://trajectory.mah.priv.at";
export const TRAJECTORY_API_BASES = [TRAJECTORY_API, TRAJECTORY_API_FALLBACK];

// Levelzählung der API: N=1 oberstes, N=nLevels unterstes Modelllevel (~10 m AGL).
export const MODELS = {
  icon_d2: {
    apiModel: "icon_d2",
    dataset: "dwd_icon_d2",
    label: "ICON-D2 (~2,2 km)",
    grid: 0.02,
    gridMeters: 2200,
    nLevels: 65,
    bbox: { latMin: 43.18, latMax: 58.08, lonMin: -3.94, lonMax: 20.34 },
    // Reale DWD-Vorhersagereichweite; begrenzt den Zeitschieber im
    // clientseitigen Rechenmodus (s. maxDurationH() in app.js).
    maxForecastH: 48,
  },
  icon_eu: {
    apiModel: "icon_eu",
    dataset: "dwd_icon_eu",
    label: "ICON-EU (~6,5 km)",
    grid: 0.0625,
    gridMeters: 6500,
    nLevels: 74,
    bbox: { latMin: 29.5, latMax: 70.5, lonMin: -23.5, lonMax: 62.5 },
    maxForecastH: 120,
  },
  // Open-Meteo regridded das icosaedrische ICON-Global-Gitter (~13 km) auf
  // ein reguläres 0,125°-Raster (wie meteokit/config). bbox global -- an der
  // Datumsgrenze endet eine Trajektorie wie sonst am Modellrand.
  icon_global: {
    apiModel: "icon_global",
    dataset: "dwd_icon",
    label: "ICON Global (~13 km)",
    grid: 0.125,
    gridMeters: 13915,
    nLevels: 120,
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
    // 00/12-UTC-Läufe rechnen 180 h, 06/18 UTC nur 120 h; Open-Meteo füllt
    // mit dem vorigen langen Lauf auf -- ab jedem Lauf sind so 174 h sicher.
    maxForecastH: 174,
  },
};

// CVD-validierte Farb-Slots für helle Kartenhintergründe. Eine Höhe behält
// ihren Slot, solange sie in der Liste ist (Farbe folgt der Höhe, nie dem
// Listenplatz — Hinzufügen/Entfernen färbt die übrigen nicht um). Maximal
// 8 Höhen gleichzeitig.
export const SERIES_COLORS = [
  "#2a78d6", "#008300", "#e87ba4", "#eda100",
  "#1baf7a", "#eb6834", "#4a3aa7", "#e34948",
];

export const DEFAULT_HEIGHTS = [500, 1500, 3000];
export const HEIGHT_MIN = 10;
export const HEIGHT_MAX = 10000;

// Zeitmarken-Abstände (Minuten) für die Punktmarkierungen.
export const MARKER_INTERVALS = [10, 30, 60, 180, 360];

// Methodenvergleich: Farbe je Berechnungsart (die ersten vier Palette-Slots
// sind auch paarweise CVD-validiert), Strichlierung als Zweitkodierung.
export const METHODS = [
  { key: "height", label: "konstante Höhe", color: "#2a78d6", dash: null },
  { key: "pressure", label: "isobar", color: "#008300", dash: "8 6" },
  { key: "theta", label: "isentrop", color: "#e87ba4", dash: "12 4 3 4" },
  { key: "z3d", label: "Modell-w (3D)", color: "#eda100", dash: "2 6" },
];
