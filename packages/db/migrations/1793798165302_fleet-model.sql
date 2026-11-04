-- Up Migration
-- Phase 6: fleet model. Projects, measurement points, devices, deployments.
--
-- Least disruptive path: the tables are renamed and the old names stay as
-- views over them.
--   sites  -> projects   (view sites  = SELECT * FROM projects)
--   meters -> devices    (view meters = SELECT * FROM devices)
-- Plain single-table views are updatable in Postgres, so every existing
-- query, INSERT ... RETURNING, UPDATE, ON CONFLICT and FOR UPDATE keeps
-- working unchanged, and foreign keys that pointed at sites/meters follow the
-- rename. Both names reach the same rows: nothing to keep in sync. The views
-- are dropped once Phase 8 has moved the UI and API to the new names.
--
-- Raw readings stay keyed by device (meter_readings.meter_id = devices.id)
-- and are never rewritten. Attribution to a point or project is by time
-- window through deployments; the point_readings_* views apply it, with the
-- per-deployment sign and scale corrections.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── Tenants ─────────────────────────────────────────────────────────────────
ALTER TABLE tenants
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'client' CHECK (kind IN ('internal', 'client')),
    ADD COLUMN slug TEXT;
-- A tenant holding super_admin users is Grid-IQ itself.
UPDATE tenants t SET kind = 'internal'
WHERE EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role = 'super_admin');
-- Slug from the name; a numeric suffix where two names collide.
WITH base AS (
    SELECT id, COALESCE(NULLIF(trim(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'tenant') AS s,
           created_at
    FROM tenants
), numbered AS (
    SELECT id, s, row_number() OVER (PARTITION BY s ORDER BY created_at, id) AS k FROM base
)
UPDATE tenants t SET slug = CASE WHEN n.k = 1 THEN n.s ELSE n.s || '-' || n.k END
FROM numbered n WHERE n.id = t.id;
CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);

-- ── Projects (was sites) ────────────────────────────────────────────────────
ALTER TABLE sites RENAME TO projects;
ALTER TABLE projects
    ADD COLUMN end_client_name   TEXT,
    ADD COLUMN gps_lat           DOUBLE PRECISION CHECK (gps_lat BETWEEN -90 AND 90),
    ADD COLUMN gps_lon           DOUBLE PRECISION CHECK (gps_lon BETWEEN -180 AND 180),
    ADD COLUMN status            TEXT NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('planned', 'active', 'completed', 'archived')),
    ADD COLUMN starts_on         DATE,
    ADD COLUMN ends_on           DATE,
    ADD COLUMN live_data_visible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN notes             TEXT,
    ADD CONSTRAINT projects_dates_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on);
-- New projects are South African local time. Existing rows keep their value
-- (the TOU endpoint already reads 'UTC' as Africa/Johannesburg).
ALTER TABLE projects ALTER COLUMN timezone SET DEFAULT 'Africa/Johannesburg';
UPDATE projects SET status = 'archived' WHERE archived_at IS NOT NULL;
COMMENT ON TABLE projects IS 'An engagement under a client tenant (was sites; the view sites stays until Phase 8). The tariff is the project''s site_settings row.';

-- The legacy archive/restore endpoints set archived_at; keep status in step.
CREATE FUNCTION projects_archive_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        IF NEW.archived_at IS NOT NULL THEN
            NEW.status := 'archived';
        ELSIF NEW.status = 'archived' THEN
            NEW.status := 'active';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER projects_archive_status BEFORE UPDATE OF archived_at ON projects
    FOR EACH ROW EXECUTE FUNCTION projects_archive_status();

CREATE VIEW sites AS SELECT * FROM projects;

-- ── Devices (was meters) ────────────────────────────────────────────────────
ALTER TABLE meters RENAME TO devices;
ALTER TABLE devices
    ADD COLUMN code               TEXT CHECK (code ~ '^[A-Z0-9][A-Z0-9-]*$'),
    ADD COLUMN comms_module       TEXT,
    ADD COLUMN firmware           TEXT,
    ADD COLUMN mqtt_username      TEXT,
    ADD COLUMN router_model       TEXT,
    ADD COLUMN sim_iccid          TEXT,
    ADD COLUMN calibration_due_on DATE,
    ADD COLUMN status             TEXT NOT NULL DEFAULT 'in_stock'
                                  CHECK (status IN ('in_stock', 'deployed', 'maintenance', 'retired')),
    ADD COLUMN notes              TEXT;
