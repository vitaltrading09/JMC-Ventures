#!/bin/bash
# Grid-IQ healthcheck — runs every minute via root cron.
#
# systemd's Restart=always covers crashes, but won't help if a process is
# *alive but deadlocked* (e.g. wedged on a DB query, stuck in a tight loop,
# event loop blocked). This script hits the HTTP health endpoint of each
# service; if the request fails or times out, the service is restarted.
#
# Install:  installed automatically by deploy/legacy-aws/scripts/install.sh
# Manual:   sudo crontab -e  →  * * * * * /home/ubuntu/Grid-IQ/deploy/legacy-aws/scripts/healthcheck.sh >> /var/log/gridiq-healthcheck.log 2>&1
# Tail:     sudo tail -f /var/log/gridiq-healthcheck.log

set -u
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

check_and_restart() {
    local service="$1"
    local url="$2"
    local name="$3"

    # 8-second timeout — generous enough that a busy GC pause doesn't trigger,
    # tight enough that a deadlock is caught within ~10s.
    if curl -sf -m 8 "$url" -o /dev/null; then
        return 0
    fi

    # Failed. Check what systemd thinks.
    local state
    state=$(systemctl is-active "$service" 2>/dev/null || echo "unknown")

    echo "[$TIMESTAMP] $name UNHEALTHY (HTTP probe failed, systemd state=$state) — restarting"
    systemctl restart "$service"

    # Give it a moment to come back up, then re-probe.
    sleep 4
    if curl -sf -m 8 "$url" -o /dev/null; then
        echo "[$TIMESTAMP] $name restored OK ✓"
    else
        echo "[$TIMESTAMP] $name STILL DOWN after restart ✗  (check: journalctl -u $service -n 50)"
    fi
}

# Frontend's "/" returns the landing page HTML which is good enough as a liveness signal.
check_and_restart powerguard-auth      http://localhost:3001/health           "Auth Service"
check_and_restart powerguard-ingestion http://localhost:3002/health           "Ingestion Service"
check_and_restart powerguard-gateway   http://localhost:8081/health           "API Gateway"
check_and_restart powerguard-web       http://localhost:3000/                 "Web Frontend"
