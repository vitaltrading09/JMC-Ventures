# PowerGuard / Grid-IQ Platform ⚡

Metering, electrical-analysis and advisory platform for South African C&I sites.

The whole stack runs as one Docker Compose project: Caddy (TLS) in front of
Next.js, the API gateway, auth, the ingestion service split into
`api` / `ingest` / `jobs` containers, Mosquitto (MQTT over TLS) and TimescaleDB.
See [deploy/README.md](deploy/README.md) for the service list.

## 🚀 Run locally (Docker Compose)

### 1. Prerequisites
- **Docker Desktop** (running), with `docker compose` (V2)
- **Node.js 22** and **Git** (for tests and `npm run dev`)

### 2. Clone
```bash
git clone https://github.com/vitaltrading09/JMC-Ventures.git
cd JMC-Ventures
```

### 3. Configure
Every variable is documented in `.env.example`. The defaults serve the app on
`https://localhost` and MQTT on `mqtt.localhost:8883`, using Caddy's local CA.
```bash
cp .env.example .env    # replace every change_me (openssl rand -hex 32)
cp docker-compose.override.yml.example docker-compose.override.yml   # 127.0.0.1-only dev ports
cp mosquitto/config/acl.example mosquitto/config/acl
cp mosquitto/config/conf.d/dev-listener.conf.example mosquitto/config/conf.d/dev-listener.conf
```
Create the MQTT users. The ingest user and password must match `MQTT_USERNAME`
and `MQTT_PASSWORD` in `.env` (on Git Bash, prefix the commands with `MSYS_NO_PATHCONV=1`):
```bash
docker compose run --rm --no-deps --entrypoint mosquitto_passwd mosquitto -c -b /mosquitto/config/passwd gridiq-ingest '<MQTT_PASSWORD>'
docker compose run --rm --no-deps --entrypoint mosquitto_passwd mosquitto -b /mosquitto/config/passwd <meter-uuid> '<meter-password>'
```

### 4. Start
```bash
docker compose up -d --build
bash deploy/scripts/sync-mqtt-certs.sh   # first run only: gives Mosquitto the cert Caddy issued
bash deploy/status.sh                    # every service should be healthy
```

### 5. Seed (local dev only)
```bash
ALLOW_DEMO_SEED=true DEMO_USER_PASSWORD='<choose-a-local-password>' \
  DATABASE_URL="postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/<POSTGRES_DB>" \
  npx tsx services/auth-service/src/seed.ts
```
The seed scripts refuse to run unless `ALLOW_DEMO_SEED=true`.

### 6. Open
[https://localhost](https://localhost). Accept the browser warning for Caddy's
local CA, then log in as `demo@grid-iq.co.za`.

### Without containers (`npm run dev`)
You can still run the Node services on the host against the compose database:
copy `.env.example` into each service folder (see the comments at its top),
`echo "NEXT_PUBLIC_API_URL=http://localhost:8081" > apps/web/.env.local`, start
`docker compose up -d timescaledb migrate caddy mosquitto`, then `npm run dev`.

### Tests
```bash
npm run build && npm test   # the web build needs apps/web/.env.local (NEXT_PUBLIC_API_URL)
```

## 📁 Project Structure
- `apps/web`: Next.js frontend (dashboard UI)
- `services/auth-service`: authentication API (Express + JWT)
- `services/ingestion-service`: REST API, MQTT ingest and scheduled jobs (one image, `ROLES` picks which)
- `services/api-gateway`: central entry point (Express proxy)
- `deploy/`: Caddyfile, deploy/status/logs scripts, MQTT cert sync, multi-arch build
- `mosquitto/config`: broker config, ACL and password-file templates
- `scripts`: database seeding and utility scripts
