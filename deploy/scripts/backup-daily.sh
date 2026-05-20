#!/bin/bash
# PowerGuard — daily PostgreSQL backup to S3
# Cron (installed by setup-backups.sh): 0 2 * * * (02:00 UTC = 04:00 SAST)
# Config: /home/ubuntu/.backup-env
#   BACKUP_S3_BUCKET   required
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION  (if not using instance role)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/powerguard"
LOG="${LOG_DIR}/backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [BACKUP-DAILY] $1" | tee -a "$LOG"; }
err() { log "ERROR: $1"; exit 1; }

mkdir -p "$LOG_DIR"
touch "$LOG"

# Load credentials/config (optional — if using EC2 instance role, not needed)
[ -f /home/ubuntu/.backup-env ] && source /home/ubuntu/.backup-env

BUCKET="${BACKUP_S3_BUCKET:?Set BACKUP_S3_BUCKET in /home/ubuntu/.backup-env}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="powerguard_${TIMESTAMP}.dump"
TMP_FILE="/tmp/${BACKUP_NAME}"

log "════════════════════════════════════════"
log "Starting daily backup → s3://${BUCKET}/daily/${BACKUP_NAME}"

# ── 1. pg_dump via Docker (binary-safe with -T) ─────────────────────────────
# Custom format is already compressed (default level 6). No gzip wrapper needed.
if ! docker exec -T powerguard-db \
        pg_dump -U powerguard_user -d powerguard_db \
        --format=custom --compress=9 \
        > "$TMP_FILE" 2>>"$LOG"; then
    rm -f "$TMP_FILE"
    err "pg_dump failed — check container logs: docker logs powerguard-db"
fi

SIZE=$(du -sh "$TMP_FILE" | cut -f1)
log "Dump complete — size: ${SIZE}"

# ── 2. Upload to S3 ─────────────────────────────────────────────────────────
if ! aws s3 cp "$TMP_FILE" "s3://${BUCKET}/daily/${BACKUP_NAME}" \
        --storage-class STANDARD_IA \
        --only-show-errors 2>>"$LOG"; then
    rm -f "$TMP_FILE"
    err "S3 upload failed — check AWS credentials and bucket policy"
fi
log "Uploaded → s3://${BUCKET}/daily/${BACKUP_NAME}"

# ── 3. Cleanup local temp file ──────────────────────────────────────────────
rm -f "$TMP_FILE"

# ── 4. Prune daily backups older than 30 days ───────────────────────────────
log "Pruning S3 daily backups older than 30 days…"
PRUNED=0
while IFS= read -r line; do
    file_date=$(echo "$line" | awk '{print $1}')
    file_time=$(echo "$line" | awk '{print $2}')
    file_name=$(echo "$line" | awk '{print $4}')
    [ -z "$file_name" ] && continue

    file_epoch=$(date -d "${file_date} ${file_time}" +%s 2>/dev/null || echo 0)
    cutoff_epoch=$(date -d '30 days ago' +%s)

    if [ "$file_epoch" -lt "$cutoff_epoch" ]; then
        aws s3 rm "s3://${BUCKET}/daily/${file_name}" --only-show-errors 2>>"$LOG" && {
            log "  Pruned: ${file_name}"
            PRUNED=$((PRUNED + 1))
        }
    fi
done < <(aws s3 ls "s3://${BUCKET}/daily/" 2>>"$LOG" || true)

[ "$PRUNED" -eq 0 ] && log "  No old backups to prune" || log "  Pruned ${PRUNED} file(s)"

log "Daily backup complete ✓"
log "════════════════════════════════════════"
