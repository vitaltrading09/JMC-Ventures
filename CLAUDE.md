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
  - Retention windows are env-configurable: `MAX_BACKFILL_DAYS` (default 14; the
    device-timestamp window in mqtt.ts) and `COMPRESS_AFTER_DAYS` (default 15; raw
    compression AND the continuous-aggregate refresh window), validated in
    `packages/db/index.js` (`retentionConfig`: compress must be > backfill). The
    migrate step applies them to the DB policies (`reconcileRetention`); every
    ingestion role exits at startup if the DB disagrees (`assertRetentionConsistent`).
  - Old databases with duplicate `(meter_id, time)` readings: the baseline stops;
    run the explicit `quarantine-duplicate-readings.js` step (moves them to
    `meter_readings_quarantine`, deletes nothing for good), then migrate.
- **Aggregates (Phase 4)**: continuous aggregates `readings_1m` (from raw), then
  hierarchical `readings_10m`, `readings_30m`, `readings_1h`, `readings_1d`. Core
  channels only (V/I per phase, P/Q/S/PF totals, frequency, THD V/I per phase,
  unbalance) as `<col>_avg/_min/_max`, voltage mean square `<col>_ms` (true RMS),
  energy registers `<col>_first/_last`, `n` (samples), `minutes`, `n_interrupt`
  (samples below 23 V). Averages are re-weighted by `n`, so they equal the plain
  raw average. `readings_30m.kva_demand` / `kw_demand` are minute-weighted (billed
  demand). The first migrate run on a DB with history materialises everything once;
  CSV imports refresh their range (`refreshAggregates`).
  - Read path (`src/aggregates.ts` `planRead`): ~300–700 points per chart, raw only for
    ranges ≤ 2 h; response shapes unchanged (`X-Readings-Source` header says which view).
  - Demand (`src/demand.ts`) from `readings_30m` / `readings_1m`, intervals need ≥ 80 %
    of minutes covered. Monthly energy (`src/energy.ts`) from register deltas per hour;
    a negative delta is a reset (`data_quality.register_resets`, never summed through);
    power-integration fallback (900 s gap cap) only where registers are absent; each
    month reports `method`.
  - Compliance (`power-quality.ts`) on 10-minute values (NRS 048-2 basis) across all
    measured phases, interruptions at 1-minute resolution; forecast on `readings_1h`;
    AI context on 30m/1m/1h (billed demand per meter: meters are never summed or averaged,
    a main incomer and its sub-meters would double-count).
  - CSV import (`/upload`) tags rows `time_source = 'IMPORT'` and reports duplicates
    (existing meter/time) separately from imported rows.
- **Alerting (jobs role, `src/alerting.ts`)**: 10-minute voltage/THD (and THD-I vs a
  site-declared `alert_max_thd_i`, else a weekly trend notice), 30-minute demand vs
  contracted MDI / `alert_max_kw`, instantaneous MDI early warning, `pq_events` by
  duration (`EVENT_ALERT_MIN_SECONDS` / `site_settings.event_alert_min_s`), data health
  (silent > `METER_SILENT_MINUTES`, coverage < 95 %/h, clock drift, rising conflicts from
  `ingest_stats`). Every message states its basis; dedupe via `alerts.dedupe_key`
  (unique per meter/type/key) plus memory.
