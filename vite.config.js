import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Komponentenbibliothek meteokit: eigenes Repo, als `file:`-Abhängigkeit
// eingebunden (s. package.json) -- eine Quelle der Wahrheit für GRAMET & Co.
// npm/bun legt dafür einen Symlink in node_modules an, das Ziel liegt also
// außerhalb des Projekt-Roots (daher `server.fs.allow` unten). Voraussetzung:
// beide Repos nebeneinander ausgecheckt, auch beim VPS-Build.
// Der App-Code importiert ausschließlich über `meteokit/…` (nur in src/gramet.js).
const meteokit = fileURLToPath(new URL("../meteokit", import.meta.url));

/** Default base `/` for local `bun run dev` / `bun run build`.
 *  VPS path deploy uses: `bunx vite build --base=/trajectories/`
 *  (deploy-vps.sh flattens vite-plugin-cesium’s nested dist/<base>/cesium). */
export default defineConfig({
  base: "/",
  plugins: [cesium()],
  // meteokit ist ein Quellpaket, kein vorgebautes Bundle: Vite würde es sonst
  // mit esbuild vorbündeln, das Vite-eigene Import-Suffixe wie `?inline`
  // (gramet-panel.js lädt so sein CSS) nicht kennt.
  optimizeDeps: { exclude: ["meteokit"] },
  // Die Bibliothek liegt außerhalb des Projekt-Roots -- ohne diese Freigabe
  // verweigert der Dev-Server das Ausliefern ihrer Module.
  server: { fs: { allow: [root, meteokit] } },
});