CREATE UNIQUE INDEX devices_code_key ON devices (code);
CREATE UNIQUE INDEX devices_mqtt_username_key ON devices (mqtt_username);
COMMENT ON TABLE devices IS 'A physical fleet asset (was meters; the view meters stays until Phase 8). meter_readings.meter_id = devices.id.';
COMMENT ON COLUMN devices.site_id IS 'Compatibility: the project of the device''s current (or last) deployment, so the legacy site pages still find it. Attribution is by deployments.';
COMMENT ON COLUMN devices.mqtt_username IS 'Broker username = topic segment (acuvim/{mqtt_username}/telemetry). New devices: lower(code). Legacy meters: NULL, they publish on their UUID.';

-- ── Measurement points ──────────────────────────────────────────────────────
CREATE TABLE measurement_points (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    role                  TEXT NOT NULL DEFAULT 'incomer'
                          CHECK (role IN ('incomer', 'sub_load', 'pv', 'bess', 'generator', 'other')),
    parent_point_id       UUID REFERENCES measurement_points(id) ON DELETE SET NULL
                          CHECK (parent_point_id IS DISTINCT FROM id),
    nominal_voltage_v     NUMERIC CHECK (nominal_voltage_v > 0),
    ct_primary_a          NUMERIC CHECK (ct_primary_a > 0),
    breaker_rating_a      NUMERIC CHECK (breaker_rating_a > 0),
    declared_capacity_kva NUMERIC CHECK (declared_capacity_kva > 0),
    contracted_mdi_kva    NUMERIC CHECK (contracted_mdi_kva > 0),
    sort_order            INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at           TIMESTAMPTZ
);
CREATE INDEX idx_points_project ON measurement_points (project_id);
COMMENT ON COLUMN measurement_points.nominal_voltage_v IS 'Phase-to-neutral nominal (230 V for LV). Commissioning checks each phase against it.';

-- ── Deployments ─────────────────────────────────────────────────────────────
CREATE TABLE deployments (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id            UUID NOT NULL REFERENCES devices(id),
    measurement_point_id UUID NOT NULL REFERENCES measurement_points(id),
    installed_at         TIMESTAMPTZ NOT NULL,
    removed_at           TIMESTAMPTZ,
    ct_ratio_configured  NUMERIC CHECK (ct_ratio_configured > 0),
    pt_ratio_configured  NUMERIC CHECK (pt_ratio_configured > 0),
    power_sign           SMALLINT NOT NULL DEFAULT 1 CHECK (power_sign IN (1, -1)),
    scale_correction     DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (scale_correction > 0),
    installed_by         TEXT,
    commissioning        JSONB,
    photos               JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (removed_at IS NULL OR removed_at > installed_at),
    -- A device is in one place at a time; a point has one device at a time.
    CONSTRAINT deployments_device_no_overlap EXCLUDE USING gist
        (device_id WITH =, tstzrange(installed_at, COALESCE(removed_at, 'infinity')) WITH &&),
    CONSTRAINT deployments_point_no_overlap EXCLUDE USING gist
        (measurement_point_id WITH =, tstzrange(installed_at, COALESCE(removed_at, 'infinity')) WITH &&)
);
CREATE INDEX idx_deployments_device ON deployments (device_id, installed_at);
CREATE INDEX idx_deployments_point ON deployments (measurement_point_id, installed_at);

-- ── Audit log (corrections now; Phase 7 adds the rest) ─────────────────────
CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_user_id UUID,
    actor_email   TEXT,
    action        TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    before        JSONB,
    after         JSONB,
    reason        TEXT
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, at DESC);

-- Payload bytes per device per hour, for the fleet's cellular data budget.
ALTER TABLE ingest_stats ADD COLUMN payload_bytes BIGINT NOT NULL DEFAULT 0;

-- ── Data migration: every existing meter becomes a deployed device ─────────
-- One point per meter. The role is incomer unless the meter's load profile
-- names only PV or only battery storage. One open deployment from the
-- meter's first reading (or its creation, if earlier or it has none);
-- archived meters are removed at their archive time and retired.
CREATE TEMP TABLE _first_reading ON COMMIT DROP AS
    SELECT d.id AS device_id,
           LEAST(d.created_at, (SELECT min(r.time) FROM meter_readings r WHERE r.meter_id = d.id)) AS first_at
    FROM devices d WHERE d.site_id IS NOT NULL;

INSERT INTO measurement_points (id, project_id, name, role, sort_order, created_at)
SELECT d.id, d.site_id, d.name,
       CASE WHEN d.load_types = ARRAY['solar_pv']::text[] THEN 'pv'
            WHEN d.load_types = ARRAY['battery_storage']::text[] THEN 'bess'
            ELSE 'incomer' END,
       (row_number() OVER (PARTITION BY d.site_id ORDER BY d.created_at, d.id))::int,
       d.created_at
FROM devices d WHERE d.site_id IS NOT NULL;
-- (Point ids reuse the meter ids: one point per migrated meter, easy to trace.)

