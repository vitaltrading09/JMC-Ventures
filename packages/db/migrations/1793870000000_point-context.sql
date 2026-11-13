-- Up Migration
-- Point briefing: the consultant's questions to GridIQ staff about a measurement
-- point (where the meter is connected, what it feeds, correction, generation,
-- sensitive equipment, reported symptoms). Structured answers, validated by
-- services/ingestion-service/src/point-context.ts; used by rule findings, watch
-- conclusions, the consultant and the reports. Free-text site context stays on
-- projects.site_context.

ALTER TABLE measurement_points ADD COLUMN context JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Down Migration
ALTER TABLE measurement_points DROP COLUMN context;
