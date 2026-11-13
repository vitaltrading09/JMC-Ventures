-- Up Migration
-- GridIQ deliverables, close-out, email, retention, passwordless login and AI
-- budgets (implementation prompt sections 11–15).

-- ── Reports: immutable, versioned datasets tied to an assessment ───────────
-- A report revision freezes its input: the structured dataset the PDF, the
-- portal and the consultant all read, with its data cutoff, calculation and
-- rule versions and a SHA-256 of the canonical JSON. Once issued (status
-- 'published', shown as "issued") the dataset can never change: a correction
-- is a new revision that supersedes it, with a stated reason.
ALTER TABLE reports
    ADD COLUMN assessment_id    UUID REFERENCES assessments(id) ON DELETE SET NULL,
    ADD COLUMN kind             TEXT CHECK (kind IN ('overview', 'power_quality', 'handover')),
    ADD COLUMN revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    ADD COLUMN supersedes_id    UUID REFERENCES reports(id),
    ADD COLUMN superseded_at    TIMESTAMPTZ,
    ADD COLUMN revision_reason  TEXT,
    ADD COLUMN provisional      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN dataset          JSONB,
    ADD COLUMN dataset_sha256   CHAR(64),
    ADD COLUMN data_cutoff_at   TIMESTAMPTZ,
    ADD COLUMN calc_version     TEXT,
    ADD COLUMN rule_version     TEXT,
    ADD COLUMN template_version TEXT,
    ADD COLUMN ai_model         TEXT,
    ADD COLUMN ai_prompt_version TEXT,
    ADD COLUMN pdf_sha256       CHAR(64),
    ADD COLUMN generated_at     TIMESTAMPTZ;
CREATE UNIQUE INDEX reports_assessment_kind_revision ON reports (assessment_id, kind, revision) WHERE assessment_id IS NOT NULL;

CREATE FUNCTION reports_freeze_issued() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Once issued (ever published) with a frozen dataset: withdrawing it does not unfreeze it.
    IF OLD.published_at IS NOT NULL AND OLD.dataset_sha256 IS NOT NULL AND (
        NEW.dataset IS DISTINCT FROM OLD.dataset OR NEW.dataset_sha256 IS DISTINCT FROM OLD.dataset_sha256
        OR NEW.pdf_path IS DISTINCT FROM OLD.pdf_path OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
        OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
        OR NEW.data_cutoff_at IS DISTINCT FROM OLD.data_cutoff_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.status <> 'published') THEN
        -- The one exception: the retention purge clears content (dataset_purged).
        IF NOT (NEW.dataset IS NULL AND current_setting('gridiq.purge', true) = 'on') THEN
            RAISE EXCEPTION 'report % is issued: its dataset and PDF are frozen; create a new revision', OLD.id;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER reports_freeze_issued BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION reports_freeze_issued();

-- ── Close-out bookkeeping on the assessment ────────────────────────────────
ALTER TABLE assessments
    ADD COLUMN closeout_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (closeout_status IN ('pending', 'running', 'done', 'failed')),
    ADD COLUMN closeout_at     TIMESTAMPTZ,
    ADD COLUMN closeout_error  TEXT,
    ADD COLUMN package_path    TEXT,
    ADD COLUMN ai_budget_cents BIGINT NOT NULL DEFAULT 5000 CHECK (ai_budget_cents >= 0);

-- ── Email outbox (durable, deduplicated, retried) ──────────────────────────
-- Sent by the jobs role through EMAIL_PROVIDER (smtp | file | none). The
-- dedupe key makes a resend after a worker restart a no-op. 'sent' means the
-- provider accepted it; that is not proof of delivery.
CREATE TABLE email_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dedupe_key      TEXT NOT NULL UNIQUE,
    to_email        TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body_text       TEXT NOT NULL,
    body_html       TEXT,
    attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
    assessment_id   UUID REFERENCES assessments(id) ON DELETE SET NULL,
    purpose         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error      TEXT,
    provider        TEXT,
    provider_message_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMPTZ
);
CREATE INDEX idx_email_outbox_due ON email_outbox (next_attempt_at) WHERE status IN ('queued', 'sending');