INSERT INTO deployments (device_id, measurement_point_id, installed_at, removed_at,
                         ct_ratio_configured, pt_ratio_configured, installed_by, commissioning)
SELECT d.id, d.id, COALESCE(f.first_at, d.created_at, NOW()),
       CASE WHEN d.archived_at > COALESCE(f.first_at, d.created_at) THEN d.archived_at END,
       d.ct_ratio, d.pt_ratio, 'migration (Phase 6)',
       '{"final": true, "overall": "not_evaluated", "note": "In service before commissioning checks existed", "checks": []}'::jsonb
FROM devices d JOIN _first_reading f ON f.device_id = d.id;

UPDATE devices SET status = CASE WHEN archived_at IS NOT NULL THEN 'retired' ELSE 'deployed' END
WHERE site_id IS NOT NULL;
UPDATE measurement_points p SET archived_at = d.archived_at FROM devices d WHERE d.id = p.id AND d.archived_at IS NOT NULL;

-- contracted_mdi_kva belongs to the incomer point. site_settings stays the
-- source the UI and alerting read until Phase 8; copy it now and mirror later
-- writes, so the point value is never stale.
UPDATE measurement_points p SET contracted_mdi_kva = ss.contracted_mdi_kva
FROM site_settings ss WHERE ss.site_id = p.project_id AND p.role = 'incomer' AND p.parent_point_id IS NULL
  AND ss.contracted_mdi_kva IS NOT NULL;

CREATE FUNCTION site_settings_mirror_mdi() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE measurement_points SET contracted_mdi_kva = NEW.contracted_mdi_kva
    WHERE project_id = NEW.site_id AND role = 'incomer' AND parent_point_id IS NULL;
    RETURN NEW;
END $$;
CREATE TRIGGER site_settings_mirror_mdi AFTER INSERT OR UPDATE OF contracted_mdi_kva ON site_settings
    FOR EACH ROW EXECUTE FUNCTION site_settings_mirror_mdi();

-- Meters still created through the legacy path (Add Meter, seeds, CSV
-- tooling) get a point and an open deployment at their project, so the fleet
-- model covers every device. Fleet-API devices are created without a site
-- and installed explicitly.
CREATE FUNCTION devices_legacy_deploy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.site_id IS NOT NULL THEN
        INSERT INTO measurement_points (id, project_id, name, role, sort_order)
        VALUES (NEW.id, NEW.site_id, NEW.name,
                CASE WHEN NEW.load_types = ARRAY['solar_pv']::text[] THEN 'pv'
                     WHEN NEW.load_types = ARRAY['battery_storage']::text[] THEN 'bess'
                     ELSE 'incomer' END,
                (SELECT COALESCE(max(sort_order), 0) + 1 FROM measurement_points WHERE project_id = NEW.site_id));
        INSERT INTO deployments (device_id, measurement_point_id, installed_at, ct_ratio_configured, pt_ratio_configured, installed_by)
        VALUES (NEW.id, NEW.id, COALESCE(NEW.created_at, NOW()), NEW.ct_ratio, NEW.pt_ratio, 'legacy add meter');
        UPDATE devices SET status = 'deployed' WHERE id = NEW.id;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER devices_legacy_deploy AFTER INSERT ON devices
    FOR EACH ROW EXECUTE FUNCTION devices_legacy_deploy();

CREATE VIEW meters AS SELECT * FROM devices;

