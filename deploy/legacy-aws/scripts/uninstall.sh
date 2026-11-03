#!/bin/bash
# Roll back the systemd setup — stops services, removes units, removes cron.
# Run: sudo bash deploy/legacy-aws/scripts/uninstall.sh
# After uninstall, you can fall back to `bash deploy/legacy-aws/start.sh` (legacy nohup mode).

set -u
if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HEALTHCHECK="$REPO_ROOT/deploy/legacy-aws/scripts/healthcheck.sh"

echo "▶ Stopping and disabling services…"
for svc in powerguard-auth powerguard-ingestion powerguard-gateway powerguard-web; do
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
    rm -f "/etc/systemd/system/$svc.service"
    echo "  ✓ $svc removed"
done

systemctl daemon-reload
echo "  ✓ systemd daemon reloaded"

echo ""
echo "▶ Removing healthcheck cron…"
(crontab -l 2>/dev/null | grep -vF "$HEALTHCHECK") | crontab -
rm -f /etc/logrotate.d/gridiq-healthcheck
echo "  ✓ Cron and logrotate config removed"

echo ""
echo "Docker containers (TimescaleDB, Redis, Mosquitto) left running."
echo "Application logs at /var/log/gridiq-healthcheck.log preserved."
echo ""
echo "Done. You can now use 'bash deploy/legacy-aws/start.sh' again."
