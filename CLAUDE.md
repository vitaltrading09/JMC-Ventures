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
| Frontend | Next.js 14, TypeScript, Tailwind CSS, Recharts |
| Auth Service | Node.js + Express, JWT + bcrypt, port **3001** |
| Ingestion Service | Node.js + Express, MQTT listener, AI engine, port **3002** |
| API Gateway | Node.js + Express, reverse proxy, port **8081** |
| Database | PostgreSQL + TimescaleDB (hypertable for `meter_readings`) |
| MQTT Broker | Eclipse Mosquitto, ports **1883** (TCP) / **9001** (WS) |
| AI | OpenAI (recommendations, narratives, chat) |

---

## Architecture

```
Browser (Next.js :3000)
        │
        ▼
  API Gateway (:8081)
    ├── /auth/*  → auth-service (:3001)
    └── /ingestion/* → ingestion-service (:3002)
                            │
                    ┌───────┼───────┐
                    ▼       ▼       ▼
              TimescaleDB         Mosquitto
                            │
                     Acuvim II meters
                   (MQTT topic: acuvim/{meter_id}/telemetry)
```

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
| `/api/chat` | AI chat route (OpenAI — pending migration to Claude) | ✅ Done |

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
- Node.js 18+
- `mosquitto-clients` for MQTT testing (optional — on Windows use WSL)

### First-time setup

**1. Create `.env` files** (all gitignored). The root `.env.example` is the single
list of every variable; copy it and replace the placeholders:

```bash
cp .env.example .env                              # docker compose (POSTGRES_*)
cp .env.example services/auth-service/.env
cp .env.example services/ingestion-service/.env
cp .env.example services/api-gateway/.env
echo "NEXT_PUBLIC_API_URL=http://localhost:8081" > apps/web/.env.local
```

> ⚠️ `JWT_SECRET` (32+ chars) **must be identical** in every service. auth-service
> and ingestion-service exit at startup if `DATABASE_URL` or `JWT_SECRET` is
> missing; the gateway exits without `JWT_SECRET`. There are no credential
> fallbacks in code.

**2. Start Docker infrastructure:**
```bash
docker compose up -d
# Wait 15 seconds for TimescaleDB to initialise
docker ps   # should show: powerguard-db, powerguard-mqtt (Redis is no longer used)
```

**3. Install dependencies:**
```bash
npm install
```

**4. Seed the database (local dev only):**
```bash
ALLOW_DEMO_SEED=true DEMO_USER_PASSWORD='<choose one>' DATABASE_URL='<from your .env>' npx tsx services/auth-service/src/seed.ts
```
The seed scripts (`services/auth-service/src/seed.ts`, `scripts/seed.ts`,
`scripts/fix_password.ts`) refuse to run without `ALLOW_DEMO_SEED=true`. Never set it on a server.

**5. Start all services:**
```bash
npm run dev
# Starts: Next.js :3000, auth-service :3001, ingestion-service :3002, api-gateway :8081
```

**6. Open the app:** `http://localhost:3000`  
Log in as `demo@grid-iq.co.za` with the `DEMO_USER_PASSWORD` you chose.

### Test a meter reading via MQTT
```bash
mosquitto_pub -h localhost -u <mqtt-user> -P '<mqtt-password>' \
  -t "acuvim/YOUR_METER_UUID/telemetry" \
  -m '{"V1": 230, "I1": 50, "Psum_kW": 11.5, "PF": 0.95, "Freq_Hz": 50}'
```
Replace `YOUR_METER_UUID` with a meter UUID from the Sites page (shown in the MQTT config modal after adding a meter).

### Adding a real Acuvim II meter

1. Go to **Sites → Add Site** → fill in name/address
2. Modal auto-opens **Add Meter** — fill in the meter name, serial number, model
3. After saving, a **MQTT Config modal** appears with all values pre-filled — copy each into the Acuvim II web interface under `Communication → MQTT`
4. Set telemetry interval to 60s on the device
5. Within 60s the meter will appear live (green "Live" badge) in the Sites page

---

## Production Deployment (Pending)

Target: **AWS Lightsail** (af-south-1, Cape Town)

- Single Linux instance running full Docker Compose stack
- Caddy as reverse proxy with automatic TLS
- Domain: `powerguard.co.za` via Route 53 / Lightsail DNS
- Secrets via AWS SSM Parameter Store (not hardcoded)
- Old EC2 at `35.179.107.189` (London) — decommission after migration

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

### 3. AWS Lightsail deployment
- Provision af-south-1 instance
- Set up Docker Compose with Caddy TLS
- Migrate secrets to SSM Parameter Store
- Point powerguard.co.za DNS

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
- Mosquitto runtime files (`mosquitto/config/passwd`, `mosquitto/data/`, `mosquitto/log/`)
  are gitignored. Create the password file per machine (`mosquitto/config/passwd.example`).
- `apps/web/.env.production` was removed. `NEXT_PUBLIC_API_URL` is supplied at build
  time (on the legacy AWS box: `apps/web/.env.production.local`).
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
MQTT port:         1883 (TCP) / 9001 (WS)
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