-- ── Point-level views over each aggregate ──────────────────────────────────
-- Each bucket is attributed to the deployment whose window holds the
-- bucket's first sample (t_first): exactly one deployment, and the partial
-- bucket at an install is kept. The 1-minute view is exact to the minute; in
-- an hourly or daily bucket that spans a removal and the next install, the
-- whole bucket goes to the earlier deployment. Corrections per deployment:
--   power_sign -1   negates P, Q, PF and kW demand (min and max swap) and
--                   swaps the import and export registers;
--   scale_correction multiplies currents, P, Q, S, demand and registers.
-- Voltages, frequency, THD and unbalance are ratios or unaffected.
CREATE VIEW point_readings_1m AS
SELECT d.measurement_point_id,
       p.project_id,
       pr.tenant_id,
       d.id AS deployment_id,
       r.meter_id AS device_id,
       (d.power_sign <> 1 OR d.scale_correction <> 1) AS correction_applied,
       r.bucket,
       r.n,
       r.t_first,
       r.t_last,
       r.n_interrupt,
       r.voltage_a_avg,
       r.voltage_a_min,
       r.voltage_a_max,
       r.voltage_b_avg,
       r.voltage_b_min,
       r.voltage_b_max,
       r.voltage_c_avg,
       r.voltage_c_min,
       r.voltage_c_max,
       r.current_a_avg * d.scale_correction AS current_a_avg,
       r.current_a_min * d.scale_correction AS current_a_min,
       r.current_a_max * d.scale_correction AS current_a_max,
       r.current_b_avg * d.scale_correction AS current_b_avg,
       r.current_b_min * d.scale_correction AS current_b_min,
       r.current_b_max * d.scale_correction AS current_b_max,
       r.current_c_avg * d.scale_correction AS current_c_avg,
       r.current_c_min * d.scale_correction AS current_c_min,
       r.current_c_max * d.scale_correction AS current_c_max,
       r.power_active_total_avg * d.power_sign * d.scale_correction AS power_active_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_min ELSE -r.power_active_total_max END * d.scale_correction AS power_active_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_max ELSE -r.power_active_total_min END * d.scale_correction AS power_active_total_max,
       r.power_reactive_total_avg * d.power_sign * d.scale_correction AS power_reactive_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_min ELSE -r.power_reactive_total_max END * d.scale_correction AS power_reactive_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_max ELSE -r.power_reactive_total_min END * d.scale_correction AS power_reactive_total_max,
       r.power_apparent_total_avg * d.scale_correction AS power_apparent_total_avg,
       r.power_apparent_total_min * d.scale_correction AS power_apparent_total_min,
       r.power_apparent_total_max * d.scale_correction AS power_apparent_total_max,
       r.power_factor_total_avg * d.power_sign AS power_factor_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_min ELSE -r.power_factor_total_max END AS power_factor_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_max ELSE -r.power_factor_total_min END AS power_factor_total_max,
       r.frequency_avg,
       r.frequency_min,
       r.frequency_max,
       r.thd_voltage_a_avg,
       r.thd_voltage_a_min,
       r.thd_voltage_a_max,
       r.thd_voltage_b_avg,
       r.thd_voltage_b_min,
       r.thd_voltage_b_max,
       r.thd_voltage_c_avg,
       r.thd_voltage_c_min,
       r.thd_voltage_c_max,
       r.thd_current_a_avg,
       r.thd_current_a_min,
       r.thd_current_a_max,
       r.thd_current_b_avg,
       r.thd_current_b_min,
       r.thd_current_b_max,
       r.thd_current_c_avg,
       r.thd_current_c_min,
       r.thd_current_c_max,
       r.voltage_unbalance_avg,
       r.voltage_unbalance_min,
       r.voltage_unbalance_max,
       r.current_unbalance_avg,
       r.current_unbalance_min,
       r.current_unbalance_max,
       r.voltage_a_ms,
       r.voltage_b_ms,
       r.voltage_c_ms,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_first ELSE r.energy_export_total_first END * d.scale_correction AS energy_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_last ELSE r.energy_export_total_last END * d.scale_correction AS energy_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_first ELSE r.energy_import_total_first END * d.scale_correction AS energy_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_last ELSE r.energy_import_total_last END * d.scale_correction AS energy_export_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_first ELSE r.energy_reactive_export_total_first END * d.scale_correction AS energy_reactive_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_last ELSE r.energy_reactive_export_total_last END * d.scale_correction AS energy_reactive_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_first ELSE r.energy_reactive_import_total_first END * d.scale_correction AS energy_reactive_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_last ELSE r.energy_reactive_import_total_last END * d.scale_correction AS energy_reactive_export_total_last
FROM readings_1m r
JOIN deployments d ON d.device_id = r.meter_id
                  AND r.t_first >= d.installed_at
                  AND (d.removed_at IS NULL OR r.t_first < d.removed_at)
JOIN measurement_points p ON p.id = d.measurement_point_id
JOIN projects pr ON pr.id = p.project_id;

