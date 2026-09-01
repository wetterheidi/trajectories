/**
 * Zeitband: ein zweigriffiger Zeitschieber, an dem Startzeit, Dauer und
 * Richtung in einem Zug eingestellt werden.
 *
 * Das Band rechnet selbst nichts und führt keinen eigenen Zustand. Quelle der
 * Wahrheit bleiben die drei ursprünglichen Bedienelemente `#timeslider`,
 * `#duration` und `#direction` (die beiden letzten sind im Grundmodus
 * ausgeblendet). Beim Zeichnen liest das Band sie, beim Ziehen schreibt es
 * zurück -- samt der `input`/`change`-Ereignisse, an denen die App ohnehin
 * schon hängt. Deshalb ändert der Umbau nichts an der Logik dahinter:
 * Persistenz, Reichweiten-Hinweis, „veraltet"-Markierung und Neuberechnung
 * reagieren unverändert.
 *
 * Bedienung:
 *   Startgriff (eckig)  -- verschiebt den Zeitpunkt, die Dauer wandert mit.
 *   Endgriff (rund)     -- setzt die Dauer; links vom Start heißt rückwärts.
 *   − / + / Mausrad     -- zoomt den Ausschnitt (die Achse deckt gut 6 Tage
 *                          ab, ein 12-h-Flug wäre darin kaum zu greifen).
 *   Doppelklick         -- zurück auf die ganze Achse.
 */

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;

// Zoomstufen als Fensterbreite in Stunden; die volle Achse kommt als
// gröbste Stufe automatisch dazu.
const ZOOM_SPANS = [12, 24, 48, 96];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {object} o
 * @param {HTMLElement} o.root      Hülle, in die das Band gezeichnet wird
 * @param {HTMLInputElement} o.slider     `#timeslider` (Stunden seit Epoche)
 * @param {HTMLInputElement} o.duration   `#duration` (Stunden)
 * @param {HTMLSelectElement} o.direction `#direction` ("1" | "-1")
 * @param {() => number} o.maxDurationH   modusabhängige Obergrenze der Dauer
 * @param {(ms: number) => string} o.fmtTime
 * @returns {{ refresh: () => void }}
 */
