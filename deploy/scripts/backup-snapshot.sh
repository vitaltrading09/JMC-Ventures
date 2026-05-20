#!/bin/bash
# Grid-IQ — weekly EBS snapshot (whole-disk, includes OS + Docker volumes)
# Cron (installed by setup-backups.sh): 0 3 * * 0 (Sunday 03:00 UTC = 05:00 SAST)
# Requires: ec2:CreateSnapshot, ec2:DescribeInstances, ec2:DescribeSnapshots,
#           ec2:DeleteSnapshot, ec2:CreateTags  (IAM policy: deploy/iam/backup-policy.json)

set -euo pipefail

LOG_DIR="/var/log/gridiq"
LOG="${LOG_DIR}/backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [BACKUP-SNAPSHOT] $1" | tee -a "$LOG"; }
err() { log "ERROR: $1"; exit 1; }

mkdir -p "$LOG_DIR"
touch "$LOG"

[ -f /home/ubuntu/.backup-env ] && source /home/ubuntu/.backup-env

# ── 1. Get instance metadata ─────────────────────────────────────────────────
log "════════════════════════════════════════"
log "Starting weekly EBS snapshot…"

INSTANCE_ID=$(curl -s --max-time 5 \
    http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
if [ -z "$INSTANCE_ID" ]; then
    err "Cannot determine EC2 instance ID — is this running on EC2?"
fi
log "Instance: $INSTANCE_ID"

# ── 2. Find root EBS volume ──────────────────────────────────────────────────
VOLUME_ID=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
    --output text 2>>"$LOG")

if [ -z "$VOLUME_ID" ] || [ "$VOLUME_ID" = "None" ]; then
    err "Cannot find root EBS volume for instance $INSTANCE_ID"
fi
log "Volume: $VOLUME_ID"

# ── 3. Create snapshot ───────────────────────────────────────────────────────
DATE_TAG=$(date +%Y-%m-%d)
SNAPSHOT_ID=$(aws ec2 create-snapshot \
    --volume-id "$VOLUME_ID" \
    --description "Grid-IQ weekly backup ${DATE_TAG}" \
    --tag-specifications \
        "ResourceType=snapshot,Tags=[{Key=Name,Value=gridiq-weekly-${DATE_TAG}},{Key=Project,Value=gridiq},{Key=Backup,Value=weekly}]" \
    --query 'SnapshotId' \
    --output text 2>>"$LOG")

if [ -z "$SNAPSHOT_ID" ] || [ "$SNAPSHOT_ID" = "None" ]; then
    err "Snapshot creation returned no ID"
fi
log "Snapshot initiated: $SNAPSHOT_ID (status: pending, completes in background)"

# ── 4. Prune weekly snapshots older than 90 days (keep ~12 weeks) ────────────
log "Pruning EBS snapshots older than 90 days…"
CUTOFF=$(date -d '90 days ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || \
         python3 -c "import datetime; print((datetime.datetime.utcnow()-datetime.timedelta(days=90)).strftime('%Y-%m-%dT%H:%M:%S'))")
PRUNED=0

while IFS= read -r old_snap; do
    [ -z "$old_snap" ] && continue
    aws ec2 delete-snapshot --snapshot-id "$old_snap" 2>>"$LOG" && {
        log "  Deleted old snapshot: $old_snap"
        PRUNED=$((PRUNED + 1))
    } || log "  WARNING: could not delete $old_snap (may already be deleted)"
done < <(aws ec2 describe-snapshots \
    --filters \
        "Name=tag:Project,Values=gridiq" \
        "Name=tag:Backup,Values=weekly" \
    --query "Snapshots[?StartTime<='${CUTOFF}'].SnapshotId" \
    --output text 2>>"$LOG" | tr '\t' '\n' || true)

[ "$PRUNED" -eq 0 ] && log "  No old snapshots to prune" || log "  Pruned ${PRUNED} snapshot(s)"

log "Weekly snapshot complete ✓"
log "════════════════════════════════════════"