- **Fleet model (Phase 6, `src/fleet/`, migration `1793798165302_fleet-model.sql`)**:
  - `sites` was renamed `projects` and `meters` was renamed `devices`. The old names
    are updatable views (`SELECT * FROM projects` / `devices`), so existing code works
    unchanged. New code uses the new names; the views go once Phase 8 has moved the UI.
  - `measurement_points` (role incomer/sub_load/pv/bess/generator/other, parent, CT
    primary, nominal V phase-to-neutral, contracted MDI) and `deployments` (device at a
    point from `installed_at` to `removed_at`, `power_sign`, `scale_correction`, configured
    CT/PT ratio, `commissioning` jsonb). `btree_gist` exclusion constraints: one place
    per device, one device per point, at any time.
  - Raw readings stay keyed by device. Attribution is by deployment window through
    `point_readings_1m/10m/30m/1h/1d`, one view per aggregate. A bucket belongs to the
    deployment holding its first sample (`t_first`). Corrections are applied there:
    sign −1 negates P/Q/PF/kW demand and swaps import/export registers; scale multiplies
    currents, P/Q/S, demand and registers.
  - Every correction is written to `audit_log` with a required reason.
  - `devices.site_id` stays as a compatibility field: the project of the current or
    last deployment, so the legacy site pages follow a moved box.
  - A meter created the legacy way (trigger `devices_legacy_deploy`) gets a point and an
    open deployment. A CSV import extends a device's first deployment back over older
    history.
  - `site_settings` is now per project. Its `contracted_mdi_kva` is mirrored onto the
    project's top-level incomer point by a trigger, until Phase 8.
  - `tenants.kind` (internal/client) and `slug`.
  - Fleet API (`src/fleet/routes.ts`), internal roles only (`super_admin`, `engineer`):
    - CRUD `/projects`, `/projects/:id/points`, `/points/:id`, `/devices`;
    - `POST /deployments`, `/deployments/:id/remove`, `PATCH /deployments/:id/corrections`;
    - `GET /fleet`;
    - `GET /projects/:id/energy-balance` (`src/fleet/balance.ts`; clients may read their own).
  - Commissioning checklist (`src/fleet/commissioning.ts`): the jobs role runs it every
    minute for the first 15 min after an install.
  - New devices publish on `acuvim/{lower(code)}/telemetry` (= `mqtt_username`). Devices
    without a project still ingest; retired ones are dead-lettered.
  - DB tests: `TEST_DATABASE_URL=... node --test --test-concurrency=1 services/ingestion-service/test/db/*.test.js`
    (CI runs them in the migrations job). They start the built auth-service and api-gateway
    too, so build every service first.
