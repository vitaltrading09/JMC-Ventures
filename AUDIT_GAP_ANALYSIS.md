# VoltGuard — Codebase Gap Analysis

**Audit date:** 2026-07-25
**Repository:** `JMC-Ventures` (local dir `PowerGaurd`, product currently branded **Grid-IQ**)
**Audited against:** VoltGuard 4-Pillar target specification
**Method:** Full static read of `init.sql`, all 10 service TypeScript files (4,813 LOC), all 35 frontend files, gateway config, and package manifests. No runtime/DB introspection.

---

## 1. Executive Summary & Readiness Score

### Headline: **~30% ready**

The repository is a **working, well-built power quality monitoring SaaS** — but it is not the product described in the target specification. It is roughly one pillar of four, executed to a high standard, plus a solid platform foundation.

The critical thing to understand before planning: **the target spec is a business-model pivot, not a feature list.** The existing product sells *advisory* to facility owners. VoltGuard sells *verified risk reduction* to insurance brokers, with the facility owner as the beneficiary. Those need different data (documents and physical inspections, not just telemetry), a different buyer, and a different trust model (an underwriter must be able to audit a claim, which means immutability and third-party share links).

The good news is that the hardest and most defensible part — the deterministic, standards-referenced telemetry assessment engine — already exists and is genuinely strong. `power-quality.ts` measures against NRS 048-2 and NEMA MG-1 with no AI in the measurement path, which is exactly the property an underwriter needs. That engine is worth ~35 of the target's 100 points and it is largely built.

The bad news is that **three of the four pillars are effectively greenfield**, and the two that touch money (insurance tiers, fee splits) have zero code — not stubs, zero.

### Readiness by pillar

| Pillar | Weight | Ready | Evidence |
|---|---|---|---|
| 1. Document Compliance Vault | 25% | **5%** | Zero hashing, zero share tokens, zero expiry tracking. Only one PDF-per-site SLD backdrop on local disk. |
| 2. MQTT Telemetry & Health Engine | 25% | **70%** | Full pipeline, dead-letter queue, NRS 048-2 assessment, forecasting. Missing THD_I assessment, 15-min rollups, dip *events*. |
| 3. Physical Inspection & Unified Score | 25% | **20%** | Two scoring engines exist but neither matches the target's 100-point split. No physical inspection data model at all. |
| 4. Remediation Marketplace & Fee Split | 25% | **15%** | A recommendation→lead pipeline exists and works. No SOW, no projects, no invoicing, no fee split. |
| *Platform foundation (not a pillar)* | — | **65%** | Multi-tenant auth, gateway, TimescaleDB, print-ready report UI, white-labelling all working. |

**Weighted pillar readiness: (5 + 70 + 20 + 15) / 4 = 27.5%.** Adding credit for the reusable foundation puts the honest figure at **~30%**.

### The five findings that should change your plan

1. **There is no ORM and no migration tool.** Schema lives in `init.sql` *plus* idempotent `CREATE/ALTER ... IF NOT EXISTS` blocks inside a startup IIFE in `main.ts:37-231` and `mqtt.ts:11-44`. It works today because the schema is small. This spec adds ~12 tables and financial records — **that pattern will fail you.** There is no version tracking, no rollback, no down-migration, and a failed `ALTER` is caught and logged as non-fatal (`main.ts:223`), so the service will happily start against a half-migrated database. This is the single highest-leverage fix and it blocks everything else.

2. **`meter_readings.time` is set to `NOW()`, not the device timestamp** (`mqtt.ts:226`). The AXM-WEB2 store-and-forward buffer replays telemetry after an internet outage — all of it lands stamped with *arrival* time, in a burst. Consequences: (a) the `ON CONFLICT (meter_id, time) DO NOTHING` idempotency guard at `mqtt.ts:233` can essentially never fire, because a replayed packet gets a fresh timestamp; (b) post-outage data is plotted at the wrong time; (c) any insurance claim built on this timeline is challengeable. For a product whose output is evidence, this is a correctness bug, not a nitpick.

3. **THD_I is ingested but never assessed.** `mqtt.ts:159` extracts it, `meter_readings.thd_current_a` stores it, `main.ts:1229` returns it in the raw readings endpoint — and nothing else touches it. `power-quality.ts` judges `thd_voltage_a` only. The spec explicitly requires THD_I thresholds. The data is already flowing; only the assessment logic is missing. **Cheapest real win in this audit.**

4. **`savings_ledger` is a dead table.** Declared in `init.sql:170-186` with a `platform_fee_amount` column commented "10% of total_savings_amount". Zero code references anywhere in the repo. Someone designed a fee model, wrote the table, and never wired it. The target's 3%/8% split should replace it outright rather than extend it.

5. **Tenant isolation is enforced per-route, not centrally.** `authenticateToken` (`main.ts:509-528`) verifies the JWT and attaches `req.user` — but performs **no tenant scoping**. Every one of the 44 ingestion routes must remember to filter by `req.user.tenantId` itself. Most do. That is a per-route audit burden that grows with every endpoint, and the spec adds underwriter share-links that bypass JWT entirely. Centralise this before adding external access.

---

## 2. Feature Mapping — Current vs Target

### Tech stack (confirmed)

