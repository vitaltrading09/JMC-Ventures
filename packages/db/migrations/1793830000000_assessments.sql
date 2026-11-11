-- Up Migration
-- GridIQ assessment model (implementation prompt 2026-11-11, sections 4–6, 13).
--
-- A client buys a fixed-period assessment of a site. The meter stays a
-- company asset (devices, deployments); the assessment is the purchased
-- service with its own clock, separate from the physical deployment window,
-- the report deadlines and the retention deadline.
--
-- Clients reach live data, history, findings, chat and the API only through an
-- access grant on an assessment whose window [start_at, end_at) contains NOW()
-- and that has not been closed or revoked. This is checked in SQL on every
-- request (src/scope.ts telemetrySql); the expiry job only does follow-up work.
-- Existing projects get no assessment and no access: staff create one.

-- ── Packages (editable, draft until the operator confirms tax and inclusions) ─
CREATE TABLE assessment_packages (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                    TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]+$'),
    name                    TEXT NOT NULL,
    duration_days           INTEGER NOT NULL CHECK (duration_days > 0),
    -- Money in integer cents (ZAR).
    price_cents             BIGINT NOT NULL CHECK (price_cents >= 0),
    currency                CHAR(3) NOT NULL DEFAULT 'ZAR',
    -- Unknown until the operator says: are the example prices VAT-inclusive?
    tax_basis               TEXT CHECK (tax_basis IN ('incl_vat', 'excl_vat', 'not_vat_registered')),
    included_meters         INTEGER NOT NULL DEFAULT 1 CHECK (included_meters >= 1),
    extra_meter_price_cents BIGINT CHECK (extra_meter_price_cents >= 0),
    day_rate_cents          BIGINT CHECK (day_rate_cents >= 0),
    retention_months        INTEGER NOT NULL DEFAULT 3 CHECK (retention_months IN (3, 6)),
    inclusions              JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status <> 'published' OR tax_basis IS NOT NULL)
);

-- Example prices from the brief: same core features for every duration.
-- Draft: a package cannot be published until its tax basis is set.
INSERT INTO assessment_packages (code, name, duration_days, price_cents, inclusions) VALUES
    ('assess-7d',  '7-day assessment',  7,  299900, '{"reports": ["overview", "power_quality"], "data_export": true, "consultant_chat": true, "note": "Example price; confirm VAT treatment and inclusions before publishing"}'),
    ('assess-14d', '14-day assessment', 14, 499900, '{"reports": ["overview", "power_quality"], "data_export": true, "consultant_chat": true, "note": "Example price; confirm VAT treatment and inclusions before publishing"}'),
    ('assess-21d', '21-day assessment', 21, 699900, '{"reports": ["overview", "power_quality"], "data_export": true, "consultant_chat": true, "note": "Example price; confirm VAT treatment and inclusions before publishing"}'),
    ('assess-30d', '30-day assessment', 30, 799900, '{"reports": ["overview", "power_quality"], "data_export": true, "consultant_chat": true, "note": "Example price; confirm VAT treatment and inclusions before publishing"}');

-- ── Assessments ─────────────────────────────────────────────────────────────
CREATE SEQUENCE assessment_ref_seq;

CREATE TABLE assessments (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference                TEXT NOT NULL UNIQUE DEFAULT ('GQ-A-' || lpad(nextval('assessment_ref_seq')::text, 4, '0')),
    tenant_id                UUID NOT NULL REFERENCES tenants(id),
    project_id               UUID NOT NULL REFERENCES projects(id),
    package_id               UUID REFERENCES assessment_packages(id),
    title                    TEXT NOT NULL,
    -- Operational state. 'active' is necessary but not sufficient for access:
    -- start_at <= NOW() < end_at is checked as well.
    status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'scheduled', 'active', 'ended', 'cancelled')),
    -- Purchased duration: a day is 24 hours from the confirmed start.
    duration_days            INTEGER NOT NULL CHECK (duration_days > 0),
    planned_start_at         TIMESTAMPTZ,
    start_at                 TIMESTAMPTZ,
    end_at                   TIMESTAMPTZ,
    -- Early closure / cancellation (end_at keeps the purchased end).
    closed_at                TIMESTAMPTZ,
    close_reason             TEXT,
    timezone                 TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
    -- Commercial snapshot (the quote as agreed) and payment.
    quote                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    price_cents              BIGINT CHECK (price_cents >= 0),
    payment_state            TEXT NOT NULL DEFAULT 'unpaid'
                             CHECK (payment_state IN ('unpaid', 'invoiced', 'paid', 'exception')),
    payment_reference        TEXT,
    payment_exception_reason TEXT,
    -- Final-delivery grant: after end_at, recipients may download only the
    -- frozen deliverables for this many days (capped by retention).
    delivery_days            INTEGER NOT NULL DEFAULT 7 CHECK (delivery_days BETWEEN 0 AND 31),
    -- Report and retention state are independent of the operational status.
    report_status            TEXT NOT NULL DEFAULT 'not_started'
                             CHECK (report_status IN ('not_started', 'provisional', 'awaiting_review', 'issued', 'delivery_failed')),
    retention_months         INTEGER NOT NULL DEFAULT 3 CHECK (retention_months IN (3, 6)),
    -- end_at + retention_months calendar months (end-of-month clamped), set at start.
    retention_until          TIMESTAMPTZ,
    retention_status         TEXT NOT NULL DEFAULT 'retained'
                             CHECK (retention_status IN ('retained', 'purge_pending', 'purged', 'purge_failed')),
    retention_exception_until  TIMESTAMPTZ,
    retention_exception_reason TEXT,
    internal_notes           TEXT,
    created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_at IS NULL OR (start_at IS NOT NULL AND end_at > start_at)),
    CHECK (status NOT IN ('active', 'ended') OR (start_at IS NOT NULL AND end_at IS NOT NULL)),
    CHECK (payment_state <> 'exception' OR payment_exception_reason IS NOT NULL),
    CHECK (retention_exception_until IS NULL OR retention_exception_reason IS NOT NULL)
);
CREATE INDEX idx_assessments_project ON assessments (project_id);
CREATE INDEX idx_assessments_tenant ON assessments (tenant_id);
CREATE INDEX idx_assessments_live ON assessments (end_at) WHERE status = 'active';

