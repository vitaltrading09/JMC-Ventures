# PowerGuard — Backup System

## What runs

| Job | Schedule | Retention | What it backs up |
|---|---|---|---|
| `backup-daily.sh` | 02:00 UTC (04:00 SAST) | 30 days | PostgreSQL pg_dump (custom format, compressed) |
| `backup-snapshot.sh` | Sunday 03:00 UTC | 90 days | EBS volume snapshot (whole disk incl. Docker volumes) |

---

## One-time setup

### Step 1 — Create S3 bucket (AWS console or CLI)

```bash
# Cape Town region — keeps data in SA for POPIA
aws s3api create-bucket \
  --bucket powerguard-backups-prod \
  --region af-south-1 \
  --create-bucket-configuration LocationConstraint=af-south-1

# Block all public access
aws s3api put-public-access-block \
  --bucket powerguard-backups-prod \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Enable versioning (safety net for accidental deletes)
aws s3api put-bucket-versioning \
  --bucket powerguard-backups-prod \
  --versioning-configuration Status=Enabled
```

### Step 2 — Create IAM user + access key

1. Go to **IAM → Users → Create user**
2. Username: `powerguard-backup`
3. Attach the policy in `deploy/iam/backup-policy.json`
   - Replace `BUCKET_NAME` with `powerguard-backups-prod` before pasting
4. Create access key (type: "Application running outside AWS")
5. Save the **Access Key ID** and **Secret Access Key**

> **Alternative (recommended for EC2):** Instead of an IAM user, attach an IAM role to the EC2 instance.
> Create a role with the same policy and attach it via **EC2 → Instance → Actions → Security → Modify IAM role**.
> Then you do NOT need `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.backup-env`.

### Step 3 — Create credentials file on the server

SSH in and create `/home/ubuntu/.backup-env`:

```bash
ssh -i ~/Downloads/powerguard.pem ubuntu@35.179.107.189

nano /home/ubuntu/.backup-env
```

Contents:
```bash
BACKUP_S3_BUCKET=powerguard-backups-prod
AWS_DEFAULT_REGION=af-south-1
# Only needed if NOT using an EC2 instance role:
AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxxxxxxxx
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```bash
chmod 600 /home/ubuntu/.backup-env
```

### Step 4 — Run the setup script

```bash
cd ~/PowerGuard
sudo bash deploy/scripts/setup-backups.sh
```

This will:
- Install AWS CLI v2 (if missing)
- Register daily + weekly cron jobs
- Configure logrotate
- Run a first backup as smoke test

---

## Restore procedure

### From S3 (database only)

```bash
sudo bash ~/PowerGuard/deploy/scripts/backup-restore.sh
```

The script lists available backups and prompts for confirmation. Type `RESTORE` to proceed. Services are stopped during restore and restarted after.

To restore a specific file directly:
```bash
sudo bash ~/PowerGuard/deploy/scripts/backup-restore.sh powerguard_20250520_020000.dump
```

### From EBS snapshot (full server restore)

Use this when the instance itself is unrecoverable (disk failure, accidental termination):

1. Go to **EC2 → Snapshots** in AWS console
2. Find the most recent `powerguard-weekly-*` snapshot
3. **Actions → Create volume** (same AZ as your instance)
4. Detach the failed root volume and attach the restored one, OR launch a new instance from the snapshot:
   - **Actions → Create image from snapshot** → **Launch instance**

---

## Monitoring

```bash
# Watch backup log live
tail -f /var/log/powerguard/backup.log

# Check last backup time
grep "backup complete" /var/log/powerguard/backup.log | tail -5

# List S3 backups
source /home/ubuntu/.backup-env
aws s3 ls s3://$BACKUP_S3_BUCKET/daily/ | sort -r | head -10

# List EBS snapshots
aws ec2 describe-snapshots \
  --filters "Name=tag:Project,Values=powerguard" \
  --query 'Snapshots[*].[SnapshotId,StartTime,State,Description]' \
  --output table
```

---

## Quarterly restore drill

Run the restore script against a **test** Postgres container to verify backup integrity:

```bash
# 1. Download latest backup
source /home/ubuntu/.backup-env
LATEST=$(aws s3 ls s3://$BACKUP_S3_BUCKET/daily/ | sort -r | head -1 | awk '{print $4}')
aws s3 cp "s3://$BACKUP_S3_BUCKET/daily/$LATEST" /tmp/drill_restore.dump

# 2. Spin up isolated test container
docker run -d --name pg_drill \
  -e POSTGRES_USER=powerguard_user \
  -e POSTGRES_PASSWORD=powerguard_password \
  -e POSTGRES_DB=powerguard_db \
  timescale/timescaledb:latest-pg15

sleep 5  # let it initialise

# 3. Restore into test container
docker cp /tmp/drill_restore.dump pg_drill:/tmp/restore.dump
docker exec pg_drill pg_restore -U powerguard_user -d powerguard_db \
  --no-owner --no-acl /tmp/restore.dump

# 4. Spot-check
docker exec pg_drill psql -U powerguard_user -d powerguard_db \
  -c "SELECT COUNT(*) FROM meter_readings; SELECT MAX(time) FROM meter_readings;"

# 5. Cleanup
docker rm -f pg_drill
rm -f /tmp/drill_restore.dump

echo "Drill complete ✓"
```
