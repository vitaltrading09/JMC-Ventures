# PowerGuard Enterprise Rebuild Plan

**Status:** Planning
**Owner:** Matthys Theron
**Last updated:** 2026-04-15

---

## 0. Strategic Direction

### Product vision (revised)
PowerGuard becomes the **trusted operations platform for industrial power & microgrid sites** — starting with rock-solid meter data ingestion and AI-driven power-quality recommendations, then expanding into **remote PLC monitoring & control** for microgrid operators.

Two customer archetypes, one platform:

1. **Energy consumers** (factories, farms, commercial sites) — want power quality visibility, tariff optimization, and AI recommendations to cut their bill.
2. **Control & microgrid companies** (PLC integrators, EPC contractors, O&M providers) — want a multi-site SCADA-lite layer: monitor PLCs, push setpoints, view control audit trails, and give their own clients a branded portal.

The same multi-tenant architecture serves both. The control layer becomes a paid add-on module.

### What will make this a success
| Lever | What it looks like |
|---|---|
| **Meter data you can trust** | Store-and-forward from site, TLS MQTT, idempotent writes, per-meter health monitoring. No silent drops. |
| **Actionable recommendations** | Not "your THD is 6%". Instead: "Install a 50kVAR harmonic filter at Panel B — payback 14 months, ROI calc attached". |
| **Standards-compliant reports** | One-click EN 50160, IEEE 519, and NRS 048 (South African) compliance reports. This is your moat for industrial clients. |
| **White-label for integrators** | Control companies can put their logo on the portal and resell to their microgrid clients. |
| **Fleet view for multi-site** | One screen to see every meter/PLC across every site — critical for O&M providers. |
| **Safety on control actions** | MFA, RBAC, dry-run mode, deadman timers, full audit trail. Control companies will not trust the platform without this. |

### Scope decisions for this rebuild
- **Drop Grid-X** entirely for now (placeholder code only; bring back as a module when ready)
- **Keep same AWS EC2** for now but harden it (see §4)
- **Keep Gemini API** for the chat widget; **add Claude** for heavy analysis work (see §5)
- **Rebuild the metering ingestion pipeline from scratch** (see §6)
- **Add PLC/control module as Phase 3** (see §9)

---

## 1. AWS & Infrastructure decisions

### Current state
- Single EC2 at `35.179.107.189` (London region, based on IP range)
- Docker Compose stack, manually deployed
- Self-hosted PostgreSQL + TimescaleDB in a container
- Mosquitto broker on same EC2, port 1883 unencrypted
- Public IP hardcoded in `apps/web/.env.production` and `start.sh`

### Keep the EC2? **Yes, with caveats.**
The server is fine. The *way* it's used is the problem. Fix these without migrating:

| Fix | Why |
|---|---|
| Register a domain (e.g. `powerguard.app`) and point via Route 53 | No more hardcoded IPs; easy DR later |
| Put Nginx or Caddy in front with Let's Encrypt TLS | Browser lock icon; required for prod |
| Move DB to a separate volume with automated EBS snapshots | Protects against container loss |
| Add CloudWatch agent for basic metrics | Free tier; catches problems early |
| Enable EC2 backups + rotate key pair | Standard hygiene |

### When to migrate (later, not now)
- **RDS PostgreSQL + TimescaleDB extension** when DB > 50GB or you have >3 paying clients
- **AWS IoT Core** when you hit >20 sites on Mosquitto (see §6)
- **ECS or EKS** only when you have multi-server deployments

### Gemini API key — keep, but split responsibilities
| Task | Model | Why |
|---|---|---|
| Chat widget, quick Q&A | **Gemini 2.5 Flash** (keep current) | Cheap, fast, good enough for conversational |
| Power quality analysis, report generation, root-cause | **Claude Sonnet 4.6** (add) | Far better at engineering reasoning, longer context for meter data |
| Control recommendations (PLC setpoints) | **Claude Opus** (later) | Highest stakes; best reasoning |

Rotate the current Gemini key since it's been in .env files that may have been committed. Generate fresh keys in a new Google Cloud project with usage caps.

---

## 2. Files & code to DELETE

### Immediate deletion — one-off junk scripts
```
definitive_fix.js
final_cleanup.js
final_fix.js
final_fix2.js
fix_api_urls.js
fix_quotes.js
fix_quotes2.js
update_urls.js
context_test.txt
test-parser.js        ← after we verify new parser covers these cases
test_import.csv       ← move to services/ingestion-service/test/fixtures/
```

