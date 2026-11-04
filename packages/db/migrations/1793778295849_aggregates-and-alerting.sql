-- Up Migration
-- Phase 4: continuous aggregates, retention windows, alerting support.
--
-- Aggregates (all ultimately from raw meter_readings):
--   readings_1m   from raw: per channel avg/min/max, voltage mean square,
--                 first/last of the energy registers, n (samples), coverage.
--   readings_10m  NRS 048-2 voltage and THD assessment (10-minute values)
--   readings_30m  billed demand (kVA MDI)
--   readings_1h, readings_1d  long-range charts and monthly energy
-- The higher views are hierarchical from readings_1m. Averages are
-- re-weighted by sample count, so every avg equals the plain average of the
-- raw samples in that bucket (exact, not an average of averages); the voltage
-- mean square gives a true RMS over 10 minutes. Core channel set only: the
-- per-phase P/Q/S/PF and the other Phase 3 channels stay raw-only.
--
-- Refresh windows start at COMPRESS_AFTER_DAYS (15) ago, which is beyond
-- MAX_BACKFILL_DAYS (14), so a store-and-forward replay is still aggregated.
-- The migrate step re-applies both from the environment
-- (packages/db/bin/migrate.js reconcileRetention); test/constants.test.js
-- enforces the ordering.

CREATE MATERIALIZED VIEW readings_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    meter_id,
    time_bucket('1 minute', time) AS bucket,
    count(*) AS n,
    min(time) AS t_first,
    max(time) AS t_last,
    -- samples with phase A below 10 % of 230 V: supply interruption (power-quality.ts V_INTERRUPTION),
    count(*) FILTER (WHERE voltage_a < 23) AS n_interrupt,
    avg(voltage_a) AS voltage_a_avg,
    min(voltage_a) AS voltage_a_min,
    max(voltage_a) AS voltage_a_max,
    avg(voltage_b) AS voltage_b_avg,
    min(voltage_b) AS voltage_b_min,
    max(voltage_b) AS voltage_b_max,
    avg(voltage_c) AS voltage_c_avg,
    min(voltage_c) AS voltage_c_min,
    max(voltage_c) AS voltage_c_max,
    avg(current_a) AS current_a_avg,
    min(current_a) AS current_a_min,
    max(current_a) AS current_a_max,
    avg(current_b) AS current_b_avg,
    min(current_b) AS current_b_min,
    max(current_b) AS current_b_max,
    avg(current_c) AS current_c_avg,
    min(current_c) AS current_c_min,
    max(current_c) AS current_c_max,
    avg(power_active_total) AS power_active_total_avg,
    min(power_active_total) AS power_active_total_min,
    max(power_active_total) AS power_active_total_max,
    avg(power_reactive_total) AS power_reactive_total_avg,
    min(power_reactive_total) AS power_reactive_total_min,
    max(power_reactive_total) AS power_reactive_total_max,
    avg(power_apparent_total) AS power_apparent_total_avg,
    min(power_apparent_total) AS power_apparent_total_min,
    max(power_apparent_total) AS power_apparent_total_max,
    avg(power_factor_total) AS power_factor_total_avg,
    min(power_factor_total) AS power_factor_total_min,
    max(power_factor_total) AS power_factor_total_max,
    avg(frequency) AS frequency_avg,
    min(frequency) AS frequency_min,
    max(frequency) AS frequency_max,
    avg(thd_voltage_a) AS thd_voltage_a_avg,
    min(thd_voltage_a) AS thd_voltage_a_min,
    max(thd_voltage_a) AS thd_voltage_a_max,
    avg(thd_voltage_b) AS thd_voltage_b_avg,
    min(thd_voltage_b) AS thd_voltage_b_min,
    max(thd_voltage_b) AS thd_voltage_b_max,
    avg(thd_voltage_c) AS thd_voltage_c_avg,
    min(thd_voltage_c) AS thd_voltage_c_min,
    max(thd_voltage_c) AS thd_voltage_c_max,
    avg(thd_current_a) AS thd_current_a_avg,
    min(thd_current_a) AS thd_current_a_min,
    max(thd_current_a) AS thd_current_a_max,
    avg(thd_current_b) AS thd_current_b_avg,
    min(thd_current_b) AS thd_current_b_min,
    max(thd_current_b) AS thd_current_b_max,
    avg(thd_current_c) AS thd_current_c_avg,
    min(thd_current_c) AS thd_current_c_min,
    max(thd_current_c) AS thd_current_c_max,
    avg(voltage_unbalance) AS voltage_unbalance_avg,
    min(voltage_unbalance) AS voltage_unbalance_min,
    max(voltage_unbalance) AS voltage_unbalance_max,
    avg(current_unbalance) AS current_unbalance_avg,
    min(current_unbalance) AS current_unbalance_min,
    max(current_unbalance) AS current_unbalance_max,
    avg(voltage_a * voltage_a) AS voltage_a_ms,
    avg(voltage_b * voltage_b) AS voltage_b_ms,
    avg(voltage_c * voltage_c) AS voltage_c_ms,
    first(energy_import_total, time) FILTER (WHERE energy_import_total IS NOT NULL) AS energy_import_total_first,
    last(energy_import_total, time) FILTER (WHERE energy_import_total IS NOT NULL) AS energy_import_total_last,
    first(energy_export_total, time) FILTER (WHERE energy_export_total IS NOT NULL) AS energy_export_total_first,
    last(energy_export_total, time) FILTER (WHERE energy_export_total IS NOT NULL) AS energy_export_total_last,
    first(energy_reactive_import_total, time) FILTER (WHERE energy_reactive_import_total IS NOT NULL) AS energy_reactive_import_total_first,
    last(energy_reactive_import_total, time) FILTER (WHERE energy_reactive_import_total IS NOT NULL) AS energy_reactive_import_total_last,
    first(energy_reactive_export_total, time) FILTER (WHERE energy_reactive_export_total IS NOT NULL) AS energy_reactive_export_total_first,
    last(energy_reactive_export_total, time) FILTER (WHERE energy_reactive_export_total IS NOT NULL) AS energy_reactive_export_total_last
