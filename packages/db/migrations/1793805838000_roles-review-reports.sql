-- Up Migration
-- Phase 7: roles, review workflow for recommendations, reports.
--
-- Roles: internal tenant super_admin / engineer; client tenant client_admin /
-- client_viewer (read-only). admin -> client_admin, user / viewer ->
-- client_viewer. broker stays (behind FEATURE_BROKER). Any other value is
-- mapped to the least privilege, client_viewer.
UPDATE users SET role = 'client_admin' WHERE role = 'admin';
UPDATE users SET role = 'client_viewer'
WHERE role IS NULL OR role NOT IN ('super_admin', 'engineer', 'client_admin', 'client_viewer', 'broker');
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'client_viewer';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('super_admin', 'engineer', 'client_admin', 'client_viewer', 'broker'));
UPDATE tenants t SET kind = 'internal'
WHERE EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role IN ('super_admin', 'engineer'));

-- ── Review workflow for recommendations ────────────────────────────────────
-- status keeps its meaning (ACTIVE = the current run, SUPERSEDED = replaced by
-- a later run). review_status is the editorial state: engines write drafts,
-- an internal user publishes or dismisses. Client roles see published only,
-- and never internal_notes.
ALTER TABLE recommendations
    ADD COLUMN review_status  TEXT NOT NULL DEFAULT 'draft'
                              CHECK (review_status IN ('draft', 'in_review', 'published', 'dismissed')),
    ADD COLUMN reviewed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN reviewed_at    TIMESTAMPTZ,
    ADD COLUMN evidence       JSONB,
    ADD COLUMN internal_notes TEXT;
-- Everything already stored was shown to clients before the workflow existed.
UPDATE recommendations SET review_status = 'published', reviewed_at = created_at;
CREATE INDEX idx_recommendations_review ON recommendations (review_status, created_at DESC);
COMMENT ON COLUMN recommendations.evidence IS 'measurement_point_id, meter_id, from, to, metric, calculation, chart parameters';

-- ── Reports ─────────────────────────────────────────────────────────────────
CREATE TABLE reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title        TEXT,
    period_start TIMESTAMPTZ NOT NULL,
    period_end   TIMESTAMPTZ NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published')),
    approved_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at  TIMESTAMPTZ,
    published_by UUID REFERENCES users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    pdf_path     TEXT,
    dataset_id   TEXT,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (period_end > period_start)
);
CREATE INDEX idx_reports_project ON reports (project_id, period_end DESC);

-- A share link now points at a report; the public page serves it only while
-- the report is published. Links made before this have no report and stop working.
ALTER TABLE report_shares ADD COLUMN report_id UUID REFERENCES reports(id) ON DELETE CASCADE;

-- Down Migration
ALTER TABLE report_shares DROP COLUMN report_id;
DROP TABLE reports;
DROP INDEX idx_recommendations_review;
ALTER TABLE recommendations
    DROP COLUMN review_status, DROP COLUMN reviewed_by, DROP COLUMN reviewed_at,
    DROP COLUMN evidence, DROP COLUMN internal_notes;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
UPDATE users SET role = 'admin' WHERE role = 'client_admin';
UPDATE users SET role = 'viewer' WHERE role IN ('client_viewer', 'engineer');
