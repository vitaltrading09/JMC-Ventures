#!/bin/bash
# Grid-IQ production setup — switches services from `nohup &` to systemd.
# Idempotent: safe to run multiple times.
#
# Run from anywhere on the server:  sudo bash /home/ubuntu/Grid-IQ/deploy/legacy-aws/scripts/install.sh

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $0"
    exit 1
fi

# Resolve repo root (script lives at deploy/legacy-aws/scripts/install.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSTEMD_SRC="$REPO_ROOT/deploy/legacy-aws/systemd"
HEALTHCHECK="$REPO_ROOT/deploy/legacy-aws/scripts/healthcheck.sh"
HEALTHCHECK_LOG="/var/log/gridiq-healthcheck.log"

echo "════════════════════════════════════════════════════"
echo "  Grid-IQ systemd setup"
echo "════════════════════════════════════════════════════"
echo "  Repo:          $REPO_ROOT"
echo "  systemd src:   $SYSTEMD_SRC"
echo "  Healthcheck:   $HEALTHCHECK"
echo ""

# ── 1. Sanity checks ───────────────────────────────────────────────────────
echo "▶ Sanity checks…"

for envfile in \
    "$REPO_ROOT/services/auth-service/.env" \
    "$REPO_ROOT/services/ingestion-service/.env" \
    "$REPO_ROOT/services/api-gateway/.env"; do
    if [ ! -f "$envfile" ]; then
        echo "  ✗ Missing: $envfile"
        echo ""
        echo "    Create it before continuing — see CLAUDE.md for required vars."
        echo "    JWT_SECRET MUST be identical across all three .env files."
        exit 1
    fi
done
echo "  ✓ All .env files present"

if ! command -v docker >/dev/null; then
    echo "  ✗ Docker not installed"; exit 1
fi
echo "  ✓ Docker available"

if ! command -v node >/dev/null; then
    echo "  ✗ Node.js not installed"; exit 1
fi
echo "  ✓ Node $(node -v) available"

# ── 2. Stop legacy supervisors (nohup, PM2) ────────────────────────────────
echo ""
echo "▶ Stopping any legacy supervisors…"

# PM2 — previously used to supervise these services. We're replacing it with
# systemd, so stop everything PM2 was managing and disable its boot startup.
if command -v pm2 >/dev/null 2>&1; then
    if sudo -u ubuntu pm2 list 2>/dev/null | grep -qE "^│ *[0-9]+ *│"; then
        echo "  → PM2 detected with active apps — stopping and removing…"
        sudo -u ubuntu pm2 stop all 2>/dev/null || true
        sudo -u ubuntu pm2 delete all 2>/dev/null || true
    fi
    # Remove pm2-ubuntu.service if PM2 had registered itself as a system supervisor
    if systemctl list-unit-files 2>/dev/null | grep -q "^pm2-ubuntu.service"; then
        pm2 unstartup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true
    fi
    sudo -u ubuntu pm2 kill 2>/dev/null || true
    echo "  ✓ PM2 retired"
fi

# Legacy nohup processes (compiled dist/ or tsx source)
pkill -f "npx tsx services/" 2>/dev/null || true
pkill -f "Grid-IQ/services" 2>/dev/null || true
pkill -f "next-server"       2>/dev/null || true
pkill -f "next start"        2>/dev/null || true
sleep 2
echo "  ✓ Legacy processes stopped"

# ── 3. Ensure Docker infrastructure is up ──────────────────────────────────
echo ""
echo "▶ Bringing up Docker infrastructure (TimescaleDB, Redis, Mosquitto)…"
cd "$REPO_ROOT"
docker compose --project-directory "$REPO_ROOT" -f "$REPO_ROOT/deploy/legacy-aws/docker-compose.legacy.yml" up -d
sleep 3
echo "  ✓ Docker services running"

