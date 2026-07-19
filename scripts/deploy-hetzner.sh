#!/usr/bin/env bash
#
# Deployt die Trajektorien-App nach https://trajectories.wetterheidi.de
#
# - Baut den Web-Build mit base=/ (Subdomain-Root)
# - Legt beim ersten Lauf den nginx-Vhost MIT Pfoertner-Gate an und holt
#   das Let's-Encrypt-Zertifikat (idempotent, wird danach übersprungen)
# - Synchronisiert dist/ nach /apps/trajectories auf dem Server
#
# Pfoertner: Der Vhost meldet sich als tool=trajectories. Damit jemand
# hineinkommt, muss das Tool einmalig im Panel unter
# https://verwaltung.wetterheidi.de/admin/tools angelegt und den Nutzern
# das Häkchen gegeben werden — bis dahin liefert der Pförtner 403.
#
# Aufruf: npm run deploy   (oder direkt: bash scripts/deploy-hetzner.sh)

set -euo pipefail

SERVER="root@178.104.206.136"
DOMAIN="trajectories.wetterheidi.de"
REMOTE_DIR="/apps/trajectories"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Baue Web-Build (base=/) ..."
cd "$PROJECT_DIR"
npx vite build --base=/

echo "==> Prüfe Server-Setup (nginx-Vhost + Zertifikat) ..."
ssh "$SERVER" bash -s -- "$DOMAIN" "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"
REMOTE_DIR="$2"

mkdir -p "$REMOTE_DIR"

if [ ! -f "/etc/nginx/sites-available/$DOMAIN" ]; then
    echo "    Lege nginx-Vhost für $DOMAIN an (mit Pfoertner-Gate) ..."
    cat > "/etc/nginx/sites-available/$DOMAIN" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    root $REMOTE_DIR;
    index index.html;

    # --- Pfoertner: gilt für den gesamten Vhost -----------------------------
    set \$pfoertner_tool trajectories;
    auth_request /_pfoertner;
    error_page 401 = @zum_login;
    error_page 403 /gesperrt.html;
    include snippets/pfoertner.conf;
    # ------------------------------------------------------------------------

    # Let's-Encrypt-Validierung muss ohne Login erreichbar sein.
    location ^~ /.well-known/acme-challenge/ {
        auth_request off;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
NGINX
    ln -sf "../sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
    nginx -t
    systemctl reload nginx

    echo "    Hole Let's-Encrypt-Zertifikat ..."
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect
else
    echo "    Vhost existiert bereits, Setup übersprungen."
fi
REMOTE

echo "==> Synchronisiere dist/ nach $SERVER:$REMOTE_DIR ..."
rsync -avz --delete --exclude=.DS_Store "$PROJECT_DIR/dist/" "$SERVER:$REMOTE_DIR/"

echo "==> Fertig: https://$DOMAIN"
