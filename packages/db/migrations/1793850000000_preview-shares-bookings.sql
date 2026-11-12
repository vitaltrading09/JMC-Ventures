-- Up Migration
-- Client experience (2026-11-12):
--
-- preview_shares    a link to the PROVISIONAL report of a live assessment, made by
--                   a client admin once there is useful data (24 h). The link
--                   stops at the earlier of its expiry and the assessment's end;
--                   only the SHA-256 of the token is stored. Revocable; audited.
-- booking_requests  "Book a follow-up assessment": a client's request for a new
--                   assessment, handled by staff in the ops console.

CREATE TABLE preview_shares (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('overview', 'power_quality')),
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT CHECK (label IS NULL OR length(label) <= 120),
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    opened_count  INTEGER NOT NULL DEFAULT 0,
    last_opened_at TIMESTAMPTZ
);
CREATE INDEX idx_preview_shares_assessment ON preview_shares (assessment_id);

CREATE TABLE booking_requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id       UUID REFERENCES projects(id) ON DELETE SET NULL,
    from_assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
    requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    purpose          TEXT NOT NULL CHECK (purpose IN ('follow_up', 'verify_improvement', 'new_site', 'other')),
    duration_days    INTEGER CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
    preferred_start  DATE,
    contact_name     TEXT CHECK (contact_name IS NULL OR length(contact_name) <= 120),
    contact_phone    TEXT CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
    notes            TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
    status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'booked', 'declined')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    handled_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    handled_at       TIMESTAMPTZ
);
CREATE INDEX idx_booking_requests_status ON booking_requests (status, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS booking_requests;
DROP TABLE IF EXISTS preview_shares;