FROM meter_readings
GROUP BY meter_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW readings_10m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    meter_id,
    time_bucket('10 minutes', bucket) AS bucket,
    sum(n) AS n,
    -- minutes with at least one sample: coverage, and the time weighting for demand,
    count(*) AS minutes,
    min(t_first) AS t_first,
    max(t_last) AS t_last,
    sum(n_interrupt) AS n_interrupt,
    sum(voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_avg IS NOT NULL), 0) AS voltage_a_avg,
    min(voltage_a_min) AS voltage_a_min,
    max(voltage_a_max) AS voltage_a_max,
    sum(voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_avg IS NOT NULL), 0) AS voltage_b_avg,
    min(voltage_b_min) AS voltage_b_min,
    max(voltage_b_max) AS voltage_b_max,
    sum(voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_avg IS NOT NULL), 0) AS voltage_c_avg,
    min(voltage_c_min) AS voltage_c_min,
    max(voltage_c_max) AS voltage_c_max,
    sum(current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE current_a_avg IS NOT NULL), 0) AS current_a_avg,
    min(current_a_min) AS current_a_min,
    max(current_a_max) AS current_a_max,
    sum(current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE current_b_avg IS NOT NULL), 0) AS current_b_avg,
    min(current_b_min) AS current_b_min,
    max(current_b_max) AS current_b_max,
    sum(current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE current_c_avg IS NOT NULL), 0) AS current_c_avg,
    min(current_c_min) AS current_c_min,
    max(current_c_max) AS current_c_max,
    sum(power_active_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_active_total_avg IS NOT NULL), 0) AS power_active_total_avg,
    min(power_active_total_min) AS power_active_total_min,
    max(power_active_total_max) AS power_active_total_max,
    sum(power_reactive_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_reactive_total_avg IS NOT NULL), 0) AS power_reactive_total_avg,
    min(power_reactive_total_min) AS power_reactive_total_min,
    max(power_reactive_total_max) AS power_reactive_total_max,
    sum(power_apparent_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_apparent_total_avg IS NOT NULL), 0) AS power_apparent_total_avg,
    min(power_apparent_total_min) AS power_apparent_total_min,
    max(power_apparent_total_max) AS power_apparent_total_max,
    sum(power_factor_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_factor_total_avg IS NOT NULL), 0) AS power_factor_total_avg,
    min(power_factor_total_min) AS power_factor_total_min,
    max(power_factor_total_max) AS power_factor_total_max,
    sum(frequency_avg * n) / NULLIF(sum(n) FILTER (WHERE frequency_avg IS NOT NULL), 0) AS frequency_avg,
    min(frequency_min) AS frequency_min,
    max(frequency_max) AS frequency_max,
    sum(thd_voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_a_avg IS NOT NULL), 0) AS thd_voltage_a_avg,
    min(thd_voltage_a_min) AS thd_voltage_a_min,
    max(thd_voltage_a_max) AS thd_voltage_a_max,
    sum(thd_voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_b_avg IS NOT NULL), 0) AS thd_voltage_b_avg,
    min(thd_voltage_b_min) AS thd_voltage_b_min,
    max(thd_voltage_b_max) AS thd_voltage_b_max,
    sum(thd_voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_c_avg IS NOT NULL), 0) AS thd_voltage_c_avg,
    min(thd_voltage_c_min) AS thd_voltage_c_min,
    max(thd_voltage_c_max) AS thd_voltage_c_max,
    sum(thd_current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_a_avg IS NOT NULL), 0) AS thd_current_a_avg,
    min(thd_current_a_min) AS thd_current_a_min,
    max(thd_current_a_max) AS thd_current_a_max,
    sum(thd_current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_b_avg IS NOT NULL), 0) AS thd_current_b_avg,
    min(thd_current_b_min) AS thd_current_b_min,
    max(thd_current_b_max) AS thd_current_b_max,
    sum(thd_current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_c_avg IS NOT NULL), 0) AS thd_current_c_avg,
    min(thd_current_c_min) AS thd_current_c_min,
    max(thd_current_c_max) AS thd_current_c_max,
    sum(voltage_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_unbalance_avg IS NOT NULL), 0) AS voltage_unbalance_avg,
    min(voltage_unbalance_min) AS voltage_unbalance_min,
    max(voltage_unbalance_max) AS voltage_unbalance_max,
    sum(current_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE current_unbalance_avg IS NOT NULL), 0) AS current_unbalance_avg,
    min(current_unbalance_min) AS current_unbalance_min,
    max(current_unbalance_max) AS current_unbalance_max,
    sum(voltage_a_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_ms IS NOT NULL), 0) AS voltage_a_ms,
    sum(voltage_b_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_ms IS NOT NULL), 0) AS voltage_b_ms,
    sum(voltage_c_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_ms IS NOT NULL), 0) AS voltage_c_ms,
    first(energy_import_total_first, bucket) FILTER (WHERE energy_import_total_first IS NOT NULL) AS energy_import_total_first,
    last(energy_import_total_last, bucket) FILTER (WHERE energy_import_total_last IS NOT NULL) AS energy_import_total_last,
    first(energy_export_total_first, bucket) FILTER (WHERE energy_export_total_first IS NOT NULL) AS energy_export_total_first,
    last(energy_export_total_last, bucket) FILTER (WHERE energy_export_total_last IS NOT NULL) AS energy_export_total_last,
    first(energy_reactive_import_total_first, bucket) FILTER (WHERE energy_reactive_import_total_first IS NOT NULL) AS energy_reactive_import_total_first,
    last(energy_reactive_import_total_last, bucket) FILTER (WHERE energy_reactive_import_total_last IS NOT NULL) AS energy_reactive_import_total_last,
    first(energy_reactive_export_total_first, bucket) FILTER (WHERE energy_reactive_export_total_first IS NOT NULL) AS energy_reactive_export_total_first,
    last(energy_reactive_export_total_last, bucket) FILTER (WHERE energy_reactive_export_total_last IS NOT NULL) AS energy_reactive_export_total_last
