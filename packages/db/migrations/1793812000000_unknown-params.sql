-- Up Migration
-- Ops console (Phase 8).
--
-- Parameter names a meter sends that the channel map (src/ingest/channels.ts)
-- does not know. Until now only logged; the ops Data health page lists them
-- so new firmware names can be added to the map.
CREATE TABLE ingest_unknown_params (
    meter_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (meter_id, name)
);

-- A device's reporting interval: the median sample spacing within its hourly
-- buckets since `since` (an hour before, so a fresh install has one).
-- 1 s for a box at 1 Hz, 300 s for a meter that reports every 5 minutes.
CREATE FUNCTION device_spacing_s(dev UUID, since TIMESTAMPTZ) RETURNS DOUBLE PRECISION
LANGUAGE sql STABLE AS $$
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t_last - t_first) / (n - 1))
    FROM readings_1h
    WHERE meter_id = dev AND bucket >= since - INTERVAL '1 hour' AND n > 1
$$;

-- Share of the samples expected since `since` (at the device's own interval)
-- that arrived, 0–1. NULL when the interval is not known yet.
CREATE FUNCTION device_coverage(dev UUID, since TIMESTAMPTZ) RETURNS DOUBLE PRECISION
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN extract(epoch FROM NOW() - since) <= 0 OR sp.s IS NULL OR sp.s <= 0 THEN NULL
        ELSE LEAST(1, got.n / (extract(epoch FROM NOW() - since) / sp.s))
    END
    FROM (SELECT device_spacing_s(dev, since) AS s) sp,
         (SELECT COALESCE(SUM(n), 0)::double precision AS n FROM readings_1m WHERE meter_id = dev AND bucket >= since) got
$$;

-- Down Migration
DROP FUNCTION device_coverage(UUID, TIMESTAMPTZ);
DROP FUNCTION device_spacing_s(UUID, TIMESTAMPTZ);
DROP TABLE ingest_unknown_params;