- **Roles and scoping (Phase 7, `src/scope.ts`, migration `1793805838000_roles-review-reports.sql`)**:
  - Roles: `super_admin` and `engineer` (internal tenant, `tenants.kind = 'internal'`);
    `client_admin` and `client_viewer` (client tenants); `broker`. The old `admin` maps to
    `client_admin`, `user`/`viewer` to `client_viewer` (DB migrated; old tokens mapped by
    `normaliseRole`).
  - `client_viewer` is read-only. The only writes it may make are compliance Q&A, marking
    alerts read and recommendation notify, enforced in `authenticateToken`.
  - `authenticateToken` builds `req.scope` (`userId`, `role`, `tenantId`, `isInternal`,
    `filterTenantId`). An internal user may name one tenant with `?tenant_id=` or
    `body.tenant_id`; clients are always confined to their own.
  - Routes never write their own tenant filter. They use `meterParam` / `siteParam`
    middleware and `findSite`, `findMeter`, `findOwned`, `tenantSql`, `telemetrySql`,
    `exclusiveDeviceSql`. `forClient` strips `internal_notes` and `reviewed_by`.
  - `projects.live_data_visible = false` hides telemetry (readings, health check, demand,
    energy, scores, alerts, AI context) from clients until a report for the project is
    published.
  - The legacy per-meter routes only reach a device for a client while every deployment
    of it was at that client's projects. A moved box is reached through the point views.
  - Review workflow (`src/review.ts`):
    - `recommendations.review_status` (draft/in_review/published/dismissed), next to the
      unchanged `status` (ACTIVE/SUPERSEDED). Engines write drafts with `evidence`.
    - Internal: `GET /review/recommendations`, `PATCH /recommendations/:id/review`
      (`supersede_previous` retires the client's earlier published set).
    - `reports` (project + period, draft → approved → published): `POST /reports`, then
      `/reports/:id/approve|publish|withdraw`. Clients read published ones (`GET /reports`).
    - Share links (`report_shares.report_id`) need a published report. The public page
      serves the report's own period (`assessPowerQuality(..., endAt)`) and returns 410
      `not_published` otherwise.
    - Every transition is written to `audit_log`.
  - Broker portfolio: off unless `FEATURE_BROKER=true` (API routes 404, renewal sweep off,
    web `/broker` hidden; build arg `NEXT_PUBLIC_FEATURE_BROKER`).
  - Cross-tenant test: `test/db/scoping.test.js` calls every route with tenant A's token
    aimed at tenant B.
- **Public API v1 (Phase 9, `src/v1/`, migration `1793817650769_api-keys-and-exports.sql`)**:
  - Under `/api/v1`, read-only, versioned. `src/v1/routes.ts` declares each route once with
    its OpenAPI description. `/api/v1/openapi.json` (OpenAPI 3.1) is generated from those
    declarations; Swagger UI (from `swagger-ui-dist`, no CDN) is at `/api/docs/`.
    - Routes: `GET /v1/projects`, `/v1/projects/{id}` (points and metered windows),
      `/v1/points/{id}/readings?interval=raw|1m|15m|30m|1h|1d&from&to&format=json|csv`,
      `/v1/projects/{id}/energy-balance?interval=total|day|month`, `/findings` (published),
      `/reports`, `/v1/reports/{id}.pdf`, `POST /v1/exports`, `GET /v1/exports[/{id}]`,
      `/v1/exports/{id}/download?expires&sig` (signed, no key).
  - **API keys** (`api_keys`, auth-service `src/api-keys.ts`):
    - A client admin creates them in portal Settings → API keys (`/auth/keys`); super_admin
      may name a client tenant. The key is `gq_live_<prefix>_<secret>`, shown once; only its
      sha256 is stored.
    - Scopes: `projects:read readings:read readings:raw energy:read findings:read
      reports:read exports:write`. The default is all but `readings:raw`. `project_ids`
      (null = all) limits a key to some projects. Create and revoke go to `audit_log`.
  - **Gateway** (`services/api-gateway/src/api-keys.ts`):
    - Verifies a key through auth `POST /internal/keys/verify`, cached 60 s (failures 10 s),
      so a revoke takes effect within a minute. The gateway answers 404 to `/auth/internal`
      from outside.
    - The key is swapped for a 5-minute JWT: role `client_viewer`, its tenant, plus
      `apiKey: {id, scopes, projectIds}`.
    - Rate limit `API_KEY_RATE_PER_MIN` (default 120) per key.
    - A key outside `/v1` gets 401. The ingestion api also refuses an API-key token outside
      `/v1/` (403).
  - **Scope**:
    - `req.scope.apiKey` with `hasApiScope` / `projectAllowed` (`src/scope.ts`). Tenant
      scope as everywhere: `findSite`, `findPoint`, `tenantSql`.
    - Sessions (the portal) may call `/v1` too; scopes then do not apply.
    - `live_data_visible = false` → 403 on readings, balance and exports.
    - A viewer may `POST /v1/exports` (it only reads).
  - **Readings** (`src/v1/series.ts`):
    - From `point_readings_*` (raw: `meter_readings` inside the deployment windows, corrected
      the same way). 15m comes from 1m; 1d is SAST days from 1h.
    - Rows are period-ending (`period_start`, `period_end`) and carry `n`, `coverage` (n ×
      the box's median sample spacing / interval), and `flags` (`gap` < 0.8 coverage,
      `register_reset`, `correction_applied`).
    - Energy is the register step per deployment; a negative step is left empty and flagged.
    - Range per request: raw 1 day, 1m 31 days, 15m/30m 1 year, 1h 2 years, 1d 10 years.
      Longer ranges go through exports.
    - CSV starts with `#` lines stating the conventions (`csvHeader`).
  - **Exports** (`src/v1/exports-job.ts`, jobs role every minute):
    - Claimed with `FOR UPDATE SKIP LOCKED`; a job stuck `running` > 1 h is requeued.
    - Written in `MAX_RANGE_DAYS` chunks as gzip CSV to `EXPORT_DIR/<id>.csv.gz`
      (`/data/exports`, mounted in api and jobs).
    - `expires_at` = done + 7 days; then the file is deleted and the row marked `expired`.
    - Download links are HMAC-signed (JWT_SECRET) and valid 1 hour. Max ranges: raw 31 days,
      1m 1 year, coarser 10 years.
  - **Report PDFs**:
    - Ops attach the PDF to a draft report: `POST /reports/:id/pdf` (multipart `file`,
      checked for `%PDF-`, 50 MB) stores `UPLOAD_DIR/report-pdfs/<id>.pdf` in
      `reports.pdf_path` and writes `audit_log`.
    - Served by `GET /reports/:id/pdf` (portal; clients: published only) and
      `/v1/reports/{id}.pdf`.
    - The upload refuses only after reading the body (an early answer resets the connection
      behind the proxy).
  - **Web**: portal Settings → API keys (client_admin), project tab Exports (with a curl
    example), a PDF link in Reports, and Attach/Replace PDF in ops Review → Reports.
  - **Tests**: `test/v1.test.js` (unit). `test/db/public-api.test.js` runs the real gateway,
    auth and api end to end (keys, scopes, corrections, CSV, PDF, exports and expiry).
    The scoping test also scans the v1 route declarations.
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
| `/dashboard/tools/pv-sizer`, `/dashboard/savings`, `/dashboard/value`, `/dashboard/sites/[id]` (simulation tab) | Sizing and value tools, kept behind `NEXT_PUBLIC_FEATURE_TOOLS` (build arg from `FEATURE_TOOLS`, off by default). Every other old `/dashboard` and `/admin` URL redirects (`movedTo` in `middleware.ts`): clients to `/portal`, staff to `/ops` | Flagged |
| `/ops` | **Ops console (Phase 8, internal roles):** Home, Fleet (+ device), Install wizard, Deployment (commissioning, corrections, remove), Review (findings, reports), Projects (+ project: points, energy balance, tariffs, live-data switch), Data health, Clients, Leads. Staff land here after login | ✅ Done |
| `/portal` | **Client portal (Phase 8):** Overview (live tiles), Projects, Project (tabs: Overview, Metering layout, Energy balance, Load profile, Demand, Power quality, Findings, Reports), Point (the per-meter chart, by point), Alerts, Settings (branding, users). Reads `src/portal.ts` (point views, scoped); no internal fields | ✅ Done |
| `/api/chat` | AI chat route (OpenAI — pending migration to Claude). Caddy routes `/api/chat*` to web, all other `/api/*` to the gateway | ✅ Done |

### Backend Services

| Service | Key Features | Status |
|---|---|---|
| `auth-service` | Register, login, tenant management, JWT | ✅ Done |
| `ingestion-service` | MQTT ingest (durable, batched), continuous aggregates read path, pq_events, alerting on 10/30-minute aggregates + events + data health (jobs), energy from registers, energy scoring, AI recommendations | ✅ Done |
| `api-gateway` | Proxy, CORS, rate limiting, helmet, API-key auth for `/v1` (Phase 9) | ✅ Done |

### Key Backend Files

- `services/ingestion-service/src/mqtt.ts` — the ingest role's MQTT pipeline (topic `acuvim/{meter_id}/telemetry`), plus the timestamp provenance logic (`resolveReadingTime`, conflict counter, dead-letter). Since Phase 3:
  - **Durable:** QoS 1 subscription, persistent session (`MQTT_CLIENT_ID`, `clean: false`). Each message's PUBACK is held until the batch that wrote it commits (`src/ingest/ack-gate.ts`: mqtt.js 5 reads packets one at a time, so only the outgoing PUBACK is deferred). On a DB failure nothing is acked and the writer retries; if ingest dies, the broker redelivers. SIGTERM flushes and acks before disconnecting (`stop_grace_period: 30s`).
  - **Batched** (`src/ingest/batch-writer.ts`): one multi-row `INSERT ... ON CONFLICT (meter_id, time) DO NOTHING RETURNING` per flush (`INGEST_FLUSH_MS` 1000 / `INGEST_FLUSH_ROWS` 500); the bounded queue (`INGEST_MAX_QUEUE` 50,000) applies backpressure, never drops.
  - **Mapping is data** (`src/ingest/channels.ts`): column → candidate param names, ~42 columns including L-L voltages, neutral current, per-phase P/Q/S/PF, THD per phase, unbalance, kvarh, demand. Add new firmware names there; tests use `test/fixtures/` payloads. Unmapped names are logged once per meter per hour, and payload bytes/msg per meter hourly (`src/ingest/stats.ts`).
  - **Meter cache** (`src/ingest/meter-cache.ts`): refreshed every 60 s and on a miss; topic segment matches id, serial, then `mqtt_username` (fleet devices: lowercase code). Unknown, archived and retired devices are dead-lettered (`unknown meter`).
  - **No alert queries in ingest.** Alerting runs in the jobs role on aggregates (see Alerting above). Ingest feeds an in-memory event detector (`src/ingest/event-detector.ts`) that writes voltage/frequency excursions to `pq_events` (ongoing after `EVENT_MIN_SECONDS`, updated when they end). 1-second data cannot resolve sub-second dips.
  - Mosquitto `max_inflight_messages 1000`: with deferred PUBACKs the default 20 would cap ingest at ~20 msg/flush.
- `services/ingestion-service/src/energy-score.ts` — Calculates energy score (0–100) from PF, THD, load factor, voltage quality. Stores in `site_scores` table.
- `services/ingestion-service/src/ai-recommendations.ts` — Claude-powered recommendation engine. Generates contextual recommendations per site based on score components.
- `services/ingestion-service/src/main.ts` — REST endpoints (readings via aggregates, demand, monthly energy, compliance, AI context), role startup, cron registration.
- `services/ingestion-service/src/alerting.ts` — all alert rules (jobs role); `src/energy.ts` — register-based period energy; `src/aggregates.ts` — chart read planning.

### Frontend structure (Phase 8)

- `/ops` (staff) and `/portal` (clients) replace `/admin` and `/dashboard`. Staff land on `/ops`
  after login, clients on `/portal`; `middleware.ts` guards both and redirects old URLs.
- Single-line diagram: `components/sld/SldEditor.tsx` (via `SldView`), bound to measurement points
  (stored as `meterId` in `site_diagrams.layout`; it holds the point id). Editable on the ops
  project page, read-only in the portal's Metering layout tab.
- The per-meter/point chart: `components/charts/MeasurementChart.tsx` (3-phase V/I, P/Q/S, PF,
  THD, frequency, energy; NRS 048-2 reference lines; states its aggregate and SAST).
- The AI chat widget (`components/dashboard/ChatWidget.tsx`, `/api/chat`) sits in the portal layout.
- Adding meters is ops-only: Fleet → New box (shows the broker username and topic), then Install.
  The old Add Meter screen is gone; CSV import is `/ops/import`.

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
`scripts/fix_password.ts`, `scripts/seed-readings.ts`) refuse to run without `ALLOW_DEMO_SEED=true`. Never set it on a server.
Log in as `demo@grid-iq.co.za` (client_admin) or `ops@grid-iq.co.za` (super_admin, internal tenant) with the `DEMO_USER_PASSWORD` you chose.

