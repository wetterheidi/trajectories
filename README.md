# Windtrajektorien

Webanwendung zur Berechnung und Kartendarstellung von Windtrajektorien
(vorwärts und rückwärts) auf Basis der nativen ICON-Modelllevel von
[open-meteo.mah.priv.at](https://open-meteo.mah.priv.at) (DWD ICON-EU / ICON-D2,
bereitgestellt von Michael).

## Start

```bash
npm install
npm run dev        # Entwicklungsserver (Vite)
npm test           # Integrator-Tests (synthetische Windfelder, offline)
npm run test:live  # Live-Test gegen den Server
```

Die App ist reines ESM ohne Build-Zwang — jeder statische Webserver im
Projektwurzelverzeichnis funktioniert ebenfalls.

## Bedienung

Startpunkt per Kartenklick setzen (Marker ist verschiebbar), Modell, Startzeit
(Schieber, UTC), Dauer, Richtung und Höhenreferenz (AGL/AMSL) wählen. Starthöhen
sind frei wählbar (Schieber bis 6000 m, Zahlenfeld bis 10 000 m, 10-m-Raster,
max. 8 gleichzeitig): Höhe einstellen und mit „+" (oder Enter) zur Liste
hinzufügen, „ד entfernt sie wieder. Jede Höhe behält ihre Farbe, solange sie
in der Liste ist. Die Höhenreferenz gilt für die gesamte Trajektorie: „AGL"
rechnet geländefolgend auf konstanter Höhe über Grund, „AMSL" auf konstanter
absoluter Höhe. Der Markenabstand (10 min – 6 h) steuert die Punktmarkierungen,
deren Tooltip Zeit, Höhe und Wind zeigt.

„Querschnitt anzeigen" öffnet unter der Karte das Höhenprofil als Small
Multiples: ein Streifen je Trajektorie mit gemeinsamer Zeitachse (x = Stunden
seit Start) und gemeinsamer Höhenskala (y = m NN). Jeder Streifen zeigt das
Modellgelände entlang des eigenen Pfades als graue Silhouette — die Pfade
verschiedener Starthöhen laufen ja auseinander. Fadenkreuz-Hover zeigt Zeit,
Höhen und Bodenhöhe über alle Streifen. Die Geländehöhen stammen aus den
bereits gecachten Gitterpunkten (Modellorographie, keine zusätzlichen Abrufe).

Unter „Einheiten" lassen sich Höhe (m/ft — gilt für Anzeige *und* Eingabe)
und Windgeschwindigkeit (km/h, m/s, kt) umstellen; intern wird durchgehend
SI gerechnet, der GeoJSON-Export bleibt SI.

**Konsolen-Monitor:** `?debug=1` an die URL (oder `localStorage.trajDebug =
"1"`) protokolliert jeden Interpolationsaufruf in der Browser-Konsole: Zeit,
Position, Zielfläche, Ergebnis-Wind sowie je Gitterpunkt Bilinear-Gewicht,
verwendetes ICON-Level-Bracket, Höhen, Interpolationsgewicht und (falls
geladen) p, T und w.

„GeoJSON herunterladen" exportiert die zuletzt berechneten Trajektorien als
FeatureCollection: je Höhe eine LineString (mit Höhe als dritter Koordinate,
Zeitstempeln je Stützpunkt und allen Berechnungs-Metadaten in den properties)
plus die Zeitmarken als Points mit Wind.

## Meteorologik

- **Integration:** Petterssen-Schema (iterativ-implizit, wie HYSPLIT) mit
  adaptivem Zeitschritt (Verschiebung ≤ 0,75 Gitterweiten, 60–900 s).
  Rückwärtstrajektorien sind derselbe Algorithmus mit negativem Zeitschritt.
- **Interpolation:** horizontal bilinear zwischen den vier umgebenden
  Gitterpunkten, vertikal linear in der Höhe zwischen den nativen ICON-Leveln,
  zeitlich linear zwischen den Stundenterminen. Immer komponentenweise (u, v) —
  nie über Betrag/Richtung.
- **Vertikalbewegung** (wie HYSPLIT wählbar):
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
  stoppt die Trajektorie mit sichtbarem Grund.
- **Geometrie:** Kugelgeometrie mit cos(Breite)-Korrektur der Längenverlagerung.
- **Grenzen:** Am Rand des Modellgebiets, am Ende des Datenzeitraums oder bei
  Datenlücken stoppt die Trajektorie mit sichtbarem Grund statt zu extrapolieren.

## Struktur

| Datei | Zweck |
|---|---|
| `src/integrator.js` | Petterssen-Integrator, reine Mathematik, ohne I/O |
| `src/windfield.js` | Datenzugriff: Levelfenster, Punkt-Cache, 4-D-Interpolation |
| `src/config.js` | Server, Modellgitter/BBoxen, feste Höhen-Farbzuordnung |
| `src/app.js` | Leaflet-UI |
| `test/` | Offline-Tests (Kreisschluss, Umkehrbarkeit) + Live-Smoke-Test |

Levelzählung der API: N=1 oberstes Level, N=65 (D2) bzw. N=74 (EU) unterstes
(~10 m AGL). Windvariablen kommen in km/h und werden intern in m/s geführt.
