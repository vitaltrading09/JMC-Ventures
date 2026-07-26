#!/usr/bin/env bash
#
# Grid-IQ database backup.
#
# Every figure the product sells — "monitored since May", the trend lines, the
# degradation forecast, the value ledger — is derived from meter_readings. That
# history cannot be re-collected. Losing it does not just lose data, it removes
# the argument that continuous monitoring is worth more than a one-off survey.
#
# Run from cron:
#   0 2 * * * /home/ubuntu/PowerGuard/deploy/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1
#
# Restore:
#   gunzip -c powerguard-YYYYMMDD-HHMMSS.dump.gz > /tmp/r.dump
#   sudo docker cp /tmp/r.dump powerguard-db:/tmp/r.dump
#   sudo docker exec powerguard-db pg_restore -U powerguard_user -d powerguard_db --clean --if-exists /tmp/r.dump
#
set -euo pipefail

CONTAINER="${PG_CONTAINER:-powerguard-db}"
DB_NAME="${PG_DB:-powerguard_db}"
DB_USER="${PG_USER:-powerguard_user}"
ROOT="${BACKUP_ROOT:-/home/ubuntu/backups/db}"

KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-5}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"

# Refuse to run if the disk is nearly full — a backup that fills the disk takes
# the database down with it, which is worse than having no backup today.
MIN_FREE_MB="${MIN_FREE_MB:-2048}"

TS="$(date -u +%Y%m%d-%H%M%S)"
DOW="$(date -u +%u)"   # 7 = Sunday
DOM="$(date -u +%d)"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FAILED: $*"; exit 1; }

mkdir -p "$ROOT"/{daily,weekly,monthly}

# Never let two runs overlap; a long dump plus a cron tick would otherwise
# compete for the same connection and disk.
exec 9>"$ROOT/.lock"
flock -n 9 || die "another backup is already running"

FREE_MB=$(df -Pm "$ROOT" | awk 'NR==2 {print $4}')
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || die "only ${FREE_MB}MB free, need ${MIN_FREE_MB}MB"

command -v docker >/dev/null 2>&1 || die "docker not found"
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || die "container '$CONTAINER' is not running"

OUT="$ROOT/daily/powerguard-${TS}.dump.gz"
TMP="${OUT}.partial"

log "starting dump of ${DB_NAME}"

# -Fc (custom format) rather than plain SQL: it supports selective and parallel
# restore, which matters when the thing you need back is one table at 3am.
# Piped straight out of the container so nothing large lands inside it.
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" 2>/tmp/pgdump.err | gzip -9 > "$TMP"; then
    rm -f "$TMP"
    die "pg_dump failed: $(tail -3 /tmp/pgdump.err 2>/dev/null || echo 'no detail')"
fi

# A dump nobody has verified is a guess. Two checks, because they catch
# different failures.
#
# 1. gzip -t reads the whole stream and checks its CRC and length trailer, so a
#    dump truncated by a full disk or a killed process is caught here.
if ! gzip -t "$TMP" 2>/dev/null; then
    rm -f "$TMP"
    die "compressed stream is incomplete or corrupt — treating as no backup"
fi

# 2. pg_restore --list proves the archive's table of contents actually parses.
#    pipefail must be off for this one: pg_restore reads the header and exits
#    without draining the stream, so gunzip takes SIGPIPE and reports 141. That
#    is expected, and only pg_restore's own status is meaningful here.
set +o pipefail
gunzip -c "$TMP" 2>/dev/null | docker exec -i "$CONTAINER" pg_restore --list >/dev/null 2>/tmp/pgverify.err
VERIFY_RC=$?
set -o pipefail
if [ "$VERIFY_RC" -ne 0 ]; then
    rm -f "$TMP"
    die "archive did not parse: $(tail -2 /tmp/pgverify.err 2>/dev/null || echo 'no detail')"
fi

mv "$TMP" "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
log "verified ${OUT} (${SIZE})"

# Promote copies rather than moving them: a weekly must not disappear when the
# daily retention window rolls past it.
[ "$DOW" = "7" ]  && { cp -f "$OUT" "$ROOT/weekly/";  log "promoted to weekly"; }
[ "$DOM" = "01" ] && { cp -f "$OUT" "$ROOT/monthly/"; log "promoted to monthly"; }

prune() {
    local dir="$1" keep="$2" removed=0
    # shellcheck disable=SC2012
    while IFS= read -r f; do
        rm -f "$f"; removed=$((removed + 1))
    done < <(ls -1t "$dir"/*.dump.gz 2>/dev/null | tail -n +$((keep + 1)))
    [ "$removed" -gt 0 ] && log "pruned ${removed} from $(basename "$dir")"
    return 0
}

prune "$ROOT/daily"   "$KEEP_DAILY"
prune "$ROOT/weekly"  "$KEEP_WEEKLY"
prune "$ROOT/monthly" "$KEEP_MONTHLY"

log "done — total backup store: $(du -sh "$ROOT" | cut -f1), disk free: $(df -Ph "$ROOT" | awk 'NR==2 {print $4}')"

# OFFSITE: local copies do not survive loss of the instance. When AWS
# credentials are available, add here (and drop KEEP_* accordingly):
#   aws s3 cp "$OUT" "s3://<bucket>/db/" --storage-class STANDARD_IA
