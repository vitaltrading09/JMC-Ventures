# PowerGuard — Claude Code Project Brief

> Read this first. It gives you full context on what this project is, what's been built, what's pending, and how to work on it.

---

## What is PowerGuard?

PowerGuard is a **multi-tenant power quality monitoring and AI advisory SaaS platform** built for the South African industrial/commercial energy market.

**Business model:** Flat monthly SaaS subscription per site.  
**Primary users:** Energy-intensive businesses (factories, commercial buildings, mines).  
**Operator:** JMC Ventures / PowerGuard admin team.  
**Key value proposition:** Energy score, demand charge management, power quality monitoring, tariff optimisation, and monthly AI-generated site performance reports — delivered as a subscription even after a client installs solar (EPC handles O&M; PowerGuard handles ongoing advisory).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Docker Compose (one project), Node 22 images for linux/arm64 + linux/amd64 |
| Edge | Caddy 2.8.4: TLS on **80/443** for `APP_DOMAIN` and `MQTT_DOMAIN` |
| Frontend | Next.js 14.2 (standalone output), TypeScript, Tailwind CSS, Recharts, port **3000** (internal) |
| Auth Service | Node.js + Express, JWT + bcrypt, port **3001** (internal) |
| Ingestion Service | Node.js + Express, one image run as `api` (:3002) / `ingest` / `jobs` containers via `ROLES` |
| API Gateway | Node.js + Express, reverse proxy, port **8081** (internal, behind Caddy at `/api`) |
| Database | PostgreSQL 16 + TimescaleDB 2.25.2 (hypertable for `meter_readings`); schema via migrations in `packages/db` |
| MQTT Broker | Eclipse Mosquitto 2.0.22, **8883 TLS only** (local dev adds 127.0.0.1:1883) |
| AI | OpenAI (recommendations, narratives, chat) |

---

## Architecture

```
Browser ──https──▶ caddy (:443, APP_DOMAIN)
                     ├── /api/chat*  → web:3000   (Next.js route, not the gateway)
                     ├── /api/*      → gateway:8081 (prefix stripped)
                     │                   ├── /auth/*      → auth:3001
                     │                   └── /ingestion/* → api:3002   (ROLES=api)
                     └── everything else → web:3000

Acuvim II / AXM-WEB2 ──mqtts:8883──▶ mosquitto ──▶ ingest (ROLES=ingest) ──▶ timescaledb
  topic acuvim/{meter_id}/telemetry                  jobs (ROLES=jobs: cron) ──▶ timescaledb
                                                     migrate (one-shot)  ──▶ timescaledb
```

- Only `caddy` (80/443) and `mosquitto` (8883) publish host ports. Everything
  else talks over the compose network.
- **Roles** (`services/ingestion-service/src/roles.ts`): `ROLES` is a comma list
  of `api`, `ingest`, `jobs` (default all three, for `npm run dev`). Only `api`
  calls `app.listen`; only `ingest` calls `initMqtt`; only `jobs` calls
  `registerJobs` (every `cron.schedule`). Without `api` a container serves an
  internal `/health` on `HEALTH_PORT` (9090): MQTT connected / jobs registered.
- **Schema = migrations** (`packages/db`, node-pg-migrate, plain SQL). No
  service runs DDL. The one-shot `migrate` service (`node
  /app/packages/db/bin/migrate.js up`) applies pending migrations in one
  transaction, after updating the timescaledb extension if the image is newer.
  auth-service and every ingestion role call `assertSchemaCurrent()` at startup
  and **exit** if a migration is pending. See `packages/db/README.md`.
  - The baseline migration is the only idempotent one (safe on empty and existing
    DBs). Later migrations are normal, non-idempotent DDL.
  - `MAX_BACKFILL_DAYS` (30, mqtt.ts) and `COMPRESSION_AFTER_DAYS` (35, the
    compression policy) both live in `packages/db/index.js`; a test fails if
    compression <= backfill.
  - Old databases with duplicate `(meter_id, time)` readings: the baseline stops;
    run the explicit `quarantine-duplicate-readings.js` step (moves them to
    `meter_readings_quarantine`, deletes nothing for good), then migrate.
