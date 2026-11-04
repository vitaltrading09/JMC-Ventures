#!/usr/bin/env bash
# Restore a pg_dump (-Fc) of a Grid-IQ database into the compose timescaledb,
# then bring it to the current schema.
#
#   bash deploy/scripts/restore-dump.sh <dump-file> <timescaledb-version-of-the-dump>
#   e.g. bash deploy/scripts/restore-dump.sh local/prod.dump 2.25.0
#
# Only into an EMPTY database (a fresh DATA_DIR): it refuses if any table
# exists, so it can never overwrite data.
#
# A TimescaleDB dump must be restored into the same extension version it was
# taken from. The image may ship a newer one, so the extension is created at
# the dump's version, the dump restored, and `migrate` then updates the
# extension and applies the migrations. Find the dump's version on the source:
#   SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"
export MSYS_NO_PATHCONV=1   # Git Bash: keep container paths as they are

DUMP="${1:-}"
TS_VERSION="${2:-}"
if [ -z "$DUMP" ] || [ -z "$TS_VERSION" ] || [ ! -f "$DUMP" ]; then
    echo "Usage: bash deploy/scripts/restore-dump.sh <dump-file> <timescaledb-version>" >&2
    exit 1
fi

env_value() { grep -E "^${1}=" .env | tail -n1 | cut -d= -f2-; }
PGUSER="$(env_value POSTGRES_USER)"
PGDB="$(env_value POSTGRES_DB)"

psql_db() { docker compose exec -T timescaledb psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }

echo "==> starting timescaledb"
docker compose up -d --wait timescaledb

tables=$(psql_db -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [ "$tables" != 0 ]; then
    echo "restore-dump: $PGDB already has $tables table(s). Refusing to restore over existing data." >&2
    echo "             Restore into a fresh DATA_DIR (empty database) instead." >&2
    exit 1
fi

echo "==> stopping app services while restoring"
docker compose stop api ingest jobs auth >/dev/null 2>&1 || true

echo "==> timescaledb extension at the dump's version ($TS_VERSION)"
psql_db -c "DROP EXTENSION IF EXISTS timescaledb" \
        -c "CREATE EXTENSION timescaledb VERSION '$TS_VERSION'" \
        -c "SELECT timescaledb_pre_restore()" >/dev/null

echo "==> pg_restore"
docker compose cp "$DUMP" timescaledb:/tmp/restore.dump
# Some catalog warnings are normal for TimescaleDB restores; real errors fail below.
docker compose exec -T timescaledb pg_restore -U "$PGUSER" -d "$PGDB" --no-owner /tmp/restore.dump
docker compose exec -T timescaledb rm -f /tmp/restore.dump
psql_db -c "SELECT timescaledb_post_restore()" >/dev/null

echo "==> restored row counts"
psql_db -tAc "SELECT 'meter_readings', count(*) FROM meter_readings UNION ALL SELECT 'meters', count(*) FROM meters UNION ALL SELECT 'sites', count(*) FROM sites"

echo "==> duplicate readings check"
docker compose run --rm --no-deps migrate node /app/packages/db/bin/quarantine-duplicate-readings.js

cat <<EOF

Next:
  1. If duplicates were reported above, review them, then move them aside:
       docker compose run --rm --no-deps migrate node /app/packages/db/bin/quarantine-duplicate-readings.js --apply
  2. Apply the migrations (also updates the timescaledb extension):
       docker compose run --rm migrate
  3. docker compose up -d && bash deploy/status.sh
EOF
