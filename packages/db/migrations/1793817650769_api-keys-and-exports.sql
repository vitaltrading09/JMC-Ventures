-- Up Migration
-- Phase 9: public API keys and background exports.
--
-- API keys belong to a client tenant. The key is gq_live_<prefix>_<secret>;
-- only its SHA-256 is stored, and it is shown once when created. scopes limit
-- what it may read; project_ids (NULL = all the tenant's projects) where.
CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL UNIQUE,
    key_hash     CHAR(64) NOT NULL UNIQUE,
    scopes       TEXT[] NOT NULL,
    project_ids  UUID[],
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    CHECK (scopes <@ ARRAY['projects:read', 'readings:read', 'readings:raw', 'energy:read',
                           'findings:read', 'reports:read', 'exports:write']::text[])
);
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);

-- An export: one point's readings over a range at an interval, as CSV,
-- written by the jobs role to EXPORT_DIR and downloadable until expires_at.
CREATE TABLE exports (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    measurement_point_id UUID NOT NULL REFERENCES measurement_points(id) ON DELETE CASCADE,
    interval             TEXT NOT NULL CHECK (interval IN ('raw', '1m', '15m', '30m', '1h', '1d')),
    period_from          TIMESTAMPTZ NOT NULL,
    period_to            TIMESTAMPTZ NOT NULL,
    format               TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
    status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'expired')),
    rows                 INTEGER,
    bytes                BIGINT,
    error                TEXT,
    api_key_id           UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at           TIMESTAMPTZ,
    finished_at          TIMESTAMPTZ,
    expires_at           TIMESTAMPTZ,
    CHECK (period_to > period_from)
);
CREATE INDEX idx_exports_status ON exports (status, created_at);

-- Down Migration
DROP TABLE exports;
DROP TABLE api_keys;
