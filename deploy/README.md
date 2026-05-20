# Grid-IQ Production Deployment

systemd-based service supervision with auto-restart + minute-by-minute healthchecks.

## Why this exists

The previous setup used `nohup npx tsx ... &` — when a service crashed, it stayed dead until manually noticed. **That's exactly what happened on 2026-05-19**: all four services were down for an unknown amount of time, surfaced only when someone tried to deploy.

This replaces that with:

| Failure mode | Old (`nohup`) | New (`systemd`) |
|---|---|---|
| Process crash | Stays dead forever | Auto-restart in 5s |
| Tight crash loop | Burns CPU until OOM | Stops after 5 attempts in 60s |
| Deadlocked but alive | Stays unresponsive | Healthcheck restarts within 60s |
| Reboot | Nothing comes back up | Auto-starts on boot |
| Log access | `cat /tmp/auth.log` | `journalctl -u powerguard-auth -f` |
| Resource leak | OOMs the whole box | Per-service `MemoryMax` cap |

## One-time install

After cloning the repo to `/home/ubuntu/Grid-IQ` and creating all `.env` files:

```bash
sudo bash /home/ubuntu/Grid-IQ/deploy/scripts/install.sh
```

The script is idempotent — safe to re-run.

It will:
1. Stop any existing `nohup` processes
2. Bring up Docker infrastructure (TimescaleDB, Redis, Mosquitto)
3. Run `npm run build` in `apps/web`
4. Install four systemd unit files to `/etc/systemd/system/`
5. Enable + start each service in dependency order
6. Install a one-minute healthcheck cron under root
7. Configure logrotate (14-day log retention)

## Day-to-day commands

```bash
# One-glance overview of everything
bash deploy/scripts/status.sh

# Tail a specific service's logs
bash deploy/scripts/logs.sh ingestion
bash deploy/scripts/logs.sh auth 500     # last 500 lines + follow

# Manual restart
sudo systemctl restart powerguard-ingestion

# All-services restart
sudo systemctl restart powerguard-{auth,ingestion,gateway,web}

# See what the healthcheck has been doing
sudo tail -f /var/log/gridiq-healthcheck.log
```

## Redeploying after `git pull`

```bash
bash /home/ubuntu/Grid-IQ/deploy/scripts/redeploy.sh
```

This pulls, runs `npm install`, rebuilds the Next.js frontend, and restarts all four services in correct order.

## Rolling back

```bash
sudo bash deploy/scripts/uninstall.sh
```

Removes all systemd units and the healthcheck cron. Docker containers and your data are untouched. You can fall back to `bash start.sh`.

## Service dependency graph

```
docker.service
  └── powerguard-auth.service        (port 3001)
       └── powerguard-ingestion.service   (port 3002)
            └── powerguard-gateway.service  (port 8081)
                 └── powerguard-web.service   (port 3000)
```

systemd starts them in this order on boot and restarts the relevant chain if a dependency fails.

## Resource limits

| Service | MemoryMax | Why |
|---|---|---|
| auth | 256 MB | Stateless, tiny |
| gateway | 256 MB | Pure proxy |
| ingestion | 768 MB | MQTT + cron + queue worker + Claude calls |
| web | 1 GB | Next.js SSR can balloon |

If a service exceeds its cap, systemd kills it and `Restart=always` brings it back. Worst case: a 5-second blip.

## When the healthcheck restarts something

Each minute, `healthcheck.sh` hits `/health` on each service. If the probe fails or times out (8s):

1. Logs the failure with the systemd state
2. Runs `systemctl restart <service>`
3. Re-probes after 4s
4. Logs whether the restart fixed it

Watch it live:
```bash
sudo tail -f /var/log/gridiq-healthcheck.log
```

Healthy days the log stays empty — entries only appear when something actually broke.

## What's NOT covered yet

- Off-server backups (Tier 1 item #2 — pg_dump → S3)
- HTTPS / proper domain (Tier 1 item #3 — Caddy + powerguard.co.za)
- Alerting (currently you check the log yourself — Slack/email/SMS still TODO)
- Multi-host failover (single-server is fine for beta; revisit later)