### Delete the Grid-X module entirely
```
services/gridx-service/                         (whole folder)
apps/web/... any GridX UI components
docker-compose.yml                              (remove gridx-service)
init.sql                                        (remove power_kw_draw, power_kw_gen cols)
```

### Delete dev/demo backdoors
```
services/auth-service/reset-password.js         (prod leak risk)
apps/web/... remove demo credential prefill buttons on login page
scripts/seed-demo-*.js                          (keep only a minimal seed)
```

---

## 3. Things to REDO from the ground up

### 3.1 Secrets management
- Remove **every** hardcoded credential from source (MQTT pwd, JWT secret, DB URL, API key)
- Introduce a single `.env.example` per service documenting every variable
- Use AWS SSM Parameter Store for production secrets; `.env` only for local dev
- Add a `check-secrets.sh` CI gate that greps for `password`, `secret`, `api_key` hardcoded patterns

### 3.2 Authentication & session handling
- **HTTPOnly, Secure, SameSite=Strict cookies** — remove localStorage token storage entirely
- Short-lived access tokens (15 min) + refresh tokens (7 days)
- **JWT validation middleware on every protected endpoint** in every service (not just auth-service)
- **Tenant isolation middleware** — every DB query must be scoped by `tenant_id` from the JWT, enforced at the API boundary, not just in SQL
- Add TOTP-based 2FA (required for admin and control actions)
- Rate limit per user, not just per IP

### 3.3 API layer
- Standard error envelope: `{ error: { code, message, requestId } }`
- Consistent REST naming (`/api/v1/sites/:id/meters` not mixed patterns)
- OpenAPI 3.1 spec generated from code (Zod → OpenAPI)
- API versioning via URL prefix `/api/v1/`
- Pagination on every list endpoint (cursor-based for time-series)

### 3.4 Logging & observability
- **Pino** structured JSON logs on every Node service
- Request ID propagation across services (trace individual requests end-to-end)
- Ship logs to CloudWatch Logs (free tier generous)
- Add Sentry for error tracking (free tier = 5k events/month)
- Health check endpoint `/health` returning DB + Redis + MQTT broker status on every service

### 3.5 Database
- Migration tool (**node-pg-migrate** or **Knex**) — no more editing `init.sql`
- Automated daily backups to S3 (lifecycle to Glacier after 30 days)
- TimescaleDB retention policy: drop `meter_readings` older than 2 years, compress after 7 days
- Add indexes on the fields alerts & dashboards actually query (not just `(meter_id, time)`)
- Enforce foreign keys where performance allows (everywhere except the hypertable)

---

## 4. Security hardening checklist

Each item becomes a task; no ship without all green.

- [ ] All secrets in env vars / SSM, none in source
- [ ] TLS everywhere (web, API gateway, MQTT, admin endpoints)
- [ ] HTTPOnly cookies; no tokens in localStorage
- [ ] JWT verified on every service, not just gateway
- [ ] Tenant isolation middleware on every read/write
- [ ] 2FA required for admin & control actions
- [ ] Input validation via **Zod** on every endpoint (body, query, params)
- [ ] CSRF protection on state-changing endpoints
- [ ] SQL only via parameterized queries (no string concat anywhere)
- [ ] File upload: MIME check, size cap, virus scan, S3 offload
- [ ] CSP + COOP + COEP headers on web app
- [ ] Audit log table: who did what, when, from where, for every tenant write action
- [ ] Dependency vulnerability scan in CI (`npm audit`, `pip-audit`)
- [ ] Secret scanning in CI (gitleaks)
- [ ] Penetration test checklist before first paying customer

---

## 5. Metering ingestion rebuild (your priority — foolproof Acuvim II → AWS)

This is where your previous build fell over, so we spec it in detail.

### 5.1 Target architecture

