/**
 * Wegpunkte aus einem berechneten Lauf ableiten — gemeinsam genutzt von
 * `gramet.js` und `altitudeprofile.js` (beide brauchen dieselbe Form für
 * `meteokit/gramet`s `fetchTerrainProfile()`/`posOfPath()`).
 */

/**
 * Wegpunkte für den Path-Modus aus einem Lauf. `fetchGridForPath`/
 * `fetchTerrainProfile` erwarten aufsteigende Zeiten — Rückwärtstrajektorien
 * laufen in der Berechnung von der Startzeit rückwärts, werden hier also
 * umgedreht: links im Chart steht dann die Herkunft, rechts der gewählte
 * Startzeitpunkt.
 * `z` (m NN) reist als Höhenprofil mit, damit Wetterspalten/Gelände und
 * Profillinie garantiert aus derselben Punktliste stammen.
 */
export function waypointsFromRun(run, direction) {
  const wp = run.r.points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.tMs))
    .map((p) => ({
      lat: p.lat,
      lon: p.lon,
      t: Math.round(p.tMs / 1000),
      z: Number.isFinite(p.z) ? p.z : NaN,
    }));
  if (direction < 0) wp.reverse();
  return wp;
}
