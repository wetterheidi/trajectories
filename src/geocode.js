/* global L */

import { parseCoordInput } from "./coords.js";

const PHOTON = "https://photon.komoot.io";

function featureLabel(props) {
  const name = props.name || props.street || props.city || "Ort";
  const crumbs = [props.city, props.county, props.state, props.country]
    .filter(Boolean)
    .filter((c, i, a) => a.indexOf(c) === i && c !== name);
  return { name, sub: crumbs.join(", ") };
}

// Dezimal- oder MGRS-Koordinate als Photon-artiges Feature verpacken, damit
// render()/pick() unverändert bleiben können.
function coordFeature(lat, lon) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  const label = `${Math.abs(lat).toFixed(5)}°${ns} ${Math.abs(lon).toFixed(5)}°${ew}`;
  return {
    geometry: { coordinates: [lon, lat] },
    properties: { name: "Koordinate", city: label },
  };
}

const HISTORY_KEY = "trajectories.geocodeHistory.v1";
const HISTORY_MAX = 8;

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

// Neuen Eintrag vorn einreihen; einen Treffer an (fast) derselben Stelle
// ersetzen statt duplizieren, damit die Historie nicht mit Wiederholungen
// vollläuft.
function addToHistory({ lat, lon, name, sub }) {
  const list = loadHistory().filter(
    (e) => Math.abs(e.lat - lat) > 1e-4 || Math.abs(e.lon - lon) > 1e-4,
  );
  list.unshift({ lat, lon, name, sub });
  saveHistory(list.slice(0, HISTORY_MAX));
}

function historyFeature(entry) {
  return {
    geometry: { coordinates: [entry.lon, entry.lat] },
    properties: { name: entry.name, city: entry.sub || "" },
  };
}

function textEl(tag, text, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  n.textContent = text;
  return n;
}

async function photonSearch(q) {
  const url = `${PHOTON}/api/?${new URLSearchParams({ q, limit: "5", lang: "de" })}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Photon ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.features) ? data.features : [];
}

async function photonReverse(lat, lon) {
  const url = `${PHOTON}/reverse?${new URLSearchParams({
    lat: String(lat), lon: String(lon), limit: "1", lang: "de",
  })}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Photon ${resp.status}`);
  const data = await resp.json();
  const f = data.features?.[0];
  if (!f) return null;
  const { name, sub } = featureLabel(f.properties || {});
  return sub ? `${name} — ${sub}` : name;
}

/**
 * @param {{ map: L.Map, setStart: (lat: number, lon: number) => void, debounce: Function, el: (id: string) => HTMLElement }} opts
 */
export function initGeocode({ map, setStart, debounce, el }) {
  const input = el("geocode");
  const list = el("geocode-results");
  if (!input || !list) return;

  let hits = [];
  let active = -1;
  let historyMode = false;

  function hide() {
    list.hidden = true;
    list.innerHTML = "";
    hits = [];
    active = -1;
    historyMode = false;
  }

  function showHistory() {
    const hist = loadHistory();
    if (!hist.length) return;
    hits = hist.map(historyFeature);
    active = 0;
    historyMode = true;
    render();
  }

  function render() {
    list.innerHTML = "";
    if (!hits.length) {
      list.hidden = true;
      return;
    }
    if (historyMode) list.appendChild(textEl("li", "Zuletzt verwendet", "geo-hist-head"));
    hits.forEach((f, i) => {
      const { name, sub } = featureLabel(f.properties || {});
      const li = document.createElement("li");
      li.dataset.i = String(i);
      if (i === active) li.classList.add("active");
      li.appendChild(document.createTextNode(name));
      if (sub) li.appendChild(textEl("span", sub, "geo-sub"));
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus; avoid blur-before-click
        pick(i);
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function pickFeature(f) {
    if (!f?.geometry?.coordinates) return;
    const [lon, lat] = f.geometry.coordinates;
    const { name, sub } = featureLabel(f.properties || {});
    input.value = sub ? `${name}, ${sub}` : name;
    hide();
    addToHistory({ lat, lon, name, sub });
    setStart(lat, lon);
    map.setView([lat, lon], Math.max(map.getZoom(), 11));
  }

  function pick(i) {
    pickFeature(hits[i]);
  }

  const runSearch = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      hide();
      return;
    }
    historyMode = false;
    const coord = parseCoordInput(q);
    if (coord) {
      hits = [coordFeature(coord.lat, coord.lon)];
      active = 0;
      render();
      return;
    }
    try {
      hits = await photonSearch(q);
      active = hits.length ? 0 : -1;
      render();
    } catch {
      hide();
    }
  }, 300);

  input.addEventListener("input", () => {
    if (!input.value.trim()) {
      showHistory();
      return;
    }
    runSearch();
  });
  input.addEventListener("focus", showHistory);
  input.addEventListener("keydown", (e) => {
    // Auf Enter direkt springen, auch bevor die debounced Suche gefeuert
    // hat — Koordinaten sind eindeutig und brauchen keine Bestätigung aus
    // der (noch nicht aktualisierten) Trefferliste.
    if (e.key === "Enter") {
      const coord = parseCoordInput(input.value.trim());
      if (coord) {
        e.preventDefault();
        pickFeature(coordFeature(coord.lat, coord.lon));
        return;
      }
    }
    if (list.hidden || !hits.length) {
      if (e.key === "Escape") hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % hits.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + hits.length) % hits.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });
  input.addEventListener("blur", () => {
    // Delay so mousedown on a result can fire first.
    setTimeout(hide, 150);
  });

  map.on("contextmenu", async (e) => {
    L.DomEvent.preventDefault(e.originalEvent);
    const { lat, lng: lon } = e.latlng;
    setStart(lat, lon);
    const popup = L.popup({ maxWidth: 280 }).setLatLng(e.latlng)
      .setContent(textEl("div", "Suche Ort …"))
      .openOn(map);
    try {
      const label = await photonReverse(lat, lon);
      popup.setContent(textEl("div", label || "Kein Ort gefunden"));
    } catch {
      popup.setContent(textEl("div", "Geocoding fehlgeschlagen"));
    }
  });
}