CREATE VIEW point_readings_10m AS
SELECT d.measurement_point_id,
       p.project_id,
       pr.tenant_id,
       d.id AS deployment_id,
       r.meter_id AS device_id,
       (d.power_sign <> 1 OR d.scale_correction <> 1) AS correction_applied,
       r.bucket,
       r.n,
       r.minutes,
       r.t_first,
       r.t_last,
       r.n_interrupt,
       r.voltage_a_avg,
       r.voltage_a_min,
       r.voltage_a_max,
       r.voltage_b_avg,
       r.voltage_b_min,
       r.voltage_b_max,
       r.voltage_c_avg,
       r.voltage_c_min,
       r.voltage_c_max,
       r.current_a_avg * d.scale_correction AS current_a_avg,
       r.current_a_min * d.scale_correction AS current_a_min,
       r.current_a_max * d.scale_correction AS current_a_max,
       r.current_b_avg * d.scale_correction AS current_b_avg,
       r.current_b_min * d.scale_correction AS current_b_min,
       r.current_b_max * d.scale_correction AS current_b_max,
       r.current_c_avg * d.scale_correction AS current_c_avg,
       r.current_c_min * d.scale_correction AS current_c_min,
       r.current_c_max * d.scale_correction AS current_c_max,
       r.power_active_total_avg * d.power_sign * d.scale_correction AS power_active_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_min ELSE -r.power_active_total_max END * d.scale_correction AS power_active_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_max ELSE -r.power_active_total_min END * d.scale_correction AS power_active_total_max,
       r.power_reactive_total_avg * d.power_sign * d.scale_correction AS power_reactive_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_min ELSE -r.power_reactive_total_max END * d.scale_correction AS power_reactive_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_max ELSE -r.power_reactive_total_min END * d.scale_correction AS power_reactive_total_max,
       r.power_apparent_total_avg * d.scale_correction AS power_apparent_total_avg,
       r.power_apparent_total_min * d.scale_correction AS power_apparent_total_min,
       r.power_apparent_total_max * d.scale_correction AS power_apparent_total_max,
       r.power_factor_total_avg * d.power_sign AS power_factor_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_min ELSE -r.power_factor_total_max END AS power_factor_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_max ELSE -r.power_factor_total_min END AS power_factor_total_max,
       r.frequency_avg,
       r.frequency_min,
       r.frequency_max,
       r.thd_voltage_a_avg,
       r.thd_voltage_a_min,
       r.thd_voltage_a_max,
       r.thd_voltage_b_avg,
       r.thd_voltage_b_min,
       r.thd_voltage_b_max,
       r.thd_voltage_c_avg,
       r.thd_voltage_c_min,
       r.thd_voltage_c_max,
       r.thd_current_a_avg,
       r.thd_current_a_min,
       r.thd_current_a_max,
       r.thd_current_b_avg,
       r.thd_current_b_min,
       r.thd_current_b_max,
       r.thd_current_c_avg,
       r.thd_current_c_min,
       r.thd_current_c_max,
       r.voltage_unbalance_avg,
       r.voltage_unbalance_min,
       r.voltage_unbalance_max,
       r.current_unbalance_avg,
       r.current_unbalance_min,
       r.current_unbalance_max,
       r.voltage_a_ms,
       r.voltage_b_ms,
       r.voltage_c_ms,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_first ELSE r.energy_export_total_first END * d.scale_correction AS energy_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_last ELSE r.energy_export_total_last END * d.scale_correction AS energy_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_first ELSE r.energy_import_total_first END * d.scale_correction AS energy_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_last ELSE r.energy_import_total_last END * d.scale_correction AS energy_export_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_first ELSE r.energy_reactive_export_total_first END * d.scale_correction AS energy_reactive_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_last ELSE r.energy_reactive_export_total_last END * d.scale_correction AS energy_reactive_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_first ELSE r.energy_reactive_import_total_first END * d.scale_correction AS energy_reactive_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_last ELSE r.energy_reactive_import_total_last END * d.scale_correction AS energy_reactive_export_total_last
FROM readings_10m r
JOIN deployments d ON d.device_id = r.meter_id
                  AND r.t_first >= d.installed_at
                  AND (d.removed_at IS NULL OR r.t_first < d.removed_at)
JOIN measurement_points p ON p.id = d.measurement_point_id
JOIN projects pr ON pr.id = p.project_id;