FROM readings_1m
GROUP BY meter_id, time_bucket('10 minutes', bucket)
WITH NO DATA;

CREATE MATERIALIZED VIEW readings_30m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    meter_id,
    time_bucket('30 minutes', bucket) AS bucket,
    sum(n) AS n,
    -- minutes with at least one sample: coverage, and the time weighting for demand,
    count(*) AS minutes,
    min(t_first) AS t_first,
    max(t_last) AS t_last,
    sum(n_interrupt) AS n_interrupt,
    sum(voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_avg IS NOT NULL), 0) AS voltage_a_avg,
    min(voltage_a_min) AS voltage_a_min,
    max(voltage_a_max) AS voltage_a_max,
    sum(voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_avg IS NOT NULL), 0) AS voltage_b_avg,
    min(voltage_b_min) AS voltage_b_min,
    max(voltage_b_max) AS voltage_b_max,
    sum(voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_avg IS NOT NULL), 0) AS voltage_c_avg,
    min(voltage_c_min) AS voltage_c_min,
    max(voltage_c_max) AS voltage_c_max,
    sum(current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE current_a_avg IS NOT NULL), 0) AS current_a_avg,
    min(current_a_min) AS current_a_min,
    max(current_a_max) AS current_a_max,
    sum(current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE current_b_avg IS NOT NULL), 0) AS current_b_avg,
    min(current_b_min) AS current_b_min,
    max(current_b_max) AS current_b_max,
    sum(current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE current_c_avg IS NOT NULL), 0) AS current_c_avg,
    min(current_c_min) AS current_c_min,
    max(current_c_max) AS current_c_max,
    sum(power_active_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_active_total_avg IS NOT NULL), 0) AS power_active_total_avg,
    min(power_active_total_min) AS power_active_total_min,
    max(power_active_total_max) AS power_active_total_max,
    sum(power_reactive_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_reactive_total_avg IS NOT NULL), 0) AS power_reactive_total_avg,
    min(power_reactive_total_min) AS power_reactive_total_min,
    max(power_reactive_total_max) AS power_reactive_total_max,
    sum(power_apparent_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_apparent_total_avg IS NOT NULL), 0) AS power_apparent_total_avg,
    min(power_apparent_total_min) AS power_apparent_total_min,
    max(power_apparent_total_max) AS power_apparent_total_max,
    sum(power_factor_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_factor_total_avg IS NOT NULL), 0) AS power_factor_total_avg,
    min(power_factor_total_min) AS power_factor_total_min,
    max(power_factor_total_max) AS power_factor_total_max,
    sum(frequency_avg * n) / NULLIF(sum(n) FILTER (WHERE frequency_avg IS NOT NULL), 0) AS frequency_avg,
    min(frequency_min) AS frequency_min,
    max(frequency_max) AS frequency_max,
    sum(thd_voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_a_avg IS NOT NULL), 0) AS thd_voltage_a_avg,
    min(thd_voltage_a_min) AS thd_voltage_a_min,
    max(thd_voltage_a_max) AS thd_voltage_a_max,
    sum(thd_voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_b_avg IS NOT NULL), 0) AS thd_voltage_b_avg,
    min(thd_voltage_b_min) AS thd_voltage_b_min,
    max(thd_voltage_b_max) AS thd_voltage_b_max,
    sum(thd_voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_c_avg IS NOT NULL), 0) AS thd_voltage_c_avg,
    min(thd_voltage_c_min) AS thd_voltage_c_min,
    max(thd_voltage_c_max) AS thd_voltage_c_max,
    sum(thd_current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_a_avg IS NOT NULL), 0) AS thd_current_a_avg,
    min(thd_current_a_min) AS thd_current_a_min,
    max(thd_current_a_max) AS thd_current_a_max,
    sum(thd_current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_b_avg IS NOT NULL), 0) AS thd_current_b_avg,
    min(thd_current_b_min) AS thd_current_b_min,
    max(thd_current_b_max) AS thd_current_b_max,
    sum(thd_current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_c_avg IS NOT NULL), 0) AS thd_current_c_avg,
    min(thd_current_c_min) AS thd_current_c_min,
    max(thd_current_c_max) AS thd_current_c_max,
    sum(voltage_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_unbalance_avg IS NOT NULL), 0) AS voltage_unbalance_avg,
    min(voltage_unbalance_min) AS voltage_unbalance_min,
    max(voltage_unbalance_max) AS voltage_unbalance_max,
    sum(current_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE current_unbalance_avg IS NOT NULL), 0) AS current_unbalance_avg,
    min(current_unbalance_min) AS current_unbalance_min,
    max(current_unbalance_max) AS current_unbalance_max,
    sum(voltage_a_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_ms IS NOT NULL), 0) AS voltage_a_ms,
    sum(voltage_b_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_ms IS NOT NULL), 0) AS voltage_b_ms,
    sum(voltage_c_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_ms IS NOT NULL), 0) AS voltage_c_ms,
    first(energy_import_total_first, bucket) FILTER (WHERE energy_import_total_first IS NOT NULL) AS energy_import_total_first,
    last(energy_import_total_last, bucket) FILTER (WHERE energy_import_total_last IS NOT NULL) AS energy_import_total_last,
    first(energy_export_total_first, bucket) FILTER (WHERE energy_export_total_first IS NOT NULL) AS energy_export_total_first,
    last(energy_export_total_last, bucket) FILTER (WHERE energy_export_total_last IS NOT NULL) AS energy_export_total_last,
    first(energy_reactive_import_total_first, bucket) FILTER (WHERE energy_reactive_import_total_first IS NOT NULL) AS energy_reactive_import_total_first,
    last(energy_reactive_import_total_last, bucket) FILTER (WHERE energy_reactive_import_total_last IS NOT NULL) AS energy_reactive_import_total_last,
    first(energy_reactive_export_total_first, bucket) FILTER (WHERE energy_reactive_export_total_first IS NOT NULL) AS energy_reactive_export_total_first,
    last(energy_reactive_export_total_last, bucket) FILTER (WHERE energy_reactive_export_total_last IS NOT NULL) AS energy_reactive_export_total_last,
    -- Minute-weighted (≈ time-weighted) demand averages: irregular sampling,
    -- inside a minute cannot over-weight it. Billed demand uses these.,
    avg(power_apparent_total_avg) AS kva_demand,
    avg(power_active_total_avg) AS kw_demand
