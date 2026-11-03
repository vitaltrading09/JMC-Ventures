#!/bin/bash
# Redeploy after `git pull` — rebuilds frontend, restarts all backend services.
# Run: bash deploy/legacy-aws/scripts/redeploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "▶ Pulling latest from git…"
cd "$REPO_ROOT"
git pull origin main

echo ""
echo "▶ Installing any new dependencies…"
npm install --silent

echo ""
# NEXT_PUBLIC_API_URL is baked into the bundle at build time. It used to come
# from a committed apps/web/.env.production (now removed); on this box put it in
# apps/web/.env.production.local (gitignored) or export it before running.
if [ -z "${NEXT_PUBLIC_API_URL:-}" ] && ! grep -qs '^NEXT_PUBLIC_API_URL=' "$REPO_ROOT/apps/web/.env.production.local"; then
    echo "✗ NEXT_PUBLIC_API_URL is not set. Create apps/web/.env.production.local with:"
    echo "    NEXT_PUBLIC_API_URL=http://<server-ip>:8081"
    exit 1
fi
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
bash "$REPO_ROOT/deploy/legacy-aws/scripts/status.sh"
