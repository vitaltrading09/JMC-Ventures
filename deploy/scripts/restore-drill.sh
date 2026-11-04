#!/usr/bin/env bash
# Weekly restore drill: proves the latest backup restores. A backup that has
# never been restored is not a backup.
#
#   bash deploy/scripts/restore-drill.sh            (Sundays from cron)
#
# Downloads the newest daily backup, restores it into a THROWAWAY TimescaleDB
# container (same image as the stack, no volume, no ports, removed afterwards)
# with timescaledb_pre_restore() / timescaledb_post_restore(), and prints row
# counts for the key tables next to the live database's. It never touches the
# live database except to read counts.
#
# Passes when the restore completes, every key table is present, and the
# restored meter_readings holds at least 99 % of the live rows older than the
# backup (late store-and-forward backfill can add old rows after a dump).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"
export MSYS_NO_PATHCONV=1

env_value() { [ -f .env ] && grep -E "^${1}=" .env | tail -n1 | cut -d= -f2- || true; }
setting() { local v="${!1:-}"; [ -n "$v" ] && echo "$v" || env_value "$1"; }

DATA_DIR="$(setting DATA_DIR)"; DATA_DIR="${DATA_DIR:-./.data}"
PGUSER="$(setting POSTGRES_USER)"; PGDB="$(setting POSTGRES_DB)"
ENDPOINT="$(setting BACKUP_S3_ENDPOINT)"; BUCKET="$(setting BACKUP_S3_BUCKET)"
PREFIX="$(setting BACKUP_PREFIX)"; PREFIX="${PREFIX:-gridiq}"
# Private age key for encrypted backups (root-only on the server).
IDENTITY="$(setting BACKUP_AGE_IDENTITY_FILE)"; IDENTITY="${IDENTITY:-/etc/gridiq/backup-age.key}"
BACKUP_DIR="$DATA_DIR/backups"; LOG="$BACKUP_DIR/restore-drill.log"
mkdir -p "$BACKUP_DIR/drill"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }
s3() { docker compose run --rm --no-deps -T awscli --endpoint-url "$ENDPOINT" "$@"; }
live() { docker compose exec -T timescaledb psql -X -U "$PGUSER" -d "$PGDB" -tA -c "$1"; }

C="gridiq-restore-drill-$$"
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -f "$BACKUP_DIR/drill/"*.dump; }
trap cleanup EXIT
# (cleanup also removes decrypted copies: *.dump)

# ── Latest backup ──────────────────────────────────────────────────────────
LATEST="$({ s3 s3 ls "s3://$BUCKET/$PREFIX/daily/" || true; } | awk '{print $4}' | { grep -E '^gridiq-.*\.dump(\.age)?$' || true; } | sort | tail -n1)"
[ -n "$LATEST" ] || { log "FAILED: no backups under s3://$BUCKET/$PREFIX/daily/"; exit 1; }
log "drill: $LATEST"
s3 s3 cp "s3://$BUCKET/$PREFIX/daily/$LATEST" "/backups/drill/$LATEST" --only-show-errors
if [[ "$LATEST" == *.age ]]; then
    [ -r "$IDENTITY" ] || { log "FAILED: $LATEST is encrypted and the key $IDENTITY is not readable (run as root?)"; exit 1; }
    # Mount the key's directory read-only and name the file inside it. Under
    # Git Bash the host path must be in Windows form for Docker (cygpath).
    KEY_DIR="$(cd "$(dirname "$IDENTITY")" && pwd)"
    command -v cygpath >/dev/null 2>&1 && KEY_DIR="$(cygpath -m "$KEY_DIR")"
    docker compose run --rm --no-deps -T -v "$KEY_DIR:/keys:ro" age \
        -d -i "/keys/$(basename "$IDENTITY")" -o "/backups/drill/${LATEST%.age}" "/backups/drill/$LATEST" \
        || { log "FAILED: could not decrypt $LATEST with $IDENTITY"; exit 1; }
    rm -f "$BACKUP_DIR/drill/$LATEST"
    LATEST="${LATEST%.age}"
    log "decrypted with $IDENTITY"
