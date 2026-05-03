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
| Cache / Queues | Redis + BullMQ |
| MQTT Broker | Eclipse Mosquitto, ports **1883** (TCP) / **9001** (WS) |
| AI | Anthropic Claude (recommendations), previously Gemini (chatbot — to be migrated) |

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
              TimescaleDB  Redis  Mosquitto
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
| `/dashboard` | Main dashboard with energy score, KPIs, alerts | ✅ Done |
| `/dashboard/sites` | Site + meter management | ✅ Done |
| `/dashboard/savings` | Savings breakdown with Recharts bar chart | ✅ Done |
| `/dashboard/recommendations` | AI recommendation cards | ✅ Done |
| `/dashboard/reports` | Monthly report card (light theme, PDF/print ready) | ✅ Done |
| `/dashboard/marketplace` | PV sizer / marketplace | ✅ Done |
| `/admin` | Admin overview | ✅ Done |
| `/admin/clients` | Client portfolio deep-dive (scores, sites, meters, leads) | ✅ Done |
| `/admin/leads` | Leads management | ✅ Done |

### Backend Services

| Service | Key Features | Status |
|---|---|---|
| `auth-service` | Register, login, tenant management, JWT | ✅ Done |
| `ingestion-service` | MQTT listener, meter readings, energy scoring, AI recommendations, alerts | ✅ Done |
| `api-gateway` | Proxy, CORS, rate limiting, helmet | ✅ Done |

### Key Backend Files

- `services/ingestion-service/src/mqtt.ts` — Full Acuvim II MQTT pipeline. Topic: `acuvim/{meter_id}/telemetry`. Supports both native dict and AXM-WEB2 store-and-forward formats. Writes to TimescaleDB, fires alerts, dead-letter queue for bad payloads.
- `services/ingestion-service/src/energy-score.ts` — Calculates energy score (0–100) from PF, THD, load factor, voltage quality. Stores in `site_scores` table.
- `services/ingestion-service/src/ai-recommendations.ts` — Claude-powered recommendation engine. Generates contextual recommendations per site based on score components.

### Report Page Architecture (`/dashboard/reports`)

- Light theme (`bg-slate-100`) using negative margin escape (`-m-4 sm:-m-6 lg:-m-8`) to break out of dashboard layout padding
- Print CSS injected via `useEffect` (creates/removes `<style id="pg-report-print">`)
- Sidebar hidden on print via `print:hidden` (Sidebar.tsx + layout.tsx)
- `getLookingAhead()` — evaluates 4 score components, returns advisory for the weakest
- Consumption bar chart uses `MOCK_CONSUMPTION` placeholder — **needs wiring to live data** (see Pending Tasks)
- Recharts `PieChart` donut: `innerRadius={58} outerRadius={84}`, centre label via absolute overlay

---

## Local Development Setup

### Prerequisites
- Docker Desktop installed and running
- Node.js 18+
- `mosquitto-clients` for MQTT testing (optional)

### First-time setup

**1. Create `.env` files** (not in git — copy from `.env.example`):

```bash
# Auth service
cp services/auth-service/.env.example services/auth-service/.env

# Ingestion service
cp services/ingestion-service/.env.example services/ingestion-service/.env
# Then add your ANTHROPIC_API_KEY to services/ingestion-service/.env
```

Create `services/api-gateway/.env`:
```env
JWT_SECRET=powerguard_dev_secret_change_in_production_min32
PORT=8081
FRONTEND_URL=http://localhost:3000
AUTH_SERVICE_URL=http://localhost:3001
INGESTION_SERVICE_URL=http://localhost:3002
```

Create `apps/web/.env.local`:
```env
NEXT_PUBLIC_API_URL=http://localhost:8081
```

> ⚠️ The JWT_SECRET **must be identical** across all three `.env` files.

**2. Start Docker infrastructure:**
```bash
docker compose up -d
# Wait 15 seconds for TimescaleDB to initialise
docker ps   # should show: powerguard-db, powerguard-redis, powerguard-mqtt
```

**3. Install dependencies:**
```bash
npm install
```

**4. Seed the database:**
```bash
DATABASE_URL="postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db" npx tsx scripts/seed.ts
```

**5. Start all services:**
```bash
npm run dev
# Starts: Next.js :3000, auth-service :3001, ingestion-service :3002, api-gateway :8081
```

**6. Open the app:** `http://localhost:3000`
Check `scripts/seed.ts` for demo login credentials.

### Test a meter reading via MQTT
```bash
mosquitto_pub -h localhost -u acuvim_meter -P change_me_in_production \
  -t "acuvim/YOUR_METER_UUID/telemetry" \
  -m '{"V1": 230, "I1": 50, "Psum_kW": 11.5, "PF": 0.95, "Freq_Hz": 50}'
```
Replace `YOUR_METER_UUID` with a meter UUID from the Sites page.

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

### 2. Wire AI chatbot context
- Update `/api/chat` endpoint to include energy score + top recommendations per site
- Chatbot currently has no site context — it answers generically
- Also: migrate chatbot from Gemini to Claude Sonnet

### 3. AWS Lightsail deployment
- Provision af-south-1 instance
- Set up Docker Compose with Caddy TLS
- Migrate secrets to SSM Parameter Store
- Point powerguard.co.za DNS

### 4. Security hardening
- Replace localStorage JWT storage with HTTPOnly cookies
- Ensure all ingestion-service endpoints validate JWT tenant scope
- Move all remaining hardcoded secrets to env vars

### 5. Stripe / billing integration
- Monthly subscription per site
- Webhook for payment events

---

## Code Conventions

- **API calls:** All frontend calls go through `NEXT_PUBLIC_API_URL` (the API gateway). Never call auth/ingestion services directly.
- **Auth:** JWT stored in localStorage (to be migrated to HTTPOnly cookies). Sent as `Authorization: Bearer <token>`.
- **Tenant isolation:** Every API query is scoped by `tenant_id` decoded from JWT.
- **Energy score colour thresholds:** `≥80` green, `≥60` amber/yellow, `<60` red.
- **Recharts:** Used for all charts. PieChart for donuts, BarChart for consumption. Always use `<Cell>` per bar for colour control.
- **Print/PDF:** Use `data-noprint="true"` on controls, `print:hidden` on sidebar. Print CSS injected via `useEffect`.
- **Tailwind dark mode:** Dashboard uses dark sidebar (`bg-slate-900`). Report page uses full light theme.
- **Type convention:** Derive complex display types (e.g. `TenantPortfolio`) locally in the page file — don't add them to shared packages unless reused 3+ places.

---

## Key Constants

```
MQTT topic:     acuvim/{meter_id}/telemetry
MQTT user:      acuvim_meter
DB name:        powerguard_db
DB user:        powerguard_user
SA grid factor: 0.92 kg CO₂/kWh
Avg SA tariff:  R2.50/kWh (used for savings estimates)
```

---

## Repository

GitHub: https://github.com/vitaltrading09/JMC-Ventures  
Primary branch: `main`
