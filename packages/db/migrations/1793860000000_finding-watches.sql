-- Up Migration
-- Finding watches: "Start investigating" on a finding starts a watch of that
-- finding's condition at its measurement point, until the due date (or 3 days),
-- never past the assessment end.
--
--   notes       one entry per SAST day of the watch, written by the jobs role once
--               the day's aggregates have settled: {day, from, to, seen, headline,
--               values, expected}.
--   conclusion  written once at the end: {text, verdict, provider, model,
--               generated_at, observation}. With an AI provider the text is the
--               model's, from the same evidence; without one it is assembled from
--               the measurements. Shown to clients straight away, labelled as an
--               automated conclusion until GridIQ staff review it (reviewed_at,
--               staff_note).
-- One watch per finding at a time; every start, stop, conclusion and review is
-- written to audit_log.

CREATE TABLE finding_watches (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recommendation_id    UUID NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
    assessment_id        UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    measurement_point_id UUID NOT NULL REFERENCES measurement_points(id),
    kind                 TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching', 'concluded', 'cancelled')),
    started_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    until_at             TIMESTAMPTZ NOT NULL,
    notes                JSONB NOT NULL DEFAULT '[]',
    conclusion           JSONB,
    concluded_at         TIMESTAMPTZ,
    cancelled_at         TIMESTAMPTZ,
    reviewed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at          TIMESTAMPTZ,
    staff_note           TEXT CHECK (staff_note IS NULL OR length(staff_note) <= 2000),
    CHECK (until_at > started_at)
);
CREATE UNIQUE INDEX finding_watches_one_active ON finding_watches (recommendation_id) WHERE status = 'watching';
CREATE INDEX idx_finding_watches_recommendation ON finding_watches (recommendation_id, started_at DESC);

-- Down Migration
DROP TABLE IF EXISTS finding_watches;
