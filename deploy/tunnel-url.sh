#!/usr/bin/env bash
# Print the public address of the Cloudflare quick tunnel (compose profile
# "tunnel", local testing only). It changes on every start of the container.
#   docker compose --profile tunnel up -d tunnel && bash deploy/tunnel-url.sh
set -euo pipefail
cd "$(dirname "$0")/.."

for _ in $(seq 1 30); do
    url="$(docker compose --profile tunnel logs tunnel 2>/dev/null \
        | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    if [ -n "$url" ]; then
        echo "$url"
        exit 0
    fi
    sleep 2
done
echo "No tunnel address yet. Is it running? docker compose --profile tunnel ps tunnel" >&2
exit 1