FROM readings_1m
GROUP BY meter_id, time_bucket('30 minutes', bucket)
WITH NO DATA;

CREATE MATERIALIZED VIEW readings_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    meter_id,
    time_bucket('1 hour', bucket) AS bucket,
    sum(n) AS n,
    -- minutes with at least one sample: coverage, and the time weighting for demand,
    count(*) AS minutes,
    min(t_first) AS t_first,
    max(t_last) AS t_last,
    sum(n_interrupt) AS n_interrupt,
    sum(voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_avg IS NOT NULL), 0) AS voltage_a_avg,
    min(voltage_a_min) AS voltage_a_min,
    max(voltage_a_max) AS voltage_a_max,
    sum(voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_avg IS NOT NULL), 0) AS voltage_b_avg,
    min(voltage_b_min) AS voltage_b_min,
    max(voltage_b_max) AS voltage_b_max,
    sum(voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_avg IS NOT NULL), 0) AS voltage_c_avg,
    min(voltage_c_min) AS voltage_c_min,
    max(voltage_c_max) AS voltage_c_max,
    sum(current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE current_a_avg IS NOT NULL), 0) AS current_a_avg,
    min(current_a_min) AS current_a_min,
    max(current_a_max) AS current_a_max,
    sum(current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE current_b_avg IS NOT NULL), 0) AS current_b_avg,
    min(current_b_min) AS current_b_min,
    max(current_b_max) AS current_b_max,
    sum(current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE current_c_avg IS NOT NULL), 0) AS current_c_avg,
    min(current_c_min) AS current_c_min,
    max(current_c_max) AS current_c_max,
    sum(power_active_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_active_total_avg IS NOT NULL), 0) AS power_active_total_avg,
    min(power_active_total_min) AS power_active_total_min,
    max(power_active_total_max) AS power_active_total_max,
    sum(power_reactive_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_reactive_total_avg IS NOT NULL), 0) AS power_reactive_total_avg,
    min(power_reactive_total_min) AS power_reactive_total_min,
    max(power_reactive_total_max) AS power_reactive_total_max,
    sum(power_apparent_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_apparent_total_avg IS NOT NULL), 0) AS power_apparent_total_avg,
    min(power_apparent_total_min) AS power_apparent_total_min,
    max(power_apparent_total_max) AS power_apparent_total_max,
    sum(power_factor_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_factor_total_avg IS NOT NULL), 0) AS power_factor_total_avg,
    min(power_factor_total_min) AS power_factor_total_min,
    max(power_factor_total_max) AS power_factor_total_max,
    sum(frequency_avg * n) / NULLIF(sum(n) FILTER (WHERE frequency_avg IS NOT NULL), 0) AS frequency_avg,
    min(frequency_min) AS frequency_min,
    max(frequency_max) AS frequency_max,
    sum(thd_voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_a_avg IS NOT NULL), 0) AS thd_voltage_a_avg,
    min(thd_voltage_a_min) AS thd_voltage_a_min,
    max(thd_voltage_a_max) AS thd_voltage_a_max,
    sum(thd_voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_b_avg IS NOT NULL), 0) AS thd_voltage_b_avg,
    min(thd_voltage_b_min) AS thd_voltage_b_min,
    max(thd_voltage_b_max) AS thd_voltage_b_max,
    sum(thd_voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_c_avg IS NOT NULL), 0) AS thd_voltage_c_avg,
    min(thd_voltage_c_min) AS thd_voltage_c_min,
    max(thd_voltage_c_max) AS thd_voltage_c_max,
    sum(thd_current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_a_avg IS NOT NULL), 0) AS thd_current_a_avg,
    min(thd_current_a_min) AS thd_current_a_min,
    max(thd_current_a_max) AS thd_current_a_max,
    sum(thd_current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_b_avg IS NOT NULL), 0) AS thd_current_b_avg,
    min(thd_current_b_min) AS thd_current_b_min,
    max(thd_current_b_max) AS thd_current_b_max,
    sum(thd_current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_c_avg IS NOT NULL), 0) AS thd_current_c_avg,
    min(thd_current_c_min) AS thd_current_c_min,
    max(thd_current_c_max) AS thd_current_c_max,
    sum(voltage_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_unbalance_avg IS NOT NULL), 0) AS voltage_unbalance_avg,
    min(voltage_unbalance_min) AS voltage_unbalance_min,
    max(voltage_unbalance_max) AS voltage_unbalance_max,
    sum(current_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE current_unbalance_avg IS NOT NULL), 0) AS current_unbalance_avg,
    min(current_unbalance_min) AS current_unbalance_min,
    max(current_unbalance_max) AS current_unbalance_max,
    sum(voltage_a_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_ms IS NOT NULL), 0) AS voltage_a_ms,
    sum(voltage_b_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_ms IS NOT NULL), 0) AS voltage_b_ms,
    sum(voltage_c_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_ms IS NOT NULL), 0) AS voltage_c_ms,
    first(energy_import_total_first, bucket) FILTER (WHERE energy_import_total_first IS NOT NULL) AS energy_import_total_first,
    last(energy_import_total_last, bucket) FILTER (WHERE energy_import_total_last IS NOT NULL) AS energy_import_total_last,
    first(energy_export_total_first, bucket) FILTER (WHERE energy_export_total_first IS NOT NULL) AS energy_export_total_first,
    last(energy_export_total_last, bucket) FILTER (WHERE energy_export_total_last IS NOT NULL) AS energy_export_total_last,
    first(energy_reactive_import_total_first, bucket) FILTER (WHERE energy_reactive_import_total_first IS NOT NULL) AS energy_reactive_import_total_first,
    last(energy_reactive_import_total_last, bucket) FILTER (WHERE energy_reactive_import_total_last IS NOT NULL) AS energy_reactive_import_total_last,
    first(energy_reactive_export_total_first, bucket) FILTER (WHERE energy_reactive_export_total_first IS NOT NULL) AS energy_reactive_export_total_first,
    last(energy_reactive_export_total_last, bucket) FILTER (WHERE energy_reactive_export_total_last IS NOT NULL) AS energy_reactive_export_total_last
