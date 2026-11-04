-- Up Migration
-- Phase 5: what /api/health/deep reports on.

-- Liveness of the ingest role, written by it every 30 s. last_flush_at is the
-- last batch that committed readings; alive_at moves even when no meter is
-- publishing, so "ingest is down" and "meters are quiet" can be told apart.
CREATE TABLE service_heartbeats (
    service       TEXT PRIMARY KEY,          -- e.g. 'ingest'
    alive_at      TIMESTAMPTZ NOT NULL,
    last_flush_at TIMESTAMPTZ,
    detail        JSONB
);

-- One row per deploy/scripts/backup.sh run.
CREATE TABLE backup_runs (
    id          BIGSERIAL PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    ok          BOOLEAN,
    object_key  TEXT,
    bytes       BIGINT,
    message     TEXT
);
CREATE INDEX idx_backup_runs_ok ON backup_runs (finished_at DESC) WHERE ok;

-- Down Migration
DROP TABLE backup_runs;
DROP TABLE service_heartbeats;
