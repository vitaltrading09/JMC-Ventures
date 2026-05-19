#!/bin/bash
# Tail logs for a PowerGuard service.
# Usage: bash deploy/scripts/logs.sh <auth|ingestion|gateway|web>  [lines]

SERVICE="${1:-}"
LINES="${2:-100}"

if [ -z "$SERVICE" ]; then
    cat <<EOF
Usage:  bash deploy/scripts/logs.sh <service> [lines]

Services:
  auth        Authentication service (port 3001)
  ingestion   MQTT + meter ingestion + AI (port 3002)
  gateway     API gateway / reverse proxy (port 8081)
  web         Next.js frontend (port 3000)

Examples:
  bash deploy/scripts/logs.sh ingestion           # tail with last 100 lines
  bash deploy/scripts/logs.sh ingestion 500       # tail with last 500 lines
  bash deploy/scripts/logs.sh auth                # tail auth service

EOF
    exit 1
fi

case "$SERVICE" in
    auth|ingestion|gateway|web) ;;
    *) echo "Unknown service: $SERVICE"; exit 1 ;;
esac

exec journalctl -u "powerguard-$SERVICE" -n "$LINES" -f --no-pager
