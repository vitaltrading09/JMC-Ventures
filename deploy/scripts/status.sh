#!/bin/bash
# Quick overview of all PowerGuard infrastructure.
# Run: bash deploy/scripts/status.sh

YEL='\033[1;33m'
GRN='\033[1;32m'
RED='\033[1;31m'
DIM='\033[2m'
RST='\033[0m'

echo -e "${YEL}━━━ Docker Containers ━━━${RST}"
docker ps --format "  {{.Names}}  ←  {{.Status}}  ({{.Ports}})" 2>/dev/null | grep -E "powerguard" \
    || echo -e "  ${RED}No PowerGuard containers running${RST}"

echo ""
echo -e "${YEL}━━━ systemd Services ━━━${RST}"
for svc in powerguard-auth powerguard-ingestion powerguard-gateway powerguard-web; do
    state=$(systemctl is-active "$svc" 2>/dev/null)
    pid=$(systemctl show -p MainPID --value "$svc" 2>/dev/null)
    mem=$(systemctl show -p MemoryCurrent --value "$svc" 2>/dev/null)
    if [ "$mem" != "" ] && [ "$mem" != "[not set]" ] && [ "$mem" -gt 0 ] 2>/dev/null; then
        mem_mb=$((mem / 1024 / 1024))
        mem_str="${mem_mb}MB"
    else
        mem_str="—"
    fi
    case "$state" in
        active)   echo -e "  ${GRN}●${RST} $svc  (PID $pid · ${mem_str})" ;;
        inactive) echo -e "  ${DIM}○${RST} $svc  ${DIM}inactive${RST}" ;;
        failed)   echo -e "  ${RED}✗${RST} $svc  ${RED}FAILED${RST}  (journalctl -u $svc)" ;;
        *)        echo -e "  ${YEL}?${RST} $svc  $state" ;;
    esac
done

echo ""
echo -e "${YEL}━━━ HTTP Health Probes ━━━${RST}"
probe() {
    local name="$1"; local url="$2"
    if curl -sf -m 3 "$url" -o /dev/null; then
        echo -e "  ${GRN}✓${RST} $name  ${DIM}$url${RST}"
    else
        echo -e "  ${RED}✗${RST} $name  ${DIM}$url${RST}"
    fi
}
probe "Auth"      "http://localhost:3001/health"
probe "Ingestion" "http://localhost:3002/health"
probe "Gateway"   "http://localhost:8081/health"
probe "Web"       "http://localhost:3000/"

echo ""
echo -e "${YEL}━━━ Recent Restarts (last 24h) ━━━${RST}"
for svc in powerguard-auth powerguard-ingestion powerguard-gateway powerguard-web; do
    restarts=$(journalctl -u "$svc" --since "24 hours ago" --no-pager 2>/dev/null | grep -c "Started" || echo 0)
    if [ "$restarts" -gt 1 ]; then
        echo -e "  ${YEL}⚠${RST}  $svc started $restarts times"
    fi
done | head -5 || true

echo ""
echo -e "${DIM}Hint: bash deploy/scripts/logs.sh <service>   to tail logs${RST}"
