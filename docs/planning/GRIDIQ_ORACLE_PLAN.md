# Grid-IQ: Oracle Migration, 1-Second Ingestion and Fleet/Portal Plan

Repo: `github.com/vitaltrading09/JMC-Ventures` (product branded Grid-IQ)

This file has four parts:

- **Part A — How to use this file** with Claude Code on your other laptop.
- **Part B — The prompts** you paste into Claude Code, phase by phase.
- **Part C — Phase specifications.** Claude Code reads these. Each has tasks and acceptance criteria.
- **Part D — Go-live runbook.** The steps only you can do (Oracle, DNS, meters, data migration).
- **Part E — Product and frontend recommendation** for the fleet/project/portal direction.

Two milestones:

- **Milestone A — Live on Oracle** (Phases 0–5): the existing product, hardened, containerised, on Oracle Johannesburg with a domain, TLS and 1-second-ready ingestion.
- **Milestone B — Fleet and client portal** (Phases 6–9): portable meter fleet, projects, measurement points, deployments, internal ops console, client portal, public API.

Do Milestone A first. Don't start the fleet model on infrastructure you're still moving.

---

## Part A — How to use this file

1. On the other laptop, install Claude Code (desktop app or CLI) and sign in. Give it GitHub access.
2. Clone the repo and open it in Claude Code.
3. Copy this file into the repo at `docs/planning/GRIDIQ_ORACLE_PLAN.md` and commit it on `main`. Claude Code reads it from there.
4. Paste the **Master prompt** (Part B) once at the start of a session.
5. Paste one **Phase prompt** at a time. Review the PR Claude Code opens, run it locally, merge, then start the next phase.
6. Do the **Part D** human steps when a phase says `⏸ HUMAN CHECKPOINT`.

Rules that keep this safe:

- One branch and one PR per phase. Never let it work directly on `main`.
- Claude Code never touches the production AWS server or production database. All database work happens against the local Docker stack.
- You run the production commands in Part D yourself.

---

## Part B — Prompts for Claude Code

### Master prompt (paste once per session)

```
You are working in the Grid-IQ monorepo (JMC-Ventures). Read these files before doing anything:
- CLAUDE.md
- docs/planning/GRIDIQ_ORACLE_PLAN.md   (this plan; Part C is your spec)
- AUDIT_GAP_ANALYSIS.md                 (background only; the plan overrides it where they differ)

Context: Grid-IQ is a metering, electrical-analysis and advisory platform for South African
C&I sites. Acuvim II meters with AXM-WEB2 modules publish over MQTT. We are moving from
systemd + npx tsx on an AWS box to Docker Compose on an Oracle Cloud ARM VM in Johannesburg,
behind Caddy with a real domain, and making ingestion robust at 1-second resolution.
Later we add a portable meter fleet, projects, measurement points, deployments, an internal
ops console and a client portal.

Working rules:
1. Work only on the branch named in the phase prompt. Open a PR when the phase is complete.
   Never push to main, never force-push.
2. Never commit secrets. Every credential comes from .env files that are gitignored, with
   a matching .env.example containing placeholders only.
3. Never connect to or modify any production server or database. Test everything against
   the local docker compose stack.
4. Preserve existing behaviour unless the phase spec says to change it. In particular, do not
   weaken the timestamp provenance logic in services/ingestion-service/src/mqtt.ts
   (resolveReadingTime, MAX_BACKFILL_DAYS, ON CONFLICT guard, conflict counter, dead-letter).
5. Raw meter readings are immutable evidence. Never write code that updates or deletes rows
   in meter_readings except through an explicit, documented retention or migration step.
6. Every phase must leave `npm run build` and `npm test` green, and must pass the phase's
   acceptance criteria. Add tests for any logic you add (parsers, batching, attribution,
   aggregation maths, scoping).
7. When the spec is ambiguous or you find a conflict with existing code, stop and ask me,
   don't guess. When you find a bug outside the phase scope, list it in the PR description
   rather than fixing it silently.
8. At the end of each phase, update CLAUDE.md so it reflects the new reality (architecture,
   commands, env vars), and write a short "How to verify" section in the PR description.
Confirm you have read the files and summarise the current architecture in 10 lines before
starting any phase.
```

### Phase prompts (paste one at a time)

```
Execute Phase 0 (Security and repo hygiene) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-0-hygiene. Stop at the end and give me the list of credentials I must rotate.
```

```
Execute Phase 1 (Containerise and split roles) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-1-docker. The full stack must come up locally with `docker compose up -d --build`
and pass the acceptance criteria. Build images for linux/arm64 and linux/amd64.
```

```
Execute Phase 2 (Migrations) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-2-migrations. The baseline migration must work on BOTH an empty database and a
restored copy of the existing production schema.
```

```
Execute Phase 3 (1-second ingestion hardening) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-3-ingest. Include a load-test script that simulates 20 meters at 1 Hz plus a
store-and-forward replay burst, and report the measured results in the PR.
```

```
Execute Phase 4 (Aggregates and standards-correct alerting) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-4-aggregates.
```

```
Execute Phase 5 (Backups, monitoring, deploy scripts) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-5-ops. Then stop. I will do the go-live runbook in Part D before Phase 6.
```

```
Execute Phase 6 (Fleet, projects, measurement points, deployments: data model and API)
from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C. Branch: phase-6-fleet-model.
Write the data migration for existing sites and meters, and test it against a restored
production dump that I will place at ./local/prod.dump (gitignored).
```

```
Execute Phase 7 (Roles, tenant scoping, review workflow) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-7-scoping. Include tests proving a client user cannot read another tenant's data
through any endpoint.
```

```
Execute Phase 8 (Frontend: ops console and client portal) from docs/planning/GRIDIQ_ORACLE_PLAN.md
Part C and Part E. Branch: phase-8-frontend. Propose the page list and navigation first and
wait for my approval before building. Reuse existing components and charts; do not redesign
pages that the spec does not mention.
```

```
Execute Phase 9 (Public API and exports) from docs/planning/GRIDIQ_ORACLE_PLAN.md Part C.
Branch: phase-9-api. Generate an OpenAPI 3.1 spec and serve docs at /api/docs.
```

---

## Part C — Phase specifications

### Phase 0 — Security and repo hygiene

Tasks:

1. Stop tracking the Mosquitto runtime files and add them to `.gitignore`:
   - `git rm --cached mosquitto/config/passwd mosquitto/data/mosquitto.db mosquitto/log/mosquitto.log`
   - Add `mosquitto/config/passwd`, `mosquitto/data/`, `mosquitto/log/`.
   - Add `mosquitto/config/passwd.example` with instructions only, and no hash.