CREATE VIEW point_readings_30m AS
SELECT d.measurement_point_id,
       p.project_id,
       pr.tenant_id,
       d.id AS deployment_id,
       r.meter_id AS device_id,
       (d.power_sign <> 1 OR d.scale_correction <> 1) AS correction_applied,
       r.bucket,
       r.n,
       r.minutes,
       r.t_first,
       r.t_last,
       r.n_interrupt,
       r.voltage_a_avg,
       r.voltage_a_min,
       r.voltage_a_max,
       r.voltage_b_avg,
       r.voltage_b_min,
       r.voltage_b_max,
       r.voltage_c_avg,
       r.voltage_c_min,
       r.voltage_c_max,
       r.current_a_avg * d.scale_correction AS current_a_avg,
       r.current_a_min * d.scale_correction AS current_a_min,
       r.current_a_max * d.scale_correction AS current_a_max,
       r.current_b_avg * d.scale_correction AS current_b_avg,
       r.current_b_min * d.scale_correction AS current_b_min,
       r.current_b_max * d.scale_correction AS current_b_max,
       r.current_c_avg * d.scale_correction AS current_c_avg,
       r.current_c_min * d.scale_correction AS current_c_min,
       r.current_c_max * d.scale_correction AS current_c_max,
       r.power_active_total_avg * d.power_sign * d.scale_correction AS power_active_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_min ELSE -r.power_active_total_max END * d.scale_correction AS power_active_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_max ELSE -r.power_active_total_min END * d.scale_correction AS power_active_total_max,
       r.power_reactive_total_avg * d.power_sign * d.scale_correction AS power_reactive_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_min ELSE -r.power_reactive_total_max END * d.scale_correction AS power_reactive_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_max ELSE -r.power_reactive_total_min END * d.scale_correction AS power_reactive_total_max,
       r.power_apparent_total_avg * d.scale_correction AS power_apparent_total_avg,
       r.power_apparent_total_min * d.scale_correction AS power_apparent_total_min,
       r.power_apparent_total_max * d.scale_correction AS power_apparent_total_max,
       r.power_factor_total_avg * d.power_sign AS power_factor_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_min ELSE -r.power_factor_total_max END AS power_factor_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_max ELSE -r.power_factor_total_min END AS power_factor_total_max,
       r.frequency_avg,
       r.frequency_min,
       r.frequency_max,
       r.thd_voltage_a_avg,
       r.thd_voltage_a_min,
       r.thd_voltage_a_max,
       r.thd_voltage_b_avg,
       r.thd_voltage_b_min,
       r.thd_voltage_b_max,
       r.thd_voltage_c_avg,
       r.thd_voltage_c_min,
       r.thd_voltage_c_max,
       r.thd_current_a_avg,
       r.thd_current_a_min,
       r.thd_current_a_max,
       r.thd_current_b_avg,
       r.thd_current_b_min,
       r.thd_current_b_max,
       r.thd_current_c_avg,
       r.thd_current_c_min,
       r.thd_current_c_max,
       r.voltage_unbalance_avg,
       r.voltage_unbalance_min,
       r.voltage_unbalance_max,
       r.current_unbalance_avg,
       r.current_unbalance_min,
       r.current_unbalance_max,
       r.voltage_a_ms,
       r.voltage_b_ms,
       r.voltage_c_ms,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_first ELSE r.energy_export_total_first END * d.scale_correction AS energy_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_last ELSE r.energy_export_total_last END * d.scale_correction AS energy_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_first ELSE r.energy_import_total_first END * d.scale_correction AS energy_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_last ELSE r.energy_import_total_last END * d.scale_correction AS energy_export_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_first ELSE r.energy_reactive_export_total_first END * d.scale_correction AS energy_reactive_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_last ELSE r.energy_reactive_export_total_last END * d.scale_correction AS energy_reactive_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_first ELSE r.energy_reactive_import_total_first END * d.scale_correction AS energy_reactive_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_last ELSE r.energy_reactive_import_total_last END * d.scale_correction AS energy_reactive_export_total_last,
       r.kva_demand * d.scale_correction AS kva_demand,
       r.kw_demand * d.power_sign * d.scale_correction AS kw_demand
FROM readings_30m r
JOIN deployments d ON d.device_id = r.meter_id
                  AND r.t_first >= d.installed_at
                  AND (d.removed_at IS NULL OR r.t_first < d.removed_at)
JOIN measurement_points p ON p.id = d.measurement_point_id
JOIN projects pr ON pr.id = p.project_id;

