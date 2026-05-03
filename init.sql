-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Tenants (Organizations)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user', -- 'admin', 'viewer', 'super_admin'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sites (Locations)
CREATE TABLE IF NOT EXISTS sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    name VARCHAR(255) NOT NULL,
    address TEXT,
    timezone VARCHAR(50) DEFAULT 'UTC',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meters (Devices)
CREATE TABLE IF NOT EXISTS meters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID REFERENCES sites(id),
    name VARCHAR(255) NOT NULL,
    serial_number VARCHAR(100) UNIQUE,
    model VARCHAR(100), -- e.g., 'Acuvim II'
    api_key VARCHAR(255), -- For ingestion authentication
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meter Readings (Time-Series Data)
-- Storing V, I, kW, kWh, PF, THD, etc.
CREATE TABLE IF NOT EXISTS meter_readings (
    time TIMESTAMPTZ NOT NULL,
    meter_id UUID NOT NULL, -- No foreign key constraint for performance in hypertable usually, but can add if needed
    voltage_a DOUBLE PRECISION,
    voltage_b DOUBLE PRECISION,
    voltage_c DOUBLE PRECISION,
    current_a DOUBLE PRECISION,
    current_b DOUBLE PRECISION,
    current_c DOUBLE PRECISION,
    power_active_total DOUBLE PRECISION, -- kW
    power_reactive_total DOUBLE PRECISION, -- kVAR
    power_apparent_total DOUBLE PRECISION, -- kVA
    energy_import_total DOUBLE PRECISION, -- kWh (Accumulated)
    energy_export_total DOUBLE PRECISION, -- kWh (Accumulated)
    power_factor_total DOUBLE PRECISION,
    frequency DOUBLE PRECISION,
    thd_voltage_a DOUBLE PRECISION,
    thd_current_a DOUBLE PRECISION
);

-- Convert to Hypertable
SELECT create_hypertable('meter_readings', 'time', if_not_exists => TRUE);

-- Primary query index
CREATE INDEX IF NOT EXISTS idx_meter_readings_meter_time ON meter_readings (meter_id, time DESC);

-- Unique index required for ON CONFLICT (meter_id, time) DO NOTHING idempotent inserts.
-- Prevents duplicate rows when AXM-WEB2 store-and-forward replays packets after an outage.
-- Must include the time partitioning dimension for TimescaleDB hypertables.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meter_readings_unique ON meter_readings (meter_id, time);

-- Alerts Config (Per Tenant thresholds)
CREATE TABLE IF NOT EXISTS alert_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    max_peak_kw DECIMAL(10, 2), -- Alert if power_active_total exceeds this
    min_voltage DECIMAL(10, 2), -- Alert if voltage_a sags below this
    max_thd DECIMAL(10, 2), -- Alert if Total Harmonic Distortion is too high
    email_notifications BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id)
);

-- Active Alerts Log
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    meter_id UUID REFERENCES meters(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'PEAK_DEMAND', 'VOLTAGE_SAG', 'PREDICTIVE_WARNING'
    severity VARCHAR(20) NOT NULL, -- 'INFO', 'WARNING', 'CRITICAL'
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster alert querying
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_id ON alerts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts(is_read);

-- Dead-letter payloads: captures unparseable or unrecognised MQTT messages
-- so no telemetry is silently discarded. Inspect to diagnose firmware mismatches.
CREATE TABLE IF NOT EXISTS dead_letter_payloads (
    id          BIGSERIAL PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    topic       TEXT,
    raw_payload TEXT,
    error_msg   TEXT
);

-- Energy Score weights — configurable per site, override auto-detected defaults
-- Added to site_settings as optional columns (NULL = use auto-detected defaults)
-- ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS tariff_type VARCHAR(50);
-- ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS weight_pf DECIMAL(4,3);
-- ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS weight_thd DECIMAL(4,3);
-- ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS weight_load_factor DECIMAL(4,3);
-- ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS weight_voltage_quality DECIMAL(4,3);
-- (These are added at runtime via the ingestion-service startup migration)

-- Energy Scores — calculated every 5 min, tracked over time per site
CREATE TABLE IF NOT EXISTS energy_scores (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id              UUID REFERENCES sites(id) ON DELETE CASCADE,
    score                DECIMAL(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    pf_score             DECIMAL(5,2),
    thd_score            DECIMAL(5,2),
    load_factor_score    DECIMAL(5,2),
    voltage_quality_score DECIMAL(5,2),
    weight_pf            DECIMAL(4,3),
    weight_thd           DECIMAL(4,3),
    weight_load_factor   DECIMAL(4,3),
    weight_voltage_quality DECIMAL(4,3),
    tariff_type          VARCHAR(50),
    calculated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_energy_scores_site ON energy_scores (site_id, calculated_at DESC);

-- AI Recommendations — Claude-generated, ranked by ROI, per site
CREATE TABLE IF NOT EXISTS recommendations (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id                         UUID REFERENCES sites(id) ON DELETE CASCADE,
    tenant_id                       UUID REFERENCES tenants(id) ON DELETE CASCADE,
    type                            VARCHAR(100) NOT NULL,
    priority                        INTEGER DEFAULT 1,
    title                           VARCHAR(255) NOT NULL,
    problem                         TEXT,
    solution                        TEXT,
    estimated_monthly_saving_zar    DECIMAL(12,2) DEFAULT 0,
    estimated_implementation_cost_zar DECIMAL(12,2) DEFAULT 0,
    payback_months                  INTEGER DEFAULT 0,
    confidence                      VARCHAR(20) DEFAULT 'MEDIUM',
    standard_reference              VARCHAR(255),
    status                          VARCHAR(50) DEFAULT 'ACTIVE',
    created_at                      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recommendations_site ON recommendations (site_id, status, created_at DESC);

-- Leads — created when client clicks "Notify Team" on a recommendation
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

-- Savings Ledger (Verified Savings for 10% model)
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
    platform_fee_amount DECIMAL(10, 2), -- 10% of total_savings_amount
    status VARCHAR(50) DEFAULT 'pending' -- 'invoiced', 'paid'
);