2. Remove hard-coded credential fallbacks:
   - `services/ingestion-service/src/main.ts`: the `DATABASE_URL` fallback containing `powerguard_password`. Search the whole repo for `powerguard_password`, `password123`, `demo123` and for any `|| 'postgres://` fallback.
   - Each service must **fail fast at startup** if `DATABASE_URL` or `JWT_SECRET` is missing. Keep the existing JWT length check.
3. Remove `apps/web/.env.production` (it hard-codes the AWS IP). Replace it with a build arg (Phase 1).
4. Delete the dead simulated-data pipeline in `services/ingestion-service/src/main.ts`:
   - The BullMQ `Queue`/`Worker` that inserts `Math.random()` readings.
   - `scheduleIngestion`.
   - The commented-out cron.
   - The `ioredis`/`bullmq` imports and dependencies.
   - Redis is not used anywhere else. Confirm with grep and state the result in the PR.
5. Gate the demo seed users (`services/auth-service/src/seed.ts`, `scripts/seed.ts`, `scripts/fix_password.ts`) behind `ALLOW_DEMO_SEED=true`. Remove demo credentials from README, CLAUDE.md and start.sh output.
6. Add `.env.example` at the repo root covering every variable used by any service. Remove duplicated `.env.example` content from the per-service folders or keep them in sync.
7. Add `gitleaks` (or equivalent) as a CI step.

Acceptance:

- `git grep -nE "powerguard_password|password123|demo123"` returns nothing outside `.env.example` placeholders.
- Starting any service without `DATABASE_URL` exits non-zero with a clear message.
- CI is green, including the secrets scan.
- The PR description lists every credential I must rotate in production: DB password, MQTT user(s), JWT secret, demo accounts, and any API keys in server `.env` files.

### Phase 1 — Containerise and split roles

Target runtime, one Docker Compose project:

| Service | Image | Exposed to internet | Notes |
|---|---|---|---|
| `caddy` | `caddy:2.8.x` (pin exact) | 80, 443 | TLS for `app.` and `mqtt.` hostnames |
| `web` | built from `apps/web` | no | Next.js, `next start` |
| `gateway` | built from `services/api-gateway` | no | behind Caddy at `/api` |
| `auth` | built from `services/auth-service` | no | |
| `api` | built from `services/ingestion-service`, `ROLES=api` | no | REST endpoints |
| `ingest` | same image, `ROLES=ingest` | no | MQTT → DB only |
| `jobs` | same image, `ROLES=jobs` | no | all `cron.schedule` work |
| `mosquitto` | `eclipse-mosquitto:2.0.x` (pin exact) | 8883 | TLS only |
| `timescaledb` | `timescale/timescaledb:<pinned>-pg16` | no | version must match production (see Part D) |
| `migrate` | same image as api, one-shot | no | Phase 2 |

Tasks:

1. **Role split in `services/ingestion-service/src/main.ts`.** This is the minimal change, not a rewrite.
   - Read `ROLES` (comma-separated, default `api,ingest,jobs` for local dev).
   - Only `ingest` calls `initMqtt(pool)`.
   - Only `jobs` registers the cron schedules. Move every `cron.schedule(...)` into a `registerJobs(pool)` function.
   - Only `api` calls `app.listen`.
   - The schema bootstrap IIFE stays for now (Phase 2 replaces it) but must not run in more than one role. Run it in `api` only, and make `ingest`/`jobs` wait until the DB is reachable.
2. **Dockerfiles.**
   - Multi-stage builds: `npm ci` with workspaces, `tsc` build, slim runtime stage, `node dist/main.js`, non-root user, `HEALTHCHECK` hitting `/health` where the service has one.
   - `ingest` and `jobs` get a lightweight health signal: a file touched on each successful flush or job, or a tiny HTTP `/health` on an internal port.
   - `apps/web`: Next.js standalone output (`output: 'standalone'` in `next.config.js`), with `NEXT_PUBLIC_API_URL` passed as a **build arg** because Next bakes it in at build time.
3. **`docker-compose.yml` rewrite.**
   - Pin every image to an exact version.
   - No `ports:` on anything except `caddy` (80/443) and `mosquitto` (8883).
   - All credentials via `.env`.
   - `restart: unless-stopped` everywhere.
   - `depends_on` with `condition: service_healthy` for the database.
   - Persistent data under `${DATA_DIR:-./.data}`: `pg/`, `caddy/`, `mosquitto/data/`, `mqtt-certs/`, `uploads/`.
   - Remove the `init.sql` mount (Phase 2 replaces it with migrations).
   - Remove `version:` (obsolete).
   - Add `docker-compose.override.yml.example` for local dev that exposes 5432 on `127.0.0.1` only.
4. **Uploads.**
   - `multer({ dest: 'uploads/' })` and `SLD_PDF_DIR` must resolve to `process.env.UPLOAD_DIR` (default `/data/uploads`), mounted as a volume.
   - Add a TODO in the PR for moving SLD PDFs to object storage later. Don't do it now.
5. **Caddyfile** (`deploy/caddy/Caddyfile`):
   ```
   {$APP_DOMAIN} {
       encode zstd gzip
       handle_path /api/* {
           reverse_proxy gateway:8081
       }
       reverse_proxy web:3000
   }
   {$MQTT_DOMAIN} {
       respond "Grid-IQ MQTT endpoint" 200
   }
   ```
   - The `MQTT_DOMAIN` block exists only so Caddy obtains and renews the certificate.
   - The frontend calls the API at `https://APP_DOMAIN/api`. Set `FRONTEND_URL=https://APP_DOMAIN` for gateway CORS.
   - Check every frontend `fetch` uses `NEXT_PUBLIC_API_URL`. There are about 40 call sites. Nothing may hard-code a host or port.
6. **Mosquitto** (`mosquitto/config/mosquitto.conf`):
   ```
   per_listener_settings false
   listener 8883
   certfile /mosquitto/certs/fullchain.pem
   keyfile  /mosquitto/certs/privkey.pem
   allow_anonymous false
   password_file /mosquitto/config/passwd
   acl_file /mosquitto/config/acl
   persistence true
   persistence_location /mosquitto/data/
   max_queued_messages 200000
   max_queued_bytes 0
   queue_qos0_messages true
   log_dest stdout
   ```
   - For local dev only, add a second listener on `127.0.0.1:1883` via the override file.
   - `acl` (template committed as `acl.example`):
     ```
     # meters: each user may only publish its own telemetry topic
     pattern write acuvim/%u/telemetry
     # ingest service
     user gridiq-ingest
     topic read acuvim/+/telemetry
     ```