- The ingest container reaches the broker as `mqtts://${MQTT_DOMAIN}:8883`.
  `MQTT_DOMAIN` is a network alias of the mosquitto container, so the TLS
  hostname matches the certificate without leaving the host.
- Mosquitto's certificate is Caddy's certificate for `MQTT_DOMAIN`, copied by
  `deploy/scripts/sync-mqtt-certs.sh` to `${DATA_DIR}/mqtt-certs/`. Mosquitto
  waits at startup until the certificate is present.
- Persistent data lives under `${DATA_DIR}` (default `./.data`, `/data` on
  the server): `pg/ caddy/ caddy-config/ mosquitto/data/ mqtt-certs/ uploads/`.
- Uploads (CSV staging, SLD PDFs) go to `UPLOAD_DIR` (default `/data/uploads`).
  Stored SLD paths are relative to it; legacy `uploads/...` rows still resolve.

---

## What Has Been Built

### Frontend Pages (`apps/web/app/`)

| Route | Description | Status |
|---|---|---|
| `/` | Landing page | ✅ Done |
| `/login` | Auth login | ✅ Done |
| `/dashboard` | Main dashboard with energy score, KPIs, alerts, frequency chart | ✅ Done |
| `/dashboard/sites` | Site + meter management. **Add Meter shows full MQTT config** after creation | ✅ Done |
| `/dashboard/sites/[id]` | Per-meter chart page: 3-phase V/I, P/Q/S, PF, THD, freq, energy. NRS 048 reference lines. Solar/battery simulation tab | ✅ Done |
| `/dashboard/alerts` | Alerts log page with severity filter | ✅ Done |
| `/dashboard/analytics` | Tariff-aware analytics: MDI tracking, NRS 048 compliance, demand charges | ✅ Done |
| `/dashboard/savings` | Savings breakdown with Recharts bar chart | ✅ Done |
| `/dashboard/recommendations` | AI recommendation cards (Claude-powered) | ✅ Done |
| `/dashboard/reports` | Monthly report card (light theme, PDF/print ready) | ✅ Done |
| `/dashboard/settings/alerts` | Alert threshold config per site | ✅ Done |
| `/dashboard/settings/tariffs` | Tariff config | ✅ Done |
| `/dashboard/settings/data` | CSV data import | ✅ Done |
| `/dashboard/tools/pv-sizer` | PV sizer tool | ✅ Done |
| `/admin` | Admin overview | ✅ Done |
| `/admin/clients` | Client portfolio deep-dive (scores, sites, meters, leads) | ✅ Done |
| `/admin/leads` | Leads management | ✅ Done |
| `/api/chat` | AI chat route (OpenAI — pending migration to Claude). Caddy routes `/api/chat*` to web, all other `/api/*` to the gateway | ✅ Done |

### Backend Services

| Service | Key Features | Status |
|---|---|---|
| `auth-service` | Register, login, tenant management, JWT | ✅ Done |
| `ingestion-service` | MQTT listener, meter readings, energy scoring, AI recommendations, NRS 048 alerts, MDI tracking | ✅ Done |
| `api-gateway` | Proxy, CORS, rate limiting, helmet | ✅ Done |

### Key Backend Files

- `services/ingestion-service/src/mqtt.ts` — Full Acuvim II MQTT pipeline. Topic: `acuvim/{meter_id}/telemetry`. Supports both native dict and AXM-WEB2 store-and-forward formats. Writes to TimescaleDB, fires alerts, dead-letter queue for bad payloads. Smart serial number mapping.
- `services/ingestion-service/src/energy-score.ts` — Calculates energy score (0–100) from PF, THD, load factor, voltage quality. Stores in `site_scores` table.
- `services/ingestion-service/src/ai-recommendations.ts` — Claude-powered recommendation engine. Generates contextual recommendations per site based on score components.
- `services/ingestion-service/src/main.ts` — NRS 048-2 alert logic, MDI (Max Demand Indicator) tracking, tariff-aware analytics endpoints.

