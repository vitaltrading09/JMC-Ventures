#!/bin/bash
# Grid-IQ — restore from S3 backup (disaster recovery / quarterly drill)
# Usage: sudo bash deploy/scripts/backup-restore.sh [BACKUP_FILENAME]
#   BACKUP_FILENAME — optional, e.g. gridiq_20250520_020000.dump
#   If omitted, lists the 20 most recent backups and prompts for selection.
#
# ⚠️  This replaces the LIVE database. Services are stopped during restore.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/gridiq"
LOG="${LOG_DIR}/backup.log"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [RESTORE] $1" | tee -a "$LOG"; }
err()  { log "ERROR: $1"; exit 1; }
info() { echo "  $1"; }

mkdir -p "$LOG_DIR"
touch "$LOG"

if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $0 ${1:-}"
    exit 1
fi

[ -f /home/ubuntu/.backup-env ] && source /home/ubuntu/.backup-env
BUCKET="${BACKUP_S3_BUCKET:?Set BACKUP_S3_BUCKET in /home/ubuntu/.backup-env}"

echo ""
echo "════════════════════════════════════════════════════"
echo "  Grid-IQ — Restore from S3 Backup"
echo "════════════════════════════════════════════════════"
echo ""
echo "  ⚠️  WARNING: This will REPLACE the current database."
echo "     All data not yet in this backup will be lost."
echo ""

# ── 1. Resolve backup filename ───────────────────────────────────────────────
if [ -n "${1:-}" ]; then
    BACKUP_FILE="$1"
else
    echo "  Available daily backups (most recent first):"
    aws s3 ls "s3://${BUCKET}/daily/" 2>/dev/null | sort -r | head -20 | \
        awk '{printf "    %-50s  %s %s  %s\n", $4, $1, $2, $3}'
    echo ""
    read -rp "  Enter backup filename: " BACKUP_FILE
fi

[ -z "$BACKUP_FILE" ] && err "No backup file specified"

TMP_RESTORE="/tmp/pg_restore_${BACKUP_FILE}"

# ── 2. Download from S3 ──────────────────────────────────────────────────────
echo ""
echo "  Downloading s3://${BUCKET}/daily/${BACKUP_FILE}…"
if ! aws s3 cp "s3://${BUCKET}/daily/${BACKUP_FILE}" "$TMP_RESTORE" 2>>"$LOG"; then
    err "Download failed — check S3 path: s3://${BUCKET}/daily/${BACKUP_FILE}"
fi
info "Downloaded: $(du -sh "$TMP_RESTORE" | cut -f1)"

# ── 3. Final confirmation ────────────────────────────────────────────────────
echo ""
echo "  ┌──────────────────────────────────────────────┐"
echo "  │  About to restore: ${BACKUP_FILE}"
echo "  │  This will DROP and recreate powerguard_db"
echo "  │  All services will be stopped during restore"
echo "  └──────────────────────────────────────────────┘"
echo ""
read -rp "  Type RESTORE to confirm: " CONFIRM
if [ "$CONFIRM" != "RESTORE" ]; then
    echo ""
    echo "  Aborted. No changes made."
    rm -f "$TMP_RESTORE"
    exit 0
fi

log "Restore confirmed: ${BACKUP_FILE}"

# ── 4. Stop services ─────────────────────────────────────────────────────────
echo ""
echo "  Stopping services…"
for svc in powerguard-web powerguard-gateway powerguard-auth powerguard-ingestion; do
    systemctl stop "$svc" 2>/dev/null && info "Stopped: $svc" || info "Already stopped: $svc"
done

# ── 5. Terminate existing DB connections ─────────────────────────────────────
echo ""
echo "  Terminating active DB connections…"
docker exec -T powerguard-db psql -U powerguard_user -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='powerguard_db' AND pid <> pg_backend_pid();" \
    >/dev/null 2>>"$LOG" || true

# ── 6. Drop and recreate database ───────────────────────────────────────────
echo "  Dropping powerguard_db…"
docker exec -T powerguard-db dropdb -U powerguard_user --if-exists powerguard_db 2>>"$LOG" || \
    err "dropdb failed — kill remaining connections and retry"

echo "  Creating fresh powerguard_db…"
docker exec -T powerguard-db createdb -U powerguard_user powerguard_db 2>>"$LOG" || \
    err "createdb failed"

# ── 7. Restore ───────────────────────────────────────────────────────────────
echo "  Restoring data (this may take a minute)…"
docker cp "$TMP_RESTORE" powerguard-db:/tmp/pg_restore.dump
docker exec -T powerguard-db \
    pg_restore -U powerguard_user -d powerguard_db \
    --no-owner --no-acl --role=powerguard_user \
    /tmp/pg_restore.dump 2>>"$LOG" || {
    # pg_restore exits non-zero for warnings (e.g. missing extensions) — warn but continue
    echo "  ⚠  pg_restore returned non-zero (check log for warnings): $LOG"
}
docker exec -T powerguard-db rm -f /tmp/pg_restore.dump
rm -f "$TMP_RESTORE"
info "Data restored"

# ── 8. Restart services ──────────────────────────────────────────────────────
echo ""
echo "  Restarting services…"
for svc in powerguard-auth powerguard-ingestion powerguard-gateway powerguard-web; do
    systemctl start "$svc" && info "Started: $svc" || info "WARNING: failed to start $svc"
done

log "Restore complete: ${BACKUP_FILE}"

echo ""
echo "════════════════════════════════════════════════════"
echo "  ✅ Restore complete"
echo "════════════════════════════════════════════════════"
echo ""
echo "  Verify the app at http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo 'SERVER_IP'):3000"
echo "  Tail logs:  bash $SCRIPT_DIR/../scripts/logs.sh ingestion"
echo "  Backup log: tail -f $LOG"
echo ""