7. **Certificate sync for Mosquitto** (`deploy/scripts/sync-mqtt-certs.sh`).
   - Caddy stores certificates under `${DATA_DIR}/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<MQTT_DOMAIN>/`.
   - The script copies the `.crt` and `.key` to `${DATA_DIR}/mqtt-certs/fullchain.pem` and `privkey.pem`, sets ownership to uid/gid 1883 (the mosquitto user in the official image) with mode 0640, and restarts the `mosquitto` container **only if the files changed**.
   - Intended to run from daily cron (Phase 5 installs it).
8. **Next.js upgrade.** Move `next` from 14.1.0 to the latest 14.2.x patch release, and fix anything that breaks. Do not move to Next 15 in this phase.
9. **Retire legacy runtime files.** Move `start.sh`, `deploy/systemd/*` and `deploy/scripts/{install,uninstall,healthcheck,status,logs,redeploy}.sh` into `deploy/legacy-aws/` with a README explaining they are for the old AWS box only until decommission.
10. **New deploy scripts** in `deploy/`:
    - `deploy.sh`: git pull, `docker compose build`, `docker compose run --rm migrate`, `docker compose up -d`, then a health summary.
    - `status.sh`.
    - `logs.sh <service>`.

Acceptance:

- `docker compose up -d --build` from a clean checkout plus `.env` brings every container to healthy.
- `docker compose ps` shows only caddy (80/443) and mosquitto (8883) with host ports. In local dev, the override adds 127.0.0.1-only ports.
- Stopping `api` does not stop ingestion. Prove it with a test publish while `api` is stopped.
- `docker buildx build --platform linux/arm64,linux/amd64` succeeds for every image.
- README and CLAUDE.md describe the new run model.

### Phase 2 — Migrations

Tasks:

1. Adopt `node-pg-migrate` (plain SQL migrations) in a `packages/db` workspace, or in `services/ingestion-service/migrations` if a new workspace is too disruptive. Explain the choice in the PR.
2. Write a **baseline migration** consolidating `init.sql` and every startup `CREATE/ALTER ... IF NOT EXISTS` block in `main.ts` and `mqtt.ts`.
   - It must be safe on an empty database **and** on a restored production database: use `IF NOT EXISTS` and conditional DDL inside the baseline only.
   - From the next migration onward, migrations are normal and non-idempotent.
3. Add `btree_gist` and `pgcrypto` extensions in the baseline (Phase 6 needs `btree_gist`).
4. Remove the startup schema bootstrap from `main.ts` and `mqtt.ts`. Services must refuse to start if the database is behind the latest migration: check the migrations table and exit with a clear message.
5. The `migrate` compose service runs `migrate up` and exits. `deploy.sh` runs it before `up -d`.
6. Drop the `savings_ledger` table in a migration (zero code references; confirm with grep first).
7. Keep the existing compression policy semantics. Compression must start strictly later than `MAX_BACKFILL_DAYS`. Make both values come from one shared constant or config, and add a test that fails if compression ≤ backfill.

Acceptance:

- A fresh empty DB plus `migrate up` gives a working app.
- A restored copy of production (`./local/prod.dump`, gitignored) plus `migrate up` applies cleanly with no data change. Prove it with row counts before and after in the PR.
- No `ALTER TABLE` or `CREATE TABLE` remains in service startup code.

### Phase 3 — 1-second ingestion hardening

Current problems in `services/ingestion-service/src/mqtt.ts`:

- QoS 0 with a clean session, so messages published during an ingest restart are lost at the broker.
- Per-message `pool.connect()`, meter lookup join, single-row insert and up to six alert SELECTs. No backpressure.
- An unknown meter is logged and discarded rather than dead-lettered.
- Only 15 channels are stored.

Tasks:

1. **Durable session.**
   - Connect with `clientId: 'gridiq-ingest'` (from env), `clean: false`, and QoS 1 on the subscription.
   - Delay the PUBACK until the batch containing the message is committed. With mqtt.js you can override `client.handleMessage = (packet, done) => { ...; enqueue(packet, done) }` and call `done()` after the flush. Verify against the installed mqtt.js major version.
   - On a DB failure, do not ack. Let the broker redeliver.
2. **Batch writer.**
   - In-memory queue of parsed rows. Flush every `INGEST_FLUSH_MS` (default 1000) or `INGEST_FLUSH_ROWS` (default 500), whichever comes first.
   - Each flush is one multi-row `INSERT ... ON CONFLICT (meter_id, time) DO NOTHING RETURNING meter_id, time` in a transaction.
   - Rows not returned are conflicts and feed the existing `noteConflict`.
   - Bounded queue (`INGEST_MAX_QUEUE`, default 50,000). When full, pause message handling (backpressure) rather than dropping.
   - Graceful shutdown on SIGTERM: stop accepting, flush, ack, exit.
3. **Meter lookup cache.**
   - In-memory map, refreshed every 60 s and on cache miss.
   - Key by the topic segment. Match on meter `id::text`, then `serial_number`, then the new `mqtt_username` column (Phase 6 adds it; tolerate its absence now).
   - Unknown meter: dead-letter with `error_msg='unknown meter'`, not discard.
4. **Wider channel set.**
   - Add typed nullable columns through a migration for the AXM-WEB2 1-second parameters:
     - Per-phase L-N voltages (exist).
     - L-L voltages `voltage_ab/bc/ca`.
     - Per-phase currents (exist), plus neutral current.
     - Per-phase P/Q/S/PF.
     - THD V and I for all three phases.
     - Voltage and current unbalance.
     - Import/export kWh and kvarh registers.
     - Demand values if the meter publishes them.
   - Extend the parameter-name mapping in `mqtt.ts` accordingly. Keep it as a data table (param name → column), not a chain of `??`.
   - Put the mapping in its own module with unit tests built from real payload samples in `test/fixtures/`. Add at least one AXM-WEB2 array-format fixture and one dict-format fixture.
   - Unknown parameter names are counted and logged once per meter per hour, so we learn what the firmware sends.
5. **Remove per-message alert queries from the ingest path.**
   - Alert evaluation moves to Phase 4 (aggregate-based) plus an in-memory event detector (below).
   - Ingest only writes readings and feeds the event detector.
6. **In-memory event detector.**
   - Per meter and channel, track excursions beyond the configured thresholds (voltage below min or above max, frequency out of band).
   - Emit an event row when an excursion ends, or when it has lasted ≥ `EVENT_MIN_SECONDS` (default 3) and is still ongoing.
   - New table `pq_events`: `id, meter_id, type, started_at, ended_at, duration_s, extreme_value, threshold, samples, created_at`.
   - Note in code: 1-second telemetry cannot resolve sub-second dips. Those need meter event logs or waveforms.