fi

# Backup start time, from the name gridiq-YYYY-MM-DDTHHMMSSZ.dump
STAMP="$(echo "$LATEST" | sed -E 's/^gridiq-([0-9-]+)T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump$/\1 \2:\3:\4+00/')"

# ── Throwaway database, same image as the stack ────────────────────────────
IMAGE="$(docker compose config --images | grep -m1 'timescale/timescaledb')"
# Same role name as the live database: TimescaleDB's job table (compression and
# aggregate-refresh policies) records its owner and does not restore without it.
docker run -d --name "$C" -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="drill-$$" -e POSTGRES_DB=drill "$IMAGE" >/dev/null
# Wait for the image's init to finish (it restarts the server once).
for i in $(seq 1 60); do
    if docker logs "$C" 2>&1 | grep -q "PostgreSQL init process complete" \
       && docker exec "$C" pg_isready -U "$PGUSER" -d drill >/dev/null 2>&1; then break; fi
    sleep 2
done
drill() { docker exec -i "$C" psql -X -U "$PGUSER" -d drill -v ON_ERROR_STOP=1 -tA "$@"; }
drill -c "SELECT timescaledb_pre_restore()" >/dev/null

docker cp "$BACKUP_DIR/drill/$LATEST" "$C:/tmp/drill.dump"
set +e
docker exec "$C" pg_restore -U "$PGUSER" -d drill --no-owner /tmp/drill.dump > "$BACKUP_DIR/drill/pg_restore.out" 2>&1
RESTORE_RC=$?
set -e
drill -c "SELECT timescaledb_post_restore()" >/dev/null
RESTORE_ERRORS="$(grep -c 'error:' "$BACKUP_DIR/drill/pg_restore.out" || true)"

# ── Row counts ─────────────────────────────────────────────────────────────
TABLES="tenants sites meters users meter_readings alerts recommendations pq_events pgmigrations"
printf '%-18s %14s %14s\n' table restored live | tee -a "$LOG"
OK=1
for t in $TABLES; do
    R="$(drill -c "SELECT count(*) FROM $t" 2>/dev/null || echo MISSING)"
    L="$(live "SELECT count(*) FROM $t" 2>/dev/null || echo '?')"
    printf '%-18s %14s %14s\n' "$t" "$R" "$L" | tee -a "$LOG"
    [ "$R" = MISSING ] && OK=0
done
# Retention and aggregate policies came back with the data.
RJ="$(drill -c "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name IN ('policy_compression', 'policy_refresh_continuous_aggregate')")"
LJ="$(live "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name IN ('policy_compression', 'policy_refresh_continuous_aggregate')")"
printf '%-18s %14s %14s
' "policy jobs" "$RJ" "$LJ" | tee -a "$LOG"
[ "$RJ" = "$LJ" ] || OK=0
R_OLD="$(drill -c "SELECT count(*) FROM meter_readings")"
L_OLD="$(live "SELECT count(*) FROM meter_readings WHERE time < '$STAMP'::timestamptz")"
log "meter_readings older than the backup: restored $R_OLD, live $L_OLD"
if [ "$L_OLD" -gt 0 ] && [ "$((R_OLD * 100))" -lt "$((L_OLD * 99))" ]; then OK=0; fi
log "pg_restore exit $RESTORE_RC, $RESTORE_ERRORS error line(s) (TimescaleDB catalog warnings are normal)"

if [ "$OK" = 1 ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-drill"
    log "OK restore drill passed for $LATEST"
else
    log "FAILED restore drill for $LATEST (see $BACKUP_DIR/drill/pg_restore.out)"
    cp "$BACKUP_DIR/drill/pg_restore.out" "$BACKUP_DIR/drill/last-failure.out" 2>/dev/null || true
    exit 1
fi
