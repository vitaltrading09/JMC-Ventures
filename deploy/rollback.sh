#!/usr/bin/env bash
# Roll the app containers back to the previously deployed images.
#
#   bash deploy/rollback.sh             # to .deploy/previous-tag (written by deploy.sh)
#   bash deploy/rollback.sh <tag>       # to a specific earlier tag (see: docker images gridiq/web)
#
# No rebuild, no migration. Migrations are forward-only: an older image runs
# against a newer schema (services only warn when the database is ahead of
# them). If the release you are leaving added a migration the old code cannot
# live with, restore the pre-deploy backup instead (docs/RUNBOOK.md).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

TAG="${1:-$(cat .deploy/previous-tag 2>/dev/null || true)}"
[ -n "$TAG" ] || { echo "rollback: no tag given and no .deploy/previous-tag" >&2; exit 1; }
CURRENT="$(grep -E '^IMAGE_TAG=' .env | tail -n1 | cut -d= -f2- || true)"

for img in gridiq/web gridiq/api-gateway gridiq/auth-service gridiq/ingestion-service; do
    docker image inspect "$img:$TAG" >/dev/null 2>&1 || { echo "rollback: image $img:$TAG is not on this machine" >&2; exit 1; }
done

echo "==> rolling back $CURRENT → $TAG"
if grep -qE '^IMAGE_TAG=' .env; then sed -i "s#^IMAGE_TAG=.*#IMAGE_TAG=$TAG#" .env; else echo "IMAGE_TAG=$TAG" >> .env; fi
mkdir -p .deploy && echo "$CURRENT" > .deploy/previous-tag
# --no-build: exactly the images already here. --no-deps: do not run the old
# image's migrate step against the newer schema.
docker compose up -d --no-build --no-deps web gateway auth api ingest jobs
bash deploy/status.sh
