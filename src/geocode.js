/* global L */

const PHOTON = "https://photon.komoot.io";

function featureLabel(props) {
  const name = props.name || props.street || props.city || "Ort";
  const crumbs = [props.city, props.county, props.state, props.country]
    .filter(Boolean)
    .filter((c, i, a) => a.indexOf(c) === i && c !== name);
  return { name, sub: crumbs.join(", ") };
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

  function hide() {
    list.hidden = true;
    list.innerHTML = "";
    hits = [];
    active = -1;
  }

  function render() {
    list.innerHTML = "";
    if (!hits.length) {
      list.hidden = true;
      return;
    }
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

  function pick(i) {
    const f = hits[i];
    if (!f?.geometry?.coordinates) return;
    const [lon, lat] = f.geometry.coordinates;
    const { name, sub } = featureLabel(f.properties || {});
    input.value = sub ? `${name}, ${sub}` : name;
    hide();
    setStart(lat, lon);
    map.setView([lat, lon], Math.max(map.getZoom(), 11));
  }

  const runSearch = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      hide();
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

  input.addEventListener("input", runSearch);
  input.addEventListener("keydown", (e) => {
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