7. **Load-test script** (`services/ingestion-service/test/load/simulate.ts`).
   - 20 simulated meters at 1 Hz over MQTT for 10 minutes, plus one meter replaying a 2-hour backlog as fast as possible with device timestamps.
   - Report: rows/s sustained, p95 time from publish to commit, DB CPU, conflicts, dead letters, and zero rows lost (compare expected vs actual counts).
8. **Kill test.** During the load test, `docker compose restart ingest`. Acceptance requires zero lost rows (QoS 1 + persistent session + broker queue).
9. **Payload-size logging.** Log average bytes per message per meter every hour. This feeds the cellular data budget for the portable fleet (Part E).

Acceptance:

- The load test shows zero lost rows, including across an ingest restart.
- p95 publish-to-commit is under 3 s at 20 meters × 1 Hz on a 4-OCPU ARM VM (or a stated local equivalent).
- All existing timestamp tests still pass. New tests cover the mapping table, batching, backpressure and the event detector.

### Phase 4 — Aggregates and standards-correct alerting

Tasks:

1. **Continuous aggregates** (migration), all from raw `meter_readings`:
   - `readings_1m`, with per channel: `avg`, `min`, `max`. For energy registers: `first(x, time)`, `last(x, time)`. Plus `count(*) AS n` (coverage; expect 60).
   - `readings_10m`: same pattern, used for NRS 048-2 voltage and THD assessment.
   - `readings_30m`: `avg(power_apparent_total)`, `avg(power_active_total)`, `max(...)` and `n`. Used for billed demand (kVA MDI). Computing it from raw keeps the average exact.
   - `readings_1h` and `readings_1d`, hierarchical from `readings_1m` if the pinned TimescaleDB supports it. Otherwise from raw.
   - Refresh policy `start_offset` must be ≥ `MAX_BACKFILL_DAYS` so replayed data is aggregated. `end_offset` = one bucket. Add a test or check that enforces the offset rule.
2. **Point the read endpoints at the aggregates.**
   - `/meters/:id/readings`, `/readings/aggregate`, `/meters/:id/demand`, `/meters/:id/monthly`, compliance endpoints and the AI context builder.
   - Choose the view from the requested range so the client gets about 300–700 points. Use raw data only for ranges ≤ 2 h.
   - Keep the response shapes unchanged so the frontend keeps working.
3. **Energy from registers.**
   - Monthly and period energy comes from register deltas (`last − first` per bucket, summed).
   - A negative delta is a register reset (typical when a portable meter is reset between deployments). Treat it as a break and flag it in a `data_quality` output. Never sum through it.
   - Keep the power-integration fallback (with the existing 900 s gap cap) only where registers are absent, and label which method was used.
4. **Alerting rework** (runs in the `jobs` role):
   - **Regulation and compliance alerts** are evaluated on `readings_10m`: voltage magnitude and voltage THD against NRS 048-2 limits.
     - Alert text must state it is a 10-minute value.
     - Single-sample wording such as "NRS 048 min" on 1-second data must be removed everywhere.
   - **Demand alerts** are evaluated on `readings_30m` against contracted MDI. The existing instantaneous MDI early warning can stay, with its existing careful wording.
   - **Events** come from `pq_events` (Phase 3). Alert on events by type and duration with per-site thresholds.
   - **Data-health alerts:** a meter silent for more than `METER_SILENT_MINUTES` (default 5); coverage below 95% in the last hour; clock drift (median `ingested_at − device_time` above 120 s or growing); rising conflict counts.
   - Dedupe in the jobs process (in memory, plus a uniqueness window in the DB), not per reading.
