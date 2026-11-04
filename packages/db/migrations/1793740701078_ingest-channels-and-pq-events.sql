-- Up Migration
-- Phase 3: the AXM-WEB2 1-second channel set, and pq_events for the ingest
-- event detector. Every new reading column is nullable with no default, which
-- TimescaleDB allows on a compression-enabled hypertable and which does not
-- rewrite existing rows.

ALTER TABLE meter_readings
    -- Line-to-line voltages (V)
    ADD COLUMN voltage_ab DOUBLE PRECISION,
    ADD COLUMN voltage_bc DOUBLE PRECISION,
    ADD COLUMN voltage_ca DOUBLE PRECISION,
    -- Neutral current (A)
    ADD COLUMN current_n DOUBLE PRECISION,
    -- Per-phase power: active kW, reactive kvar, apparent kVA, PF
    ADD COLUMN power_active_a DOUBLE PRECISION,
    ADD COLUMN power_active_b DOUBLE PRECISION,
    ADD COLUMN power_active_c DOUBLE PRECISION,
    ADD COLUMN power_reactive_a DOUBLE PRECISION,
    ADD COLUMN power_reactive_b DOUBLE PRECISION,
    ADD COLUMN power_reactive_c DOUBLE PRECISION,
    ADD COLUMN power_apparent_a DOUBLE PRECISION,
    ADD COLUMN power_apparent_b DOUBLE PRECISION,
    ADD COLUMN power_apparent_c DOUBLE PRECISION,
    ADD COLUMN power_factor_a DOUBLE PRECISION,
    ADD COLUMN power_factor_b DOUBLE PRECISION,
    ADD COLUMN power_factor_c DOUBLE PRECISION,
    -- THD for the phases not already stored (%), thd_*_a exist
    ADD COLUMN thd_voltage_b DOUBLE PRECISION,
    ADD COLUMN thd_voltage_c DOUBLE PRECISION,
    ADD COLUMN thd_current_b DOUBLE PRECISION,
    ADD COLUMN thd_current_c DOUBLE PRECISION,
    -- Unbalance (%)
    ADD COLUMN voltage_unbalance DOUBLE PRECISION,
    ADD COLUMN current_unbalance DOUBLE PRECISION,
    -- Reactive energy registers (kvarh); kWh import/export exist
    ADD COLUMN energy_reactive_import_total DOUBLE PRECISION,
    ADD COLUMN energy_reactive_export_total DOUBLE PRECISION,
    -- Demand, only when the meter publishes it (kW, kvar, kVA)
    ADD COLUMN demand_active DOUBLE PRECISION,
    ADD COLUMN demand_reactive DOUBLE PRECISION,
    ADD COLUMN demand_apparent DOUBLE PRECISION;

-- Power-quality excursions found by the in-memory event detector in the
-- ingest role (services/ingestion-service/src/ingest/event-detector.ts).
-- ended_at is NULL while an excursion is still ongoing; the same row is
-- updated when it ends. 1-second telemetry cannot resolve sub-second dips:
-- those need the meter's own event log or waveform capture.
CREATE TABLE pq_events (
    id            UUID PRIMARY KEY,
    meter_id      UUID NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    type          VARCHAR(32) NOT NULL,   -- UNDERVOLTAGE, OVERVOLTAGE, UNDERFREQUENCY, OVERFREQUENCY
    channel       VARCHAR(32) NOT NULL,   -- meter_readings column, e.g. voltage_b
    started_at    TIMESTAMPTZ NOT NULL,
    ended_at      TIMESTAMPTZ,
    duration_s    DOUBLE PRECISION NOT NULL,
    extreme_value DOUBLE PRECISION NOT NULL,
    threshold     DOUBLE PRECISION NOT NULL,
    samples       INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pq_events_meter_time ON pq_events (meter_id, started_at DESC);

-- Down Migration
DROP TABLE pq_events;
ALTER TABLE meter_readings
    DROP COLUMN voltage_ab, DROP COLUMN voltage_bc, DROP COLUMN voltage_ca,
    DROP COLUMN current_n,
    DROP COLUMN power_active_a, DROP COLUMN power_active_b, DROP COLUMN power_active_c,
    DROP COLUMN power_reactive_a, DROP COLUMN power_reactive_b, DROP COLUMN power_reactive_c,
    DROP COLUMN power_apparent_a, DROP COLUMN power_apparent_b, DROP COLUMN power_apparent_c,
    DROP COLUMN power_factor_a, DROP COLUMN power_factor_b, DROP COLUMN power_factor_c,
    DROP COLUMN thd_voltage_b, DROP COLUMN thd_voltage_c,
    DROP COLUMN thd_current_b, DROP COLUMN thd_current_c,
    DROP COLUMN voltage_unbalance, DROP COLUMN current_unbalance,
    DROP COLUMN energy_reactive_import_total, DROP COLUMN energy_reactive_export_total,
    DROP COLUMN demand_active, DROP COLUMN demand_reactive, DROP COLUMN demand_apparent;
