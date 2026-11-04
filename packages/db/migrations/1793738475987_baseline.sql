-- Up Migration
--
-- BASELINE. Consolidates init.sql and every startup CREATE/ALTER ... IF NOT
-- EXISTS block that used to run in ingestion-service main.ts and mqtt.ts.
--
-- It must be safe on BOTH an empty database and an existing one (a restored
-- dump, or a local DB built by the old startup bootstrap). Hence IF NOT EXISTS
-- and conditional DDL throughout: this is the only migration allowed to be
-- idempotent. Every later migration is a normal, non-idempotent migration.
--
-- It never touches existing rows.

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Phase 6 (deployments) needs exclusion constraints over uuid + tstzrange.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── Tenancy ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- White-label branding: an installer or reseller puts their own identity on
-- the report they hand to their client. Renewal date lives on the tenant
-- because a policy renews per client, not per site.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_footer TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS renewal_date DATE;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user', -- 'admin', 'viewer', 'super_admin', 'broker'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    name VARCHAR(255) NOT NULL,
    address TEXT,
    timezone VARCHAR(50) DEFAULT 'UTC',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID REFERENCES sites(id),
    name VARCHAR(255) NOT NULL,
    serial_number VARCHAR(100) UNIQUE,
    model VARCHAR(100), -- e.g., 'Acuvim II'
    api_key VARCHAR(255), -- For ingestion authentication
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active/pause flag, load profile (what the meter actually measures) and
-- CT/PT ratio scaling.
ALTER TABLE meters
    ADD COLUMN IF NOT EXISTS is_active        BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS load_types       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS load_description TEXT,
    ADD COLUMN IF NOT EXISTS site_type        VARCHAR(50),
    ADD COLUMN IF NOT EXISTS ct_ratio         NUMERIC DEFAULT 1,
    ADD COLUMN IF NOT EXISTS pt_ratio         NUMERIC DEFAULT 1;

-- ── Telemetry ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meter_readings (
    time TIMESTAMPTZ NOT NULL,
    meter_id UUID NOT NULL, -- no FK: hypertable insert performance
    voltage_a DOUBLE PRECISION,
    voltage_b DOUBLE PRECISION,
    voltage_c DOUBLE PRECISION,
    current_a DOUBLE PRECISION,
    current_b DOUBLE PRECISION,
    current_c DOUBLE PRECISION,
    power_active_total DOUBLE PRECISION,   -- kW
    power_reactive_total DOUBLE PRECISION, -- kVAR
    power_apparent_total DOUBLE PRECISION, -- kVA
    energy_import_total DOUBLE PRECISION,  -- kWh (accumulated)
    energy_export_total DOUBLE PRECISION,  -- kWh (accumulated)
    power_factor_total DOUBLE PRECISION,
    frequency DOUBLE PRECISION,
    thd_voltage_a DOUBLE PRECISION,
    thd_current_a DOUBLE PRECISION,
    -- Timestamp provenance. `time` is the authoritative timestamp; these
    -- record where it came from (mqtt.ts resolveReadingTime).
    device_time TIMESTAMPTZ,
    ingested_at TIMESTAMPTZ DEFAULT NOW(),
    time_source VARCHAR(10)
);

SELECT create_hypertable('meter_readings', 'time', if_not_exists => TRUE);