-- ── Final-delivery links (one per recipient, expiring) ─────────────────────
-- A recipient may download ONLY the frozen deliverables of one assessment
-- through this link, until expires_at (the delivery window, capped by
-- retention). It reopens nothing else. Only the token's SHA-256 is stored.
CREATE TABLE delivery_links (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    grant_id      UUID REFERENCES assessment_grants(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    token_hash    CHAR(64) NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ
);
CREATE INDEX idx_delivery_links_assessment ON delivery_links (assessment_id);

-- ── Retention: deletion receipts and tombstones ────────────────────────────
-- A receipt says what was deleted (counts only, no customer content).
-- Tombstones list the deleted ranges so a restore from an older backup can
-- re-apply them before anyone gets access (deploy/scripts/apply-tombstones.sh).
CREATE TABLE assessment_purges (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessments(id),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
    counts        JSONB NOT NULL DEFAULT '{}'::jsonb,
    error         TEXT
);
CREATE TABLE deletion_tombstones (
    id            BIGSERIAL PRIMARY KEY,
    assessment_id UUID NOT NULL,
    entity        TEXT NOT NULL,   -- meter_readings | pq_events | alerts | recommendations | reports | exports | files | ai_messages
    device_id     UUID,
    range_from    TIMESTAMPTZ,
    range_to      TIMESTAMPTZ,
    ref           TEXT,
    deleted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tombstones_assessment ON deletion_tombstones (assessment_id);

-- ── Passwordless login codes ───────────────────────────────────────────────
-- Short-lived, single use, attempt-capped; only an HMAC of the code is stored.
CREATE TABLE login_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL CHECK (email = lower(email)),
    code_hash   CHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    used_at     TIMESTAMPTZ,
    ip          TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_login_codes_email ON login_codes (email, created_at DESC);

-- Staff MFA (TOTP). The secret is stored encrypted with a key derived from
-- JWT_SECRET; mfa_enabled_at set once the first code was verified.
ALTER TABLE users ADD COLUMN mfa_secret_enc TEXT, ADD COLUMN mfa_enabled_at TIMESTAMPTZ;
-- Passwordless users have no password: keep the column, allow an unusable marker.

-- ── AI consultant: conversation log and budget ─────────────────────────────
CREATE TABLE ai_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content       TEXT NOT NULL,
    provider      TEXT,
    model         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_cents    NUMERIC(10, 3) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ai_messages_assessment ON ai_messages (assessment_id, created_at);

-- Down Migration
DROP TABLE ai_messages;
ALTER TABLE users DROP COLUMN mfa_secret_enc, DROP COLUMN mfa_enabled_at;
DROP TABLE login_codes;
DROP TABLE deletion_tombstones;
DROP TABLE assessment_purges;
DROP TABLE delivery_links;
DROP TABLE email_outbox;
ALTER TABLE assessments DROP COLUMN closeout_status, DROP COLUMN closeout_at, DROP COLUMN closeout_error,
    DROP COLUMN package_path, DROP COLUMN ai_budget_cents;
DROP TRIGGER reports_freeze_issued ON reports;
DROP FUNCTION reports_freeze_issued();
DROP INDEX reports_assessment_kind_revision;
ALTER TABLE reports
    DROP COLUMN assessment_id, DROP COLUMN kind, DROP COLUMN revision, DROP COLUMN supersedes_id, DROP COLUMN superseded_at,
    DROP COLUMN revision_reason, DROP COLUMN provisional, DROP COLUMN dataset, DROP COLUMN dataset_sha256, DROP COLUMN data_cutoff_at,
    DROP COLUMN calc_version, DROP COLUMN rule_version, DROP COLUMN template_version, DROP COLUMN ai_model, DROP COLUMN ai_prompt_version,
    DROP COLUMN pdf_sha256, DROP COLUMN generated_at;