**Synthetic readings (local dev only).** There is no production data, so
`scripts/seed-readings.ts` fills `meter_readings` for the 5 seeded demo meters
(found by their `DEMO-*` serials; nothing else is touched). Run it after the
seed, with the stack up (the api role must have bootstrapped the schema):
```bash
ALLOW_DEMO_SEED=true DATABASE_URL='postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/<POSTGRES_DB>'   npx tsx scripts/seed-readings.ts
```
- Default: 90 days ending now at 5-minute resolution. Options: `--days N`,
  `--interval M`, `--end ISO`, `--alert-days N` (0 = no alerts), `--only hq,mall`, `--dry-run`.
- Re-running is safe and only tops the window up to now: `ON CONFLICT (meter_id, time) DO NOTHING`,
  deterministic values, energy register integrated from a fixed epoch. It never updates or
  deletes readings. Keep `--interval` the same across runs. After a profile change, new rows
  are re-based onto the stored register so it stays monotonic; stored rows keep their old curve
  (wipe `.data/` and re-seed for a clean set).
- Every row has `time_source = 'SIMULATED'`, `device_time = time`. Simulated real-time alerts
  (THD, sags, MDI, peak kW; MQTT never sees these rows) start with `[SIMULATED]`.
- Blank `site_settings` (Eskom TOU tariffs, contracted MDI, demand interval, NRS 048 alert limits)
  and meter profiles (site type, load types) are filled in; values already set are kept.
