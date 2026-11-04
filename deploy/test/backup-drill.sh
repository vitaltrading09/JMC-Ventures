#!/usr/bin/env bash
# LOCAL TEST: backup.sh → S3 (S3Mock) → restore-drill.sh, end to end.
#
#   bash deploy/test/backup-drill.sh
#
# Uses the running stack's compose project plus deploy/test/s3mock.override.yml.
# Overrides the BACKUP_* settings for this run only (.env is not changed).
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"
export MSYS_NO_PATHCONV=1

SEP="${COMPOSE_PATH_SEPARATOR:-:}"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}${SEP}deploy/test/s3mock.override.yml"
export BACKUP_S3_ENDPOINT=http://s3mock:9090
export BACKUP_S3_BUCKET=gridiq-backups
export BACKUP_S3_ACCESS_KEY_ID=test BACKUP_S3_SECRET_ACCESS_KEY=test BACKUP_S3_REGION=us-east-1
export BACKUP_PREFIX=drill-test

docker compose up -d --wait s3mock timescaledb
echo "==> backup.sh"
bash deploy/scripts/backup.sh
echo "==> objects in the bucket"
docker compose run --rm --no-deps -T awscli --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls --recursive "s3://$BACKUP_S3_BUCKET/$BACKUP_PREFIX/"
echo "==> restore-drill.sh"
bash deploy/scripts/restore-drill.sh