-- The points (and so the deployments) an assessment covers.
CREATE TABLE assessment_points (
    assessment_id        UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    measurement_point_id UUID NOT NULL REFERENCES measurement_points(id),
    PRIMARY KEY (assessment_id, measurement_point_id)
);

-- Named access. user_id is resolved when the user exists; until then the
-- grant waits on the email (the user's own email must match).
CREATE TABLE assessment_grants (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    email         TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%@%'),
    -- report recipient: receives deliverables; portal: may also sign in.
    receives_reports BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ,
    revoked_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    revoke_reason TEXT
);
CREATE UNIQUE INDEX assessment_grants_one_live ON assessment_grants (assessment_id, email) WHERE revoked_at IS NULL;
CREATE INDEX idx_assessment_grants_user ON assessment_grants (user_id) WHERE revoked_at IS NULL;

-- ── Fleet asset history ─────────────────────────────────────────────────────
-- Device lifecycle states from the brief: available (was in_stock), reserved,
-- in_transit, deployed, maintenance, retired. Operational health is separate.
ALTER TABLE devices DROP CONSTRAINT devices_status_check;
UPDATE devices SET status = 'available' WHERE status = 'in_stock';
ALTER TABLE devices ALTER COLUMN status SET DEFAULT 'available';
ALTER TABLE devices ADD CONSTRAINT devices_status_check
    CHECK (status IN ('available', 'reserved', 'in_transit', 'deployed', 'maintenance', 'retired'));
-- What this asset can measure (channels, harmonics orders, events, waveform,
-- cadences). Unknown until confirmed; nothing is assumed from the model name.
ALTER TABLE devices ADD COLUMN capability_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Planned versus actual install/removal.
ALTER TABLE deployments
    ADD COLUMN planned_install_at TIMESTAMPTZ,
    ADD COLUMN planned_removal_at TIMESTAMPTZ;

CREATE TABLE maintenance_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    UUID NOT NULL REFERENCES devices(id),
    occurred_at  TIMESTAMPTZ NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('maintenance', 'calibration', 'inspection', 'fault', 'repair', 'firmware')),
    description  TEXT NOT NULL,
    technician   TEXT,
    outcome      TEXT,
    cost_cents   BIGINT CHECK (cost_cents >= 0),
    next_due_on  DATE,
    evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_maintenance_device ON maintenance_events (device_id, occurred_at DESC);

-- Site context for honest, site-specific analysis (section 10): nominal
-- voltage, wiring, supply, operating hours, major loads, symptoms.
ALTER TABLE projects ADD COLUMN site_context JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Down Migration
ALTER TABLE projects DROP COLUMN site_context;
DROP TABLE maintenance_events;
ALTER TABLE deployments DROP COLUMN planned_install_at, DROP COLUMN planned_removal_at;
ALTER TABLE devices DROP COLUMN capability_profile;
ALTER TABLE devices DROP CONSTRAINT devices_status_check;
UPDATE devices SET status = 'in_stock' WHERE status IN ('available', 'reserved', 'in_transit');
ALTER TABLE devices ALTER COLUMN status SET DEFAULT 'in_stock';
ALTER TABLE devices ADD CONSTRAINT devices_status_check CHECK (status IN ('in_stock', 'deployed', 'maintenance', 'retired'));
DROP TABLE assessment_grants;
DROP TABLE assessment_points;
DROP TABLE assessments;
DROP SEQUENCE assessment_ref_seq;
DROP TABLE assessment_packages;
