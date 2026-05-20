#!/bin/bash
# PowerGuard — one-time backup system setup
# Run: sudo bash deploy/scripts/setup-backups.sh
#
# What this does:
#   1. Installs AWS CLI v2 if missing
#   2. Creates /var/log/powerguard/backup.log
#   3. Makes backup scripts executable
#   4. Installs cron jobs (daily pg_dump 02:00 UTC, weekly snapshot Sunday 03:00 UTC)
#   5. Configures logrotate
#   6. Runs a smoke-test backup (if credentials are present)

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="/var/log/powerguard"
LOG="${LOG_DIR}/backup.log"

echo ""
echo "════════════════════════════════════════════════════"
echo "  PowerGuard Backup System Setup"
echo "════════════════════════════════════════════════════"
echo ""

# ── 1. Install AWS CLI v2 ────────────────────────────────────────────────────
echo "▶ Checking AWS CLI…"
if command -v aws >/dev/null 2>&1; then
    echo "  ✓ AWS CLI already installed: $(aws --version 2>&1 | head -1)"
else
    echo "  → Downloading AWS CLI v2…"
    TMP_DIR=$(mktemp -d)
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "${TMP_DIR}/awscliv2.zip"
    unzip -q "${TMP_DIR}/awscliv2.zip" -d "${TMP_DIR}/"
    "${TMP_DIR}/aws/install"
    rm -rf "$TMP_DIR"
    echo "  ✓ AWS CLI installed: $(aws --version 2>&1 | head -1)"
fi

# ── 2. Create log directory ──────────────────────────────────────────────────
echo ""
echo "▶ Creating log directory…"
mkdir -p "$LOG_DIR"
touch "$LOG"
chmod 640 "$LOG"
echo "  ✓ ${LOG}"

# ── 3. Make scripts executable ───────────────────────────────────────────────
echo ""
echo "▶ Setting script permissions…"
chmod +x "${SCRIPT_DIR}/backup-daily.sh"
chmod +x "${SCRIPT_DIR}/backup-snapshot.sh"
chmod +x "${SCRIPT_DIR}/backup-restore.sh"
echo "  ✓ backup-daily.sh, backup-snapshot.sh, backup-restore.sh"

# ── 4. Check credentials file ────────────────────────────────────────────────
echo ""
echo "▶ Checking /home/ubuntu/.backup-env…"
CREDS_OK=false

if [ ! -f /home/ubuntu/.backup-env ]; then
    echo ""
    echo "  ✗ /home/ubuntu/.backup-env not found."
    echo ""
    echo "  Create it now:"
    echo "    nano /home/ubuntu/.backup-env"
    echo ""
    echo "  Required contents:"
    echo "    BACKUP_S3_BUCKET=powerguard-backups-prod"
    echo "    AWS_DEFAULT_REGION=af-south-1"
    echo ""
    echo "  If NOT using an EC2 instance role, also add:"
    echo "    AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxxxxxxxx"
    echo "    AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    echo ""
    echo "  See deploy/README-BACKUPS.md for S3 bucket + IAM setup instructions."
else
    source /home/ubuntu/.backup-env
    chmod 600 /home/ubuntu/.backup-env

    if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
        echo "  ✗ BACKUP_S3_BUCKET not set in .backup-env"
    else
        echo "  ✓ Credentials file found (chmod 600)"
        echo "  → Testing S3 access to s3://${BACKUP_S3_BUCKET}…"
        if aws s3 ls "s3://${BACKUP_S3_BUCKET}" >/dev/null 2>&1; then
            echo "  ✓ S3 bucket accessible"
            CREDS_OK=true
        else
            echo "  ✗ Cannot access s3://${BACKUP_S3_BUCKET}"
            echo "    Check: bucket name, region, IAM permissions"
            echo "    IAM policy template: ${REPO_ROOT}/deploy/iam/backup-policy.json"
        fi
    fi
fi

# ── 5. Install cron jobs ─────────────────────────────────────────────────────
echo ""
echo "▶ Installing backup cron jobs (root crontab)…"

DAILY_JOB="0 2 * * * root ${SCRIPT_DIR}/backup-daily.sh >> ${LOG} 2>&1"
SNAPSHOT_JOB="0 3 * * 0 root ${SCRIPT_DIR}/backup-snapshot.sh >> ${LOG} 2>&1"

EXISTING_CRON="$(crontab -l 2>/dev/null || true)"
FILTERED="$(echo "$EXISTING_CRON" | grep -vE "backup-(daily|snapshot)" || true)"
{
    [ -n "$FILTERED" ] && echo "$FILTERED"
    echo "$DAILY_JOB"
    echo "$SNAPSHOT_JOB"
} | crontab -

echo "  ✓ Daily pg_dump:    every day at 02:00 UTC (04:00 SAST)"
echo "  ✓ Weekly snapshot:  every Sunday at 03:00 UTC (05:00 SAST)"

# ── 6. Logrotate ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Configuring logrotate…"
cat > /etc/logrotate.d/powerguard-backup <<EOF
${LOG} {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 640 root root
}
EOF
echo "  ✓ 30-day log retention for ${LOG}"

# ── 7. Smoke-test backup ─────────────────────────────────────────────────────
echo ""
if [ "$CREDS_OK" = "true" ]; then
    echo "▶ Running first backup now (smoke test)…"
    if bash "${SCRIPT_DIR}/backup-daily.sh"; then
        echo "  ✓ First backup succeeded — verify in S3 console"
    else
        echo "  ✗ First backup failed — check ${LOG}"
    fi
else
    echo "▶ Skipping smoke test (no valid credentials yet)"
    echo "  Once .backup-env is configured, re-run this script or run manually:"
    echo "    sudo bash ${SCRIPT_DIR}/backup-daily.sh"
fi

# ── 8. Summary ───────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  ✅ Backup system installed"
echo "════════════════════════════════════════════════════"
echo ""
cat <<EOF
Cron schedule (UTC):
  Daily  pg_dump    → 02:00 every day
  Weekly EBS snap   → 03:00 every Sunday

Retention:
  Daily S3 dumps    → 30 days (auto-pruned by backup-daily.sh)
  Weekly snapshots  → 90 days (~12 weeks, auto-pruned by backup-snapshot.sh)

Useful commands:
  sudo bash ${SCRIPT_DIR}/backup-daily.sh        # run backup now
  tail -f ${LOG}                                 # watch backup log
  sudo bash ${SCRIPT_DIR}/backup-restore.sh      # restore from S3

Setup guide:
  ${REPO_ROOT}/deploy/README-BACKUPS.md
EOF
