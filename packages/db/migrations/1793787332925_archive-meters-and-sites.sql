-- Up Migration
-- Deleting a meter or site in the app archives it: it disappears from the
-- lists and stops ingesting, but its readings, reports and alerts are kept
-- (raw readings are evidence). An admin can restore it. Permanently removing
-- an archived meter's data is the documented ops step
-- deploy/scripts/purge-archived-meter.sh (backup first).
ALTER TABLE meters ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE sites  ADD COLUMN archived_at TIMESTAMPTZ;
CREATE INDEX idx_meters_live ON meters (site_id) WHERE archived_at IS NULL;

-- Down Migration
DROP INDEX idx_meters_live;
ALTER TABLE sites  DROP COLUMN archived_at;
ALTER TABLE meters DROP COLUMN archived_at;
