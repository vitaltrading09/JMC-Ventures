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

-- Create Indexes for fast querying
CREATE INDEX IF NOT EXISTS idx_meter_readings_meter_time ON meter_readings (meter_id, time DESC);

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