CREATE VIEW point_readings_1h AS
SELECT d.measurement_point_id,
       p.project_id,
       pr.tenant_id,
       d.id AS deployment_id,
       r.meter_id AS device_id,
       (d.power_sign <> 1 OR d.scale_correction <> 1) AS correction_applied,
       r.bucket,
       r.n,
       r.minutes,
       r.t_first,
       r.t_last,
       r.n_interrupt,
       r.voltage_a_avg,
       r.voltage_a_min,
       r.voltage_a_max,
       r.voltage_b_avg,
       r.voltage_b_min,
       r.voltage_b_max,
       r.voltage_c_avg,
       r.voltage_c_min,
       r.voltage_c_max,
       r.current_a_avg * d.scale_correction AS current_a_avg,
       r.current_a_min * d.scale_correction AS current_a_min,
       r.current_a_max * d.scale_correction AS current_a_max,
       r.current_b_avg * d.scale_correction AS current_b_avg,
       r.current_b_min * d.scale_correction AS current_b_min,
       r.current_b_max * d.scale_correction AS current_b_max,
       r.current_c_avg * d.scale_correction AS current_c_avg,
       r.current_c_min * d.scale_correction AS current_c_min,
       r.current_c_max * d.scale_correction AS current_c_max,
       r.power_active_total_avg * d.power_sign * d.scale_correction AS power_active_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_min ELSE -r.power_active_total_max END * d.scale_correction AS power_active_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_max ELSE -r.power_active_total_min END * d.scale_correction AS power_active_total_max,
       r.power_reactive_total_avg * d.power_sign * d.scale_correction AS power_reactive_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_min ELSE -r.power_reactive_total_max END * d.scale_correction AS power_reactive_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_max ELSE -r.power_reactive_total_min END * d.scale_correction AS power_reactive_total_max,
       r.power_apparent_total_avg * d.scale_correction AS power_apparent_total_avg,
       r.power_apparent_total_min * d.scale_correction AS power_apparent_total_min,
       r.power_apparent_total_max * d.scale_correction AS power_apparent_total_max,
       r.power_factor_total_avg * d.power_sign AS power_factor_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_min ELSE -r.power_factor_total_max END AS power_factor_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_max ELSE -r.power_factor_total_min END AS power_factor_total_max,
       r.frequency_avg,
       r.frequency_min,
       r.frequency_max,
       r.thd_voltage_a_avg,
       r.thd_voltage_a_min,
       r.thd_voltage_a_max,
       r.thd_voltage_b_avg,
       r.thd_voltage_b_min,
       r.thd_voltage_b_max,
       r.thd_voltage_c_avg,
       r.thd_voltage_c_min,
       r.thd_voltage_c_max,
       r.thd_current_a_avg,
       r.thd_current_a_min,
       r.thd_current_a_max,
       r.thd_current_b_avg,
       r.thd_current_b_min,
       r.thd_current_b_max,
       r.thd_current_c_avg,
       r.thd_current_c_min,
       r.thd_current_c_max,
       r.voltage_unbalance_avg,
       r.voltage_unbalance_min,
       r.voltage_unbalance_max,
       r.current_unbalance_avg,
       r.current_unbalance_min,
       r.current_unbalance_max,
       r.voltage_a_ms,
       r.voltage_b_ms,
       r.voltage_c_ms,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_first ELSE r.energy_export_total_first END * d.scale_correction AS energy_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_last ELSE r.energy_export_total_last END * d.scale_correction AS energy_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_first ELSE r.energy_import_total_first END * d.scale_correction AS energy_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_last ELSE r.energy_import_total_last END * d.scale_correction AS energy_export_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_first ELSE r.energy_reactive_export_total_first END * d.scale_correction AS energy_reactive_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_last ELSE r.energy_reactive_export_total_last END * d.scale_correction AS energy_reactive_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_first ELSE r.energy_reactive_import_total_first END * d.scale_correction AS energy_reactive_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_last ELSE r.energy_reactive_import_total_last END * d.scale_correction AS energy_reactive_export_total_last
FROM readings_1h r
JOIN deployments d ON d.device_id = r.meter_id
                  AND r.t_first >= d.installed_at
                  AND (d.removed_at IS NULL OR r.t_first < d.removed_at)
JOIN measurement_points p ON p.id = d.measurement_point_id
JOIN projects pr ON pr.id = p.project_id;