### Report Page Architecture (`/dashboard/reports`)

- Light theme (`bg-slate-100`) using negative margin escape (`-m-4 sm:-m-6 lg:-m-8`) to break out of dashboard layout padding
- Print CSS injected via `useEffect` (creates/removes `<style id="pg-report-print">`)
- Sidebar hidden on print via `print:hidden` (Sidebar.tsx + layout.tsx)
- `getLookingAhead()` — evaluates 4 score components, returns advisory for the weakest
- Consumption bar chart uses `MOCK_CONSUMPTION` placeholder — **needs wiring to live data** (see Pending Tasks)
- Recharts `PieChart` donut: `innerRadius={58} outerRadius={84}`, centre label via absolute overlay

### Site Detail Page (`/dashboard/sites/[id]`)

- Measurement tabs: P, Q, S, PF, Voltage, Current, THD, Frequency, Energy
- Voltage + Current support **3-phase toggle** (L1/L2/L3 individual lines)
- NRS 048-2 reference lines on charts (PF min 0.85, THD max 8%, voltage 207–253V, freq 49–51Hz)
- Date range picker + quick presets (24h / 7d / 30d / 90d)
- Summary stats strip (latest / avg / max / min)
- **Simulation tab** — solar + battery sizing with 24h chart and auto-size from data

### Add Meter Flow (`/dashboard/sites`)

After clicking **Add Meter** and saving, a confirmation modal appears showing the exact values to enter into the Acuvim II dashboard:
- Broker host / port (1883)
- MQTT username + password
- **MQTT topic** (unique per meter: `acuvim/{meter_uuid}/telemetry`)
- Each field has a copy-to-clipboard button

---

## Local Development Setup

### Prerequisites
- Docker Desktop installed and running (`docker compose` — V2 syntax, space not hyphen)
- Node.js 22 (tests, seeding, `npm run dev`)
- `mosquitto-clients` for MQTT testing (optional — on Windows use WSL, or `docker compose exec mosquitto mosquitto_pub ...`)

### First-time setup (full stack in Docker — the normal way)

```bash
cp .env.example .env                                   # replace every change_me
cp docker-compose.override.yml.example docker-compose.override.yml   # 127.0.0.1-only DB + MQTT ports
cp mosquitto/config/acl.example mosquitto/config/acl
cp mosquitto/config/conf.d/dev-listener.conf.example mosquitto/config/conf.d/dev-listener.conf
# MQTT users (Git Bash: prefix with MSYS_NO_PATHCONV=1). Ingest user = MQTT_USERNAME/MQTT_PASSWORD.
docker compose run --rm --no-deps --entrypoint mosquitto_passwd mosquitto -c -b /mosquitto/config/passwd gridiq-ingest '<MQTT_PASSWORD>'
docker compose run --rm --no-deps --entrypoint mosquitto_passwd mosquitto -b /mosquitto/config/passwd <meter-uuid> '<pw>'

docker compose up -d --build
bash deploy/scripts/sync-mqtt-certs.sh    # first run: copies Caddy's mqtt.localhost cert to Mosquitto
bash deploy/status.sh                     # every service healthy
```

- `.env` defaults: `APP_DOMAIN=localhost`, `MQTT_DOMAIN=mqtt.localhost`, `DATA_DIR=./.data`.
  Caddy issues both certificates from its local CA. The override sets
  `MQTT_CA_CERT=/mqtt-certs/ca.crt` so `ingest` trusts that CA.
- Compose derives `DATABASE_URL`, service URLs, `FRONTEND_URL` and `MQTT_BROKER_URL`
  itself. The web image is built with `NEXT_PUBLIC_API_URL=https://${APP_DOMAIN}/api`
  (build arg). Changing `APP_DOMAIN` means rebuilding `web`.
- `JWT_SECRET` (32+ chars) is shared by every container. There are no
  credential fallbacks in code; services exit at startup without `DATABASE_URL` / `JWT_SECRET`.
- Open `https://localhost` and accept the local-CA warning.

