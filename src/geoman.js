/**
 * Leaflet-Geoman-Zeichenwerkzeug: Marker/Linie/Kreis zeichnen, editieren,
 * verschieben, löschen — mit Peilungs-/Distanz-Labels an Liniensegmenten
 * und Radius-Labels an Kreisen. Portiert aus DZMaster
 * (upper_winds_open_meteo/src/ui-web/mapManager.js), auf DroneForecast
 * gekürzt: kein I18n, keine nm-Distanzangaben, kein Capacitor-Check.
 */

/* global L */

function isMobileDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function calculateBearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lng2 - lng1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function initGeoman(map) {
  if (!map.pm) return; // Geoman-Skript nicht geladen

  map.pm.addControls({
    position: "topleft",
    drawMarker: true,
    drawCircleMarker: false,
    drawPolyline: true,
    drawPolygon: false,
    drawRectangle: false,
    drawCircle: true,
    cutPolygon: false,
    editMode: true,
    dragMode: true,
    removalMode: true,
    rotateMode: false,
  });
  map.pm.setGlobalOptions({ tooltips: false });

  const liveMeasureLabel = L.DomUtil.create("div", "leaflet-measure-label", map.getContainer());
  const geomanHintBar = L.DomUtil.create("div", "geoman-hint-bar", map.getContainer());
  const persistentLabelsGroup = L.layerGroup().addTo(map);

  let hintFadeTimer = null;
  function showGeomanHint(text, duration = 1500) {
    clearTimeout(hintFadeTimer);
    geomanHintBar.textContent = text;
    geomanHintBar.style.display = "block";
    geomanHintBar.classList.remove("fading");
    hintFadeTimer = setTimeout(() => {
      geomanHintBar.classList.add("fading");
      setTimeout(() => { geomanHintBar.style.display = "none"; }, 500);
    }, duration);
  }
  function hideGeomanHint() {
    clearTimeout(hintFadeTimer);
    geomanHintBar.style.display = "none";
  }

  let lastKnownLatLngs = null;
  let lastKnownCircleState = null;
  let currentLayer = null;
  let isDrawingCompleted = false;

  function createPermanentLineLabel(latlngs, index) {
    const currentPoint = latlngs[index];
    const prevPoint = index > 0 ? latlngs[index - 1] : null;
    if (!prevPoint) return;

    const nextPoint = index < latlngs.length - 1 ? latlngs[index + 1] : null;
    const inBearing = calculateBearing(prevPoint.lat, prevPoint.lng, currentPoint.lat, currentPoint.lng);
    const segmentDistanceText = formatDistance(prevPoint.distanceTo(currentPoint));

    let totalDistance = 0;
    for (let i = 1; i <= index; i++) totalDistance += latlngs[i - 1].distanceTo(latlngs[i]);
    const totalDistanceText = formatDistance(totalDistance);

    const outBearingText = nextPoint
      ? `${calculateBearing(currentPoint.lat, currentPoint.lng, nextPoint.lat, nextPoint.lng).toFixed(0)}°`
      : "---";

    const labelContent = `
      <div class="geoman-permanent-label">
        <div>Ein: ${inBearing.toFixed(0)}°</div>
        <div>Aus: ${outBearingText}</div>
        <div>+: ${segmentDistanceText}</div>
        <div>∑: ${totalDistanceText}</div>
      </div>
    `;
    L.marker(currentPoint, {
      icon: L.divIcon({ className: "geoman-label-container", html: labelContent, iconAnchor: [-5, -5] }),
      pmIgnore: true,
    }).addTo(persistentLabelsGroup);
  }

  function createPermanentCircleLabel(layer) {
    const radiusText = formatDistance(layer.getRadius());
    const labelContent = `<div class="geoman-permanent-label">Radius:<br> ${radiusText}</div>`;
    const label = L.marker(layer.getLatLng(), {
      icon: L.divIcon({ className: "geoman-label-container", html: labelContent, iconAnchor: [0, 0] }),
      pmIgnore: true,
    });
    label.addTo(persistentLabelsGroup);
    layer.permanentLabel = label;
  }

  function updateAllPermanentLineLabels(layer) {
    if (!layer || !(layer instanceof L.Polyline)) return;
    persistentLabelsGroup.clearLayers();
    const latlngs = layer.getLatLngs();
    if (Array.isArray(latlngs[0])) {
      latlngs.forEach((sub) => sub.forEach((_, i) => createPermanentLineLabel(sub, i)));
    } else {
      latlngs.forEach((_, i) => createPermanentLineLabel(latlngs, i));
    }
    lastKnownLatLngs = JSON.stringify(latlngs);
    currentLayer = layer;
  }

  function updateCircleLabel(layer) {
    if (!layer || !(layer instanceof L.Circle)) return;
    if (layer.permanentLabel) persistentLabelsGroup.removeLayer(layer.permanentLabel);
    createPermanentCircleLabel(layer);
  }

  setInterval(() => {
    if (!currentLayer) return;
    if (currentLayer instanceof L.Polyline) {
      const cur = JSON.stringify(currentLayer.getLatLngs());
      if (cur !== lastKnownLatLngs) updateAllPermanentLineLabels(currentLayer);
    } else if (currentLayer instanceof L.Circle) {
      const cur = JSON.stringify({ center: currentLayer.getLatLng(), radius: currentLayer.getRadius() });
      if (cur !== lastKnownCircleState) {
        updateCircleLabel(currentLayer);
        lastKnownCircleState = cur;
      }
    }
  }, 500);

  map.on("pm:drawstart", (e) => {
    isDrawingCompleted = false;
    const workingLayer = e.workingLayer;
    persistentLabelsGroup.clearLayers();
    liveMeasureLabel.style.display = "block";

    let mouseMoveHandler, vertexAddHandler, vertexRemoveHandler, mapMoveHandler, cleanup;

    if (e.shape === "Line") {
      if (isMobileDevice()) {
        liveMeasureLabel.innerHTML = "Ersten Punkt antippen";
        showGeomanHint("Ersten Punkt antippen");
        let lastPoint = null;
        let rubberBandLayer = null;

        mapMoveHandler = () => {
          const latlngs = workingLayer.getLatLngs();
          if (latlngs.length > 0) {
            lastPoint = latlngs[latlngs.length - 1];
            const currentCenter = map.getCenter();
            if (rubberBandLayer) map.removeLayer(rubberBandLayer);
            rubberBandLayer = L.polyline([lastPoint, currentCenter], {
              color: "#3388ff", dashArray: "5, 5", weight: 3, interactive: false,
            }).addTo(map);

            const bearing = calculateBearing(lastPoint.lat, lastPoint.lng, currentCenter.lat, currentCenter.lng);
            const distanceText = formatDistance(lastPoint.distanceTo(currentCenter));
            liveMeasureLabel.innerHTML = `Ein: ${bearing.toFixed(0)}°<br>Aus: ---°<br>+: ${distanceText}`;
            const size = map.getSize();
            L.DomUtil.setPosition(liveMeasureLabel, L.point(size.x / 2 + 20, size.y / 2 - 40));
          } else {
            if (rubberBandLayer) { map.removeLayer(rubberBandLayer); rubberBandLayer = null; }
            liveMeasureLabel.innerHTML = "Ersten Punkt antippen";
          }
        };
        vertexAddHandler = () => {
          if (rubberBandLayer) { map.removeLayer(rubberBandLayer); rubberBandLayer = null; }
          showGeomanHint("Weiter antippen zum Fortsetzen");
          setTimeout(() => { updateAllPermanentLineLabels(workingLayer); map.fire("move"); }, 50);
        };
        vertexRemoveHandler = () => {
          setTimeout(() => { updateAllPermanentLineLabels(workingLayer); map.fire("move"); }, 50);
        };
        map.on("move", mapMoveHandler);
        workingLayer.on("pm:vertexadded", vertexAddHandler);
        workingLayer.on("pm:vertexremoved", vertexRemoveHandler);
        cleanup = () => {
          map.off("move", mapMoveHandler);
          workingLayer.off("pm:vertexadded", vertexAddHandler);
          workingLayer.off("pm:vertexremoved", vertexRemoveHandler);
          if (rubberBandLayer) { map.removeLayer(rubberBandLayer); rubberBandLayer = null; }
        };
      } else {
        liveMeasureLabel.innerHTML = "Ersten Punkt klicken";
        showGeomanHint("Ersten Punkt klicken");
        mouseMoveHandler = (moveEvent) => {
          const latlngs = workingLayer.getLatLngs();
          if (latlngs.length > 0) {
            const lastPoint = latlngs[latlngs.length - 1];
            const bearing = calculateBearing(lastPoint.lat, lastPoint.lng, moveEvent.latlng.lat, moveEvent.latlng.lng);
            const distanceText = formatDistance(lastPoint.distanceTo(moveEvent.latlng));
            liveMeasureLabel.innerHTML = `Ein: ${bearing.toFixed(0)}°<br>Aus: ---°<br>+: ${distanceText}`;
            L.DomUtil.setPosition(liveMeasureLabel, moveEvent.containerPoint.add([15, -15]));
          }
        };
        vertexAddHandler = () => {
          showGeomanHint("Weiter klicken zum Fortsetzen");
          setTimeout(() => updateAllPermanentLineLabels(workingLayer), 50);
        };
        vertexRemoveHandler = () => setTimeout(() => updateAllPermanentLineLabels(workingLayer), 50);
        map.on("mousemove", mouseMoveHandler);
        workingLayer.on("pm:vertexadded", vertexAddHandler);
        workingLayer.on("pm:vertexremoved", vertexRemoveHandler);
        cleanup = () => {
          map.off("mousemove", mouseMoveHandler);
          workingLayer.off("pm:vertexadded", vertexAddHandler);
          workingLayer.off("pm:vertexremoved", vertexRemoveHandler);
        };
      }
    } else if (e.shape === "Circle") {
      if (isMobileDevice()) {
        liveMeasureLabel.innerHTML = "";
        showGeomanHint("Ersten Punkt antippen");
        const size = map.getSize();
        L.DomUtil.setPosition(liveMeasureLabel, L.point(size.x / 2, size.y / 2 - 40));
        let centerSet = false;

        mapMoveHandler = () => {
          if (!centerSet) return;
          const center = workingLayer.getLatLng();
          if (!center) return;
          const radius = center.distanceTo(map.getCenter());
          workingLayer.setRadius(radius);
          liveMeasureLabel.innerHTML = `Radius: ${formatDistance(radius)}`;
          const sz = map.getSize();
          L.DomUtil.setPosition(liveMeasureLabel, L.point(sz.x / 2, sz.y / 2 - 40));
        };
        vertexAddHandler = () => {
          if (!centerSet) {
            centerSet = true;
            liveMeasureLabel.innerHTML = "Karte bewegen für Radius";
            showGeomanHint("Karte bewegen für Radius");
            const sz = map.getSize();
            L.DomUtil.setPosition(liveMeasureLabel, L.point(sz.x / 2, sz.y / 2 - 40));
            map.on("move", mapMoveHandler);
          } else {
            finalize();
            updateCircleLabel(workingLayer);
            currentLayer = workingLayer;
            lastKnownCircleState = JSON.stringify({ center: workingLayer.getLatLng(), radius: workingLayer.getRadius() });
          }
        };
        workingLayer.on("pm:vertexadded", vertexAddHandler);
        cleanup = () => {
          map.off("move", mapMoveHandler);
          workingLayer.off("pm:vertexadded", vertexAddHandler);
          centerSet = false;
          liveMeasureLabel.style.display = "none";
        };
      } else {
        liveMeasureLabel.innerHTML = "Klicken und ziehen für Kreis";
        showGeomanHint("Klicken und ziehen für Kreis");
        mouseMoveHandler = (moveEvent) => {
          const center = workingLayer.getLatLng();
          if (!center) return;
          const radius = center.distanceTo(moveEvent.latlng);
          liveMeasureLabel.innerHTML = `Radius: ${formatDistance(radius)}`;
          L.DomUtil.setPosition(liveMeasureLabel, moveEvent.containerPoint.add([15, -15]));
        };
        map.on("mousemove", mouseMoveHandler);
        cleanup = () => map.off("mousemove", mouseMoveHandler);
      }
    } else if (e.shape === "Marker") {
      showGeomanHint(isMobileDevice() ? "Zum Setzen antippen" : "Zum Setzen klicken");
    }

    const finalize = () => {
      if (cleanup) cleanup();
      liveMeasureLabel.style.display = "none";
      hideGeomanHint();
    };

    map.once("pm:create", (createEvent) => {
      isDrawingCompleted = true;
      finalize();
      if (createEvent.shape === "Line" && createEvent.layer instanceof L.Polyline) {
        updateAllPermanentLineLabels(createEvent.layer);
      } else if (createEvent.shape === "Circle" && createEvent.layer instanceof L.Circle) {
        updateCircleLabel(createEvent.layer);
        currentLayer = createEvent.layer;
        lastKnownCircleState = JSON.stringify({ center: createEvent.layer.getLatLng(), radius: createEvent.layer.getRadius() });
      }
      if (createEvent.layer.pm) createEvent.layer.pm.enable();
    });

    map.once("pm:drawend", () => {
      if (!isDrawingCompleted) {
        finalize();
        persistentLabelsGroup.clearLayers();
      }
    });
  });

  map.on("pm:edit", (e) => {
    if (e.shape === "Line" && e.layer instanceof L.Polyline) {
      setTimeout(() => updateAllPermanentLineLabels(e.layer), 300);
    } else if (e.shape === "Circle" && e.layer instanceof L.Circle) {
      if (isMobileDevice()) {
        liveMeasureLabel.style.display = "block";
        liveMeasureLabel.innerHTML = `Radius: ${formatDistance(e.layer.getRadius())}`;
        const sz = map.getSize();
        L.DomUtil.setPosition(liveMeasureLabel, L.point(sz.x / 2, sz.y / 2 - 40));
      }
      setTimeout(() => {
        updateCircleLabel(e.layer);
        currentLayer = e.layer;
        lastKnownCircleState = JSON.stringify({ center: e.layer.getLatLng(), radius: e.layer.getRadius() });
      }, 300);
    }
  });

  map.on("pm:editend", () => {
    if (isMobileDevice()) liveMeasureLabel.style.display = "none";
  });

  map.on("pm:remove", () => {
    persistentLabelsGroup.clearLayers();
    lastKnownCircleState = null;
    lastKnownLatLngs = null;
    currentLayer = null;
    liveMeasureLabel.style.display = "none";
  });
}
