import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Komponentenbibliothek: liegt (noch) im Nachbar-Repo droneforecast, wird per
// Alias eingebunden statt kopiert -- eine Quelle der Wahrheit für GRAMET & Co.
// Voraussetzung: beide Repos nebeneinander ausgecheckt (auch beim VPS-Build).
// Wird die Bibliothek später ein eigenes Paket, ändert sich nur dieses Ziel;
// der App-Code importiert ausschließlich über `@windkit/…` (nur in src/gramet.js).
const windkit = fileURLToPath(new URL("../droneforecast", import.meta.url));

/** Default base `/` for local `bun run dev` / `bun run build`.
 *  VPS path deploy uses: `bunx vite build --base=/trajectories/`
 *  (deploy-vps.sh flattens vite-plugin-cesium’s nested dist/<base>/cesium). */
export default defineConfig({
  base: "/",
  plugins: [cesium()],
  resolve: {
    alias: [{ find: /^@windkit\//, replacement: `${windkit}/src/` }],
  },
  // Die Bibliothek liegt außerhalb des Projekt-Roots -- ohne diese Freigabe
  // verweigert der Dev-Server das Ausliefern ihrer Module.
  server: { fs: { allow: [root, windkit] } },
});