**Seed the database (local dev only)**, through the override's 127.0.0.1:5432:
```bash
ALLOW_DEMO_SEED=true DEMO_USER_PASSWORD='<choose one>'   DATABASE_URL='postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/<POSTGRES_DB>'   npx tsx services/auth-service/src/seed.ts
```
The seed scripts (`services/auth-service/src/seed.ts`, `scripts/seed.ts`,
`scripts/fix_password.ts`) refuse to run without `ALLOW_DEMO_SEED=true`. Never set it on a server.
Log in as `demo@grid-iq.co.za` with the `DEMO_USER_PASSWORD` you chose.

### Day-to-day commands

```bash
bash deploy/deploy.sh                 # git pull, build, migrate, up -d, cert sync, health summary
bash deploy/status.sh                 # state + health
bash deploy/logs.sh ingest            # follow one service
docker compose stop api               # ingestion keeps running: api, ingest and jobs are separate
bash deploy/scripts/build-multiarch.sh   # buildx linux/arm64 + linux/amd64 for every image
npm run build && npm test             # web build needs NEXT_PUBLIC_API_URL (apps/web/.env.local)
```

### Without containers (`npm run dev`)

Copy `.env.example` to `services/{auth-service,ingestion-service,api-gateway}/.env`,
`echo "NEXT_PUBLIC_API_URL=http://localhost:8081" > apps/web/.env.local`, start
`docker compose up -d timescaledb migrate caddy mosquitto` (with the override),
then `npm run dev`. The ingestion service runs all three roles in one process
(`ROLES` unset), with `UPLOAD_DIR=./uploads`.
After adding or pulling a migration, apply it from the host with
`npm run migrate -w packages/db` (uses `DATABASE_URL` from your shell). Services
refuse to start until it has run.

### Test a meter reading via MQTT
Local dev, plain listener on 127.0.0.1:1883 (from the override). The ACL only
lets a user publish to `acuvim/<its username>/telemetry`, so the meter user
must be named after the meter UUID:
```bash
mosquitto_pub -h localhost -p 1883 -u <meter-uuid> -P '<pw>' -q 1   -t "acuvim/<meter-uuid>/telemetry"   -m '{"V1": 230, "I1": 50, "Psum_kW": 11.5, "PF": 0.95, "Freq_Hz": 50}'
```
Over TLS, as a real meter connects: `-h mqtt.localhost -p 8883 --cafile .data/mqtt-certs/ca.crt`.

### Adding a real Acuvim II meter

1. Go to **Sites → Add Site** → fill in name/address
2. Modal auto-opens **Add Meter** — fill in the meter name, serial number, model
3. After saving, a **MQTT Config modal** appears with all values pre-filled — copy each into the Acuvim II web interface under `Communication → MQTT`
4. Set telemetry interval to 60s on the device
5. Within 60s the meter will appear live (green "Live" badge) in the Sites page

---

## Production Deployment

Target: **Oracle Cloud ARM VM (A1), Johannesburg**, running the same Docker
Compose stack behind Caddy with a real domain. The steps are in
`docs/planning/GRIDIQ_ORACLE_PLAN.md` Part D. Server `.env`: `APP_DOMAIN=app.<domain>`,
`MQTT_DOMAIN=mqtt.<domain>`, `DATA_DIR=/data`. Deploy with `bash deploy/deploy.sh`.

- AWS is gone and no production data is carried over: the Oracle server starts
  from an empty database. The plan's AWS steps (D5 version check, D7 restore,
  D9 backfill, D11 decommission) do not apply. TimescaleDB is `2.25.2-pg16`; bumping
  the image is safe (`migrate` updates the extension).
- Old local data: `deploy/scripts/restore-dump.sh <dump> <ts-version>` restores a
  dump into an empty DB (the old local dev DB is `./local/prod.dump`, TimescaleDB
  2.25.0, gitignored), then quarantine duplicates and migrate (`packages/db/README.md`).
- The old systemd / `npx tsx` runtime files were deleted in Phase 1.
- Backups (`deploy/backup-db.sh`, `deploy/scripts/backup-*.sh`) still target the legacy
  `powerguard-db` container; Phase 5 replaces them.

