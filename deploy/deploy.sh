#!/usr/bin/env bash
# Deploy the Docker Compose stack on this machine (Oracle VM or local).
#
#   bash deploy/deploy.sh            # pull main, build, migrate, start
#   SKIP_PULL=1 bash deploy/deploy.sh  # deploy the current checkout as is
#
# Steps: git pull → docker compose build → migrate (one-shot) → up -d →
# MQTT certificate sync → health summary.
#
# Images are tagged with the commit (IMAGE_TAG in .env is set to it), and the
# tag that was running before is kept in .deploy/previous-tag, so
# deploy/rollback.sh can go back without rebuilding.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

[ -f .env ] || { echo "deploy: .env is missing (cp .env.example .env and fill it in)" >&2; exit 1; }

if [ -z "${SKIP_PULL:-}" ]; then
    echo "==> git pull"
    git pull --ff-only
fi

# Tag this build with the commit; remember what was running.
set_env() { # key value: replace or append in .env
    if grep -qE "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}
mkdir -p .deploy
PREV_TAG="$(grep -E '^IMAGE_TAG=' .env | tail -n1 | cut -d= -f2- || true)"
NEW_TAG="$(git rev-parse --short=12 HEAD)$(git diff --quiet HEAD -- . ':!.env' || echo -dirty)"
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$NEW_TAG" ]; then echo "$PREV_TAG" > .deploy/previous-tag; fi
set_env IMAGE_TAG "$NEW_TAG"
echo "==> docker compose build (IMAGE_TAG=$NEW_TAG, previous ${PREV_TAG:-none})"
docker compose build

echo "==> migrate"
docker compose up -d timescaledb
docker compose run --rm migrate

# The api and jobs containers run as the image's node user (uid 1000) and
# write exports here; Docker would create a missing directory as root.
DATA_DIR_VAL="$(grep -E '^DATA_DIR=' .env | tail -n1 | cut -d= -f2- || true)"
DATA_DIR_VAL="${DATA_DIR_VAL:-./.data}"
mkdir -p "$DATA_DIR_VAL/exports"
if [ "$(stat -c %u "$DATA_DIR_VAL/exports" 2>/dev/null || echo 1000)" != 1000 ]; then
    chown 1000:1000 "$DATA_DIR_VAL/exports" 2>/dev/null || sudo -n chown 1000:1000 "$DATA_DIR_VAL/exports" 2>/dev/null \
        || echo "deploy: warning: chown 1000:1000 $DATA_DIR_VAL/exports so the jobs container can write exports" >&2
fi

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