FROM readings_1m
GROUP BY meter_id, time_bucket('1 hour', bucket)
WITH NO DATA;

CREATE MATERIALIZED VIEW readings_1d
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    meter_id,
    time_bucket('1 day', bucket) AS bucket,
    sum(n) AS n,
    -- minutes with at least one sample: coverage, and the time weighting for demand,
    count(*) AS minutes,
    min(t_first) AS t_first,
    max(t_last) AS t_last,
    sum(n_interrupt) AS n_interrupt,
    sum(voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_avg IS NOT NULL), 0) AS voltage_a_avg,
    min(voltage_a_min) AS voltage_a_min,
    max(voltage_a_max) AS voltage_a_max,
    sum(voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_avg IS NOT NULL), 0) AS voltage_b_avg,
    min(voltage_b_min) AS voltage_b_min,
    max(voltage_b_max) AS voltage_b_max,
    sum(voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_avg IS NOT NULL), 0) AS voltage_c_avg,
    min(voltage_c_min) AS voltage_c_min,
    max(voltage_c_max) AS voltage_c_max,
    sum(current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE current_a_avg IS NOT NULL), 0) AS current_a_avg,
    min(current_a_min) AS current_a_min,
    max(current_a_max) AS current_a_max,
    sum(current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE current_b_avg IS NOT NULL), 0) AS current_b_avg,
    min(current_b_min) AS current_b_min,
    max(current_b_max) AS current_b_max,
    sum(current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE current_c_avg IS NOT NULL), 0) AS current_c_avg,
    min(current_c_min) AS current_c_min,
    max(current_c_max) AS current_c_max,
    sum(power_active_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_active_total_avg IS NOT NULL), 0) AS power_active_total_avg,
    min(power_active_total_min) AS power_active_total_min,
    max(power_active_total_max) AS power_active_total_max,
    sum(power_reactive_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_reactive_total_avg IS NOT NULL), 0) AS power_reactive_total_avg,
    min(power_reactive_total_min) AS power_reactive_total_min,
    max(power_reactive_total_max) AS power_reactive_total_max,
    sum(power_apparent_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_apparent_total_avg IS NOT NULL), 0) AS power_apparent_total_avg,
    min(power_apparent_total_min) AS power_apparent_total_min,
    max(power_apparent_total_max) AS power_apparent_total_max,
    sum(power_factor_total_avg * n) / NULLIF(sum(n) FILTER (WHERE power_factor_total_avg IS NOT NULL), 0) AS power_factor_total_avg,
    min(power_factor_total_min) AS power_factor_total_min,
    max(power_factor_total_max) AS power_factor_total_max,
    sum(frequency_avg * n) / NULLIF(sum(n) FILTER (WHERE frequency_avg IS NOT NULL), 0) AS frequency_avg,
    min(frequency_min) AS frequency_min,
    max(frequency_max) AS frequency_max,
    sum(thd_voltage_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_a_avg IS NOT NULL), 0) AS thd_voltage_a_avg,
    min(thd_voltage_a_min) AS thd_voltage_a_min,
    max(thd_voltage_a_max) AS thd_voltage_a_max,
    sum(thd_voltage_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_b_avg IS NOT NULL), 0) AS thd_voltage_b_avg,
    min(thd_voltage_b_min) AS thd_voltage_b_min,
    max(thd_voltage_b_max) AS thd_voltage_b_max,
    sum(thd_voltage_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_voltage_c_avg IS NOT NULL), 0) AS thd_voltage_c_avg,
    min(thd_voltage_c_min) AS thd_voltage_c_min,
    max(thd_voltage_c_max) AS thd_voltage_c_max,
    sum(thd_current_a_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_a_avg IS NOT NULL), 0) AS thd_current_a_avg,
    min(thd_current_a_min) AS thd_current_a_min,
    max(thd_current_a_max) AS thd_current_a_max,
    sum(thd_current_b_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_b_avg IS NOT NULL), 0) AS thd_current_b_avg,
    min(thd_current_b_min) AS thd_current_b_min,
    max(thd_current_b_max) AS thd_current_b_max,
    sum(thd_current_c_avg * n) / NULLIF(sum(n) FILTER (WHERE thd_current_c_avg IS NOT NULL), 0) AS thd_current_c_avg,
    min(thd_current_c_min) AS thd_current_c_min,
    max(thd_current_c_max) AS thd_current_c_max,
    sum(voltage_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE voltage_unbalance_avg IS NOT NULL), 0) AS voltage_unbalance_avg,
    min(voltage_unbalance_min) AS voltage_unbalance_min,
    max(voltage_unbalance_max) AS voltage_unbalance_max,
    sum(current_unbalance_avg * n) / NULLIF(sum(n) FILTER (WHERE current_unbalance_avg IS NOT NULL), 0) AS current_unbalance_avg,
    min(current_unbalance_min) AS current_unbalance_min,
    max(current_unbalance_max) AS current_unbalance_max,
    sum(voltage_a_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_a_ms IS NOT NULL), 0) AS voltage_a_ms,
    sum(voltage_b_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_b_ms IS NOT NULL), 0) AS voltage_b_ms,
    sum(voltage_c_ms * n) / NULLIF(sum(n) FILTER (WHERE voltage_c_ms IS NOT NULL), 0) AS voltage_c_ms,
    first(energy_import_total_first, bucket) FILTER (WHERE energy_import_total_first IS NOT NULL) AS energy_import_total_first,
    last(energy_import_total_last, bucket) FILTER (WHERE energy_import_total_last IS NOT NULL) AS energy_import_total_last,
    first(energy_export_total_first, bucket) FILTER (WHERE energy_export_total_first IS NOT NULL) AS energy_export_total_first,
    last(energy_export_total_last, bucket) FILTER (WHERE energy_export_total_last IS NOT NULL) AS energy_export_total_last,
    first(energy_reactive_import_total_first, bucket) FILTER (WHERE energy_reactive_import_total_first IS NOT NULL) AS energy_reactive_import_total_first,
    last(energy_reactive_import_total_last, bucket) FILTER (WHERE energy_reactive_import_total_last IS NOT NULL) AS energy_reactive_import_total_last,
    first(energy_reactive_export_total_first, bucket) FILTER (WHERE energy_reactive_export_total_first IS NOT NULL) AS energy_reactive_export_total_first,
    last(energy_reactive_export_total_last, bucket) FILTER (WHERE energy_reactive_export_total_last IS NOT NULL) AS energy_reactive_export_total_last
