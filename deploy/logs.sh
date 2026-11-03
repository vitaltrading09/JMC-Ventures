#!/usr/bin/env bash
# Follow one service's logs.
#   bash deploy/logs.sh <service> [lines]
# Services: caddy web gateway auth api ingest jobs migrate mosquitto timescaledb
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ $# -lt 1 ]; then
    echo "Usage: bash deploy/logs.sh <service> [lines]" >&2
    echo "Services: $(docker compose config --services | tr '\n' ' ')" >&2
    exit 1
fi
exec docker compose logs --follow --tail "${2:-100}" "$1"