5. **THD_I.** Add current-THD assessment (it's ingested but never assessed, per audit finding #3). Report it against the site's declared limits, or as a trend if none are configured. Do not claim an NRS 048-2 limit for current THD. That standard covers voltage quality. Note IEEE 519 / NRS 048-4 context in the text only if a limit is configured.
6. **Retention configuration:**
   - Keep raw data in TimescaleDB, compressed after `COMPRESS_AFTER_DAYS`.
   - Make `MAX_BACKFILL_DAYS` and `COMPRESS_AFTER_DAYS` env-configurable, defaulting to 7 and 8. Document that the backfill window must cover the AXM-WEB2 buffer depth.
   - Do not implement the Parquet archive yet. Add a design note in `docs/planning/ARCHIVE.md` for when the database exceeds 100 GB.

Acceptance:

- Dashboard charts for 30 days load from aggregates. Show the query plan in the PR for one 30-day request.
- Every alert message states the averaging basis (10-min, 30-min, event duration).
- A test proves a register reset does not create negative or inflated monthly energy.

### Phase 5 — Backups, monitoring, deploy

Tasks:

1. **Backups.** Replace both existing backup implementations with one script, `deploy/scripts/backup.sh`.
   - Note: `deploy/scripts/backup-daily.sh` and `backup-restore.sh` use `docker exec -T`. `-T` is a `docker compose exec` flag, not a `docker exec` flag, so those scripts fail at the pg_dump step.
   - Run `docker compose exec -T timescaledb pg_dump -Fc` to a temp file.
   - Verify with `pg_restore --list`.
   - Upload to S3-compatible storage with `aws s3 cp --endpoint-url $BACKUP_S3_ENDPOINT` (works for Cloudflare R2 and OCI Object Storage).
   - Retention: 7 daily, 4 weekly, 6 monthly.
   - Write a status line to a log and a timestamp file.
2. **Restore drill.** `deploy/scripts/restore-drill.sh` downloads the latest backup, restores it into a throwaway `timescaledb` container (using `timescaledb_pre_restore()` / `timescaledb_post_restore()`), and prints row counts for key tables. Intended to run weekly from cron.
3. **Cron install script.** `deploy/scripts/install-cron.sh` installs: backup at 02:00 SAST daily, restore drill Sundays, cert sync daily, and `docker system prune` weekly with a safe filter.
4. **External health endpoint.**
   - `GET /api/health/deep` returns: DB reachable, latest migration applied, last ingest flush age, last backup age, number of meters silent.
   - Protect it with a static token header. It is for an external uptime monitor.
5. **Runbook.** `docs/RUNBOOK.md` covers deploy, rollback (previous image tag), restore, rotating MQTT credentials, adding a meter user, and reading logs.

Acceptance:

- The restore drill succeeds locally against a backup produced by `backup.sh` (using MinIO in compose for the test).
- `/api/health/deep` reports correctly when ingest is stopped (flush age grows).

`⏸ HUMAN CHECKPOINT — do Part D (go-live) now. Milestone A is complete when the checklist at the end of Part D is green.`

### Phase 6 — Fleet, projects, measurement points, deployments

See Part E for the product reasoning. This phase is the data model and API only.

New concepts:

| Entity | Meaning | Key fields |
|---|---|---|
| `tenants` (existing) | An organisation: Grid-IQ itself (`kind='internal'`) or a client such as Solareff (`kind='client'`) | add `kind`, `slug`, branding (exists) |
| `projects` | An engagement under a client tenant, typically one end-client's site | `tenant_id`, `name`, `end_client_name`, `address`, `gps`, `timezone` (default `Africa/Johannesburg`), `status` (`planned/active/completed/archived`), `starts_on`, `ends_on`, `tariff` link, `live_data_visible` (bool), `notes` |
| `measurement_points` | A place where a meter is (or was) connected | `project_id`, `name`, `role` (`incomer/sub_load/pv/bess/generator/other`), `parent_point_id` (hierarchy), `nominal_voltage_v`, `ct_primary_a`, `breaker_rating_a`, `declared_capacity_kva`, `contracted_mdi_kva` (incomer), `sort_order` |
| `devices` (evolve existing `meters`) | A physical fleet asset: one portable box | `code` (e.g. `GQ-M01`), `serial_number`, `model`, `comms_module` (AXM-WEB2), `firmware`, `mqtt_username`, `router_model`, `sim_iccid`, `calibration_due_on`, `status` (`in_stock/deployed/maintenance/retired`), `notes` |
| `deployments` | A device installed at a point for a time window | `device_id`, `measurement_point_id`, `installed_at`, `removed_at` (null = active), `ct_ratio_configured`, `pt_ratio_configured`, `power_sign` (+1/−1), `scale_correction` (default 1.0), `installed_by`, `commissioning` (jsonb checklist results), `photos` (later) |

Rules:

1. **Raw readings stay keyed by device** (`meter_readings.meter_id` = device id) and are never rewritten when a box moves. Attribution to a project or point is by time window through `deployments`.
2. **No overlaps.** Use exclusion constraints with `btree_gist`:
   - `EXCLUDE USING gist (device_id WITH =, tstzrange(installed_at, coalesce(removed_at, 'infinity')) WITH &&)`
   - The same on `measurement_point_id`: one active device per point.
3. **Corrections live in deployments, not in raw data.**
   - A PV meter with a reversed CT gets `power_sign = -1`.
   - A wrong CT ratio gets a `scale_correction`.
   - Point-level views apply them, and every correction is audit-logged (who, when, why).
4. **Point-level views** over each aggregate, e.g. `point_readings_1m`: join `readings_1m` to `deployments` on device and `bucket` in the window, apply sign and correction to power and energy columns, and expose `measurement_point_id`, `project_id`, `tenant_id`.
5. **Energy balance per project** (computed in the API, not stored):
   - Grid import/export come from the incomer.
   - PV generation comes from the `pv` point.
   - Site consumption = incomer import − incomer export + PV generation (+ BESS discharge − charge if a BESS point exists).
   - Unmetered remainder = site consumption − Σ(sub_load points).
   - Show "not available" rather than zero when a required point has no coverage in the period.
6. **Data migration** for existing data:
   - Each existing `site` becomes a `project` under its tenant. Keep `sites` as a compatibility view or keep the table and add a `project_id` link. Choose the least disruptive option and explain it.
   - Each existing `meter` becomes a `device`.
   - Create one `measurement_point` per existing meter (role `incomer` unless the meter profile says otherwise).
   - Create one open `deployment` from the meter's first reading time.
   - Move `site_settings` alert thresholds and `contracted_mdi_kva` to the project or point. Keep reading the old columns until Phase 8 switches the UI.
7. **Ingest topic.**
   - New devices use `acuvim/{mqtt_username}/telemetry`, where `mqtt_username` = device `code` lowercased (e.g. `gq-m01`). The Mosquitto ACL `pattern write acuvim/%u/telemetry` then enforces that a box can only publish as itself.
   - Old UUID topics keep working.
8. **Internal API endpoints** (internal roles only):
   - CRUD for projects, measurement points and devices.
   - `POST /deployments` (install), `POST /deployments/:id/remove`.
   - `GET /fleet`: every device with status, current deployment, last seen, coverage last 24 h, clock drift, payload bytes/day.
9. **Commissioning checklist** stored in `deployments.commissioning`, evaluated automatically during the first 15 minutes after install and visible in the ops UI:
   - Readings arriving with `time_source=DEVICE`.
   - Clock drift < 5 s.
   - All three phase voltages present and within ±10% of nominal.
   - Phase rotation / sequence plausible if the meter reports it.
   - Active power sign matches the point role (incomer import positive; PV generation positive after `power_sign`).
   - PF between 0.5 and 1.0 under load.
   - Current < CT primary.
   - Coverage ≥ 95%.

Acceptance:

- The migration runs cleanly on `./local/prod.dump`. Existing dashboards still show the same numbers for existing meters (compare totals for a sample month before and after).
- Moving a device from project A to project B in a test produces correct attribution on both sides, with no data copied.
- The exclusion constraints reject an overlapping deployment.

### Phase 7 — Roles, tenant scoping, review workflow

1. **Roles.**
   - Internal tenant: `super_admin`, `engineer`.
   - Client tenant: `client_admin`, `client_viewer`.
   - Map existing roles: `admin` → `client_admin`, `user`/`viewer` → `client_viewer`.
   - Keep `broker` working but hide it behind feature flag `FEATURE_BROKER` (default off). Do not delete `renewal.ts` or the broker pages.
2. **Central scoping** (audit finding #5).
   - One middleware builds `req.scope = { userId, tenantId, isInternal, role }` from the JWT.
   - All data access goes through repository functions that take `scope` and add the tenant filter. Internal users may pass an explicit `tenantId` to act on a client.
   - Remove ad-hoc tenant filters from routes as you move them.
   - Write tests that iterate over every route with a client token from tenant A and assert nothing from tenant B is returned.
   - Consider Postgres Row-Level Security as a second layer; propose it in the PR but don't implement it.
3. **Review workflow** for findings and recommendations.
   - Add `status` (`draft/in_review/published/dismissed`), `reviewed_by`, `reviewed_at`, `evidence` (jsonb: `measurement_point_id`, `from`, `to`, metric, query or calculation id, chart parameters) and `internal_notes` (never returned to client roles) to `recommendations`.
   - The AI and deterministic engines create **drafts**.
   - Client roles only see `published`.
4. **Reports:** a `reports` table with `project_id`, `period_start`, `period_end`, `status` (`draft/approved/published`), `approved_by`, `approved_at`, `pdf_path`, `dataset_id`. The share-token public report keeps working but only for published reports.
5. **Live data visibility.** If `projects.live_data_visible = false`, client roles see no telemetry for that project until a report is published. Default is true.
6. **Audit log table:** who changed deployments, corrections, published findings, and created or revoked API keys.

Acceptance:

- The cross-tenant test suite passes.
- A client user cannot see draft findings, internal notes or unpublished reports through any endpoint.

### Phase 8 — Frontend: ops console and client portal

Implement Part E's information architecture. Reuse the existing pages and components. Mapping:

| Existing | Becomes |
|---|---|
| `/admin`, `/admin/clients`, `/admin/leads` | `/ops` (internal home), `/ops/clients`, `/ops/leads` |
| `/dashboard` | `/portal` overview (client) and a per-project overview |
| `/dashboard/sites` | `/portal/projects` (client), `/ops/projects` (internal) |
| `/dashboard/sites/[id]` | `/portal/projects/[id]/points/[pointId]`, keeping all existing chart tabs |
| `/dashboard/analytics`, `health-check`, `recommendations`, `reports` | tabs inside a project: Demand, Power quality, Findings, Reports |
| `/dashboard/settings/*` | `/portal/settings` (branding, users, API keys); tariffs and alert thresholds move to project settings |
| `/dashboard/tools/pv-sizer`, the simulation tab, `/dashboard/savings`, `/dashboard/value` | hidden behind feature flags, off by default |
| `/broker` | behind `FEATURE_BROKER` |
| `/dashboard/sld` | project-level "Metering layout" (the SLD editor, with `MeterNode` bound to measurement points) |

New internal pages:

- `/ops/fleet`: the device list. Columns: code, status, project and point, last seen, 24 h coverage, clock drift, payload/day, calibration due. Filters by status. Click-through to device history (all past deployments).
- `/ops/deployments/new`: install wizard. Pick device → project → point (or create one) → CT/PT/sign config → live commissioning checklist that updates for 15 minutes.
- `/ops/review`: review queue for draft findings and reports with an evidence preview (the chart for the evidence window) and publish/dismiss actions.
- `/ops/data-health`: silent meters, dead letters (from `dead_letter_payloads`), unknown parameters, conflicts, register resets.

Frontend rules:

- Introduce a small data layer (TanStack Query) for new pages. Migrate old pages only when touched.
- Every chart and finding shows its interval basis and time zone.
- Client portal pages must not render internal-only fields even if the API accidentally returns them. API scoping is the primary control; this is defence in depth.

### Phase 9 — Public API and exports

1. **API keys** per client tenant.
   - Table `api_keys`: `id, tenant_id, name, prefix, key_hash (sha256), scopes text[], project_ids uuid[] (null = all), created_by, created_at, last_used_at, revoked_at`.
   - Key format `gq_live_<prefix>_<secret>`, shown once at creation.
   - Managed by `client_admin` in `/portal/settings/api`.
2. **Gateway** authenticates `Authorization: Bearer gq_live_...`, applies a per-key rate limit and passes `scope` downstream exactly like a JWT user with `client_viewer` rights limited to the key's scopes and projects.
3. **Versioned read-only endpoints** under `/api/v1`:
   - `GET /v1/projects`
   - `GET /v1/projects/{id}` (points, active deployments without internal fields)
   - `GET /v1/points/{id}/readings?interval=1m|15m|30m|1h|1d&from&to&format=json|csv`. Raw 1 s only if the scope includes `readings:raw`, and the range is capped.
   - `GET /v1/projects/{id}/energy-balance?from&to&interval=`
   - `GET /v1/projects/{id}/findings` (published only)
   - `GET /v1/projects/{id}/reports`, `GET /v1/reports/{id}.pdf`
   - `POST /v1/exports` → async job → `GET /v1/exports/{id}` returning a download URL. For large ranges, the jobs role writes a CSV or Parquet file to object storage.
4. **Dataset conventions,** documented in OpenAPI and in every CSV header comment:
   - Time zone, and the interval timestamp convention (period-ending, matching SA utility billing practice; state it explicitly).
   - Units, sign convention (import positive).
   - Coverage `n` per interval and quality flags (gap, register reset, correction applied).
   - Dataset id and version.
5. **OpenAPI 3.1** spec generated from route definitions and served at `/api/docs`.

---

## Part D — Go-live runbook (your steps)

> Figures for Oracle's free tier are as of mid-2026. Verify on Oracle's Always Free page.

### D1. Oracle account and VM

1. Sign up for Oracle Cloud with **home region South Africa Central (Johannesburg)**. The home region cannot be changed later.
2. Upgrade to **Pay As You Go** straight away. This removes idle reclamation and improves A1 capacity availability. You still pay nothing within Always Free limits. Create a **budget alert** (e.g. R50/month equivalent) under Billing.
3. Networking → create a VCN with a public subnet (the wizard does this).
4. Compute → create the instance:
   - Shape `VM.Standard.A1.Flex`, with the maximum your free allowance permits (historically 4 OCPU / 24 GB).
   - Image: Canonical Ubuntu 24.04 (aarch64).
   - Paste your SSH public key.
   - If you get "Out of host capacity", retry later or temporarily choose a smaller shape and resize later.
5. Networking → **Reserved public IP** → reserve one and attach it to the instance's VNIC (replacing the ephemeral IP).
6. Storage → create a **block volume** (e.g. 150 GB, within the 200 GB total including the boot volume), attach it as **paravirtualized**.
7. Subnet **Security List** ingress rules: TCP 22 (restrict to your IP if you can), TCP 80, TCP 443, TCP 8883 from `0.0.0.0/0`.

### D2. Prepare the VM

```bash
ssh ubuntu@<reserved-ip>
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Africa/Johannesburg

# Block volume → /data
lsblk                                   # find the new disk, e.g. /dev/sdb
sudo mkfs.ext4 /dev/sdb
sudo mkdir -p /data
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdb) /data ext4 defaults,_netdev,nofail 0 2" | sudo tee -a /etc/fstab
sudo mount -a && df -h /data

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
docker run --rm hello-world
```

Firewall note: Oracle's Ubuntu image ships iptables rules that reject most inbound traffic. Docker-published ports go through Docker's own FORWARD/DOCKER chains rather than the host INPUT chain. In practice the **OCI Security List** is your real perimeter, and internal services must simply not be published (Phase 1 ensures this). If 80/443/8883 don't respond after deploy, run `sudo iptables -L FORWARD --line-numbers` and look for a REJECT rule sitting above Docker's chains.

### D3. Domain and DNS

1. Buy the domain (e.g. a `.co.za`) and move DNS to Cloudflare (free).
2. Create A records pointing to the reserved IP:
   - `app.<domain>`: **DNS only** (grey cloud) at first. You can switch to proxied later with SSL mode "Full (strict)".
   - `mqtt.<domain>`: **DNS only, always.** Cloudflare's proxy does not carry MQTT.

### D4. Code and configuration on the server

```bash
# Read-only deploy key for the private repo
ssh-keygen -t ed25519 -f ~/.ssh/gridiq_deploy -N ""
cat ~/.ssh/gridiq_deploy.pub      # GitHub → repo Settings → Deploy keys → add (read-only)
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/gridiq_deploy
EOF

sudo mkdir -p /opt/gridiq && sudo chown ubuntu:ubuntu /opt/gridiq
git clone git@github.com:vitaltrading09/JMC-Ventures.git /opt/gridiq
cd /opt/gridiq
cp .env.example .env
# Edit .env: APP_DOMAIN, MQTT_DOMAIN, DATA_DIR=/data, POSTGRES_PASSWORD, JWT_SECRET,
# MQTT ingest credentials, OPENAI key, backup bucket settings.
# Generate secrets with:  openssl rand -hex 32
```

### D5. Production database version check (on the old AWS box)

```bash
docker exec powerguard-db psql -U powerguard_user -d powerguard_db -tAc \
  "SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
```

Pin `timescale/timescaledb:<that-version>-pg16` in `docker-compose.yml` before restoring. The versions must match for restore. You can upgrade the extension afterwards.

### D6. First start (empty database), certificates and MQTT users

```bash
cd /opt/gridiq
docker compose up -d timescaledb caddy
# Caddy obtains certs for app. and mqtt. — check:
docker compose logs caddy | grep -i certificate
bash deploy/scripts/sync-mqtt-certs.sh

# MQTT users: ingest service + one per meter box
docker compose run --rm mosquitto mosquitto_passwd -c -b /mosquitto/config/passwd gridiq-ingest '<strong-password>'
docker compose run --rm mosquitto mosquitto_passwd    -b /mosquitto/config/passwd gq-m01 '<strong-password>'
```

### D7. Migrate production data from AWS

On AWS (meters keep publishing to AWS meanwhile):

```bash
docker exec powerguard-db pg_dump -U powerguard_user -d powerguard_db -Fc -f /tmp/gridiq.dump
docker cp powerguard-db:/tmp/gridiq.dump ~/gridiq.dump
scp ~/gridiq.dump ubuntu@<oracle-ip>:/data/gridiq.dump
```

On Oracle (database container running, empty `POSTGRES_DB` created by the image):

```bash
cd /opt/gridiq
docker compose cp /data/gridiq.dump timescaledb:/tmp/gridiq.dump
docker compose exec timescaledb psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
docker compose exec timescaledb psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT timescaledb_pre_restore();"
docker compose exec timescaledb pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner /tmp/gridiq.dump
docker compose exec timescaledb psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT timescaledb_post_restore();"
docker compose run --rm migrate
bash deploy/deploy.sh
```

Some catalog warnings during a TimescaleDB restore are normal. Compare row counts against AWS for `meters`, `sites`, `meter_readings` (by month), `alerts` and `recommendations`.

The gap between this dump and meter cutover is covered in D9.

### D8. Smoke tests

1. Open `https://app.<domain>`, log in, and check the dashboards load with historical data.
2. From your laptop, send a test message:
   ```bash
   mosquitto_pub -h mqtt.<domain> -p 8883 --capath /etc/ssl/certs \
     -u gq-m01 -P '<pw>' -q 1 -t acuvim/gq-m01/telemetry \
     -m '{"V1":230.1,"V2":229.8,"V3":231.0,"I1":10,"I2":11,"I3":9.5,"Psum_kW":6.9}'
   ```
   Confirm the row appears. Confirm that publishing to another meter's topic is rejected by the ACL.
3. Run `curl -H "x-health-token: ..." https://app.<domain>/api/health/deep`.
4. Set up an external uptime monitor (any free uptime service) on the deep health URL, alerting to your email or phone.

### D9. Meter cutover (one meter at a time)

For each AXM-WEB2:

1. Set broker host `mqtt.<domain>`, port 8883, TLS on, username/password for that box, topic `acuvim/<username>/telemetry`, QoS 1, store-and-forward on, and NTP on.
2. Watch the ops/data-health view (or logs) for 15 minutes:
   - `time_source=DEVICE`
   - clock drift < 5 s
   - coverage ≥ 95%
   - no dead letters
3. If the module rejects the certificate (an old firmware trust store without ISRG Root X1), stop. Use a site gateway or a firmware update. **Do not** open plain 1883 to the internet.
4. After cutover, run a one-off backfill of the data written to AWS between the D7 dump and that meter's cutover. Dump `meter_readings` for that window and that meter on AWS, then restore into Oracle. `ON CONFLICT DO NOTHING` makes this idempotent. Ask Claude Code for a small `deploy/scripts/backfill-from-dump.sh` if you want it scripted.

From now on, meters only ever point at a hostname, so future server moves need no site visit.

### D10. Backups and cron

1. Create a Cloudflare R2 bucket (or an OCI Object Storage bucket, which is also S3-compatible) and an access key scoped to that bucket.
2. Put `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET` and the keys in `.env`.
3. Run `bash deploy/scripts/install-cron.sh`.
4. Run `bash deploy/scripts/backup.sh` once manually, then `bash deploy/scripts/restore-drill.sh`. **A backup you haven't restored is not a backup.**

### D11. Decommission AWS

After 7 days with all meters on Oracle, a passing restore drill and no gaps:

1. Take a final AWS dump and keep it in object storage.
2. Stop the AWS instance, wait a week, then delete it. Remove the old IP from anything that references it.

### Milestone A checklist

- [ ] `https://app.<domain>` serves the app over TLS. No service ports other than 80, 443 and 8883 are reachable from the internet. Check with `nmap` from outside.
- [ ] All meters publish over TLS with per-device credentials, and the ACL is verified.
- [ ] Restarting `ingest` loses zero readings (spot-check coverage around a restart).
- [ ] Charts for 30 days load from aggregates.
- [ ] Alerts state their averaging basis.
- [ ] Nightly backup is present in object storage and the weekly restore drill passes.
- [ ] External uptime monitor is alerting.
- [ ] All credentials from the Phase 0 list are rotated.
- [ ] AWS is stopped.

---

## Part E — Product and frontend recommendation

### E1. The model: who owns what

**Recommendation: own the platform, the fleet, the data pipeline and the interpretation. Give each client a branded, read-only portal and an API on top of it.** Don't choose between "we keep everything internal" and "the client gets a dashboard". Do both, with a review gate in between.

Why give clients like Solareff a portal and API:

- The portal **is** the product they're paying for. Without it, they download CSVs and the value moves into their spreadsheets and sizing tools. You become a data courier, and you're easy to replace.
- Live visibility builds trust during an audit: "the meter is in and data is arriving" matters to them on day one.
- The API is what lets a feasibility or EPC company plug you into their workflow. That makes you hard to remove.

Why keep the interpretation gated:

- Findings and recommendations are engineering advice. An unreviewed AI or algorithmic claim in a client's hands is a liability, and your name is on it.
- So: **live telemetry is visible immediately** (per-project switch), but **findings and reports are visible only after an engineer publishes them**. The deterministic engines and AI draft; a person approves. As confidence grows you can auto-publish specific low-risk finding types, such as data coverage or after-hours baseload.

Contract points to settle before the first paying client (get proper legal advice; I'm not a lawyer):

- The client owns its measurement data. You own the platform, models and methods.
- What derived data you may use in aggregate.
- Retention after the project ends.
- Because the meters sit on the **end-client's** premises (Solareff's customer), the end-client's consent to monitoring and data-sharing needs to be covered. In POPIA terms, get clear on who is the responsible party and who is the operator.

### E2. Hierarchy

```
Grid-IQ (internal tenant)
 ├── Fleet: GQ-M01 … GQ-M20 (portable boxes: Acuvim II + AXM-WEB2 + router + SIM)
 └── Client tenants
      └── Solareff (client tenant: client_admin / client_viewer users, API keys, branding)
           ├── Project: "ABC Foods – Germiston audit" (end client, address, dates, tariff)
           │    ├── Point: Incomer            ← deployment: GQ-M01, 2026-11-10 → open
           │    ├── Point: Sub-load – Cold rooms (parent: Incomer) ← GQ-M02
           │    └── Point: PV inverter output ← GQ-M03 (power_sign = +1 generation)
           └── Project: "XYZ Mall – baseline"
                └── Point: Incomer            ← GQ-M01 again, after it moved
```

The **deployment** is the key idea. A box is an asset. A point is a place. A deployment links them for a time window. When GQ-M01 moves from ABC Foods to XYZ Mall, nothing is copied or relabelled. History stays correct on both projects, and the box's own history shows every site it has been to.

### E3. Internal ops console (`/ops`)

This is your team's cockpit. Priorities in order:

1. **Fleet board.** Every box with status (in stock / deployed / maintenance), where it is, last seen, 24 h coverage, clock drift, data usage per day, and calibration due. Red/amber/green on health. This is what you look at every morning.
2. **Install wizard and commissioning.** Pick box → client → project → point → CT/PT/sign → live checklist for 15 minutes. It catches reversed CTs, wrong ratios, missing phases and unsynced clocks while the installer is still on site. With portable meters, most bad data comes from installation errors, and this view pays for itself.
3. **Review queue.** Draft findings and reports with their evidence charts. Publish, edit or dismiss. Internal notes stay internal.
4. **All projects.** Across every client: active, ending soon, coverage problems, report due.
5. **Data health.** Silent meters, dead letters, unknown parameters, register resets and duplicate-timestamp warnings. Most of this is already logged by the ingest code; it just needs a screen.
6. **Clients.** Tenants, users, branding, API keys, usage.

### E4. Client portal (`/portal`), e.g. what Solareff sees

1. **Projects list.** Status, dates, live tiles (current kW at incomer, today's kWh, data coverage), latest published report.
2. **Project page.**
   - A **metering layout** view: the SLD editor bound to measurement points. The incomer sits at the top, with sub-loads and PV hanging off it, each showing live values.
   - Tabs:
     - **Overview:** consumption, peak demand, PF and key numbers, each with its interval basis.
     - **Energy balance:** grid import/export, PV generation, site consumption, metered sub-loads, unmetered remainder. This is the view that makes three meters on one project more valuable than three separate meters.
     - **Load profile:** daily and weekly heatmaps, weekday/weekend, after-hours baseload.
     - **Demand:** 30-min kVA, MDI vs contracted, coincidence of sub-loads at the peak.
     - **Power quality:** 10-min NRS 048-2 assessment, events list with durations, unbalance, THD trends.
     - **Findings:** published only, each linked to its evidence chart.
     - **Reports:** published PDFs and share links.
     - **Exports:** choose interval and range. Download CSV, or get the API call that fetches the same thing.
3. **Settings.** Users, branding (already built), API keys (create, scope to projects, revoke).

Keep out of the portal by default: the PV sizer, solar/battery simulation, savings and value ledger. Your new direction says sizing belongs to the feasibility company. Keep them behind feature flags in case a client wants them later.

### E5. End-client access (Solareff's customer)

Start with **published-report share links** (already built) and optionally a per-project read-only share. Don't create end-client accounts until someone asks. It adds a third tenant level, plus support and consent complexity.

### E6. Portable fleet: practical items to design for now

- **Cellular data budget.** At 1 s, an AXM-WEB2 JSON payload with ~50 parameters is likely 1–3 KB, which works out to roughly 85–260 MB per box per day, or about 2.5–8 GB per box per month. Phase 3 logs the real payload size. Measure it on the first box before choosing SIM bundles. If it's too high, publish a core set at 1 s and the rest at 1 min.
- **Clock sync.** Enable NTP on every module and alert on drift (Phase 4). Timestamps are evidence.
- **Register resets** between deployments are expected. The platform handles them (Phase 4) instead of producing negative energy.
- **Per-box credentials.** The username is the box code (`gq-m01`), the topic is fixed by the ACL, and credentials stay with the box, not the project. Moving a box requires no broker change.
- **Asset fields** worth tracking from day one: meter serial, CT set used (sizes and serials), router IMEI, SIM ICCID and its data plan, calibration date.

### E7. Pricing shape (suggestion)

- **Per project:** set-up/installation fee plus per measurement point per week or month while deployed.
- **Report:** priced per report, or included in the project fee.
- **Portal and API:** included in the project fee. The API is a reason to choose you, not an upsell.
- **Ongoing monitoring** after an audit, with a box left in place: a monthly fee per point.
