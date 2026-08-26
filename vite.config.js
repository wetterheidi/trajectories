import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Komponentenbibliothek meteokit: eigenes Repo, als `file:`-Abhängigkeit
// eingebunden (s. package.json) -- eine Quelle der Wahrheit für GRAMET & Co.
// npm legt dafür einen Symlink in node_modules an, das Ziel liegt also
// außerhalb des Projekt-Roots (daher `server.fs.allow` unten). Voraussetzung:
// beide Repos nebeneinander ausgecheckt, auch beim VPS-Build.
// Der App-Code importiert ausschließlich über `meteokit/…` (nur in src/gramet.js).
const meteokit = fileURLToPath(new URL("../meteokit", import.meta.url));

/** Default base `/` for local `npm run dev` / `npm run build`.
 *  VPS path deploy uses: `npx vite build --base=/trajectories/`
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
  server: {
    fs: { allow: [root, meteokit] },
    // Michaels open-meteo-Server lässt per Caddy-CORS-Allowlist nur die
    // Produktions-Origin https://trajectories.wetterheidi.de durch, sonst 403
    // (auch ganz ohne Origin-Header). Im Dev-Betrieb läuft der Request über
    // diesen Node-Proxy statt direkt aus dem Browser -- daher unterliegt er
    // keinem Browser-CORS und die Origin lässt sich hier gefahrlos auf die
    // eigene Produktions-Origin setzen, damit Michaels Server ihn durchlässt.
    //
    // GRAMET fragt pro Säule ALLE Modelllevel × mehrere Variablen in einem
    // Request ab -- die Query-String allein sprengt Nodes Default-Limit für
    // Request-Header (8/16 KB), an dem Caddy/nginx in Produktion vorbeigehen
    // (der Request läuft dort nie durch einen Node-HTTP-Server). Deshalb hebt
    // der `dev`-Skript-Eintrag in package.json Nodes Limit per
    // `NODE_OPTIONS=--max-http-header-size` an -- ohne das liefert genau
    // dieser Proxy-Pfad 431 (Request Header Fields Too Large).
    proxy: {
      "/api-proxy": {
        target: "https://open-meteo.mah.priv.at",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", "https://trajectories.wetterheidi.de");
          });
        },
      },
    },
  },
});
