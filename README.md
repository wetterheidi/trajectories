# Windtrajektorien

Webanwendung zur Berechnung und Kartendarstellung von Windtrajektorien
(vorwärts und rückwärts) auf Basis der nativen ICON-Modelllevel (DWD ICON-D2 /
ICON-EU / ICON Global) von
[open-meteo.wetterheidi.de](https://open-meteo.wetterheidi.de), Fallback
[open-meteo.mah.priv.at](https://open-meteo.mah.priv.at) (Michael).

Zwei Seiten aus einem Build:

- **`/` Windtrajektorien**: Vorhersage (Schwerpunkt der App).
- **`/diagnose/` Hindcast / Modellverifikation**: eine gefahrene Strecke (GPX)
  gegen die reine Modellwind-Trajektorie, siehe [Hindcast](#hindcast--modellverifikation-diagnose).

## Start

```bash
npm install
npm run dev        # Entwicklungsserver (Vite)
npm test           # Integrator-, Bodenprüf- und Hindcast-Tests (synthetisch, offline)
npm run test:live  # Live-Test gegen den Server
npm run deploy     # Build → https://trajectories.wetterheidi.de (Pförtner)
npm run deploy:vps # Build → https://vps.mah.priv.at/trajectories/ (Caddy Basic Auth)
```

Die App braucht den Vite-Dev-Server bzw. einen Build: Sie importiert die
Komponentenbibliothek [meteokit](../meteokit) als `file:`-Abhängigkeit
(`meteokit/*`; beide Repos müssen nebeneinander ausgecheckt sein), der Hindcast
zusätzlich Chart.js aus npm, und die **3D-Ansicht** braucht die Cesium-Assets
aus dem Build (lokal: `npm run build` + `npm run preview`).

Deploy:

- `npm run deploy` → https://trajectories.wetterheidi.de (Hetzner, nginx mit
  Pförtner-Login; gilt auch für `/diagnose/`)
- `npm run deploy:vps` → https://vps.mah.priv.at/trajectories/ (Caddy Basic
  Auth, siehe [`deploy/README.md`](deploy/README.md))

Die Trajectories-HTTP-API liegt primär unter `https://trajectory.wetterheidi.de`,
`https://trajectory.mah.priv.at` dient als Fallback.

## Bedienung

Ausführliche Anleitung für Einsteiger:
[`docs/Bedienungsanleitung-Windtrajektorien.docx`](docs/Bedienungsanleitung-Windtrajektorien.docx).
Das Fachdokument zu Daten, Interpolation und Integration:
[`docs/Physik-und-Berechnung-Windtrajektorien.docx`](docs/Physik-und-Berechnung-Windtrajektorien.docx).
Hier die Kurzfassung.

**Startpunkt** (bei Rückwärtsläufen: Zielpunkt) per Rechtsklick auf die Karte,
langem Drücken (~0,5 s, Touch) oder Ziehen des Markers. Ein einfacher Linksklick
setzt bewusst nichts, damit Verschieben und Zoomen den Punkt nicht versehentlich
verstellen. Alternativ das Suchfeld: Ortsnamen (Photon), Dezimalgrad oder MGRS,
mit Verlauf. Andere Apps können den Startpunkt per `?lat=…&lon=…` an der URL
übergeben.

**Modell:** ICON-D2 (48 h), ICON-EU (120 h) oder ICON Global (~174 h). „ℹ“ zeigt
den Modelllauf.

**Zeitband:** Startzeit, Dauer und Richtung in einem Element. Das blaue Quadrat
unter der Achse ist der Start, der orange Punkt darüber das Ende. Liegt das
Ende links vom Start, wird rückwärts gerechnet. „−/+“ bzw. das Mausrad zoomen
die Achse, Doppelklick zeigt alles, „Jetzt“ setzt die aktuelle Uhrzeit (UTC).
Nach vorn reicht die Achse bis zum Modellhorizont, nach hinten so weit wie
unter „Einstellungen → Rückblick“ gewählt (1–7 Tage, Default 1).

**Starthöhen** am senkrechten Höhenbalken: Klick auf eine freie Stelle fügt eine
Höhe hinzu, Ziehen verschiebt, „ד entfernt, Zahlenfeld bzw. ↑/↓ geben genau
ein. Höchstens 8 Höhen, die Skala ist unten gespreizt, das Maximum (3–10 km,
Default 6 km) steht unter „Einstellungen → Lineal-Maximum“. Jede Höhe behält
ihre Farbe, solange sie am Balken ist, auch beim Verschieben: Die Farbe gehört
der Trajektorie, nicht der Position. Der Balken ist damit die Legende für
Karte, Ergebnisliste, Zusatzansichten und Exporte. Die hervorgehobene **aktive
Höhe** ist die, die Trajektorienverlauf, GRAMET und Live-Modus zeigen.

**Starthöhen-Referenz:** „über Grund (AGL)“ rechnet geländefolgend auf
konstanter Höhe über Grund, „über NN (AMSL)“ auf konstanter absoluter Höhe.
Eine Zeile unter dem Balken rechnet die aktive Höhe am Startort in den jeweils
anderen Bezug um. Der **Markenabstand** (10 min – 6 h) steuert die Zeitmarken,
deren Tooltip bzw. Popup Zeit, Höhe und Wind zeigt.

**Ergebnisliste:** eine Zeile je Trajektorie mit Endzeit oder Abbruchgrund,
das Auge blendet einzelne Linien aus.

**„Trajektorienverlauf (aktive Höhe)“** (`src/altitudeprofile.js`) zeigt Werte
entlang **einer** Trajektorie in gestapelten Diagrammen: Höhe über NN und über
Grund mit Geländeprofil, T/Td, Wind mit Fiedern, Bewölkung und Wetter, auf
Wunsch Δp und w. Die x-Achse ist zwischen Zeit und Distanz umschaltbar, der
Cursor ist mit der Karte gekoppelt. Angedockt wie das GRAMET (s. u.). Diese
Ansicht ersetzt den früheren Knopf „Querschnitt anzeigen“ (Small Multiples
aller Läufe).

„3D-Ansicht" öffnet die zuletzt berechneten Trajektorien als Höhenlinien über
echtem Gelände (CesiumJS, per Vite gebündelt; 3D-Modul lazy). Jede
Trajektorie bekommt eine halbtransparente Wand zum Boden, die Zeitmarken sind
anklickbare Punkte mit denselben Details wie in 2D. Der Überhöhungs-Schieber
(×1–×20) skaliert Gelände und Trajektorien gemeinsam — ohne Überhöhung wirken
Trajektorien über hunderte Kilometer optisch flach. Gelände wählbar:
**Re:Earth** (frei, ohne Token, Standard; Mapterhorn-DEM als quantized-mesh),
**Cesium World Terrain** (braucht einen kostenlosen Ion-Token, Eingabefeld
erscheint bei Auswahl) oder **flach**; bei Dienstausfall fällt die Ansicht
automatisch auf flach zurück. Die Kartengrundlage ist wählbar (Esri-Satellit
hybrid als Standard; auch OSM).
Kamera-Knöpfe am rechten Rand (Zoom, Kippen, Drehen, ⌂ = zentrieren) machen
die Ansicht ohne Maus bedienbar; sie kreisen um den Geländepunkt in der
Bildmitte. Mit Maus/Trackpad: Ziehen = verschieben, Strg+Ziehen =
kippen/drehen, Scrollen = Zoom. Da die
Trajektorien Höhen über NN führen, Cesium aber über dem WGS84-Ellipsoid
rechnet, wird der Versatz am Startpunkt kalibriert (Cesium-Geländehöhe minus
Modellorographie) und im Kopf der Ansicht angezeigt. Eine offene 3D-Ansicht
läuft bei Neuberechnung und im Live-Modus mit.

„GRAMET" öffnet den Wetterquerschnitt entlang **einer** Trajektorie — der
aktiven Höhe, also derselben Auswahl, die auch der Live-Scrub bewegt. Anders
als der Trajektorienverlauf (Werte genau auf Trajektorienhöhe) zeigt er das
Wetter in der ganzen Säule *entlang des Flugpfades*: Wolken, Niederschlag,
Vereisung/Turbulenz,
Isothermen/Isotachen über der Modell-Orographie und dem echten Gelände, dazu
die Bodenzeilen (Wind, Böen, Sicht, ww, T/Td, Luftdruck). Die x-Achse zählt
verstrichene Flugzeit oder — Umschalter „Zeit | Strecke" im Kopf, wird
gemerkt — die zurückgelegte Strecke entlang der Trajektorie (dann stehen die
Uhrzeiten unter der Achse ungleichmäßig, wo der Wind schneller oder langsamer
trägt). Jede Spalte wird an *ihrem* Ort zu *ihrer* Zeit aus dem
Modell gezogen; die Trajektorie selbst liegt als Linie in ihrer korrekten
Höhe (m NN) darin. Bei Rückwärtsläufen steht links die Herkunft und rechts
die gewählte Startzeit (der Kopf nennt beide Zeitpunkte). Verlässt der Pfad
das Modellgebiet oder reicht er über das Ende des Vorhersagezeitraums hinaus,
endet der Querschnitt dort mit sichtbarem Grund.

Die Höhenachse hat zwei Bereiche. „Gesamthöhe" reicht bis knapp über die
Tropopause (höchster Tropopausenpunkt + 2,5 km, damit überschießende
Cb-Gipfel noch ganz sichtbar sind) — nicht bis zum Modelldeckel bei ~20 km,
darüber ist ohnehin nichts mehr zu sehen. „Um die Trajektorie" zoomt auf das
Band zwischen tiefstem Geländepunkt und der höchsten Trajektorienhöhe. Anders
als in droneforecast gibt es hier **keine eingestellte Flughöhe**: die Höhe
ist das Ergebnis der Trajektorienrechnung, kommt also vom Höhenbalken
(AGL oder AMSL je nach Höhenreferenz) und wird als absolute Höhe (m NN)
geplottet — deshalb auch keine Max-Flughöhen-Deckellinie.
Ein geöffnetes GRAMET folgt einem Wechsel der aktiven Höhe; bereits geholte
Gitter bleiben zwischengespeichert, ein Hin-und-Her kostet also keine neuen
Abrufe. Die Darstellung kommt als Web Component aus der Komponentenbibliothek
[meteokit](../meteokit) (s. [Start](#start)).

Das GRAMET ist **angedockt** voreingestellt: es schlägt unten an, die Karte
bleibt darüber sichtbar und bedienbar. Die Höhe lässt sich am Griff der
Leiste ziehen (wird gemerkt), „⤢" schaltet auf die bildschirmfüllende
Ansicht und zurück. Der Chart wird dabei nicht gestaucht — reicht die
Dockhöhe nicht, behält die Wetterfläche ihre Höhe und der Panel-Inhalt
scrollt vertikal; die Zeitangabe bleibt trotzdem sichtbar, weil sie am
Cursor mitreist (s. u.).

Angedockt zeigen **Karte und GRAMET dieselbe Stelle**: der Zeiger über der
Trajektorie setzt eine Linie im Querschnitt (samt Punkt auf der
Profilkurve), der Zeiger im Querschnitt setzt eine Marke auf der Karte.
Verbindendes Element ist die Position *entlang des Weges* — der Cursor ist
also eindimensional, die Höhe dazu ist immer die der Trajektorie, nie die des
Mauszeigers. Liegt der Punkt weit außerhalb des sichtbaren Ausschnitts,
scrollt der Querschnitt waagerecht nach. An echten Selbstkreuzungen bleibt
die Richtung Karte → Querschnitt mehrdeutig (das im Bild nächstliegende
Wegstück gewinnt); die Gegenrichtung ist immer eindeutig.

Die Synchronisierung setzt einen **Mauszeiger** voraus und ist damit heute
eine Desktop-Funktion: auf schmalen Geräten bleibt das GRAMET
bildschirmfüllend (für Karte und Querschnitt nebeneinander ist kein Platz),
und ohne Hover gibt es nichts zu synchronisieren. Eine Touch-Bedienung —
etwa Tippen im Querschnitt, das die Karte darunter mitführt — ist bewusst
offen gelassen.

**Nur ein Overlay zugleich:** Trajektorienverlauf, 3D-Ansicht und GRAMET
belegen dieselbe Fläche über der Karte, das Öffnen des einen schließt deshalb
die anderen (wie die Vorhersageprodukte in droneforecast).

Alle Ergebnisanzeigen — Karte, Ergebnisliste, Trajektorienverlauf, 3D-Ansicht
und GRAMET — zeigen immer den **zuletzt gerechneten** Lauf; eine
Parameteränderung allein rechnet nicht neu. Damit das nicht unbemerkt bleibt,
wird der Zustand sichtbar gemacht, sobald sich etwas Pfadbestimmendes ändert
(Startpunkt, Modell, Startzeit, Dauer, Richtung, Höhenreferenz, Methoden,
Starthöhen, Markenabstand, Zusatzparameter, API-Schalter): der Berechnen-Knopf
wird zur Handlungsaufforderung („Trajektorien neu berechnen"), offene Overlays
bekommen ein Hinweisband. Bewusst wird nichts geschlossen — das nähme den
Kontext, ohne zu erklären, und die übrigen Anzeigen wären genauso alt. Ein
reiner Wechsel der aktiven Höhe zählt nicht dazu: diese Trajektorie ist ja
mitgerechnet. Im Live-Modus entfällt der Hinweis, weil dort ohnehin sofort neu
gerechnet wird.

**Expertenmodus** („Experte“ im Kopf) blendet das Zahlenfeld für die Dauer und
die **Methoden-Häkchen** ein (konstante Höhe, isobar, isentrop, Modell-w
sobald verfügbar). Mehrere Höhen × eine Methode oder eine Höhe × mehrere
Methoden — beides zugleich lehnt die App mit Hinweis ab (unlesbar). Bei
mehreren Methoden kodiert die Farbe die Methode (plus Strichlierung als
Zweitkodierung), alle Methoden teilen sich ein Windfeld, und im
Trajektorienverlauf ist die Methode im Kopf wählbar.

Der **Live-Modus** rechnet die aktive Höhe bei jeder Bewegung am Höhenbalken
neu (entprellt, ~200 ms); die übrigen Höhen bleiben als gepinnte Vergleiche
stehen. Das Windfeld samt Punkt-Cache bleibt dabei erhalten, solange Modell,
Vertikaloption, Startzeit, Dauer und Richtung gleich bleiben — nach der ersten
Bewegung kommt praktisch alles aus dem Cache und der Balken reagiert flüssig.
Offene Zusatzansichten laufen mit.

**Einstellungen** (unten im Panel):

- *API abrufen* (Default an): Rechnung auf dem Trajektorien-Server
  (`trajectory.wetterheidi.de`, Fallback `trajectory.mah.priv.at`). Aus:
  Rechnung im Browser direkt gegen die Modelllevel-API.
- *Zusatzparameter*: T, Td, RH, Bedeckungsgrad und WW an den Zeitmarken
  (Popup und Export). Td wird aus spezifischer Feuchte und Druck über die
  Magnus-Formel (über Wasser) berechnet — bewusst nicht die dew_point-Variable
  der API (Eis-Sättigung). Opt-in, weil die Abrufe damit etwa doppelt so groß
  werden.
- *Lineal-Maximum* und *Rückblick* (s. o.).
- *Höhe* (m/ft — gilt für Anzeige *und* Eingabe) und *Wind* (km/h, m/s, kt);
  intern wird durchgehend SI gerechnet, die Exporte bleiben SI.
- *Eigene GPX-Tracks*: fremde Tracks oder Routen zum Vergleich auf die Karte
  legen. Für eine echte Verifikation gegen den Modellwind gibt es die
  [Hindcast-Seite](#hindcast--modellverifikation-diagnose).

**Karte:** OSM oder Esri-Satellit (hybrid), Lufträume (openflightmaps) und
Lufträume weltweit (openAIP), Zeichen-/Messwerkzeuge (Leaflet-Geoman: Marker,
Linien mit Peilung/Distanz, Kreise mit Radius). Unten links stehen Koordinaten
und Geländehöhe unter dem Mauszeiger. Alle Einstellungen werden im Browser
gespeichert.

**Konsolen-Monitor:** `?debug=1` an die URL (oder `localStorage.trajDebug =
"1"`) protokolliert jeden Interpolationsaufruf in der Browser-Konsole: Zeit,
Position, Zielfläche, Ergebnis-Wind sowie je Gitterpunkt Bilinear-Gewicht,
verwendetes ICON-Level-Bracket, Höhen, Interpolationsgewicht und (falls
geladen) p, T und w.

**Herunterladen** exportiert den zuletzt berechneten Lauf als **GeoJSON**
(FeatureCollection: je Höhe eine LineString mit Höhe als dritter Koordinate,
Zeitstempeln je Stützpunkt und allen Berechnungs-Metadaten in den properties,
dazu die Zeitmarken als Points mit Wind), **GPX** oder **KML**.

## Hindcast / Modellverifikation (`/diagnose/`)

Eigene Seite mit gleichem Grundaufbau, aber Petrol statt Blau als
Erkennungsfarbe. Die beiden Seiten verlinken gegenseitig: „Hindcast“ im Kopf der
Vorhersage, „→ Vorhersage“ im Kopf des Hindcasts.

- **Eingabe:** GPX-Track mit Zeit und Höhe je Punkt, per Dateiwahl oder Drag &
  Drop. Der Track bleibt im Browser, an den Server gehen nur Gitterpunkte.
  Beginn und Ende werden auf Start und Landung vorbelegt (Höhe 8 m über dem
  Anfangswert bzw. Stillstand am Ende) und sind änderbar.
- **Modelle:** D2, EU und Global, einzeln oder zum Vergleich. Wie weit das
  Archiv zurückreicht, fragt die Seite beim Laden **live beim Server** ab
  (unterstes Modelllevel mit `past_days=92`, erste Stunde mit Wert). Modelle,
  deren Archiv oder Gebiet die Fahrt nicht abdeckt, sind mit Grund ausgegraut.
- **Rechnung:** derselbe Rechenkern wie die Vorhersage (`WindField`, native
  Gitterpunkte, bilinear/vertikal linear/zeitlich linear). Die Zielhöhe ist die
  GPS-Höhe über NN zu jedem Zeitpunkt (`computeAlongProfile` in
  `src/integrator.js`): Schritt von Trackpunkt zu Trackpunkt, Lücken auf 30 s
  unterteilt, Petterssen bis 0,1 m konvergiert. Liegt die GPS-Höhe unter dem
  Modellgelände, wird das unterste Modelllevel genommen (Anteil steht im
  Ergebnis), statt abzubrechen.
- **Ergebnis:** Spuren auf der Karte, Zeitschieber mit Ablage je Modell,
  Kennzahlen (Ablage Ende/max./mittel, Verlagerung, Vektor-Windfehler RMS,
  Geschwindigkeits-Bias, mittlerer Richtungsfehler), Diagramme (Abstand,
  Geschwindigkeit, Richtung) und CSV-Export aller Punkte.

## Meteorologik

- **Integration:** Petterssen-Schema (iterativ-implizit, wie HYSPLIT) mit
  adaptivem Zeitschritt (Verschiebung ≤ 0,75 Gitterweiten, 60–900 s).
  Rückwärtstrajektorien sind derselbe Algorithmus mit negativem Zeitschritt.
- **Interpolation:** horizontal bilinear zwischen den vier umgebenden
  Gitterpunkten, vertikal linear in der Höhe zwischen den nativen ICON-Leveln,
  zeitlich linear zwischen den Stundenterminen. Immer komponentenweise (u, v) —
  nie über Betrag/Richtung.
- **Vertikalbewegung** (wie HYSPLIT wählbar, per Methoden-Häkchen):
  - *konstante Höhe* — „AGL" geländefolgend über Grund, „AMSL" absolut über NN
  - *isobar* — am Startpunkt wird der Druck p₀ in der Starthöhe diagnostiziert,
    die Trajektorie folgt dann der p₀-Fläche (Druck-Interpolation in ln p)
  - *isentrop* — analog mit der potentiellen Temperatur θ₀ = T·(1000/p)^0.2854;
    der erste θ-Durchgang von unten wird verwendet (θ kann in labilen
    Schichten nicht-monoton sein)
  - *Modell-Vertikalbewegung (3D)* — Höhe wird mit dem Modell-w
    Petterssen-gemittelt mitintegriert; die Option schaltet sich automatisch
    frei, sobald der Server die Vertikalgeschwindigkeit anbietet (Erkennung
    beim App-Start, Einheiten aus der API-Antwort)
  Schneidet die Zielfläche das Gelände oder verlässt sie den Datenbereich,
  stoppt die Trajektorie mit sichtbarem Grund. Bei absoluten Zielhöhen
  (konstant AMSL, 3D) zählt dafür die bilinear interpolierte Modellorographie
  am Ort, nicht jede einzelne Gittersäule; ausgegeben wird dann exakt die
  Zielhöhe.
- **Geometrie:** Kugelgeometrie mit cos(Breite)-Korrektur der Längenverlagerung.
- **Grenzen:** Am Rand des Modellgebiets, am Ende des Datenzeitraums oder bei
  Datenlücken stoppt die Trajektorie mit sichtbarem Grund statt zu extrapolieren.

## Struktur

| Datei | Zweck |
|---|---|
| `src/integrator.js` | Petterssen-Integrator (Vorhersage + `computeAlongProfile` für den Hindcast), reine Mathematik, ohne I/O |
| `src/windfield.js` | Datenzugriff: Levelfenster, Punkt-Cache, 4-D-Interpolation |
| `src/config.js` | Server (Hosts aus `meteokit/config`), Modellgitter/BBoxen, feste Höhen-Farbzuordnung |
| `src/app.js` | Leaflet-UI (Vorhersage) |
| `src/timeline.js` | Zeitband (Start, Dauer, Richtung) |
| `src/altitudeprofile.js` | Trajektorienverlauf der aktiven Höhe (lazy; nutzt `crosssection.js` und `pathgeo.js`) |
| `src/geocode.js`, `src/coords.js` | Ortssuche (Photon) und Koordinateneingabe (Dezimal/MGRS) |
| `src/geoman.js` | Zeichen-/Messwerkzeuge auf der Karte |
| `src/units.js` | Anzeige-Einheiten (m/ft, km/h/m/s/kt) |
| `diagnose/index.html`, `src/diagnose/` | Hindcast-Seite: `app.js` (UI), `track.js` (GPX, Start/Landung, Kennzahlen; ohne DOM), `archive.js` (Archivtiefe live) |
| `css/diagnose.css` | Hindcast-Unterschiede zu `css/style.css` (Petrol, Tabelle, Legende) |
| `src/view3d.js` | 3D-Ansicht (CesiumJS lazy; Re:Earth / Ion / flat; Esri / OSM) |
| `src/gramet.js` | GRAMET-Querschnitt entlang der aktiven Trajektorie (lazy, Web Component aus `meteokit/gramet`), Dock-Anordnung |
| `src/cursorsync.js` | Gemeinsame Positionsanzeige Karte ↔ GRAMET / Trajektorienverlauf (hält die eine Wegpunktliste, die alle benutzen) |
| `test/` | Offline-Tests (Kreisschluss, Umkehrbarkeit, Bodenprüfung, Hindcast) + Live-Smoke-Test |

`meteokit/*` wird importiert von `config.js`, `windfield.js`, `app.js`,
`gramet.js`, `altitudeprofile.js` und `diagnose/` (Hosts, Host-Fallback,
GRAMET, Lufträume).

Levelzählung der API: N=1 oberstes Level, N=65 (D2), N=74 (EU) bzw. N=120 (Global) unterstes
(~10 m AGL). Windvariablen kommen in km/h und werden intern in m/s geführt.
