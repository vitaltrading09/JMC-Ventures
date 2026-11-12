-- Up Migration
-- Engineering UI brief §7B–C: saved evidence windows and finding cases.
--
-- evidence_refs   a named time window at a measurement point, saved from the
--                 investigation workspace during an assessment. Included in the
--                 assessment dataset (and so in the report and its hash) when
--                 include_in_report is set. Removing one keeps the row
--                 (removed_at) so an issued report's reference stays explainable.
-- finding_cases   the investigation state of one finding: owner, status, next
--                 step, due date and the verification result. One row per
--                 recommendation; every change is written to audit_log.

CREATE TABLE evidence_refs (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id        UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    measurement_point_id UUID NOT NULL REFERENCES measurement_points(id),
    recommendation_id    UUID REFERENCES recommendations(id) ON DELETE SET NULL,
    from_at              TIMESTAMPTZ NOT NULL,
    to_at                TIMESTAMPTZ NOT NULL,
    title                TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    note                 TEXT CHECK (note IS NULL OR length(note) <= 2000),
    channels             TEXT[] NOT NULL DEFAULT '{}',
    include_in_report    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at           TIMESTAMPTZ,
    CHECK (to_at > from_at)
);
CREATE INDEX idx_evidence_refs_assessment ON evidence_refs (assessment_id, from_at) WHERE removed_at IS NULL;

CREATE TABLE finding_cases (
    recommendation_id UUID PRIMARY KEY REFERENCES recommendations(id) ON DELETE CASCADE,
    owner             TEXT CHECK (owner IS NULL OR length(owner) <= 120),
    status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'investigating', 'action_planned', 'action_done', 'verified', 'not_needed')),
    next_step         TEXT CHECK (next_step IS NULL OR length(next_step) <= 1000),
    due_on            DATE,
    -- {"before": {from, to}, "after": {from, to}, "result": "improved|no_change|worse|inconclusive", "note": "..."}
    verification      JSONB,
    updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE IF EXISTS finding_cases;
DROP TABLE IF EXISTS evidence_refs;