```
Remote Site                      AWS                         Database
┌────────────────┐     TLS      ┌──────────────┐          ┌────────────┐
│ Acuvim II      │    MQTT      │  Mosquitto   │  Queue   │ TimescaleDB│
│ + AXM-WEB2     │─────────────▶│  (auth+TLS)  │─────────▶│ hypertable │
│ store & fwd    │   port 8883  │  port 8883   │          │            │
└────────────────┘              └──────┬───────┘          └─────▲──────┘
                                       │                        │
                                       ▼                        │
                                ┌──────────────┐  BullMQ  ┌─────┴──────┐
                                │ ingestion    │          │ validator  │
                                │ subscriber   │─────────▶│ + writer   │
                                └──────────────┘          └────────────┘
                                                                │
                                                                ▼ on failure
                                                          ┌──────────────┐
                                                          │ Dead-letter  │
                                                          │ S3 bucket    │
                                                          └──────────────┘
```

### 5.2 On-meter config (Acuvim II + AXM-WEB2)
Ship a **one-page install guide** for the electrician. No code required on site:

1. Set AXM-WEB2 to MQTT publish mode
2. Broker: `mqtt.powerguard.app:8883` (TLS)
3. Client ID: `meter-<serial-number>` (unique per device)
4. Username: `meter-<serial-number>` / Password: one-time onboarding token
5. Topic: `powerguard/v1/tenants/<tenant>/sites/<site>/meters/<serial>/telemetry`
6. Publish interval: 10 seconds (configurable server-side later)
7. Parameters to publish: V1/V2/V3, I1/I2/I3, Psum_kW, Qsum, PF, Hz, THD_V/I, kWh_imp/exp
8. **Enable store-and-forward** (most important setting) — AXM-WEB2 buffers up to 24h of data locally when internet drops
9. QoS 1 (at-least-once delivery)

Provide a QR-code sticker for each meter linking to its onboarding page on the portal.

### 5.3 Broker: Mosquitto with TLS + per-device auth
- Port **8883** (TLS only); close 1883
- Let's Encrypt cert via Certbot, auto-renewed
- Per-device credentials (not shared `acuvim_meter` password)
- Password file managed via portal: add/revoke a meter = regenerate password file
- ACL file: each meter can only publish to its own topic
- **Mosquitto bridge later** → AWS IoT Core when scale demands it

### 5.4 Subscriber service (rebuild from current `mqtt.ts`)
Key changes vs current code:

| Current | New |
|---|---|
| Hardcoded creds | Env vars + SSM |
| Single flat parser | Pluggable codec registry (Acuvim, Schneider, Janitza, generic JSON) |
| Silent drop on parse fail | Push raw payload to S3 dead-letter bucket with error reason |
| Silent drop on unknown meter | Auto-register meter in pending state; notify admin |
| INSERT no conflict handling | `INSERT … ON CONFLICT (meter_id, time) DO NOTHING` (idempotent) |
| No backpressure | BullMQ with rate limit per meter, max 1000 jobs queued per meter |
| No health tracking | Update `meters.last_seen_at` on every message; alert if stale > 5× publish interval |
| Single concurrency | Partition workers by tenant hash for fairness |

### 5.5 CSV import (keep as fallback for historic data loads)
Rebuild `/ingestion/upload`:
- Per-row validation with Zod; report bad rows, commit good ones
- Background job for large files (>10k rows); show progress in UI
- Deduplicate on `(meter_id, time)` via same ON CONFLICT path
- Accept ZIP of multiple CSVs
- Preview step in UI before commit

### 5.6 Meter health monitoring (new feature, high customer value)
A new `meter_health` view:
- Last seen timestamp
- Expected vs actual publish rate
- Gap report (where data was missing over last 24h)
- Payload quality score (missing fields, out-of-range values)
- Firmware version of AXM-WEB2 (publish in a separate metadata topic)

Show on a dedicated "Fleet Health" page — every site at a glance, red/amber/green per meter. **This is a killer feature for multi-site operators.**

---

## 6. Things to ADD (new features, grouped by value)

### 6.1 Trust & enterprise table-stakes
- [ ] Audit log viewer (every tenant action, exportable CSV)
- [ ] Data export: CSV + Parquet downloads for any time range
- [ ] User session management (view active sessions, force logout)
- [ ] Tenant data deletion (GDPR-style)
- [ ] SLA-style status page (`status.powerguard.app`)
- [ ] Email + SMS alert delivery (Twilio or AWS SNS)
- [ ] PDF report generation (monthly tenant power quality summary)