- Sites: Headquarters is healthy. Cape Town Factory: 24 h PF ≈ 0.75 and weekday demand spikes over
  the 1000 kVA MDI. Durban: ~30 % phase current imbalance. Sandton Mall: voltage THD > 8 % while
  trading. Pretoria Data Center: daily sags below 207 V. The jobs role scores them within 5 min and
  the predictive scan (every 30 min) flags the factory and Durban.
- Profiles and curves: `services/ingestion-service/src/demo-profiles.ts`, tested in
  `services/ingestion-service/test/demo-profiles.test.js`.
- Data older than 35 days is in compressed chunks after the policy runs; the script decompresses
  only the chunks its new rows land in before inserting (same as CSV import).

### Day-to-day commands

```bash
bash deploy/deploy.sh                 # git pull, build (IMAGE_TAG = commit), migrate, up -d, cert sync, health summary
bash deploy/rollback.sh               # previous image tag, no rebuild/migrate
bash deploy/scripts/backup.sh         # backup now (cron runs it daily; see docs/RUNBOOK.md)
bash deploy/status.sh                 # state + health
bash deploy/logs.sh ingest            # follow one service
docker compose stop api               # ingestion keeps running: api, ingest and jobs are separate
bash deploy/scripts/build-multiarch.sh   # buildx linux/arm64 + linux/amd64 for every image
# Ingest load test (20 meters × 1 Hz + a 2 h store-and-forward replay; see the file header)
npx tsx services/ingestion-service/test/load/simulate.ts --meters 20 --minutes 10 --backlog-hours 2
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

### Public link to the local stack (Cloudflare quick tunnel, testing only)

No server, account, card or domain: compose profile `tunnel` runs `cloudflared` and gives a
random `https://<words>.trycloudflare.com` address for the web app and `/api`.
```bash
# once: in .env, WEB_API_URL=/api (the web calls the API on its own origin), then
docker compose build web && docker compose up -d web
MSYS_NO_PATHCONV=1 docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile   # after a Caddyfile change
docker compose --profile tunnel up -d tunnel && bash deploy/tunnel-url.sh
docker compose --profile tunnel stop tunnel        # take it offline
```
- cloudflared reaches Caddy's plain `http://:8080` listener on the compose network (never
  published); Caddy trusts its `X-Forwarded-Proto`, so redirects stay on the tunnel's https host.
