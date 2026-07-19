export const API_BASE = "https://open-meteo.mah.priv.at";

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
  },
  icon_eu: {
    apiModel: "icon_eu",
    dataset: "dwd_icon_eu",
    label: "ICON-EU (~6,5 km)",
    grid: 0.0625,
    gridMeters: 6500,
    nLevels: 74,
    bbox: { latMin: 29.5, latMax: 70.5, lonMin: -23.5, lonMax: 62.5 },
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