CREATE VIEW point_readings_1d AS
SELECT d.measurement_point_id,
       p.project_id,
       pr.tenant_id,
       d.id AS deployment_id,
       r.meter_id AS device_id,
       (d.power_sign <> 1 OR d.scale_correction <> 1) AS correction_applied,
       r.bucket,
       r.n,
       r.minutes,
       r.t_first,
       r.t_last,
       r.n_interrupt,
       r.voltage_a_avg,
       r.voltage_a_min,
       r.voltage_a_max,
       r.voltage_b_avg,
       r.voltage_b_min,
       r.voltage_b_max,
       r.voltage_c_avg,
       r.voltage_c_min,
       r.voltage_c_max,
       r.current_a_avg * d.scale_correction AS current_a_avg,
       r.current_a_min * d.scale_correction AS current_a_min,
       r.current_a_max * d.scale_correction AS current_a_max,
       r.current_b_avg * d.scale_correction AS current_b_avg,
       r.current_b_min * d.scale_correction AS current_b_min,
       r.current_b_max * d.scale_correction AS current_b_max,
       r.current_c_avg * d.scale_correction AS current_c_avg,
       r.current_c_min * d.scale_correction AS current_c_min,
       r.current_c_max * d.scale_correction AS current_c_max,
       r.power_active_total_avg * d.power_sign * d.scale_correction AS power_active_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_min ELSE -r.power_active_total_max END * d.scale_correction AS power_active_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_active_total_max ELSE -r.power_active_total_min END * d.scale_correction AS power_active_total_max,
       r.power_reactive_total_avg * d.power_sign * d.scale_correction AS power_reactive_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_min ELSE -r.power_reactive_total_max END * d.scale_correction AS power_reactive_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_reactive_total_max ELSE -r.power_reactive_total_min END * d.scale_correction AS power_reactive_total_max,
       r.power_apparent_total_avg * d.scale_correction AS power_apparent_total_avg,
       r.power_apparent_total_min * d.scale_correction AS power_apparent_total_min,
       r.power_apparent_total_max * d.scale_correction AS power_apparent_total_max,
       r.power_factor_total_avg * d.power_sign AS power_factor_total_avg,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_min ELSE -r.power_factor_total_max END AS power_factor_total_min,
       CASE WHEN d.power_sign = 1 THEN r.power_factor_total_max ELSE -r.power_factor_total_min END AS power_factor_total_max,
       r.frequency_avg,
       r.frequency_min,
       r.frequency_max,
       r.thd_voltage_a_avg,
       r.thd_voltage_a_min,
       r.thd_voltage_a_max,
       r.thd_voltage_b_avg,
       r.thd_voltage_b_min,
       r.thd_voltage_b_max,
       r.thd_voltage_c_avg,
       r.thd_voltage_c_min,
       r.thd_voltage_c_max,
       r.thd_current_a_avg,
       r.thd_current_a_min,
       r.thd_current_a_max,
       r.thd_current_b_avg,
       r.thd_current_b_min,
       r.thd_current_b_max,
       r.thd_current_c_avg,
       r.thd_current_c_min,
       r.thd_current_c_max,
       r.voltage_unbalance_avg,
       r.voltage_unbalance_min,
       r.voltage_unbalance_max,
       r.current_unbalance_avg,
       r.current_unbalance_min,
       r.current_unbalance_max,
       r.voltage_a_ms,
       r.voltage_b_ms,
       r.voltage_c_ms,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_first ELSE r.energy_export_total_first END * d.scale_correction AS energy_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_import_total_last ELSE r.energy_export_total_last END * d.scale_correction AS energy_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_first ELSE r.energy_import_total_first END * d.scale_correction AS energy_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_export_total_last ELSE r.energy_import_total_last END * d.scale_correction AS energy_export_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_first ELSE r.energy_reactive_export_total_first END * d.scale_correction AS energy_reactive_import_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_import_total_last ELSE r.energy_reactive_export_total_last END * d.scale_correction AS energy_reactive_import_total_last,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_first ELSE r.energy_reactive_import_total_first END * d.scale_correction AS energy_reactive_export_total_first,
       CASE WHEN d.power_sign = 1 THEN r.energy_reactive_export_total_last ELSE r.energy_reactive_import_total_last END * d.scale_correction AS energy_reactive_export_total_last
FROM readings_1d r
JOIN deployments d ON d.device_id = r.meter_id
                  AND r.t_first >= d.installed_at
                  AND (d.removed_at IS NULL OR r.t_first < d.removed_at)
JOIN measurement_points p ON p.id = d.measurement_point_id
JOIN projects pr ON pr.id = p.project_id;

-- Down Migration
DROP VIEW point_readings_1d;
DROP VIEW point_readings_1h;
DROP VIEW point_readings_30m;
DROP VIEW point_readings_10m;
DROP VIEW point_readings_1m;
DROP VIEW meters;
DROP TRIGGER devices_legacy_deploy ON devices;
DROP FUNCTION devices_legacy_deploy();
DROP TRIGGER site_settings_mirror_mdi ON site_settings;
DROP FUNCTION site_settings_mirror_mdi();
ALTER TABLE ingest_stats DROP COLUMN payload_bytes;
DROP TABLE audit_log;
DROP TABLE deployments;
DROP TABLE measurement_points;
DROP INDEX devices_mqtt_username_key;
DROP INDEX devices_code_key;
ALTER TABLE devices
    DROP COLUMN code, DROP COLUMN comms_module, DROP COLUMN firmware, DROP COLUMN mqtt_username,
    DROP COLUMN router_model, DROP COLUMN sim_iccid, DROP COLUMN calibration_due_on,
    DROP COLUMN status, DROP COLUMN notes;
ALTER TABLE devices RENAME TO meters;
DROP VIEW sites;
DROP TRIGGER projects_archive_status ON projects;
DROP FUNCTION projects_archive_status();
ALTER TABLE projects ALTER COLUMN timezone SET DEFAULT 'UTC';
ALTER TABLE projects
    DROP CONSTRAINT projects_dates_check,
    DROP COLUMN end_client_name, DROP COLUMN gps_lat, DROP COLUMN gps_lon, DROP COLUMN status,
    DROP COLUMN starts_on, DROP COLUMN ends_on, DROP COLUMN live_data_visible, DROP COLUMN notes;
ALTER TABLE projects RENAME TO sites;
DROP INDEX tenants_slug_key;
ALTER TABLE tenants DROP COLUMN kind, DROP COLUMN slug;