- The address changes on every start, works only while this PC runs, and carries no MQTT
  (meters cannot use it). Anyone with the link reaches the login page.

### Test a meter reading via MQTT
Local dev, plain listener on 127.0.0.1:1883 (from the override). The ACL only
lets a user publish to `acuvim/<its username>/telemetry`, so the meter user
must be named after the meter UUID:
```bash
mosquitto_pub -h localhost -p 1883 -u <meter-uuid> -P '<pw>' -q 1   -t "acuvim/<meter-uuid>/telemetry"   -m '{"V1": 230, "I1": 50, "Psum_kW": 11.5, "PF": 0.95, "Freq_Hz": 50}'
```
Over TLS, as a real meter connects: `-h mqtt.localhost -p 8883 --cafile .data/mqtt-certs/ca.crt`.
On this Windows dev machine, Avast's Web/Mail Shield intercepts TLS from the host
(it re-signs with its own root), so host-side TLS clients fail verification against
the local CA. Containers are unaffected; run TLS tests inside the compose network.

### Adding a real Acuvim II meter

1. Ops console → **Fleet → New box** (code, e.g. `GQ-M01`): it shows the broker username (`gq-m01`)
   and topic (`acuvim/gq-m01/telemetry`). Create the broker user (docs/RUNBOOK.md → MQTT credentials).