export function createTimeline({ root, slider, duration, direction, maxDurationH, fmtTime }) {
  root.innerHTML = `
    <div class="tl-track" title="Ziehen: eckiger Griff = Startzeit, runder Griff = Ende (links vom Start = rückwärts). Mausrad oder −/+ zoomt, Doppelklick zeigt wieder alles.">
      <div class="tl-clip">
        <div class="tl-days"></div>
        <div class="tl-span"></div>
        <div class="tl-now" hidden></div>
      </div>
      <div class="tl-handle tl-h-start" data-role="start" tabindex="0"
           role="slider" aria-label="Startzeit"></div>
      <div class="tl-handle tl-h-end" data-role="end" tabindex="0"
           role="slider" aria-label="Ende der Trajektorie"></div>
    </div>
    <div class="tl-foot">
      <button type="button" class="tl-step" data-zoom="-1" title="Größeren Zeitraum zeigen">−</button>
      <button type="button" class="tl-step" data-zoom="1" title="Ausschnitt vergrößern">+</button>
      <span class="tl-readout mono"></span>
      <span class="tl-key">
        <i class="tl-key-start"></i>Start<i class="tl-key-end"></i>Ende
      </span>
    </div>`;

  const track = root.querySelector(".tl-track");
  const days = root.querySelector(".tl-days");
  const span = root.querySelector(".tl-span");
  const nowMark = root.querySelector(".tl-now");
  const hStart = root.querySelector(".tl-h-start");
  const hEnd = root.querySelector(".tl-h-end");
  const readout = root.querySelector(".tl-readout");

  /** Sichtbarer Ausschnitt in Stunden seit Epoche; null = ganze Achse. */
  let view = null;

  /** Voller erlaubter Zeitbereich -- oder null, solange der Zeitschieber noch
   *  keine Modelldaten kennt (min === max === 0). */
  function bounds() {
    const lo = +slider.min;
    const hi = +slider.max;
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { lo, hi } : null;
  }

  /** Der gerade gezeichnete Ausschnitt. */
  function axis() {
    const b = bounds();
    if (!b || !view) return b;
    return { lo: Math.max(b.lo, view.lo), hi: Math.min(b.hi, view.hi) };
  }

  const pct = (h, a) => ((h - a.lo) / (a.hi - a.lo)) * 100;

  function readState() {
    const dir = +direction.value === -1 ? -1 : 1;
    const dur = clamp(Math.round(+duration.value) || 12, 1, maxDurationH());
    const startH = +slider.value;
    return { dir, dur, startH, endH: startH + dir * dur };
  }

  // --- Zoom -----------------------------------------------------------------

  /** Verfügbare Fensterbreiten, aufsteigend; die volle Achse als letzte. */
  function zoomSpans(b) {
    const full = b.hi - b.lo;
    return [...ZOOM_SPANS.filter((s) => s < full), full];
  }

  /** @param {number} dir  +1 = näher heran, -1 = weiter weg */
  function zoom(dir, anchorH) {
    const b = bounds();
    if (!b) return;
    const spans = zoomSpans(b);
    const cur = view ? view.hi - view.lo : b.hi - b.lo;
    const i = Math.max(0, spans.findIndex((s) => s >= cur - 0.5));
    const next = spans[clamp(i - dir, 0, spans.length - 1)];
    if (next >= b.hi - b.lo) { view = null; return; }
    const anchor = clamp(Number.isFinite(anchorH) ? anchorH : +slider.value, b.lo, b.hi);
    const lo = clamp(Math.round(anchor - next / 2), b.lo, b.hi - next);
    view = { lo, hi: lo + next };
  }

  /** Zieht das Fenster nach, wenn der gerade bewegte Griff hinausläuft --
   *  dadurch schiebt sich der Ausschnitt beim Ziehen von selbst weiter. */
  function keepInView(h) {
    const b = bounds();
    if (!view || !b || !Number.isFinite(h)) return;
    const w = view.hi - view.lo;
    if (h < view.lo) view = { lo: Math.max(b.lo, h), hi: Math.max(b.lo, h) + w };
    else if (h > view.hi) view = { lo: Math.min(b.hi, h) - w, hi: Math.min(b.hi, h) };
  }

  // --- Zeichnen -------------------------------------------------------------

  /** Tagesblöcke plus 6-h-Striche; nur bei geändertem Ausschnitt neu gebaut. */
  function renderDays(a) {
    const key = `${a.lo}/${a.hi}`;
    if (days.dataset.key === key) return;
    days.dataset.key = key;
    days.textContent = "";
    // Feinraster nur, wo die Striche nicht zum Kamm verschmelzen -- und
    // Uhrzeiten nur, wo sie zwischen die Striche passen.
    const span = a.hi - a.lo;
    const step = span <= 30 ? 3 : span <= 120 ? 6 : 0;
    const hourLabels = step > 0 && span <= 60;
    const loMs = a.lo * HOUR_MS;
    const hiMs = a.hi * HOUR_MS;
    for (let d = Math.floor(loMs / DAY_MS) * DAY_MS; d < hiMs; d += DAY_MS) {
      const from = Math.max(d, loMs);
      const to = Math.min(d + DAY_MS, hiMs);
      const seg = document.createElement("div");
      seg.className = (d / DAY_MS) % 2 ? "tl-day alt" : "tl-day";
      const left = pct(from / HOUR_MS, a);
      seg.style.left = `${left}%`;
      seg.style.width = `${pct(to / HOUR_MS, a) - left}%`;
      // Angeschnittene Randtage bleiben unbeschriftet -- dort passt nichts hin.
      // Sobald die Striche Uhrzeiten tragen, tritt der Wochentag zurück: das
      // Datum steht ohnehin über dem Band (#timelabel).
      if (!hourLabels && to - from >= 8 * HOUR_MS) {
        const dt = new Date(d);
        seg.textContent = `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()}`;
      }
      days.appendChild(seg);
    }
    if (!step) return;
    for (let h = Math.ceil(a.lo / step) * step; h <= a.hi; h += step) {
      const midnight = h % 24 === 0;
      if (midnight && !hourLabels) continue; // dort steht schon der Tagesname
      const tick = document.createElement("div");
      tick.className = midnight ? "tl-tick tl-tick-day" : "tl-tick";
      tick.style.left = `${pct(h, a)}%`;
      if (hourLabels) {
        // An der Mitternachtslinie steht der Tag statt der „00" -- sonst
        // ginge im gezoomten Ausschnitt das Datum ganz verloren.
        const dt = new Date(h * HOUR_MS);
        tick.textContent = midnight
          ? `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()}`
          : String(dt.getUTCHours()).padStart(2, "0");
      }
      days.appendChild(tick);
    }
  }

  function setAria(handle, a, h, label) {
    handle.setAttribute("aria-valuemin", String(a.lo));
    handle.setAttribute("aria-valuemax", String(a.hi));
    handle.setAttribute("aria-valuenow", String(h));
    handle.setAttribute("aria-valuetext", label);
  }

  function render() {
    const a = axis();
    root.classList.toggle("tl-empty", !a);
    if (!a) {
      readout.textContent = "Modelldaten noch nicht geladen";
      return;
    }
    const b = bounds();
    renderDays(a);

    const { dir, dur, startH, endH } = readState();
    // Liegt ein Griff außerhalb des Ausschnitts, klebt er am Rand und wird
    // markiert -- die eingestellten Werte bleiben davon unberührt.
    const vStart = clamp(startH, a.lo, a.hi);
    const vEnd = clamp(endH, a.lo, a.hi);
    const from = Math.min(vStart, vEnd);
    const to = Math.max(vStart, vEnd);
    span.style.left = `${pct(from, a)}%`;
    span.style.width = `${pct(to, a) - pct(from, a)}%`;
    hStart.style.left = `${pct(vStart, a)}%`;
    hEnd.style.left = `${pct(vEnd, a)}%`;
    hStart.classList.toggle("tl-clipped", vStart !== startH);
    hEnd.classList.toggle("tl-clipped", vEnd !== endH);

    const nowH = Date.now() / HOUR_MS;
    const nowVisible = nowH >= a.lo && nowH <= a.hi;
    nowMark.hidden = !nowVisible;
    if (nowVisible) nowMark.style.left = `${pct(nowH, a)}%`;

    setAria(hStart, a, startH, fmtTime(startH * HOUR_MS));
    setAria(hEnd, a, endH, fmtTime(endH * HOUR_MS));
    readout.textContent = `${dur} h ${dir < 0 ? "rückwärts" : "vorwärts"}`;
    for (const btn of root.querySelectorAll(".tl-step")) {
      const spans = zoomSpans(b);
      const cur = view ? view.hi - view.lo : b.hi - b.lo;
      btn.disabled = +btn.dataset.zoom > 0 ? cur <= spans[0] : !view;
    }
  }

  // --- Werte zurückschreiben ------------------------------------------------

  /** Verschiebt den Zeitpunkt; Dauer und Richtung bleiben, das Ende wandert mit. */
  function setStart(h, b) {
    const v = clamp(h, b.lo, b.hi);
    if (v === +slider.value) return;
    slider.value = String(v);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Setzt Dauer und Richtung aus der Lage des Endgriffs zum Startgriff. */
  function setEnd(h, b) {
    const startH = +slider.value;
    const prevDir = +direction.value === -1 ? -1 : 1;
    let delta = clamp(h, b.lo, b.hi) - startH;
    if (delta === 0) delta = prevDir; // eine Trajektorie ohne Dauer gibt es nicht
    const dir = delta > 0 ? 1 : -1;
    const dur = clamp(Math.abs(delta), 1, maxDurationH());
    if (dur !== Math.round(+duration.value)) {
      duration.value = String(dur);
      duration.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (dir !== prevDir) {
      direction.value = String(dir);
      direction.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function apply(role, h) {
    const b = bounds();
    if (!b) return;
    if (role === "start") setStart(h, b);
    else setEnd(h, b);
    keepInView(role === "start" ? +slider.value : readState().endH);
    render();
  }

  /** Abschluss einer Geste: löst das Speichern aus (die `change`-Listener). */
  function commit() {
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    duration.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // --- Zeigergesten ---------------------------------------------------------

  /** Stunde unter dem Zeiger; außerhalb des Bandes wird bewusst extrapoliert,
   *  damit `keepInView` beim Ziehen über den Rand weiterscrollt. */
  function hAt(clientX) {
    const a = axis();
    const r = track.getBoundingClientRect();
    if (!a || !r.width) return NaN;
    return Math.round(a.lo + ((clientX - r.left) / r.width) * (a.hi - a.lo));
  }

  /** Klick neben die Griffe: der nähere von beiden springt hin. */
  function nearestRole(clientX) {
    const dx = (node) => {
      const r = node.getBoundingClientRect();
      return Math.abs(clientX - (r.left + r.width / 2));
    };
    return dx(hEnd) < dx(hStart) ? "end" : "start";
  }

  let drag = null;

  track.addEventListener("pointerdown", (ev) => {
    if (!bounds() || (ev.button ?? 0) !== 0) return;
    drag = ev.target.closest(".tl-handle")?.dataset.role || nearestRole(ev.clientX);
    ev.preventDefault();
    capture(true, ev.pointerId);
    apply(drag, hAt(ev.clientX));
    (drag === "start" ? hStart : hEnd).focus({ preventScroll: true });
  });

  track.addEventListener("pointermove", (ev) => {
    if (drag) apply(drag, hAt(ev.clientX));
  });

  /** Zeiger festhalten bzw. freigeben. Das Einfangen ist Komfort (die Geste
   *  läuft auch außerhalb des Bandes weiter) und darf sie nie abbrechen --
   *  darum bleiben Fehler hier folgenlos. */
  function capture(on, pointerId) {
    try {
      if (on) track.setPointerCapture(pointerId);
      else if (track.hasPointerCapture(pointerId)) track.releasePointerCapture(pointerId);
    } catch {
      /* Zeiger schon weg -- die Geste läuft trotzdem korrekt zu Ende */
    }
  }

  function endDrag(ev) {
    if (!drag) return;
    drag = null;
    capture(false, ev.pointerId);
    commit();
  }
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);

  track.addEventListener("wheel", (ev) => {
    if (!bounds()) return;
    ev.preventDefault();
    zoom(ev.deltaY < 0 ? 1 : -1, hAt(ev.clientX));
    render();
  }, { passive: false });

  track.addEventListener("dblclick", () => {
    view = null;
    render();
  });

  // --- Tastatur und Zoomknöpfe ---------------------------------------------

  for (const handle of [hStart, hEnd]) {
    handle.addEventListener("keydown", (ev) => {
      const b = bounds();
      if (!b) return;
      const role = handle.dataset.role;
      const cur = role === "start" ? +slider.value : readState().endH;
      const step = ev.shiftKey ? 6 : 1;
      let next = null;
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") next = cur - step;
      else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") next = cur + step;
      else if (ev.key === "Home") next = b.lo;
      else if (ev.key === "End") next = b.hi;
      if (next == null) return;
      // Der Endgriff darf nicht auf dem Startgriff liegenbleiben: dort ist die
      // Dauer null und die Richtung unbestimmt (setEnd fiele auf die bisherige
      // zurück). Schrittweise Bedienung springt deshalb über den Startgriff
      // hinweg -- erst damit kippt die Trajektorie von vorwärts auf rückwärts.
      if (role === "end" && next === +slider.value) next += Math.sign(next - cur) || 1;
      ev.preventDefault();
      apply(role, next);
      commit();
    });
  }

  for (const btn of root.querySelectorAll(".tl-step")) {
    btn.addEventListener("click", () => {
      zoom(+btn.dataset.zoom);
      render();
    });
  }

  // Änderungen von außen (Modellwechsel, Moduswechsel, Zahlenfeld im
  // Expertenmodus) zeichnen das Band mit -- render() schreibt nur DOM und löst
  // selbst keine Ereignisse aus, eine Schleife ist damit ausgeschlossen.
  slider.addEventListener("input", render);
  duration.addEventListener("input", render);
  duration.addEventListener("change", render);
  direction.addEventListener("change", render);

  render();
  return {
    refresh() {
      // Neue Achsengrenzen (Modell- oder Moduswechsel) machen ein altes
      // Zoomfenster ungültig, sobald es nicht mehr hineinpasst.
      const b = bounds();
      if (view && (!b || view.hi - view.lo >= b.hi - b.lo)) view = null;
      keepInView(+slider.value);
      render();
    },
  };
}