FROM readings_1m
GROUP BY meter_id, time_bucket('1 day', bucket)
WITH NO DATA;

-- Refresh policies: start_offset >= MAX_BACKFILL_DAYS, end_offset = one bucket.
SELECT add_continuous_aggregate_policy('readings_1m',  start_offset => INTERVAL '15 days', end_offset => INTERVAL '1 minute',   schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('readings_10m', start_offset => INTERVAL '15 days', end_offset => INTERVAL '10 minutes', schedule_interval => INTERVAL '5 minutes');
SELECT add_continuous_aggregate_policy('readings_30m', start_offset => INTERVAL '15 days', end_offset => INTERVAL '30 minutes', schedule_interval => INTERVAL '5 minutes');
SELECT add_continuous_aggregate_policy('readings_1h',  start_offset => INTERVAL '15 days', end_offset => INTERVAL '1 hour',     schedule_interval => INTERVAL '15 minutes');
SELECT add_continuous_aggregate_policy('readings_1d',  start_offset => INTERVAL '15 days', end_offset => INTERVAL '1 day',      schedule_interval => INTERVAL '1 hour');

-- Raw compression now starts at COMPRESS_AFTER_DAYS (15, was 35), still
-- strictly after the 14-day backfill window.
SELECT remove_compression_policy('meter_readings', if_exists => TRUE);
SELECT add_compression_policy('meter_readings', INTERVAL '15 days');

-- ── Alerting support (jobs role) ────────────────────────────────────────────
ALTER TABLE site_settings
    -- Declared current-distortion limit (%). No default: THD-I has no NRS 048-2
    -- limit, so without one the jobs only report a trend.
    ADD COLUMN alert_max_thd_i DECIMAL(6,2),
    -- pq_events shorter than this (seconds) do not raise an alert. NULL = default.
    ADD COLUMN event_alert_min_s INTEGER;

-- Dedupe in the database: one alert per (meter, type, key). The key encodes
-- the window (e.g. the 10-minute bucket, the hour, the event id).
ALTER TABLE alerts ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_alerts_dedupe ON alerts (meter_id, type, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Per-meter ingest counters (written by the ingest role once a minute), so the
-- jobs role can see rising ON CONFLICT counts, which only ingest observes.
CREATE TABLE ingest_stats (
    meter_id     UUID NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    hour         TIMESTAMPTZ NOT NULL,
    rows_written INTEGER NOT NULL DEFAULT 0,
    conflicts    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (meter_id, hour)
);

-- Down Migration
DROP TABLE ingest_stats;
DROP INDEX idx_alerts_dedupe;
ALTER TABLE alerts DROP COLUMN dedupe_key;
ALTER TABLE site_settings DROP COLUMN alert_max_thd_i, DROP COLUMN event_alert_min_s;
SELECT remove_compression_policy('meter_readings', if_exists => TRUE);
SELECT add_compression_policy('meter_readings', INTERVAL '35 days');
DROP MATERIALIZED VIEW readings_1d;
DROP MATERIALIZED VIEW readings_1h;
DROP MATERIALIZED VIEW readings_30m;
DROP MATERIALIZED VIEW readings_10m;
DROP MATERIALIZED VIEW readings_1m;