### 6.2 Analytical moat
- [ ] **EN 50160 compliance report** — voltage magnitude, harmonics, flicker, unbalance
- [ ] **IEEE 519 harmonic compliance** — THD & individual harmonic limits by voltage class
- [ ] **NRS 048 (South African) report** — your home-market differentiator
- [ ] Tariff optimizer: given recent usage, which Eskom/municipal tariff saves the most?
- [ ] Capacitor bank sizing recommendation with ROI
- [ ] Harmonic filter sizing recommendation
- [ ] Baseline vs actual savings tracker (proves your 10% fee)

### 6.3 AI layer (two-tier)
- [ ] **Tier 1 — Chat widget (Gemini Flash)**: quick Q&A on current meter data, "what's my peak today?"
- [ ] **Tier 2 — Deep analysis (Claude Sonnet 4.6)**: monthly report narrative, root-cause of anomalies, recommendations with engineering rationale
- [ ] AI recommendations always cite the data they're based on (no black-box output)
- [ ] Feedback loop: user rates each recommendation; fine-tune prompts over time

### 6.4 White-label for control companies
- [ ] Custom logo, favicon, and primary colour per tenant
- [ ] Custom domain support (`portal.integrator-co.com` → their tenant)
- [ ] Reseller admin role (can create sub-tenants for their own clients)
- [ ] Billing rollup (integrator sees total across their clients)

---

## 7. Test & CI plan

### Unit tests
- Vitest for TS services, pytest for Python (when gridx replacement eventually added)
- 70% line coverage gate

### Integration tests
- Docker-compose based test harness
- Seed a tenant, publish MQTT messages, assert rows in DB
- Run on every PR

### E2E
- Playwright against staging env
- Critical paths: login → import CSV → see chart → generate report → download PDF

### CI/CD (GitHub Actions)
- Lint + typecheck + unit + integration on every PR
- Deploy to staging on merge to `main`
- Manual approval to prod
- Rollback via re-deploying previous image tag

---

## 8. Phased execution plan (keep the current site alive while rebuilding)

### **Phase 1 — Stabilize & secure (weeks 1–2)**
Goal: what you have, but safe.
- Delete junk files & Grid-X (§2)
- Extract all secrets to env / SSM (§3.1)
- HTTPOnly cookies, remove localStorage (§3.2)
- JWT middleware on ingestion service (§3.2)
- TLS termination in front of everything (Caddy + domain name)
- Mosquitto on 8883 with proper per-device auth (§5.3)
- Remove demo credentials from login UI

### **Phase 2 — Metering pipeline rebuild (weeks 3–4)**
Goal: meter data you can bet the business on.
- Pluggable codec subscriber (§5.4)
- Idempotent writes with ON CONFLICT
- Dead-letter S3 bucket
- Meter health page & fleet view (§5.6)
- CSV import redone with per-row validation (§5.5)
- One-page Acuvim II install guide (§5.2)

### **Phase 3 — Enterprise foundation (weeks 5–6)**
Goal: something an enterprise buyer will sign for.
- Structured logging + Sentry + CloudWatch (§3.4)
- OpenAPI spec + Zod validation everywhere (§3.3, §4)
- Audit log table + viewer (§6.1)
- 2FA, password reset, session mgmt (§3.2)
- Email/SMS alerts (§6.1)
- Automated DB backups & migrations (§3.5)

### **Phase 4 — Analytical moat (weeks 7–8)**
Goal: the thing customers actually pay for.
- EN 50160, IEEE 519, NRS 048 reports (§6.2)
- Tariff optimizer
- Claude-powered monthly narrative reports (§6.3)
- Capacitor/filter sizing recommendations

### **Phase 5 — Control & microgrid module (weeks 9–12)**
Goal: open the control-company market.
- PLC connector service (Modbus TCP + OPC UA first)
- `sites.type` = `monitoring` | `control` | `microgrid`
- Control tab per site: read points, write points, schedules
- Control audit trail (separate table, append-only)
- Dry-run mode + MFA on every write
- Microgrid-specific dashboards (BESS SoC, genset status, PV curtailment)
- White-label theming (§6.4)

### **Phase 6 — Scale & polish (ongoing)**
- AWS IoT Core migration when Mosquitto strains
- Managed Postgres (RDS) when DB volume demands
- SOC 2 prep when first enterprise deal requires it
- Mobile app (React Native) for operators

---

## 9. PLC / microgrid integration (answering your specific question)

**Yes — this is a natural extension, and arguably a better market than pure energy consumers.** Control companies already have customer trust and recurring O&M contracts; you give them a portal to sell their clients. Architecture decisions:

### Where PLC data fits
- A PLC is modelled as a **meter of a different type** in the DB (`devices` table generalising `meters`)
- Data points (tags) are rows in a new `device_points` table
- Time-series data goes to the **same hypertable** with a wider schema or an EAV side-table
- Control actions go to a **separate append-only `control_actions` table** with full audit (user, timestamp, point, from-value, to-value, justification)

### Protocols to support, in order
1. **Modbus TCP** — ubiquitous, every PLC supports it, simplest
2. **OPC UA** — industrial standard; pairs well with Siemens, Schneider, Rockwell
3. **MQTT Sparkplug B** — increasingly the modern microgrid default (EMP2 uses it)
4. **BACnet** — only if you target buildings (probably not your market)
5. **Native integrations** — Schneider EcoStruxure, SMA ennexOS, Victron VRM, etc. — via their REST APIs

### Edge architecture
For sites without always-on internet or for safety-critical control, deploy a **PowerGuard Edge agent** (Node.js + containerized) on an IPC or Raspberry Pi 4 at the site:
- Local Modbus/OPC UA polling
- Local MQTT cache (store-and-forward)
- Local rule engine that still works during internet outage
- Secure tunnel back to cloud (tailscale or AWS IoT secure tunnels)

This is what gives you credibility with control companies. A pure-cloud offering will not be trusted for anything involving contactors, genset starts, or BESS commands.

### Safety features (non-negotiable for control)
- **MFA on every write action** — not just login
- **Dry-run mode** — simulate the write, show what would happen, require confirmation
- **Deadman timer** — automatic rollback to safe setpoint if operator loses connection
- **Per-point write permissions** — some points are read-only, some require two-person approval
- **Rate limits on writes** — no runaway setpoint changes
- **Full control audit** — every write logged, immutable, exportable for incident review

### Pricing model that fits
- Monitoring-only tenants: existing 10% savings model OR flat SaaS fee
- Control tenants: per-site-per-month (e.g. R2,500/site/month), or per-tag-per-month for large deployments
- Integrator white-label: 20% reseller margin, min 5 sites

---

## 10. Locked-in decisions (2026-04-15)

1. **Domain:** `powerguard.co.za` — register via a SA registrar (e.g. domains.co.za, Afrihost) and manage DNS in Route 53
2. **First customer target:** **Energy consumers.** Control companies become a **partnership / integration channel** later — they resell PowerGuard, we don't try to sell direct to them first
3. **Pricing:** **Flat SaaS** (per-site-per-month tiers). Cleaner to forecast, easier enterprise buy-in, easier to justify than 10%-of-savings
4. **Hosting region:** Migrate to **`af-south-1` (Cape Town)** — lower latency for SA clients, data locality story for enterprise
5. **Budget:** Minimal at start — use free tiers wherever possible. Priority spend order when budget frees up:
   1. Domain + TLS (~R200/yr) — essential
   2. Claude API — only when Phase 4 reports ship (pay-per-use, no fixed cost)
   3. Sentry free tier (5k events/mo) — sufficient until paying customers
   4. Twilio / AWS SNS — only when email/SMS alerts ship
   5. RDS — only when DB outgrows self-hosted

### Implications of these decisions
- **Energy-consumer-first** sharpens Phase 4: prioritize NRS 048 report, tariff optimizer, and residential-to-industrial scaling. These sell themselves to factories and farms.
- **Flat SaaS** means we remove the `savings_ledger` 10% model code and replace with a simple `subscription_plans` + `tenant_subscriptions` schema
- **`af-south-1` migration** is part of Phase 1 (we're rebuilding anyway; don't set up infra in London then move)
- **Minimal budget** means: no paid Sentry, no Twilio yet, defer RDS, use Let's Encrypt (free), use SES (cheap) over Twilio for email

---

## 11. Immediate next actions (once you sign off this plan)

1. Delete the 8 junk fix scripts + Grid-X folder → commit 1
2. Move secrets out of source → commit 2
3. Add HTTPOnly cookies + JWT middleware → commit 3
4. Stand up Caddy + domain + TLS → commit 4
5. Rebuild MQTT subscriber with new codec registry → commits 5–8
6. Publish fleet health page → commit 9
7. End of Phase 1.

Ready to start on Phase 1 Step 1 (cleanup) when you give the green light.
