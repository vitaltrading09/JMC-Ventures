#!/usr/bin/env bash
# Grid-IQ database backup → S3-compatible object storage (Cloudflare R2, OCI
# Object Storage, AWS S3, ...). Replaces the old AWS-era backup scripts.
#
#   bash deploy/scripts/backup.sh          (daily from cron, see install-cron.sh)
#
# 1. pg_dump -Fc of the compose database to a temp file
# 2. verify it with pg_restore --list
# 3. upload to s3://$BACKUP_S3_BUCKET/$BACKUP_PREFIX/daily/  (aws cli, --endpoint-url)
#    and on Sundays to weekly/, on the 1st to monthly/ (SAST calendar)
# 4. retention: newest 7 daily, 4 weekly, 6 monthly
# 5. status: a line in ${DATA_DIR}/backups/backup.log, the timestamp file
#    ${DATA_DIR}/backups/last-success, and a backup_runs row (read by
#    /api/health/deep)
#
# Settings (.env): BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID,
# BACKUP_S3_SECRET_ACCESS_KEY, optional BACKUP_S3_REGION (auto) and
# BACKUP_PREFIX (gridiq). The S3 client is the pinned `awscli` compose service
# (profile "tools"), so nothing is installed on the host.
# -E: the ERR trap also fires inside functions.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"
export MSYS_NO_PATHCONV=1

env_value() { [ -f .env ] && grep -E "^${1}=" .env | tail -n1 | cut -d= -f2- || true; }
setting() { local v="${!1:-}"; [ -n "$v" ] && echo "$v" || env_value "$1"; }

DATA_DIR="$(setting DATA_DIR)"; DATA_DIR="${DATA_DIR:-./.data}"
PGUSER="$(setting POSTGRES_USER)"; PGDB="$(setting POSTGRES_DB)"
ENDPOINT="$(setting BACKUP_S3_ENDPOINT)"
BUCKET="$(setting BACKUP_S3_BUCKET)"
PREFIX="$(setting BACKUP_PREFIX)"; PREFIX="${PREFIX:-gridiq}"
KEEP_DAILY=7 KEEP_WEEKLY=4 KEEP_MONTHLY=6

BACKUP_DIR="$DATA_DIR/backups"
LOG="$BACKUP_DIR/backup.log"
mkdir -p "$BACKUP_DIR/tmp"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }
psql_db() { docker compose exec -T timescaledb psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -tA "$@"; }
s3() { docker compose run --rm --no-deps -T awscli --endpoint-url "$ENDPOINT" "$@"; }

for v in ENDPOINT BUCKET PGUSER PGDB; do
    if [ -z "${!v}" ]; then echo "backup: $v is not set (.env: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, POSTGRES_USER, POSTGRES_DB)" >&2; exit 1; fi
done

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
NAME="gridiq-$STAMP.dump"
TMP="$BACKUP_DIR/tmp/$NAME"
RUN_ID="$(psql_db -c "INSERT INTO backup_runs (message) VALUES ('started') RETURNING id" | head -n1 || true)"

fail() {
    local msg="$1"
    log "FAILED: $msg"
    if [ -n "$RUN_ID" ]; then
        psql_db -c "UPDATE backup_runs SET finished_at = NOW(), ok = false, message = \$\$${msg//\$/}\$\$ WHERE id = $RUN_ID" >/dev/null 2>&1 || true
    fi
    rm -f "$TMP"
    exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

# ── 1. Dump ────────────────────────────────────────────────────────────────
log "dump $PGDB → $NAME"
docker compose exec -T timescaledb pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$TMP" || fail "pg_dump failed"
BYTES="$(wc -c < "$TMP" | tr -d ' ')"
[ "$BYTES" -gt 1024 ] || fail "dump is only $BYTES bytes"

# ── 2. Verify ──────────────────────────────────────────────────────────────
docker compose cp "$TMP" timescaledb:/tmp/verify.dump >/dev/null
ENTRIES="$(docker compose exec -T timescaledb pg_restore --list /tmp/verify.dump | grep -vc '^;' || true)"
docker compose exec -T timescaledb rm -f /tmp/verify.dump
[ "${ENTRIES:-0}" -gt 10 ] || fail "pg_restore --list found only ${ENTRIES:-0} entries"
log "verified: $BYTES bytes, $ENTRIES archive entries"

# ── 3. Upload (daily; weekly on Sunday, monthly on the 1st, SAST calendar) ──
KEY="$PREFIX/daily/$NAME"
s3 s3 cp "/backups/tmp/$NAME" "s3://$BUCKET/$KEY" --only-show-errors || fail "upload to s3://$BUCKET/$KEY failed"
if [ "$(TZ=Africa/Johannesburg date +%u)" = 7 ]; then
    s3 s3 cp "s3://$BUCKET/$KEY" "s3://$BUCKET/$PREFIX/weekly/$NAME" --only-show-errors || fail "weekly copy failed"
fi
if [ "$(TZ=Africa/Johannesburg date +%d)" = 01 ]; then
    s3 s3 cp "s3://$BUCKET/$KEY" "s3://$BUCKET/$PREFIX/monthly/$NAME" --only-show-errors || fail "monthly copy failed"
fi
rm -f "$TMP"

# ── 4. Retention ───────────────────────────────────────────────────────────
prune() { # tier keep
    local tier="$1" keep="$2"
    # An empty tier (e.g. no weekly copy yet) lists nothing and exits 1: not an error.
    { s3 s3 ls "s3://$BUCKET/$PREFIX/$tier/" || true; } | awk '{print $4}' | { grep -E '^gridiq-.*\.dump$' || true; } | sort -r \
        | tail -n +"$((keep + 1))" | while read -r old; do
            s3 s3 rm "s3://$BUCKET/$PREFIX/$tier/$old" --only-show-errors && log "retention: removed $tier/$old"
        done
}
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"
prune monthly "$KEEP_MONTHLY"

# ── 5. Status ──────────────────────────────────────────────────────────────
trap - ERR
psql_db -c "UPDATE backup_runs SET finished_at = NOW(), ok = true, object_key = '$KEY', bytes = $BYTES, message = 'ok' WHERE id = $RUN_ID" >/dev/null
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-success"
log "OK s3://$BUCKET/$KEY ($BYTES bytes)"
