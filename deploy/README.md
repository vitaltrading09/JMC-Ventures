# Grid-IQ deployment (Docker Compose)

The whole stack is one Docker Compose project (root `docker-compose.yml`).
Caddy terminates TLS on 80/443, Mosquitto listens on 8883 (TLS only); nothing
else publishes a port. Persistent data lives under `${DATA_DIR}`
(`/data` on the server, `./.data` locally).

| Service | Role |
|---|---|
| `caddy` | TLS for `APP_DOMAIN` and `MQTT_DOMAIN`; `/api/*` → gateway, everything else → web |
| `web` | Next.js (standalone) |
| `gateway` | API gateway: `/auth` → auth, `/ingestion` → api |
| `auth` | Login, users, tenants |
| `api` | ingestion-service image, `ROLES=api`: REST endpoints |
| `ingest` | same image, `ROLES=ingest`: MQTT → DB only |
| `jobs` | same image, `ROLES=jobs`: every cron job |
| `migrate` | same image, one-shot: applies pending migrations (`packages/db`), then exits |
| `mosquitto` | MQTT broker, 8883, password file + ACL |
| `timescaledb` | PostgreSQL 16 + TimescaleDB 2.25.2 |

## Scripts

```bash
bash deploy/deploy.sh                 # git pull, build (tag = commit), migrate, up -d, cert sync, health summary
bash deploy/rollback.sh [tag]         # back to the previous image tag (no rebuild, no migrate)
bash deploy/status.sh                 # state + health of every service
bash deploy/logs.sh ingest [lines]    # follow one service's logs
sudo bash deploy/scripts/sync-mqtt-certs.sh   # copy Caddy's MQTT cert to Mosquitto (daily cron in Phase 5)
bash deploy/scripts/build-multiarch.sh        # linux/arm64 + linux/amd64 images via buildx
bash deploy/scripts/restore-dump.sh <dump> <ts-version>   # restore a pg_dump into an EMPTY database
bash deploy/scripts/backup.sh         # pg_dump → S3-compatible storage, 7 daily / 4 weekly / 6 monthly
bash deploy/scripts/restore-drill.sh  # restore the newest backup into a throwaway container, compare counts
sudo bash deploy/scripts/install-cron.sh   # backup 02:00, cert sync 03:30, drill Sun 04:00, prune Sun 05:00
bash deploy/test/backup-drill.sh      # local: backup + drill against S3Mock
```

## First start on a server

Follow plan Part D (`docs/planning/GRIDIQ_ORACLE_PLAN.md`). In short:

1. `cp .env.example .env` and fill in `APP_DOMAIN`, `MQTT_DOMAIN`, `DATA_DIR=/data`,
   `POSTGRES_PASSWORD`, `JWT_SECRET`, `MQTT_PASSWORD`, `OPENAI_API_KEY`.
2. `cp mosquitto/config/acl.example mosquitto/config/acl`, then create the
   MQTT users (`mosquitto/config/passwd.example`).
3. `bash deploy/deploy.sh`. Mosquitto waits until `sync-mqtt-certs.sh` has
   copied the certificate Caddy obtained for `MQTT_DOMAIN`.

Operating procedures (deploy, rollback, restore, MQTT users, logs):
[docs/RUNBOOK.md](../docs/RUNBOOK.md). External uptime monitor:
`GET https://app.<domain>/api/health/deep` with header `x-health-token: $HEALTH_TOKEN`
(200 healthy / 503 degraded, with detail).
