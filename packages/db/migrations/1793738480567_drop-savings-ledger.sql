-- Up Migration
-- savings_ledger belonged to the old "10% of verified savings" fee model.
-- Nothing reads or writes it (grep across the repo finds only its DDL).
DROP TABLE savings_ledger;

-- Down Migration
CREATE TABLE savings_ledger (
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
