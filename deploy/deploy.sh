#!/usr/bin/env bash
# Deploy the Docker Compose stack on this machine (Oracle VM or local).
#
#   bash deploy/deploy.sh            # pull main, build, migrate, start
#   SKIP_PULL=1 bash deploy/deploy.sh  # deploy the current checkout as is
#
# Steps: git pull → docker compose build → migrate (one-shot) → up -d →
# MQTT certificate sync → health summary.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

[ -f .env ] || { echo "deploy: .env is missing (cp .env.example .env and fill it in)" >&2; exit 1; }

if [ -z "${SKIP_PULL:-}" ]; then
    echo "==> git pull"
    git pull --ff-only
fi

echo "==> docker compose build"
docker compose build

echo "==> migrate"
docker compose up -d timescaledb
docker compose run --rm migrate

echo "==> docker compose up -d"
docker compose up -d --remove-orphans

# Mosquitto waits for its certificate; Caddy may only just have issued it.
echo "==> MQTT certificate"
if ! bash deploy/scripts/sync-mqtt-certs.sh; then
    echo "    (not available yet: re-run deploy/scripts/sync-mqtt-certs.sh once Caddy has the certificate)"
fi

echo "==> waiting for health"
for _ in $(seq 1 30); do
    if ! docker compose ps --format '{{.Health}}' | grep -qE 'starting'; then break; fi
    sleep 5
done

bash deploy/status.sh
