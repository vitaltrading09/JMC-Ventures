// ─────────────────────────────────────────────────────────────────────────────
// Read path over the continuous aggregates (packages/db migration
// *_aggregates-and-alerting.sql).
//
// Charts ask for a range; this picks a bucket so the response has about
// 300–700 points, and the coarsest source that bucket can be built from:
// raw meter_readings only for ranges ≤ 2 h, otherwise readings_1m / 10m / 30m
// / 1h / 1d. Re-bucketing a view weights each row by its sample count n, so
// every average equals the plain average of the raw samples in the bucket.
// ─────────────────────────────────────────────────────────────────────────────

export type Source = 'raw' | 'readings_1m' | 'readings_10m' | 'readings_30m' | 'readings_1h' | 'readings_1d';

const SEC = 1;
const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Candidate bucket sizes, in seconds. */
const BUCKETS = [10, 15, 30, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY];
const VIEWS: Array<[Source, number]> = [
    ['readings_1d', DAY], ['readings_1h', HOUR], ['readings_30m', 30 * MIN], ['readings_10m', 10 * MIN], ['readings_1m', MIN],
];
export const MAX_POINTS = 700;
export const RAW_MAX_RANGE_S = 2 * HOUR;

export interface ReadPlan {
    source: Source;
    /** Postgres interval text for time_bucket, e.g. '15 minutes'. */
    bucket: string;
    bucketSeconds: number;
}

export function intervalText(seconds: number): string {
    if (seconds % DAY === 0) return `${seconds / DAY} day${seconds === DAY ? '' : 's'}`;
    if (seconds % HOUR === 0) return `${seconds / HOUR} hour${seconds === HOUR ? '' : 's'}`;
    if (seconds % MIN === 0) return `${seconds / MIN} minute${seconds === MIN ? '' : 's'}`;
    return `${seconds} seconds`;
}

/** Bucket and source for a chart range. */
export function planRead(from: Date, to: Date): ReadPlan {
    const range = Math.max(SEC, (to.getTime() - from.getTime()) / 1000);
    let bucketSeconds = BUCKETS.find((b) => range / b <= MAX_POINTS) ?? BUCKETS[BUCKETS.length - 1];
    if (range <= RAW_MAX_RANGE_S) {
        return { source: 'raw', bucket: intervalText(bucketSeconds), bucketSeconds };
    }
    // Beyond 2 h the aggregates are the source, so a bucket is at least 1 minute
    // (a 2–5 h range then returns 120–300 points rather than reading raw rows).
    bucketSeconds = Math.max(bucketSeconds, MIN);
    // Coarsest view whose bucket divides the chart bucket.
    const [source] = VIEWS.find(([, s]) => s <= bucketSeconds && bucketSeconds % s === 0)!;
    return { source, bucket: intervalText(bucketSeconds), bucketSeconds };
}

/** Columns of /meters/:id/readings (response shape unchanged), by source column. */
const AVG_COLUMNS = [
    'power_active_total', 'power_reactive_total', 'power_apparent_total', 'power_factor_total',
    'voltage_a', 'voltage_b', 'voltage_c', 'current_a', 'current_b', 'current_c',
    'thd_voltage_a', 'thd_current_a', 'frequency',
] as const;

/**
 * SELECT for one meter's chart series: $1 bucket interval, $2 meter id, $3 from, $4 to.
 * Same output columns as before the aggregates existed.
 */
export function meterSeriesSql(source: Source): string {
    if (source === 'raw') {
        return `
            SELECT time_bucket($1::interval, time) AS time,
                   ${AVG_COLUMNS.map((c) => `AVG(${c}) AS ${c}`).join(', ')},
                   MAX(energy_import_total) AS energy_import_total
            FROM meter_readings
            WHERE meter_id = $2 AND time >= $3 AND time <= $4
            GROUP BY 1 ORDER BY 1 ASC`;
    }
    return `
        SELECT time_bucket($1::interval, bucket) AS time,
               ${AVG_COLUMNS.map((c) => `SUM(${c}_avg * n) / NULLIF(SUM(n) FILTER (WHERE ${c}_avg IS NOT NULL), 0) AS ${c}`).join(', ')},
               MAX(energy_import_total_last) AS energy_import_total
        FROM ${source}
        WHERE meter_id = $2 AND bucket >= time_bucket($1::interval, $3::timestamptz) AND bucket <= $4
        GROUP BY 1 ORDER BY 1 ASC`;
}

/**
 * Per-meter average kW per bucket, summed across a tenant's active meters
 * (/readings/aggregate). $1 bucket, $2 from; tenantFilter adds the tenant clause.
 */
export function tenantPowerSql(source: Source, tenantFilter: string): string {
    const perMeter = source === 'raw'
        ? `SELECT time_bucket($1::interval, mr.time) AS bucket, mr.meter_id, AVG(mr.power_active_total) AS avg_kw
           FROM meter_readings mr JOIN meters m ON mr.meter_id = m.id JOIN sites s ON m.site_id = s.id
           WHERE mr.time >= $2 AND m.is_active = true AND mr.power_active_total IS NOT NULL ${tenantFilter}
           GROUP BY 1, 2`
        : `SELECT time_bucket($1::interval, v.bucket) AS bucket, v.meter_id,
                  SUM(v.power_active_total_avg * v.n) / NULLIF(SUM(v.n) FILTER (WHERE v.power_active_total_avg IS NOT NULL), 0) AS avg_kw
           FROM ${source} v JOIN meters m ON v.meter_id = m.id JOIN sites s ON m.site_id = s.id
           WHERE v.bucket >= time_bucket($1::interval, $2::timestamptz) AND m.is_active = true
             AND v.power_active_total_avg IS NOT NULL ${tenantFilter}
           GROUP BY 1, 2`;
    return `
        WITH per_meter AS (${perMeter})
        SELECT bucket AS time, ROUND(SUM(avg_kw)::numeric, 2) AS power_active_total
        FROM per_meter
        GROUP BY bucket
        ORDER BY bucket ASC`;
}