---

## Pending Tasks (Priority Order)

### 1. Wire live consumption data to report page
- File: `apps/web/app/dashboard/reports/page.tsx`
- Search for `MOCK_CONSUMPTION` — replace with real fetch from `/ingestion/meters/{id}/readings`
- The endpoint already exists in ingestion-service

### 2. Migrate AI chat from OpenAI to Claude
- File: `apps/web/app/api/chat/route.ts`
- Currently uses OpenAI — migrate to Anthropic Claude Sonnet
- Also inject energy score + top recommendations as context so chat is site-aware

### 3. Oracle migration (plan phases 2–5, then Part D)
- Phase 2 migrations, Phase 3 1-second ingest hardening, Phase 4 aggregates, Phase 5 backups/monitoring

### 4. Security hardening
- Replace localStorage JWT storage with HTTPOnly cookies
- Ensure all ingestion-service endpoints validate JWT tenant scope

### 5. Stripe / billing integration
- Monthly subscription per site
- Webhook for payment events

---

## Secrets and repo hygiene

- No credential is ever committed. Real values live in gitignored `.env` files;
  `.env.example` (repo root) holds placeholders only.
- Mosquitto runtime files (`mosquitto/config/passwd`, `mosquitto/config/acl`,
  `mosquitto/config/conf.d/*.conf`, `mosquitto/data/`, `mosquitto/log/`) are gitignored.
  Create them per machine from `passwd.example`, `acl.example`, `conf.d/*.example`.
- `.data/` (compose data) and `docker-compose.override.yml` (local dev ports) are gitignored.
- `apps/web/.env.production` was removed. `NEXT_PUBLIC_API_URL` is supplied at build
  time: a Docker build arg (compose sets `https://${APP_DOMAIN}/api`), or `apps/web/.env.local`
  for `npm run dev`. The build
  fails if it is unset; no frontend code may hard-code a host or port.
- CI runs a gitleaks scan (`.gitleaks.toml`) on the tree and on PR commits.
- The migration and fleet plan is `docs/planning/GRIDIQ_ORACLE_PLAN.md`.

## Code Conventions

- **API calls:** All frontend calls go through `NEXT_PUBLIC_API_URL` (the API gateway). Never call auth/ingestion services directly.
- **Auth:** JWT stored in localStorage (to be migrated to HTTPOnly cookies). Sent as `Authorization: Bearer <token>`.
- **Tenant isolation:** Every API query is scoped by `tenant_id` decoded from JWT.
- **Energy score colour thresholds:** `≥80` green, `≥60` amber/yellow, `<60` red.
- **NRS 048-2 limits:** PF min 0.85, THD max 8%, voltage 207–253V (±10% of 230V), frequency 49–51Hz.
- **Recharts:** Used for all charts. PieChart for donuts, BarChart for consumption, LineChart for time-series. Always use `<Cell>` per bar for colour control.
- **Print/PDF:** Use `data-noprint="true"` on controls, `print:hidden` on sidebar. Print CSS injected via `useEffect`.
- **Tailwind dark mode:** Dashboard uses dark sidebar (`bg-slate-950`). Report page uses full light theme.
- **Type convention:** Derive complex display types (e.g. `TenantPortfolio`) locally in the page file — don't add them to shared packages unless reused 3+ places.

---

## Key Constants

```
MQTT topic:        acuvim/{meter_id}/telemetry
MQTT credentials:  mosquitto/config/passwd (gitignored; see passwd.example)
MQTT port:         8883 (TLS) — local dev also 127.0.0.1:1883
DB name:           powerguard_db
DB user:           powerguard_user
SA grid factor:    0.92 kg CO₂/kWh
Avg SA tariff:     R2.50/kWh (used for savings estimates)
Peak tariff:       R5.80/kWh (07:00–10:00, 18:00–20:00)
Off-peak tariff:   R1.40/kWh (22:00–06:00)
```

---

## Repository

GitHub: https://github.com/vitaltrading09/JMC-Ventures  
Primary branch: `main`