| Layer | Actual |
|---|---|
| Monorepo | npm workspaces (`apps/*`, `services/*`, `packages/*` — `packages/` declared but **does not exist**) |
| Frontend | Next.js 14.1 App Router, TypeScript, Tailwind, Recharts, ReactFlow (SLD editor), react-pdf |
| State management | **None.** Plain `useState` + `fetch` per page. No React Query, no Zustand, no SWR. |
| Services | 3 × Express — auth `:3001`, ingestion `:3002`, gateway `:8081` |
| DB access | **Raw `pg.Pool` + hand-written SQL. No ORM.** |
| Database | PostgreSQL + TimescaleDB, one hypertable (`meter_readings`) |
| Queue | Redis + BullMQ — `ingestionQueue` declared at `main.ts:234`, minimal use |
| AI | OpenAI (`pq-narrative.ts`, model via `OPENAI_MODEL`, default `gpt-5.4-nano`) + Anthropic SDK in web deps |
| Deploy | AWS Lightsail eu-west-2, PM2, **manual `scp` file copy** (server git credentials expired) |

### Pillar 1 — Digital Compliance Document Vault → **MISSING**

| Requirement | Status | Evidence |
|---|---|---|
| SHA-256 document hashing | ❌ Missing | `grep -i "sha256\|createHash\|crypto"` across all source → **0 hits** |
| SANS 10142-1 Master CoC storage | ❌ Missing | No document table exists |
| Solar/BESS supplementary CoCs | ❌ Missing | — |
| Municipal SSEG approvals | ❌ Missing | — |
| CAD SLD storage | ⚠️ Partial | `site_diagrams` (`main.ts:143-152`) stores a ReactFlow JSONB layout + **one** background PDF per site at `uploads/sld-pdfs/`. It is a diagramming tool, not a versioned document record. |
| Expiration tracking (12-mo thermal cycles) | ❌ Missing | No expiry column anywhere |
| Underwriter share tokens / QR | ❌ Missing | `grep -i "share_token\|expires_at"` → **0 hits** |

**Storage reality check:** `multer({ dest: 'uploads/' })` (`main.ts:1186`) writes to local disk on a single Lightsail instance with no object store, no backup, no integrity check, and no virus scanning. For CSV import that is tolerable. For legally significant compliance certificates backing an insurance discount, it is a blocker — one instance failure loses the vault.

### Pillar 2 — MQTT Telemetry & Health Engine → **STRONGEST (70%)**

| Requirement | Status | Evidence |
|---|---|---|
| MQTT ingestion pipeline | ✅ Done | `mqtt.ts` — topic `acuvim/+/telemetry`, TLS-capable, auto-reconnect |
| Multi-format payload parsing | ✅ Done | Native dict + AXM-WEB2 `device.readings[]`, ~40 key aliases (`mqtt.ts:146-159`) |
| Dead-letter queue | ✅ Done | `dead_letter_payloads` — nothing silently dropped. Good practice. |
| Active/Reactive power (kW/kVAR) | ✅ Done | `power_active_total`, `power_reactive_total` |
| Maximum Demand (kVA) | ⚠️ Partial | `power_apparent_total` stored; MDI alerts at `mqtt.ts:311-326`. But **instantaneous**, not the 30-min integrated demand utilities actually bill on. Known open issue. |
| Phase current imbalance | ✅ Done — *differs from spec* | See formula note below |
| THD_V | ✅ Done | Assessed at p95 vs 8% (`power-quality.ts:280-294`) |
| **THD_I** | ❌ **Ingested, never assessed** | Finding #3 above |
| Voltage dips/swells (NRS 048-2) | ⚠️ Partial | Counts *readings* outside band (`power-quality.ts:178-179`). NRS 048-2 classifies **events** by depth × duration. A 3-second dip and a 3-hour brownout are not distinguishable in the current model. |
| Sub-DB / asset-level metering | ❌ Missing | Meters attach directly to sites; no feeder hierarchy |
| **15-minute statistical rollups** | ❌ **Missing** | See below |

**Formula note (spec vs code).** The spec states `(I_max − I_avg) / I_avg × 100`. The code (`power-quality.ts:164-165`) implements `GREATEST(|Ia−Iavg|, |Ib−Iavg|, |Ic−Iavg|) / Iavg × 100` — max *absolute deviation* from mean, the NEMA definition. **The code is more correct than the spec** and matches what `power-quality.ts:304` claims. These diverge when the largest deviation is a phase running *low* rather than high. Recommend the spec be corrected to NEMA, not the code changed.

**Rollups — nothing is materialised.** `time_bucket` is used *ad hoc at query time* only: `pickBucketInterval()` (`main.ts:1262-1269`) picks 1min→6h buckets for charts, and `pq-forecast.ts:132` uses `date_trunc('week')`. There is **no continuous aggregate, no rollup table, no compression policy, and no retention policy.** Every LLM context build and every assessment re-scans raw hypertable rows. At 60s telemetry that is 43,200 rows/meter/month — survivable now, expensive at scale, and the spec's stated goal of cheap LLM context windows is unmet.

### Pillar 3 — Physical Inspection & Unified 100-Point Score → **20%**

There are **two** scoring engines today, and neither is the target's:

| Engine | Output | Stored in |
|---|---|---|
| `energy-score.ts` | Single 0–100 weighted composite of PF / THD / V-unbalance / V-quality, weights auto-selected by detected tariff type (MEGAFLEX/TOU/FLAT) | `energy_scores` |
| `power-quality.ts` | **Two** scores: `supply_score` (utility's fault) + `install_score` (client's fault) | `pq_assessments` |