# ── 4. Build Next.js frontend (must exist for systemd web service) ─────────
echo ""
# NEXT_PUBLIC_API_URL is baked into the bundle at build time. It used to come
# from a committed apps/web/.env.production (now removed); on this box put it in
# apps/web/.env.production.local (gitignored) or export it before running.
if [ -z "${NEXT_PUBLIC_API_URL:-}" ] && ! grep -qs '^NEXT_PUBLIC_API_URL=' "$REPO_ROOT/apps/web/.env.production.local"; then
    echo "✗ NEXT_PUBLIC_API_URL is not set. Create apps/web/.env.production.local with:"
    echo "    NEXT_PUBLIC_API_URL=http://<server-ip>:8081"
    exit 1
fi
echo "▶ Building Next.js frontend (this can take a minute)…"
sudo -u ubuntu bash -lc "cd '$REPO_ROOT/apps/web' && npm run build"
echo "  ✓ Frontend built (.next/ ready)"

# ── 5. Install systemd unit files ──────────────────────────────────────────
echo ""
echo "▶ Installing systemd unit files…"
for unit in "$SYSTEMD_SRC"/*.service; do
    name="$(basename "$unit")"
    cp "$unit" "/etc/systemd/system/$name"
    echo "  ✓ $name"
done

systemctl daemon-reload
echo "  ✓ systemd daemon reloaded"

# ── 6. Enable + (re)start all services ─────────────────────────────────────
echo ""
echo "▶ Enabling and starting services…"
for svc in powerguard-auth powerguard-ingestion powerguard-gateway powerguard-web; do
    systemctl enable "$svc" >/dev/null 2>&1
    systemctl restart "$svc"
    echo "  ✓ $svc"
done

# ── 7. Install healthcheck cron (under root so it can systemctl restart) ──
echo ""
echo "▶ Installing healthcheck cron…"
chmod +x "$HEALTHCHECK"
touch "$HEALTHCHECK_LOG"
chmod 644 "$HEALTHCHECK_LOG"

# Add line to root's crontab if not already present.
# Subshell + `|| true` is essential: grep returns 1 when nothing matches
# (which trips `set -e`), and `crontab -l` returns 1 on an empty crontab.
CRON_LINE="* * * * * $HEALTHCHECK >> $HEALTHCHECK_LOG 2>&1"
EXISTING_CRON="$(crontab -l 2>/dev/null || true)"
FILTERED="$(echo "$EXISTING_CRON" | grep -vF "gridiq" || true)"
{
    [ -n "$FILTERED" ] && echo "$FILTERED"
    echo "$CRON_LINE"
} | crontab -
echo "  ✓ Cron installed: runs every minute, logs to $HEALTHCHECK_LOG"

# ── 8. Logrotate for the healthcheck log ──────────────────────────────────
cat > /etc/logrotate.d/gridiq-healthcheck <<EOF
$HEALTHCHECK_LOG {
    daily
    rotate 14
    compress
    missingok
    notifempty
    create 644 root root
}
EOF
echo "  ✓ Logrotate configured (14-day retention)"

# ── 9. Status summary ──────────────────────────────────────────────────────
echo ""
echo "▶ Waiting 8s for services to come up…"
sleep 8

echo ""
echo "════════════════════════════════════════════════════"
echo "  Service Status"
echo "════════════════════════════════════════════════════"
bash "$REPO_ROOT/deploy/legacy-aws/scripts/status.sh"

echo ""
echo "════════════════════════════════════════════════════"
echo "  ✅ Setup complete"
echo "════════════════════════════════════════════════════"
cat <<EOF

Useful commands:
  bash $REPO_ROOT/deploy/legacy-aws/scripts/status.sh          # one-glance health
  bash $REPO_ROOT/deploy/legacy-aws/scripts/logs.sh ingestion  # tail any service
  sudo systemctl restart powerguard-ingestion      # manual restart
  sudo tail -f $HEALTHCHECK_LOG                    # see healthcheck activity

After a git pull:
  bash $REPO_ROOT/deploy/legacy-aws/scripts/redeploy.sh       # rebuild web + restart services
EOF
