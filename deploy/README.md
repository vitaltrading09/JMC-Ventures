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
| `api` | ingestion-service image, `ROLES=api`: REST endpoints and the schema bootstrap |
| `ingest` | same image, `ROLES=ingest`: MQTT → DB only |
| `jobs` | same image, `ROLES=jobs`: every cron job |
| `migrate` | same image, one-shot: creates the base schema on an empty DB |
| `mosquitto` | MQTT broker, 8883, password file + ACL |
| `timescaledb` | PostgreSQL 16 + TimescaleDB |

## Scripts

```bash
bash deploy/deploy.sh                 # git pull, build, migrate, up -d, cert sync, health summary
bash deploy/status.sh                 # state + health of every service
bash deploy/logs.sh ingest [lines]    # follow one service's logs
sudo bash deploy/scripts/sync-mqtt-certs.sh   # copy Caddy's MQTT cert to Mosquitto (daily cron in Phase 5)
bash deploy/scripts/build-multiarch.sh        # linux/arm64 + linux/amd64 images via buildx
```

## First start on a server

Follow plan Part D (`docs/planning/GRIDIQ_ORACLE_PLAN.md`). In short:

1. `cp .env.example .env` and fill in `APP_DOMAIN`, `MQTT_DOMAIN`, `DATA_DIR=/data`,
   `POSTGRES_PASSWORD`, `JWT_SECRET`, `MQTT_PASSWORD`, `OPENAI_API_KEY`.
2. `cp mosquitto/config/acl.example mosquitto/config/acl`, then create the
   MQTT users (`mosquitto/config/passwd.example`).
3. `bash deploy/deploy.sh`. Mosquitto waits until `sync-mqtt-certs.sh` has
   copied the certificate Caddy obtained for `MQTT_DOMAIN`.

## Legacy

The old AWS box (systemd + `npx tsx`) uses `deploy/legacy-aws/` until it is
decommissioned; read `deploy/legacy-aws/README.md` before pulling onto it.
Backups (`deploy/backup-db.sh`, `deploy/scripts/backup-*.sh`) still target the
legacy `powerguard-db` container; Phase 5 replaces them.
