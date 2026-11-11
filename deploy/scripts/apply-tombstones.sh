#!/usr/bin/env bash
# Re-apply GridIQ deletion tombstones after restoring a backup.
#
# A backup taken before a retention purge still holds the purged assessment's
# readings and reports. Run this right after deploy/scripts/restore-dump.sh and
# BEFORE starting api/jobs or letting anyone sign in: it deletes again every
# range listed in deletion_tombstones, clears report content and marks those
# assessments purged, so a restore never resurrects deleted customer data.
#
# The tombstones themselves must come from the newest database (they are
# small): export them from the live DB first, then import into the restored one.
#
#   # on the current DB (before the restore):
#   bash deploy/scripts/apply-tombstones.sh export > /root/tombstones.csv
#   # after restoring the older dump:
#   bash deploy/scripts/apply-tombstones.sh apply /root/tombstones.csv
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
DB="${TOMBSTONE_DB:-$POSTGRES_DB}"   # TOMBSTONE_DB: another database in the same container (restore drills, tests)
PSQL=(docker compose exec -T timescaledb psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB")

case "${1:-}" in
  export)
    "${PSQL[@]}" -c "\copy (SELECT assessment_id, entity, device_id, range_from, range_to, ref, deleted_at FROM deletion_tombstones ORDER BY id) TO STDOUT WITH CSV HEADER"
    ;;
  apply)
    file="${2:?usage: apply-tombstones.sh apply <tombstones.csv>}"
    docker compose exec -T timescaledb psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB" -c "
      CREATE TABLE IF NOT EXISTS deletion_tombstones_import (assessment_id uuid, entity text, device_id uuid, range_from timestamptz, range_to timestamptz, ref text, deleted_at timestamptz);
      TRUNCATE deletion_tombstones_import;"
    docker compose exec -T timescaledb psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB" \
      -c "\copy deletion_tombstones_import FROM STDIN WITH CSV HEADER" < "$file"
    "${PSQL[@]}" <<'SQL'
BEGIN;
-- Readings and derived rows inside every deleted range.
DELETE FROM meter_readings m USING deletion_tombstones_import t
 WHERE t.entity = 'meter_readings' AND m.meter_id = t.device_id AND m.time >= t.range_from AND m.time < t.range_to;
DELETE FROM pq_events e USING deletion_tombstones_import t
 WHERE t.entity = 'meter_readings' AND e.meter_id = t.device_id AND e.started_at >= t.range_from AND e.started_at < t.range_to;
DELETE FROM alerts a USING deletion_tombstones_import t
 WHERE t.entity = 'meter_readings' AND a.meter_id = t.device_id AND a.created_at >= t.range_from AND a.created_at < t.range_to;
DELETE FROM recommendations r USING deletion_tombstones_import t
 WHERE t.entity = 'meter_readings' AND r.meter_id = t.device_id AND r.created_at >= t.range_from AND r.created_at < t.range_to;
-- Report content, links, conversations; the assessments are purged and closed.
SET LOCAL gridiq.purge = 'on';
UPDATE reports SET dataset = NULL, pdf_path = NULL WHERE assessment_id IN (SELECT DISTINCT assessment_id FROM deletion_tombstones_import);
DELETE FROM delivery_links WHERE assessment_id IN (SELECT DISTINCT assessment_id FROM deletion_tombstones_import);
DELETE FROM ai_messages WHERE assessment_id IN (SELECT DISTINCT assessment_id FROM deletion_tombstones_import);
UPDATE assessments SET retention_status = 'purged', package_path = NULL
 WHERE id IN (SELECT DISTINCT assessment_id FROM deletion_tombstones_import);
INSERT INTO deletion_tombstones (assessment_id, entity, device_id, range_from, range_to, ref, deleted_at)
SELECT i.* FROM deletion_tombstones_import i
 WHERE NOT EXISTS (SELECT 1 FROM deletion_tombstones d WHERE d.assessment_id = i.assessment_id AND d.entity = i.entity
                   AND d.device_id IS NOT DISTINCT FROM i.device_id AND d.range_from IS NOT DISTINCT FROM i.range_from);
DROP TABLE deletion_tombstones_import;
COMMIT;
SQL
    echo "Tombstones applied. Refresh the aggregates over those ranges (packages/db refreshAggregates) and remove any"
    echo "report PDFs / package directories of purged assessments still present on disk before starting the services."
    ;;
  *)
    echo "usage: $0 export | apply <tombstones.csv>" >&2; exit 2 ;;
esac
