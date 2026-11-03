#!/usr/bin/env bash
# Copy Caddy's certificate for MQTT_DOMAIN to where Mosquitto reads it, and
# restart mosquitto only if the files changed. Safe to run as often as you
# like; Phase 5 installs it as a daily cron job.
#
#   sudo bash deploy/scripts/sync-mqtt-certs.sh
#
# Reads DATA_DIR and MQTT_DOMAIN from the environment or the repo's .env.
# Caddy's issuer directory is detected (Let's Encrypt, ZeroSSL fallback, or
# Caddy's local CA when MQTT_DOMAIN is a *.localhost name in local dev).
# Override with CADDY_ISSUER=<directory name> if needed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

env_value() {
    # Value of $1 from .env, without sourcing the whole file.
    [ -f .env ] || return 0
    grep -E "^${1}=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

DATA_DIR="${DATA_DIR:-$(env_value DATA_DIR)}"
DATA_DIR="${DATA_DIR:-./.data}"
MQTT_DOMAIN="${MQTT_DOMAIN:-$(env_value MQTT_DOMAIN)}"
if [ -z "$MQTT_DOMAIN" ]; then
    echo "sync-mqtt-certs: MQTT_DOMAIN is not set (env or .env)" >&2
    exit 1
fi

CERTS_ROOT="$DATA_DIR/caddy/certificates"
DEST="$DATA_DIR/mqtt-certs"

if [ -n "${CADDY_ISSUER:-}" ]; then
    ISSUERS=("$CADDY_ISSUER")
else
    ISSUERS=(acme-v02.api.letsencrypt.org-directory acme.zerossl.com-v2-dv90 local)
fi

SRC=""
for issuer in "${ISSUERS[@]}"; do
    if [ -f "$CERTS_ROOT/$issuer/$MQTT_DOMAIN/$MQTT_DOMAIN.crt" ]; then
        SRC="$CERTS_ROOT/$issuer/$MQTT_DOMAIN"
        ISSUER="$issuer"
        break
    fi
done
if [ -z "$SRC" ]; then
    echo "sync-mqtt-certs: no certificate for $MQTT_DOMAIN under $CERTS_ROOT yet." >&2
    echo "                 Is caddy running and is DNS for $MQTT_DOMAIN pointing here? (docker compose logs caddy)" >&2
    exit 1
fi
if [ ! -r "$SRC/$MQTT_DOMAIN.key" ]; then
    echo "sync-mqtt-certs: cannot read $SRC/$MQTT_DOMAIN.key (Caddy writes it as root). Run with sudo." >&2
    exit 1
fi

mkdir -p "$DEST"
changed=0
install_file() { # src dest mode → returns 0 if the file changed
    if ! cmp -s "$1" "$2" 2>/dev/null; then
        cp "$1" "$2.tmp"
        chmod "$3" "$2.tmp"
        mv -f "$2.tmp" "$2"
        return 0
    fi
    return 1
}
install_file "$SRC/$MQTT_DOMAIN.crt" "$DEST/fullchain.pem" 0640 && changed=1
install_file "$SRC/$MQTT_DOMAIN.key" "$DEST/privkey.pem"   0640 && changed=1

# Local CA root, so the ingest container can verify a locally issued cert.
# ingest reads it once at startup, so a new one means restarting ingest.
ca_changed=0
if [ "$ISSUER" = local ] && [ -f "$DATA_DIR/caddy/pki/authorities/local/root.crt" ]; then
    install_file "$DATA_DIR/caddy/pki/authorities/local/root.crt" "$DEST/ca.crt" 0644 && ca_changed=1
fi

# The mosquitto user in the official image is uid/gid 1883. Only meaningful
# on Linux hosts; Docker Desktop bind mounts ignore ownership.
if [ "$(uname -s)" = Linux ]; then
    chown 1883:1883 "$DEST/fullchain.pem" "$DEST/privkey.pem"
fi

if [ "$changed" = 1 ]; then
    echo "sync-mqtt-certs: certificate for $MQTT_DOMAIN updated from $ISSUER; restarting mosquitto"
    docker compose restart mosquitto
else
    echo "sync-mqtt-certs: certificate for $MQTT_DOMAIN unchanged"
fi
if [ "$ca_changed" = 1 ] && [ -n "$(docker compose ps -q ingest 2>/dev/null)" ]; then
    echo "sync-mqtt-certs: local CA updated; restarting ingest"
    docker compose restart ingest
fi
