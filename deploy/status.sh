#!/usr/bin/env bash
# One-glance health of the compose stack.
#   bash deploy/status.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Only services defined in docker-compose.yml (ignores orphans from older setups).
mapfile -t services < <(docker compose config --services)

docker compose ps --all --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}' "${services[@]}"

echo
unhealthy=$(docker compose ps --format '{{.Service}} {{.Health}}' "${services[@]}" \
    | awk '$2 != "" && $2 != "healthy" {printf "%s(%s) ", $1, $2}')
stopped=$(docker compose ps --all --format '{{.Service}} {{.State}}' "${services[@]}" \
    | awk '$1 != "migrate" && $2 != "running" {printf "%s(%s) ", $1, $2}')
# migrate is a one-shot: it must have exited 0.
migrate_exit=$(docker compose ps --all --format '{{.ExitCode}}' migrate 2>/dev/null)
if [ -n "$migrate_exit" ] && [ "$migrate_exit" != 0 ]; then
    stopped="${stopped}migrate(exit $migrate_exit) "
fi

if [ -z "$unhealthy" ] && [ -z "$stopped" ]; then
    echo "All services running and healthy."
else
    [ -n "$unhealthy" ] && echo "Not healthy: $unhealthy"
    [ -n "$stopped" ] && echo "Not running: $stopped"
    echo "Hint: bash deploy/logs.sh <service>"
    exit 1
fi
