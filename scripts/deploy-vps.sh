#!/usr/bin/env bash
#
# Deploy the Vite webapp to https://vps.mah.priv.at/trajectories/
# (Caddy Basic Auth — see deploy/Caddyfile.vps-trajectories.snippet).
#
# Aufruf: npm run deploy:vps   (oder: bash scripts/deploy-vps.sh)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TRAJECTORIES_VPS_DEST:-/var/www/vps/trajectories}"
if [[ "$DEST" != /* || "$DEST" == "/" ]]; then
  echo "Refusing unsafe deployment destination: $DEST" >&2
  exit 1
fi
BASE="/trajectories/"

echo "==> Baue Web-Build (base=${BASE}) ..."
cd "$PROJECT_DIR"
npx vite build --base="$BASE"

# vite-plugin-cesium copies into dist/<base>/cesium; flatten for rsync of dist/.
if [[ -d dist/trajectories/cesium ]]; then
  rm -rf dist/cesium
  mv dist/trajectories/cesium dist/cesium
  rm -rf dist/trajectories
fi

echo "==> Synchronisiere dist/ → ${DEST}/ ..."
if mkdir -p "$DEST" 2>/dev/null && [[ -w "$DEST" ]]; then
  rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/dist/" "$DEST/"
else
  sudo mkdir -p "$DEST"
  sudo rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/dist/" "$DEST/"
fi

echo "==> Fertig: https://vps.mah.priv.at/trajectories/"
echo "    (Basic Auth: user trajectories — hash in /etc/caddy/Caddyfile)"
