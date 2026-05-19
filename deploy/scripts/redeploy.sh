#!/bin/bash
# Redeploy after `git pull` — rebuilds frontend, restarts all backend services.
# Run: bash deploy/scripts/redeploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "▶ Pulling latest from git…"
cd "$REPO_ROOT"
git pull origin main

echo ""
echo "▶ Installing any new dependencies…"
npm install --silent

echo ""
echo "▶ Rebuilding Next.js frontend…"
(cd apps/web && npm run build)

echo ""
echo "▶ Restarting backend services…"
# Order matters — gateway depends on auth+ingestion, web depends on gateway.
for svc in powerguard-auth powerguard-ingestion powerguard-gateway powerguard-web; do
    sudo systemctl restart "$svc"
    echo "  ✓ $svc restarted"
done

echo ""
sleep 5
bash "$REPO_ROOT/deploy/scripts/status.sh"
