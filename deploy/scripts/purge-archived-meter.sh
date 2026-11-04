#!/usr/bin/env bash
# PERMANENTLY remove an ARCHIVED meter and all of its data. The documented
# retention step behind "raw readings are evidence": nothing else in Grid-IQ
# deletes readings. Super-admin / ops only, run on the server.
#
#   bash deploy/scripts/purge-archived-meter.sh <meter-id> --confirm "<exact meter name>"
#
# 1. refuses unless the meter is archived (app: delete = archive) and the
#    name matches exactly;
# 2. takes a fresh backup (deploy/scripts/backup.sh), and stops if it fails;
# 3. deletes the meter's raw readings, then the meter row (its alerts,
#    recommendations, pq_events, assessments, share links and ingest stats go
#    with it through ON DELETE CASCADE), in one transaction;
# 4. refreshes the continuous aggregates over the meter's time range, so no
#    rollup keeps its data;
# 5. logs what was removed to ${DATA_DIR}/backups/purge.log.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"
export MSYS_NO_PATHCONV=1

METER_ID="${1:-}"
CONFIRM=""
if [ "${2:-}" = "--confirm" ]; then CONFIRM="${3:-}"; fi
if [ -z "$METER_ID" ] || [ -z "$CONFIRM" ]; then
    echo "Usage: bash deploy/scripts/purge-archived-meter.sh <meter-id> --confirm \"<exact meter name>\"" >&2
    exit 1
fi
if ! [[ "$METER_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then echo "purge: not a meter id: $METER_ID" >&2; exit 1; fi

env_value() { [ -f .env ] && grep -E "^${1}=" .env | tail -n1 | cut -d= -f2- || true; }
PGUSER="$(env_value POSTGRES_USER)"; PGDB="$(env_value POSTGRES_DB)"
DATA_DIR="${DATA_DIR:-$(env_value DATA_DIR)}"; DATA_DIR="${DATA_DIR:-./.data}"
LOG="$DATA_DIR/backups/purge.log"; mkdir -p "$DATA_DIR/backups"
q() { docker compose exec -T timescaledb psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -tA "$@"; }

INFO="$(q -c "SELECT m.name || '|' || (m.archived_at IS NOT NULL) || '|' || s.name FROM meters m JOIN sites s ON m.site_id = s.id WHERE m.id = '$METER_ID'")"
[ -n "$INFO" ] || { echo "purge: no meter $METER_ID" >&2; exit 1; }
NAME="${INFO%%|*}"; REST="${INFO#*|}"; ARCHIVED="${REST%%|*}"; SITE="${REST#*|}"
[ "$ARCHIVED" = t ] || { echo "purge: meter \"$NAME\" is not archived. Archive it in the app first." >&2; exit 1; }
[ "$CONFIRM" = "$NAME" ] || { echo "purge: --confirm must be the exact meter name: \"$NAME\"" >&2; exit 1; }

RANGE="$(q -c "SELECT count(*) || '|' || coalesce(min(time)::text, '') || '|' || coalesce(max(time)::text, '') FROM meter_readings WHERE meter_id = '$METER_ID'")"
ROWS="${RANGE%%|*}"; REST="${RANGE#*|}"; FIRST="${REST%%|*}"; LAST="${REST#*|}"
echo "purge: meter \"$NAME\" (site \"$SITE\"): $ROWS readings${FIRST:+ from $FIRST to $LAST}"

echo "==> backup first"
bash deploy/scripts/backup.sh || { echo "purge: backup failed; nothing was deleted" >&2; exit 1; }

echo "==> deleting"
q <<SQL
BEGIN;
DELETE FROM meter_readings WHERE meter_id = '$METER_ID';
-- Its deployment history goes with it; the measurement points (places) stay.
DELETE FROM deployments WHERE device_id = '$METER_ID';
DELETE FROM meters WHERE id = '$METER_ID';
COMMIT;
SQL

if [ -n "$FIRST" ]; then
    echo "==> refreshing aggregates over the meter's time range"
    for v in readings_1m readings_10m readings_30m readings_1h readings_1d; do
        q -c "CALL refresh_continuous_aggregate('$v', date_trunc('day', '$FIRST'::timestamptz), date_trunc('day', '$LAST'::timestamptz) + interval '1 day')"
    done
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) purged meter $METER_ID \"$NAME\" (site \"$SITE\"): $ROWS readings${FIRST:+ $FIRST..$LAST}" | tee -a "$LOG"