The supply/install split is a genuinely good product idea — it tells the client what they can actually fix. **It does not map onto the target's 100-point structure**, which needs:

| Target component | Points | Current state |
|---|---|---|
| Document Vault & Legal Compliance | 25 | ❌ No data source exists |
| Telemetry & Power Quality Logging | 35 | ✅ Substantially covered by `power-quality.ts` |
| Physical Board Condition & DB Inspection | 25 | ❌ No data source exists |
| Active Surge & Earthing Readiness | 15 | ❌ No data source exists |

So: **35 of 100 points are computable today; 65 have no underlying data model.**

Missing entirely: spare tray capacity %, thermal packing, wiring congestion, terminal torque records, dead-front cover checks, Type 1/2 SPD presence and status, earth resistance readings. There is no inspection table, no inspector role, no mobile capture surface, no photo evidence store.

**Insurance discount tiers (75%→2.5%, 85%→5.0%, >90%→7.5%): zero code.** `grep -i "insur\|discount\|premium\|underwrit"` returns only an incidental prose mention in a code comment (`power-quality.ts:9`).

### Pillar 4 — Remediation Marketplace & Fee Split → **15%**

| Requirement | Status | Evidence |
|---|---|---|
| Findings → actionable items | ✅ Done | `recommendations` table + `ai-recommendations.ts` with a standards guardrail |
| Lead capture | ✅ Done | `POST /recommendations/:id/notify` → `leads` table → `/admin/leads` UI |
| Formal Scope of Work | ❌ Missing | No SOW entity. Recommendations carry `estimated_*_zar` but are advisory text, not quotable line items. |
| Partner/consultant registry | ❌ Missing | No partner table |
| Project tracking | ❌ Missing | `leads.status` is a single varchar — no lifecycle, no assignment, no completion evidence |
| Invoicing | ❌ Missing | — |
| **3% / 8% fee split** | ❌ Missing | Dead `savings_ledger.platform_fee_amount` only (finding #4) |
| Re-measurement / verification loop | ⚠️ Partial | `pq_assessments` history + `/value-ledger` prove *change over time*, but nothing links a completed remediation to the improvement it caused |

That last row is worth dwelling on. The commercial heart of this spec is *"we fixed it and here's the measured proof"* — that is what justifies both the fee and the insurance discount. The trend machinery to prove it **already exists** (`compareTrend`, `pq_assessments`, `/value-ledger`). It just isn't attached to a remediation record. Closing that loop is a small change with outsized commercial value.

### Multi-tenancy — **3 levels, spec needs 4+**

```
CURRENT:  tenants ──< sites ──< meters
TARGET:   organizations ──< sites ──< feeder_dbs ──< metering_points
```

`meters` has no parent-board concept. The spec's "Sub-DBs and heavy assets (VFDs, Compressors, Motors)" cannot be represented — a meter is either on a site or nowhere. Partial mitigation exists: `meters.load_types TEXT[]` and `load_description` (`main.ts:44-45`) capture *what* a meter watches, but not *where it sits in the reticulation*.

Also absent: a **broker** persona. Roles are `super_admin | admin | viewer` (`auth-service/src/main.ts`), all scoped to one tenant. An insurance broker who manages 40 client organisations has no representation.

---

## 3. Database Schema Migration Code

> **Format note:** the repo has **no Prisma/Drizzle/TypeORM** — it is raw `pg` with hand-written SQL. Deltas below are therefore plain PostgreSQL DDL, which is directly usable. Introducing Prisma now would mean rewriting all 44 route handlers and is *not* recommended mid-pivot.

> **Prerequisite — do this first.** Adopt a real migration tool (`node-pg-migrate` or `graphile-migrate`) and move the existing startup DDL into `migrations/000_baseline.sql`. Everything below assumes numbered, tracked, reversible migration files. Do not add these tables to the startup IIFE.

### 3.1 — Hierarchy: feeder DBs and metering points

```sql
-- migrations/001_hierarchy.sql

CREATE TABLE IF NOT EXISTS feeder_dbs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    parent_db_id        UUID REFERENCES feeder_dbs(id) ON DELETE SET NULL, -- reticulation tree
    name                VARCHAR(255) NOT NULL,      -- 'Main Incomer', 'DB-3 Workshop'
    db_type             VARCHAR(50) NOT NULL,       -- MAIN_INCOMER | SUB_DB | MCC | ASSET
    location_desc       TEXT,
    rated_current_a     NUMERIC(10,2),
    phases              SMALLINT DEFAULT 3 CHECK (phases IN (1, 3)),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feeder_dbs_site ON feeder_dbs (site_id);

-- Attach existing meters to a board. Nullable: legacy meters stay site-level
-- until an inspector assigns them, so this migration is non-breaking.
ALTER TABLE meters
    ADD COLUMN IF NOT EXISTS feeder_db_id UUID REFERENCES feeder_dbs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS asset_type   VARCHAR(50); -- VFD | COMPRESSOR | MOTOR | INCOMER | GENERAL
CREATE INDEX IF NOT EXISTS idx_meters_feeder ON meters (feeder_db_id) WHERE feeder_db_id IS NOT NULL;
```

### 3.2 — Pillar 1: Document Vault

```sql
-- migrations/002_document_vault.sql

CREATE TYPE sans_document_type AS ENUM (
    'MASTER_COC_SANS_10142_1',
    'SUPPLEMENTARY_COC_SOLAR',
    'SUPPLEMENTARY_COC_BESS',
    'MUNICIPAL_SSEG_APPROVAL',
    'SINGLE_LINE_DIAGRAM',
    'THERMAL_SCAN_REPORT',
    'EARTH_CONTINUITY_TEST',
    'SPD_INSTALL_CERT',
    'TRANSFORMER_TEST_REPORT',
    'INSURANCE_SCHEDULE',
    'OTHER'
);

CREATE TYPE document_status AS ENUM ('VALID', 'EXPIRING_SOON', 'EXPIRED', 'SUPERSEDED', 'REJECTED');

CREATE TABLE IF NOT EXISTS compliance_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    feeder_db_id        UUID REFERENCES feeder_dbs(id) ON DELETE SET NULL,

    doc_type            sans_document_type NOT NULL,
    title               VARCHAR(255) NOT NULL,

    -- Integrity. sha256_hash is the evidentiary anchor: an underwriter can
    -- re-hash the file they were shown and prove it is the one we certified.
    sha256_hash         CHAR(64) NOT NULL,
    file_size_bytes     BIGINT NOT NULL,
    mime_type           VARCHAR(100),
    storage_key         TEXT NOT NULL,          -- S3 object key (NOT a local path)
    storage_backend     VARCHAR(20) DEFAULT 'S3',

    -- Issuance & validity
    issued_date         DATE,
    expiry_date         DATE,
    issuer_name         VARCHAR(255),           -- e.g. registered person / installer
    issuer_registration VARCHAR(100),           -- ECB / Dept. of Labour reg. no.

    status              document_status NOT NULL DEFAULT 'VALID',
    supersedes_id       UUID REFERENCES compliance_documents(id) ON DELETE SET NULL,
    verified_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at         TIMESTAMPTZ,
    notes               TEXT,

    uploaded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_doc_hash_per_site UNIQUE (site_id, sha256_hash)
);

CREATE INDEX IF NOT EXISTS idx_docs_site_type ON compliance_documents (site_id, doc_type, status);
CREATE INDEX IF NOT EXISTS idx_docs_expiry    ON compliance_documents (expiry_date)
    WHERE status IN ('VALID', 'EXPIRING_SOON');

-- Recurring obligations (e.g. thermal scan every 12 months). Separate from the
-- document itself because the obligation exists even when no document does yet —
-- that absence is precisely what must cost the client points.
CREATE TABLE IF NOT EXISTS compliance_obligations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    doc_type            sans_document_type NOT NULL,
    interval_months     INTEGER NOT NULL,
    last_satisfied_at   DATE,
    next_due_at         DATE,
    is_mandatory        BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (site_id, doc_type)
);
CREATE INDEX IF NOT EXISTS idx_obligations_due ON compliance_obligations (next_due_at);

-- Time-limited, read-only underwriter access. Store only the HASH of the token,
-- never the token itself — a leaked DB must not yield working share links.
CREATE TABLE IF NOT EXISTS audit_share_tokens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    token_hash          CHAR(64) NOT NULL UNIQUE,   -- SHA-256 of the issued token
    label               VARCHAR(255),               -- 'Santam — renewal Aug 2026'
    recipient_email     VARCHAR(255),
    scope               JSONB NOT NULL DEFAULT '{"documents":true,"health_score":true,"telemetry":false}'::jsonb,
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_live ON audit_share_tokens (expires_at)
    WHERE revoked_at IS NULL;

-- Every underwriter view is logged. This is the audit trail that makes the
-- platform a clearinghouse rather than a file drive.
CREATE TABLE IF NOT EXISTS audit_share_access_log (
    id              BIGSERIAL PRIMARY KEY,
    token_id        UUID REFERENCES audit_share_tokens(id) ON DELETE CASCADE,
    accessed_at     TIMESTAMPTZ DEFAULT NOW(),
    ip_address      INET,
    user_agent      TEXT,
    resource        TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_access_token ON audit_share_access_log (token_id, accessed_at DESC);
```

### 3.3 — Pillar 3: Physical inspection + unified scoring

```sql
-- migrations/003_physical_inspection.sql

CREATE TABLE IF NOT EXISTS db_inspections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id                 UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    feeder_db_id            UUID REFERENCES feeder_dbs(id) ON DELETE CASCADE,

    inspected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    inspector_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    inspector_reg_no        VARCHAR(100),

    -- Board integrity (target: spare capacity > 15%)
    total_ways              INTEGER,
    used_ways               INTEGER,
    spare_capacity_pct      NUMERIC(5,2) GENERATED ALWAYS AS (
        CASE WHEN total_ways > 0
             THEN ((total_ways - used_ways)::NUMERIC / total_ways) * 100
             ELSE NULL END
    ) STORED,

    -- Graded observations: 0 = fail/absent, 5 = exemplary
    thermal_packing_score   SMALLINT CHECK (thermal_packing_score BETWEEN 0 AND 5),
    wiring_congestion_score SMALLINT CHECK (wiring_congestion_score BETWEEN 0 AND 5),
    labelling_score         SMALLINT CHECK (labelling_score BETWEEN 0 AND 5),
    terminal_torque_done    BOOLEAN DEFAULT false,
    terminal_torque_date    DATE,
    dead_front_intact       BOOLEAN,
    ip_rating_adequate      BOOLEAN,
    moisture_ingress        BOOLEAN DEFAULT false,
    rodent_evidence         BOOLEAN DEFAULT false,

    -- Surge & earthing (15-point pillar)
    spd_type1_present       BOOLEAN DEFAULT false,
    spd_type2_present       BOOLEAN DEFAULT false,
    spd_status_ok           BOOLEAN,             -- indicator window green?
    spd_install_date        DATE,
    earth_resistance_ohm    NUMERIC(8,3),        -- SANS 10142-1: target < 5 Ω
    earth_continuity_ok     BOOLEAN,
    bonding_adequate        BOOLEAN,

    -- Hottest measured termination — feeds directly into risk findings
    max_thermal_delta_c     NUMERIC(6,2),
    thermal_scan_doc_id     UUID REFERENCES compliance_documents(id) ON DELETE SET NULL,

    photos                  JSONB DEFAULT '[]'::jsonb,  -- [{storage_key, sha256, caption}]
    defects                 JSONB DEFAULT '[]'::jsonb,  -- [{severity, description, sans_clause}]
    notes                   TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspections_site ON db_inspections (site_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspections_db   ON db_inspections (feeder_db_id, inspected_at DESC);

-- The unified 100-point score. Immutable snapshot: an insurance discount granted
-- on a score must remain auditable even after the underlying data moves on.
CREATE TABLE IF NOT EXISTS site_health_scores (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id                 UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    calculated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    documents_score         NUMERIC(5,2) NOT NULL CHECK (documents_score  BETWEEN 0 AND 25),
    telemetry_score         NUMERIC(5,2) NOT NULL CHECK (telemetry_score  BETWEEN 0 AND 35),
    physical_score          NUMERIC(5,2) NOT NULL CHECK (physical_score   BETWEEN 0 AND 25),
    surge_earth_score       NUMERIC(5,2) NOT NULL CHECK (surge_earth_score BETWEEN 0 AND 15),
    total_score             NUMERIC(5,2) GENERATED ALWAYS AS (
        documents_score + telemetry_score + physical_score + surge_earth_score
    ) STORED,

    -- Provenance: which inputs produced this score. Required for audit.
    pq_assessment_id        UUID REFERENCES pq_assessments(id) ON DELETE SET NULL,
    inspection_id           UUID REFERENCES db_inspections(id) ON DELETE SET NULL,
    breakdown               JSONB NOT NULL,   -- per-criterion points awarded + why
    scoring_version         VARCHAR(20) NOT NULL DEFAULT 'v1.0',

    is_current              BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_health_site ON site_health_scores (site_id, calculated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_current ON site_health_scores (site_id)
    WHERE is_current;

-- Discount tiers as DATA, not hardcoded constants. Insurers will renegotiate
-- these, and a rate change must never require a redeploy or corrupt history.
CREATE TABLE IF NOT EXISTS insurance_discount_tiers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insurer_name        VARCHAR(255) NOT NULL,
    tier_name           VARCHAR(100) NOT NULL,
    min_score           NUMERIC(5,2) NOT NULL,
    max_score           NUMERIC(5,2),
    discount_pct        NUMERIC(5,3) NOT NULL,
    applies_to          VARCHAR(50) NOT NULL DEFAULT 'PROPERTY', -- PROPERTY | MACHINERY_BREAKDOWN | BOTH
    effective_from      DATE NOT NULL,
    effective_to        DATE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO insurance_discount_tiers
    (insurer_name, tier_name, min_score, max_score, discount_pct, applies_to, effective_from)
VALUES
    ('DEFAULT', 'Bronze', 75.00, 84.99,  2.500, 'BOTH', CURRENT_DATE),
    ('DEFAULT', 'Silver', 85.00, 89.99,  5.000, 'BOTH', CURRENT_DATE),
    ('DEFAULT', 'Gold',   90.00, 100.00, 7.500, 'BOTH', CURRENT_DATE)
ON CONFLICT DO NOTHING;

-- Issued certificates — what the broker actually acts on.
CREATE TABLE IF NOT EXISTS discount_certificates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    health_score_id     UUID NOT NULL REFERENCES site_health_scores(id) ON DELETE RESTRICT,
    tier_id             UUID NOT NULL REFERENCES insurance_discount_tiers(id) ON DELETE RESTRICT,
    certificate_no      VARCHAR(50) NOT NULL UNIQUE,
    score_at_issue      NUMERIC(5,2) NOT NULL,
    discount_pct        NUMERIC(5,3) NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until         DATE NOT NULL,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT,
    pdf_storage_key     TEXT,
    pdf_sha256          CHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_certs_site ON discount_certificates (site_id, issued_at DESC);
```

### 3.4 — Pillar 4: Remediation marketplace & fee split

```sql
-- migrations/004_marketplace.sql

CREATE TYPE sow_status AS ENUM (
    'DRAFT','QUOTED','APPROVED','IN_PROGRESS','COMPLETED','VERIFIED','CANCELLED'
);
CREATE TYPE routing_type AS ENUM ('PARTNER','IN_HOUSE');

CREATE TABLE IF NOT EXISTS partners (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name        VARCHAR(255) NOT NULL,
    contact_name        VARCHAR(255),
    contact_email       VARCHAR(255),
    contact_phone       VARCHAR(50),
    registration_no     VARCHAR(100),
    ecb_reg_no          VARCHAR(100),           -- registered electrical contractor
    specialities        TEXT[] DEFAULT ARRAY[]::TEXT[],
    regions             TEXT[] DEFAULT ARRAY[]::TEXT[],
    is_active           BOOLEAN DEFAULT true,
    rating              NUMERIC(3,2),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scopes_of_work (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    feeder_db_id        UUID REFERENCES feeder_dbs(id) ON DELETE SET NULL,

    -- Provenance: which finding triggered this. Exactly one should be set.
    recommendation_id   UUID REFERENCES recommendations(id) ON DELETE SET NULL,
    inspection_id       UUID REFERENCES db_inspections(id) ON DELETE SET NULL,
    alert_id            UUID REFERENCES alerts(id) ON DELETE SET NULL,

    sow_number          VARCHAR(50) NOT NULL UNIQUE,
    title               VARCHAR(255) NOT NULL,
    category            VARCHAR(100) NOT NULL,  -- PF_CORRECTION | HARMONIC_FILTER | DB_REBALANCE | COC_RETRACE | SPD_INSTALL | THERMAL_SCAN
    description         TEXT,
    line_items          JSONB DEFAULT '[]'::jsonb,

    status              sow_status NOT NULL DEFAULT 'DRAFT',
    routing             routing_type,
    partner_id          UUID REFERENCES partners(id) ON DELETE SET NULL,

    quoted_amount_zar   NUMERIC(14,2),
    final_amount_zar    NUMERIC(14,2),

    -- 3% partner / 8% in-house. Rate is STORED per record, never re-derived from
    -- a constant: a later policy change must not silently rewrite past invoices.
    platform_fee_pct    NUMERIC(5,3),
    platform_fee_zar    NUMERIC(14,2),

    -- Closes the loop: prove the fix worked.
    baseline_pq_id      UUID REFERENCES pq_assessments(id) ON DELETE SET NULL,
    verify_pq_id        UUID REFERENCES pq_assessments(id) ON DELETE SET NULL,
    verified_improvement JSONB,

    approved_at         TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    verified_at         TIMESTAMPTZ,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sow_site   ON scopes_of_work (site_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sow_partner ON scopes_of_work (partner_id, status)
    WHERE partner_id IS NOT NULL;

-- Enforce the fee rule in the database, not only in application code.
CREATE OR REPLACE FUNCTION set_platform_fee() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.routing IS NOT NULL AND NEW.final_amount_zar IS NOT NULL THEN
        NEW.platform_fee_pct := CASE NEW.routing
                                    WHEN 'PARTNER'  THEN 3.000
                                    WHEN 'IN_HOUSE' THEN 8.000
                                END;
        NEW.platform_fee_zar := ROUND(NEW.final_amount_zar * NEW.platform_fee_pct / 100, 2);
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sow_fee ON scopes_of_work;
CREATE TRIGGER trg_sow_fee BEFORE INSERT OR UPDATE ON scopes_of_work
    FOR EACH ROW EXECUTE FUNCTION set_platform_fee();

CREATE TABLE IF NOT EXISTS sow_invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sow_id              UUID NOT NULL REFERENCES scopes_of_work(id) ON DELETE RESTRICT,
    invoice_no          VARCHAR(50) NOT NULL UNIQUE,
    gross_amount_zar    NUMERIC(14,2) NOT NULL,
    platform_fee_zar    NUMERIC(14,2) NOT NULL,
    partner_payout_zar  NUMERIC(14,2),
    vat_zar             NUMERIC(14,2),
    status              VARCHAR(30) NOT NULL DEFAULT 'DRAFT',  -- DRAFT|SENT|PAID|OVERDUE|VOID
    issued_at           TIMESTAMPTZ,
    due_at              DATE,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Retire the dead table from init.sql:170-186 (zero code references).
DROP TABLE IF EXISTS savings_ledger;
```

### 3.5 — Telemetry: rollups, retention, and the timestamp fix

```sql
-- migrations/005_telemetry_rollups.sql

-- 15-minute continuous aggregate. This is the LLM context source and the basis
-- for billable maximum demand — never query raw rows for either again.
CREATE MATERIALIZED VIEW IF NOT EXISTS meter_readings_15m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('15 minutes', time)              AS bucket,
    meter_id,
    COUNT(*)                                     AS sample_count,

    AVG(power_active_total)                      AS avg_kw,
    MAX(power_active_total)                      AS max_kw,
    AVG(power_reactive_total)                    AS avg_kvar,
    AVG(power_apparent_total)                    AS avg_kva,
    MAX(power_apparent_total)                    AS max_kva,   -- demand basis

    AVG(voltage_a) AS avg_va, AVG(voltage_b) AS avg_vb, AVG(voltage_c) AS avg_vc,
    MIN(voltage_a) AS min_va, MAX(voltage_a) AS max_va,
    AVG(current_a) AS avg_ia, AVG(current_b) AS avg_ib, AVG(current_c) AS avg_ic,
    MAX(current_a) AS max_ia, MAX(current_b) AS max_ib, MAX(current_c) AS max_ic,

    AVG(power_factor_total)                      AS avg_pf,
    MIN(power_factor_total)                      AS min_pf,
    AVG(thd_voltage_a)                           AS avg_thd_v,
    MAX(thd_voltage_a)                           AS max_thd_v,
    AVG(thd_current_a)                           AS avg_thd_i,   -- now actually used
    MAX(thd_current_a)                           AS max_thd_i,
    AVG(frequency) AS avg_hz, MIN(frequency) AS min_hz, MAX(frequency) AS max_hz,

    SUM(CASE WHEN voltage_a < 207 THEN 1 ELSE 0 END) AS dip_samples,
    SUM(CASE WHEN voltage_a > 253 THEN 1 ELSE 0 END) AS swell_samples
FROM meter_readings
GROUP BY bucket, meter_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('meter_readings_15m',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '15 minutes',
    if_not_exists => TRUE);

-- Compress raw data after 7 days; drop after 13 months (keeps a full
-- year-on-year comparison, which the insurance renewal cycle needs).
ALTER TABLE meter_readings SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'meter_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('meter_readings', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('meter_readings',  INTERVAL '13 months', if_not_exists => TRUE);

-- NRS 048-2 dip/swell EVENTS (depth x duration), not per-reading counts.
CREATE TABLE IF NOT EXISTS voltage_events (
    id              BIGSERIAL PRIMARY KEY,
    meter_id        UUID NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    event_type      VARCHAR(20) NOT NULL,      -- DIP | SWELL | INTERRUPTION
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    duration_ms     INTEGER,
    residual_pct    NUMERIC(5,2),              -- % of nominal at deepest point
    min_voltage     NUMERIC(8,2),
    max_voltage     NUMERIC(8,2),
    nrs048_class    VARCHAR(10),               -- Y / X / S / T / Z window class
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vevents_meter ON voltage_events (meter_id, started_at DESC);

-- Preserve the device's own timestamp. See Backend Gap B-1: without this,
-- store-and-forward replays are stamped with arrival time and the
-- ON CONFLICT idempotency guard cannot fire.
ALTER TABLE meter_readings
    ADD COLUMN IF NOT EXISTS device_time TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ DEFAULT NOW();
```

---

## 4. Backend API & Service Gaps

### Correctness bugs found (fix regardless of the pivot)

| # | Severity | File | Issue |
|---|---|---|---|
| **B-1** | **High** | `mqtt.ts:226` | `time` = `NOW()` instead of device timestamp. Breaks store-and-forward idempotency and misplaces post-outage data on the timeline. |
| **B-2** | Medium | `power-quality.ts` | `thd_current_a` ingested and stored but never assessed. Spec requires THD_I thresholds; data is already there. |
| **B-3** | Medium | `main.ts:223` | Schema-init failures are caught and logged non-fatally — the service starts against a half-migrated DB. |
| **B-4** | Medium | `main.ts:509` | `authenticateToken` does not scope by tenant; all 44 routes must remember to filter. No central guard. |
| **B-5** | Medium | `power-quality.ts:178` | Dips/swells counted as readings, not classified events. Not NRS 048-2 conformant reporting. |
| **B-6** | Low | `mqtt.ts:203-207` | Unmatched meter → `return` with no dead-letter write, despite the dead-letter path existing for other failures. Silent data loss. |
| **B-7** | Low | `api-gateway/src/main.ts:37` | CORS accepts a single origin; requests from the `:3000` origin are rejected while appearing to succeed server-side. |
| **B-8** | Low | `init.sql:170` | `savings_ledger` dead table with an unused fee column. Drop it. |

### Missing endpoints by pillar

**Pillar 1 — Vault (all missing)**
```
POST   /documents                      multipart; hash on receipt, store to S3
GET    /sites/:id/documents            list + status + days-to-expiry
GET    /documents/:id/download         streamed, tenant-scoped
POST   /documents/:id/verify           reviewer marks verified
GET    /sites/:id/compliance-gaps      obligations with no valid document
POST   /sites/:id/share-tokens         issue underwriter link (returns token ONCE)
DELETE /share-tokens/:id               revoke
GET    /public/audit/:token            unauthenticated, token-scoped, logged
```

**Pillar 2 — Telemetry**
```
GET  /meters/:id/rollups?interval=15m  serve from continuous aggregate
GET  /meters/:id/max-demand            30-min integrated kVA (billing basis)
GET  /meters/:id/voltage-events        NRS 048-2 classified dips/swells
```

**Pillar 3 — Inspection & scoring (all missing)**
```
POST /sites/:id/inspections            submit DB inspection scorecard
GET  /sites/:id/inspections            history
POST /inspections/:id/photos           evidence upload (hashed)
GET  /sites/:id/health-score           unified 100-point + breakdown
POST /sites/:id/health-score/calculate recompute and snapshot
GET  /sites/:id/discount-eligibility   tier + gap-to-next-tier
POST /sites/:id/certificates           issue discount certificate
```

**Pillar 4 — Marketplace (all missing)**
```
POST  /sow                             create from finding
GET   /sow                             filter by status/site/partner
PATCH /sow/:id                         status transitions
POST  /sow/:id/route                   PARTNER (3%) or IN_HOUSE (8%)
POST  /sow/:id/verify                  attach post-work assessment, prove delta
GET   /partners  /  POST /partners     registry
POST  /sow/:id/invoice                 generate with fee split
GET   /admin/revenue                   platform fee reporting
```

### Service-level gaps

- **No object storage.** `multer({ dest: 'uploads/' })` on a single Lightsail instance. The vault needs S3 (af-south-1) with server-side encryption and versioning before it holds anything legally significant.
- **No background job scheduling for the new pillars.** BullMQ is wired but barely used. Needed: nightly expiry sweep, 15-min rollup refresh monitoring, score recalculation, share-token expiry.
- **No email/notification transport.** Expiry warnings, underwriter share links, and SOW approvals all require outbound mail. Nothing exists.
- **No PDF generation service.** Certificates and underwriter packs need server-side PDF. Current reports rely on browser print CSS, which cannot produce an attachable artefact.
- **No audit log.** For a clearinghouse, who-changed-what-when is a product requirement, not an operational nicety.
- **Deployment is manual `scp`.** Server GitHub credentials expired; every deploy is a hand-copied tarball. This will not survive a build-out of this size — an SSH deploy key is ~10 minutes of work and should be step zero.

---

## 5. Three-Phase Development Roadmap

### Phase 1 — Minimum Viable Pilot *(~4–6 weeks)*
**Goal: one real site, scored on all four dimensions, with a report a broker will actually read.**

Foundations first — these are cheap now and expensive later:
1. **Adopt `node-pg-migrate`**; move all startup DDL to `migrations/000_baseline.sql`; make migration failure fatal (fixes B-3).
2. **SSH deploy key** — end the `scp` workflow.
3. **Fix B-1 (device timestamp)** and **B-6 (dead-letter on unmatched meter)**. Both are data-integrity issues; every day they run, the evidence base degrades.
4. **Fix B-2 (assess THD_I)** — smallest change with a direct spec requirement satisfied.

Then the pilot slice:
5. Migrations `001` (hierarchy) + `003` (inspection & scoring) + `005` (rollups).
6. **Unified 100-point scoring engine.** Map the existing `power-quality.ts` output onto the 35-point telemetry component; implement the other 65 from inspection + document data. Store immutable snapshots with a `scoring_version`.
7. **Inspection capture UI** — mobile-friendly form at `/dashboard/sites/[id]/inspect`. This is the main new frontend surface in Phase 1.
8. **Extend the Health Check report** (`health-check/page.tsx` is already print-ready and white-labelled) to show the 100-point breakdown and the discount tier the site currently qualifies for.

*Deliberately deferred: the vault, share tokens, and anything touching money.*

**Exit criterion:** one pilot site carries a defensible 100-point score, and a broker can be shown a PDF that explains it.

---

### Phase 2 — Broker Vault & Insurance Tiers *(~6–8 weeks)*
**Goal: an underwriter can independently verify a claim without a login.**

1. **S3 (af-south-1) + hashing pipeline.** Every upload SHA-256'd on receipt; hash stored; duplicates rejected per site.
2. Migration `002` — documents, obligations, share tokens, access log.
3. **Document vault UI** — upload, type classification, expiry dashboard, gap list ("no valid Master CoC on file — costing you 8 of 25 points").
4. **Expiry engine** — BullMQ nightly sweep → `EXPIRING_SOON` at 60 days, `EXPIRED` at 0, email + in-app alerts. Wire `compliance_obligations` so a *missing* 12-month thermal scan costs points automatically.
5. **Underwriter share links** — `/public/audit/:token`. Store only the token hash. Enforce expiry and scope. Log every access. QR render for the certificate PDF.
6. **Discount tier engine + certificate issuance.** Tiers as data (`insurance_discount_tiers`), never constants. Server-side PDF with the score, the evidence list, and a verification QR.
7. **Broker persona** — a role that reads across multiple tenants. This needs a real decision on whether brokers become an `organizations` layer above `tenants` or a cross-tenant grant table; recommend the grant table (less invasive, reversible).

**Exit criterion:** a broker issues a real discount off a VoltGuard certificate, and their underwriter verifies it via a share link without contacting you.

---

### Phase 3 — Marketplace & Split Fees *(~6–8 weeks)*
**Goal: findings convert to paid work, and the platform takes its cut automatically.**

1. Migration `004` — partners, SOWs, invoices, the fee trigger.
2. **SOW generation from findings.** Every `EquipmentRisk` in `power-quality.ts` already carries `action` and `standard` — those become SOW templates with pre-populated line items. This is the natural payoff of how that engine was built.
3. **Partner registry + routing.** 3% partner / 8% in-house, rate frozen onto each record at routing time.
4. **The verification loop — the commercially important piece.** On SOW completion, trigger a fresh assessment and diff it against `baseline_pq_id`. The trend machinery already exists (`compareTrend`, `pq_assessments`, `/value-ledger`); it needs attaching to the SOW record. *"We found it, we fixed it, here is the measured proof, and your score went from 78 to 87"* is what renews subscriptions and justifies the fee.
5. **Invoicing + fee reporting**, VAT-aware. Payment gateway integration if you want to collect rather than just calculate.
6. **Re-score on completion** → automatic tier upgrade → new certificate → broker notified.

**Exit criterion:** a finding becomes a completed, verified, invoiced job with the platform fee collected — with no manual intervention.

---

## Two things worth raising before you commit

**1. This is a repositioning, not a feature addition.** The current product sells advisory to facility managers; VoltGuard sells verified risk reduction to brokers. The telemetry engine carries over almost entirely, and the report UI mostly does — but the buyer, the pricing model, and the compliance obligations are new. Roughly 70% of the target spec is work that has not started. Plan for two to three quarters, not weeks.

**2. Financial and insurance records raise the bar on correctness.** Once a discount certificate influences someone's premium, the data behind it must be immutable, auditable, and reproducible — which is why the schema above stores fee rates and scoring versions per record rather than deriving them from constants, and why B-1 (timestamps) should be fixed before, not after, the vault holds anything. I am flagging this as an engineering constraint; whether the arrangement needs FSCA or short-term-insurance regulatory sign-off in South Africa is a question for a compliance advisor, not this audit.

---

*Generated from static analysis on 2026-07-25. No database or running-service introspection was performed; runtime behaviour and production data volumes are unverified.*