2. On the AXM-WEB2: host `mqtt.<domain>`, port 8883, TLS, that username and password, the topic,
   QoS 1, store-and-forward and NTP on, interval 1 s – 60 s.
3. **Install**: box → client → project → point → CT/PT/sign. The deployment page shows the
   commissioning checklist for 15 minutes from the first reading.

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
- Operations: `docs/RUNBOOK.md` (deploy, rollback by image tag, restore, MQTT users, logs).
  Backups: `deploy/scripts/backup.sh` (pg_dump → verified → encrypted with age to
  `BACKUP_AGE_RECIPIENT` → Cloudflare R2 via `BACKUP_S3_*`, 7/4/6 retention, status in `backup_runs`),
  weekly `restore-drill.sh` (decrypts with `BACKUP_AGE_IDENTITY_FILE`, default
  `/etc/gridiq/backup-age.key`, root only; an offline copy of the key must exist), `install-cron.sh`.
  The S3 client and age are the `awscli` and `age` compose services (profile `tools`). Local test:
  `deploy/test/backup-drill.sh` (S3Mock, throwaway age key).
- External monitor: `/api/health/deep` (header `x-health-token: $HEALTH_TOKEN`; `src/health.ts`):
  DB, pending migrations, ingest heartbeat + last flush (`service_heartbeats`, written by ingest
  every 30 s), last successful backup, silent meters. 200 / 503.

---

## Pending Tasks (Priority Order)

### 2. Migrate AI chat from OpenAI to Claude
- File: `apps/web/app/api/chat/route.ts`
- Currently uses OpenAI — migrate to Anthropic Claude Sonnet
- Also inject energy score + top recommendations as context so chat is site-aware

### 3. Oracle migration (plan phases 2–5, then Part D)
- Phases 2–9 done (6 fleet model, 7 roles/scoping/review, 8 ops console + client portal in three PRs, 9 public API, API keys, exports, report PDFs). Parquet exports are a later addition (CSV now). Phase 9 is the plan's last build phase; what remains is Part D, the owner's go-live runbook (Oracle VM, DNS, first start, smoke tests, meter cutover, backups, Milestone A checklist). The legacy `sites`/`meters` views stay until the API itself moves to the new names. Part D is the owner's go-live runbook.
- Phase 8 conventions: new pages use TanStack Query and `apps/web/lib/api.ts` (`apiGet`, `apiSend`, SAST date helpers: every chart and date states its basis and time zone); ops UI blocks in `components/ops/ui.tsx`; fleet health rules in `lib/ops.ts` (`deviceHealth`, `projectFlags`); portal types/role hook in `lib/portal.ts`; the shared chart `components/charts/MeasurementChart.tsx` (meter page and portal point page) and `components/fleet/BalanceView.tsx`. Portal API (`src/portal.ts`): `/portal/projects`, `/portal/projects/:id`, `/points/:id/readings|load-profile|demand|power-quality`, all from `point_readings_*` (corrected, per deployment window). Client admins manage their own users through the auth service (`GET/POST/PATCH/DELETE /users`). Setup (projects, points, installs, CSV import) is ops-only; client_admin manages its own users.

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
- **Tenant isolation:** through `req.scope` and the repository functions in `services/ingestion-service/src/scope.ts` only; no route writes its own `role === 'super_admin'` / `tenant_id = $n` check. A new route must be covered by `test/db/scoping.test.js` (it scans the sources for routes).
- **Roles:** check `req.scope.isInternal` / `canWrite(req.scope)`, never role strings; client data shown to clients goes through `forClient`.
- **New tables and queries** use `projects`, `devices`, `measurement_points`, `deployments`; attribute readings to a project or point only through `point_readings_*` (never by `devices.site_id`).
- **Delete = archive:** `DELETE /meters/:id` and `/sites/:id` set `archived_at` (+ `is_active = false`);
  lists hide archived rows (`?archived=1` shows them), ingest dead-letters archived meters, admins
  restore with `POST .../restore`. Raw readings are removed only by `deploy/scripts/purge-archived-meter.sh`
  (backup first, documented in docs/RUNBOOK.md). New queries listing meters/sites must filter `archived_at IS NULL`.
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