-- On an existing database these may be missing, and meter_readings may
-- already have compression enabled. TimescaleDB rejects index DDL on a
-- compression-enabled hypertable even with IF NOT EXISTS, so every change is
-- guarded by a catalog check rather than relying on IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'meter_readings' AND column_name = 'device_time') THEN
        ALTER TABLE meter_readings ADD COLUMN device_time TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'meter_readings' AND column_name = 'ingested_at') THEN
        ALTER TABLE meter_readings ADD COLUMN ingested_at TIMESTAMPTZ DEFAULT NOW();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'meter_readings' AND column_name = 'time_source') THEN
        ALTER TABLE meter_readings ADD COLUMN time_source VARCHAR(10);
    END IF;

    -- Primary query index
    IF to_regclass('public.idx_meter_readings_meter_time') IS NULL THEN
        CREATE INDEX idx_meter_readings_meter_time ON meter_readings (meter_id, time DESC);
    END IF;
    -- Required for the ON CONFLICT (meter_id, time) DO NOTHING guard: AXM-WEB2
    -- store-and-forward replays packets after an outage. Hypertable unique
    -- indexes must include the time dimension.
    IF to_regclass('public.idx_meter_readings_unique') IS NULL THEN
        -- Databases from before the guard can hold several readings for one
        -- (meter_id, time). Readings are evidence, so the migration never
        -- picks or deletes rows itself: it stops, and the operator runs the
        -- explicit quarantine step (packages/db/README.md), then migrates again.
        PERFORM 1 FROM meter_readings GROUP BY meter_id, time HAVING count(*) > 1 LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'meter_readings has duplicate (meter_id, time) rows, so the unique index behind the ON CONFLICT guard cannot be created.'
                USING HINT = 'Review them with "node packages/db/bin/quarantine-duplicate-readings.js", move them aside with "... --apply", then run the migrations again. See packages/db/README.md.';
        END IF;
        CREATE UNIQUE INDEX idx_meter_readings_unique ON meter_readings (meter_id, time);
    END IF;
END $$;

-- Dead-letter payloads: unparseable or unmappable MQTT messages, so no
-- telemetry is ever silently discarded.
CREATE TABLE IF NOT EXISTS dead_letter_payloads (
    id          BIGSERIAL PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    topic       TEXT,
    raw_payload TEXT,
    error_msg   TEXT
);

-- ── Alerts ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    max_peak_kw DECIMAL(10, 2),
    min_voltage DECIMAL(10, 2),
    max_thd DECIMAL(10, 2),
    email_notifications BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id)
);

CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    meter_id UUID REFERENCES meters(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,     -- 'PEAK_DEMAND', 'VOLTAGE_SAG', 'PREDICTIVE_WARNING', ...
    severity VARCHAR(20) NOT NULL, -- 'INFO', 'WARNING', 'CRITICAL'
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_id ON alerts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts(is_read);

-- ── Site settings: tariffs, NRS 048 thresholds, MDI, score weights ──────────
CREATE TABLE IF NOT EXISTS site_settings (
    site_id UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    tariff_peak DECIMAL(10,2),
    peak_times VARCHAR(255),
    tariff_standard DECIMAL(10,2),
    standard_times VARCHAR(255),
    tariff_offpeak DECIMAL(10,2),
    offpeak_times VARCHAR(255),
    alert_max_kw DECIMAL(10,2),
    alert_min_v DECIMAL(10,2),
    alert_max_thd DECIMAL(10,2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE site_settings
    ADD COLUMN IF NOT EXISTS tariff_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS weight_pf DECIMAL(4,3),
    ADD COLUMN IF NOT EXISTS weight_thd DECIMAL(4,3),
    ADD COLUMN IF NOT EXISTS weight_voltage_unbalance DECIMAL(4,3),
    ADD COLUMN IF NOT EXISTS weight_voltage_quality DECIMAL(4,3),
    ADD COLUMN IF NOT EXISTS alert_max_v DECIMAL(10,2),
    ADD COLUMN IF NOT EXISTS alert_min_freq DECIMAL(6,2),
    ADD COLUMN IF NOT EXISTS alert_max_freq DECIMAL(6,2),
    ADD COLUMN IF NOT EXISTS contracted_mdi_kva DECIMAL(10,2),
    ADD COLUMN IF NOT EXISTS tariff_demand DECIMAL(10,2),
    -- Utility demand integration window: Eskom Megaflex/Miniflex 30 min,
    -- some municipal tariffs 15. Per site, to reconcile against the bill.
    ADD COLUMN IF NOT EXISTS demand_interval_min INTEGER;

-- Load factor is no longer a scored component (energy-score.ts); its stored
-- weights are not transferable to voltage unbalance.
ALTER TABLE site_settings DROP COLUMN IF EXISTS weight_load_factor;

-- ── Energy scores (recomputed every 5 min) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS energy_scores (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id                  UUID REFERENCES sites(id) ON DELETE CASCADE,
    score                    DECIMAL(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    pf_score                 DECIMAL(5,2),
    thd_score                DECIMAL(5,2),
    voltage_unbalance_score  DECIMAL(5,2),
    voltage_quality_score    DECIMAL(5,2),
    weight_pf                DECIMAL(4,3),
    weight_thd               DECIMAL(4,3),
    weight_voltage_unbalance DECIMAL(4,3),
    weight_voltage_quality   DECIMAL(4,3),
    tariff_type              VARCHAR(50),
    calculated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_energy_scores_site ON energy_scores (site_id, calculated_at DESC);
ALTER TABLE energy_scores
    ADD COLUMN IF NOT EXISTS voltage_unbalance_score DECIMAL(5,2),
    ADD COLUMN IF NOT EXISTS weight_voltage_unbalance DECIMAL(4,3);
ALTER TABLE energy_scores DROP COLUMN IF EXISTS load_factor_score;
ALTER TABLE energy_scores DROP COLUMN IF EXISTS weight_load_factor;

-- ── AI recommendations and leads ────────────────────────────────────────────
-- meter_id is nullable: legacy site-wide recommendations still work.
CREATE TABLE IF NOT EXISTS recommendations (
    id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id                           UUID REFERENCES sites(id) ON DELETE CASCADE,
    tenant_id                         UUID REFERENCES tenants(id) ON DELETE CASCADE,
    type                              VARCHAR(100) NOT NULL,
    priority                          INTEGER DEFAULT 1,
    title                             VARCHAR(255) NOT NULL,
    problem                           TEXT,
    solution                          TEXT,
    estimated_monthly_saving_zar      DECIMAL(12,2) DEFAULT 0,
    estimated_implementation_cost_zar DECIMAL(12,2) DEFAULT 0,
    payback_months                    INTEGER DEFAULT 0,
    confidence                        VARCHAR(20) DEFAULT 'MEDIUM',
    standard_reference                VARCHAR(255),
    status                            VARCHAR(50) DEFAULT 'ACTIVE',
    created_at                        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recommendations_site ON recommendations (site_id, status, created_at DESC);
ALTER TABLE recommendations
    ADD COLUMN IF NOT EXISTS meter_id UUID REFERENCES meters(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_recommendations_meter
    ON recommendations (meter_id, status, created_at DESC) WHERE meter_id IS NOT NULL;

-- Created when a client clicks "Notify Team" on a recommendation.
CREATE TABLE IF NOT EXISTS leads (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id           UUID REFERENCES sites(id) ON DELETE CASCADE,
    tenant_id         UUID REFERENCES tenants(id) ON DELETE CASCADE,
    recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
    status            VARCHAR(50) DEFAULT 'NEW',
    notes             TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at DESC);

-- ── Single-line diagrams (one per site) ─────────────────────────────────────
-- layout: { nodes: [{id, type, position:{x,y}, data:{...}}], edges: [...] }.
-- background_pdf_path is relative to UPLOAD_DIR.
CREATE TABLE IF NOT EXISTS site_diagrams (
    site_id             UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    layout              JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    background_pdf_path TEXT,
    background_width    INTEGER,
    background_height   INTEGER,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Power quality assessments (trend lines, value ledger) ───────────────────
CREATE TABLE IF NOT EXISTS pq_assessments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meter_id      UUID REFERENCES meters(id) ON DELETE CASCADE,
    site_id       UUID REFERENCES sites(id) ON DELETE CASCADE,
    tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
    assessed_at   TIMESTAMPTZ DEFAULT NOW(),
    period_days   INTEGER,
    readings      INTEGER,
    verdict       VARCHAR(32),
    supply_score  INTEGER,
    install_score INTEGER,
    parameters    JSONB,
    risks         JSONB,
    degrading     JSONB
);
CREATE INDEX IF NOT EXISTS idx_pq_meter_time ON pq_assessments (meter_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pq_tenant_time ON pq_assessments (tenant_id, assessed_at DESC);
-- Cached AI narrative: stable wording per assessment, not re-billed per view.
ALTER TABLE pq_assessments ADD COLUMN IF NOT EXISTS ai_summary TEXT;

-- ── Read-only report share links ────────────────────────────────────────────
-- Only the SHA-256 of the token is stored: a leaked database must not yield
-- working links.
CREATE TABLE IF NOT EXISTS report_shares (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID REFERENCES tenants(id) ON DELETE CASCADE,
    site_id        UUID REFERENCES sites(id)   ON DELETE CASCADE,
    meter_id       UUID REFERENCES meters(id)  ON DELETE CASCADE,
    token_hash     CHAR(64) NOT NULL UNIQUE,
    label          TEXT,
    period_days    INTEGER NOT NULL DEFAULT 7,
    expires_at     TIMESTAMPTZ NOT NULL,
    revoked_at     TIMESTAMPTZ,
    view_count     INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TIMESTAMPTZ,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shares_meter ON report_shares (meter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_live  ON report_shares (expires_at) WHERE revoked_at IS NULL;

-- Every view of a shared report is logged.
CREATE TABLE IF NOT EXISTS report_share_access (
    id          BIGSERIAL PRIMARY KEY,
    share_id    UUID REFERENCES report_shares(id) ON DELETE CASCADE,
    accessed_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address  TEXT,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_access ON report_share_access (share_id, accessed_at DESC);

-- ── Broker cross-tenant access ──────────────────────────────────────────────
-- A grant table, not an organisations layer: additive, reversible, and every
-- existing tenant-scoped query stays untouched. Cross-tenant reads live only
-- on the dedicated /broker endpoints.
CREATE TABLE IF NOT EXISTS broker_client_access (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_user_id UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label          TEXT,
    granted_at     TIMESTAMPTZ DEFAULT NOW(),
    granted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at     TIMESTAMPTZ,
    UNIQUE (broker_user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_broker_access_live
    ON broker_client_access (broker_user_id) WHERE revoked_at IS NULL;

-- ── Pre-renewal reviews ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS renewal_reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    renewal_date DATE NOT NULL,
    days_before  INTEGER NOT NULL,
    summary      JSONB NOT NULL,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    -- One review per milestone per renewal: the sweep is idempotent.
    UNIQUE (tenant_id, renewal_date, days_before)
);
CREATE INDEX IF NOT EXISTS idx_renewal_reviews_tenant
    ON renewal_reviews (tenant_id, renewal_date DESC, days_before ASC);

-- ── Savings ledger (legacy 10% model; dropped by the next migration) ────────
CREATE TABLE IF NOT EXISTS savings_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    baseline_kwh DOUBLE PRECISION,
    actual_kwh DOUBLE PRECISION,
    savings_kwh DOUBLE PRECISION,
    cost_per_kwh DOUBLE PRECISION,
    total_savings_amount DECIMAL(10, 2),
    platform_fee_amount DECIMAL(10, 2),
    status VARCHAR(50) DEFAULT 'pending'
);

-- ── Compression ─────────────────────────────────────────────────────────────
-- Last, so every meter_readings DDL above runs before compression is enabled.
-- Measured ~93% saving on this telemetry. The boundary MUST be strictly later
-- than MAX_BACKFILL_DAYS (packages/db/index.js, used by mqtt.ts): TimescaleDB
-- does not enforce unique indexes against compressed chunks, so a late reading
-- landing in one would bypass the ON CONFLICT guard and silently duplicate.
-- The interval below must equal COMPRESSION_AFTER_DAYS; test/constants.test.js
-- fails if it doesn't, or if it is not greater than MAX_BACKFILL_DAYS.
-- An existing policy is left as it is (if_not_exists), as the old bootstrap did.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                   WHERE hypertable_schema = 'public' AND hypertable_name = 'meter_readings'
                     AND compression_enabled) THEN
        ALTER TABLE meter_readings SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'meter_id',
            timescaledb.compress_orderby   = 'time DESC'
        );
    END IF;
END $$;
SELECT add_compression_policy('meter_readings', INTERVAL '35 days', if_not_exists => TRUE);

-- Down Migration
-- The baseline is not reversible: it describes a schema that may have existed
-- before migrations did. Restore from a backup instead.
