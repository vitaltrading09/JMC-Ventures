import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Maximum demand — the way a utility actually bills it.
//
// Demand charges are not levied on the highest instantaneous reading. They are
// levied on the highest AVERAGE power over a fixed integration interval — 30
// minutes on Eskom's Megaflex/Miniflex tariffs, 15 on some municipal ones. A
// single 800 kW spike lasting four seconds does not move a 30-minute average
// and does not cost the client a cent; reporting it as "peak demand" produces a
// number the client can check against their bill and find wrong, which is the
// fastest way to lose a consultant's credibility.
//
// Integration is time-weighted rather than a plain average of readings, because
// readings arrive irregularly (measured: anywhere from ~8s to ~40s apart). A
// plain AVG would over-weight densely sampled stretches.
// ─────────────────────────────────────────────────────────────────────────────

/** Eskom Megaflex/Miniflex integrate demand over 30 minutes. */
export const DEFAULT_DEMAND_INTERVAL_MIN = 30;

/** Gap cap: an offline stretch must not be integrated as continuous load. */
const MAX_GAP_S = 900;

/**
 * An interval with a long telemetry gap has a true average pulled down by the
 * missing time, so treating its covered portion as the interval average would
 * invent a demand peak that never appeared on the meter. Require most of the
 * interval to be accounted for before it can set a maximum.
 */
const MIN_COVERAGE = 0.8;

export interface DemandInterval {
    interval_start: string;
    avg_kw:         number | null;
    avg_kva:        number | null;
    coverage_pct:   number;
}

export interface MaxDemandResult {
    meter_id:       string;
    interval_min:   number;
    from:           string;
    to:             string;
    /** Billing basis on kVA-demand tariffs. */
    max_kva:        number | null;
    max_kva_at:     string | null;
    max_kw:         number | null;
    max_kw_at:      string | null;
    /** Highest single reading in the window — shown only to contrast with the
     *  billed figure, never as the demand number itself. */
    peak_instant_kw: number | null;
    /** The intervals that actually set the charge, worth showing a client. */
    top_intervals:  DemandInterval[];
    intervals_assessed: number;
    method:         string;
}

export async function maxDemand(
    pool:        Pool,
    meterId:     string,
    from:        Date,
    to:          Date,
    intervalMin: number = DEFAULT_DEMAND_INTERVAL_MIN,
): Promise<MaxDemandResult> {
    const client = await pool.connect();
    try {
        const q = await client.query(`
            WITH r AS (
                SELECT
                    time_bucket($4::interval, time) AS bucket,
                    power_active_total   AS kw,
                    power_apparent_total AS kva,
                    LEAST(
                        EXTRACT(EPOCH FROM (
                            LEAD(time) OVER (ORDER BY time) - time
                        )),
                        $5
                    ) AS dt_s
                FROM meter_readings
                WHERE meter_id = $1
                  AND time >= $2
                  AND time <  $3
                  AND power_active_total IS NOT NULL
            ), agg AS (
                SELECT
                    bucket,
                    SUM(kw  * COALESCE(dt_s, 0)) / NULLIF(SUM(COALESCE(dt_s, 0)), 0) AS avg_kw,
                    SUM(kva * COALESCE(dt_s, 0)) / NULLIF(SUM(COALESCE(dt_s, 0)), 0) AS avg_kva,
                    SUM(COALESCE(dt_s, 0)) / ($6 * 60.0)                             AS coverage
                FROM r
                GROUP BY bucket
            )
            SELECT bucket, avg_kw, avg_kva, coverage
            FROM agg
            WHERE coverage >= $7
            ORDER BY avg_kva DESC NULLS LAST, avg_kw DESC NULLS LAST
        `, [
            meterId, from, to,
            `${intervalMin} minutes`, MAX_GAP_S,
            intervalMin, MIN_COVERAGE,
        ]);

        // Separate query: the highest single reading, kept purely as contrast.
        const inst = await client.query(`
            SELECT MAX(power_active_total) AS peak
            FROM meter_readings
            WHERE meter_id = $1 AND time >= $2 AND time < $3
        `, [meterId, from, to]);

        const rows = q.rows;
        const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

        // Already ordered by kVA; find the kW leader separately since the two
        // maxima need not fall in the same interval.
        let kwLeader = rows[0] ?? null;
        for (const row of rows) {
            if (num(row.avg_kw) !== null && (kwLeader === null || Number(row.avg_kw) > Number(kwLeader.avg_kw))) {
                kwLeader = row;
            }
        }

        return {
            meter_id: meterId,
            interval_min: intervalMin,
            from: from.toISOString(),
            to: to.toISOString(),
            max_kva:    rows.length ? num(rows[0].avg_kva) : null,
            max_kva_at: rows.length ? new Date(rows[0].bucket).toISOString() : null,
            max_kw:     kwLeader ? num(kwLeader.avg_kw) : null,
            max_kw_at:  kwLeader ? new Date(kwLeader.bucket).toISOString() : null,
            peak_instant_kw: num(inst.rows[0]?.peak),
            top_intervals: rows.slice(0, 10).map(r => ({
                interval_start: new Date(r.bucket).toISOString(),
                avg_kw:  num(r.avg_kw),
                avg_kva: num(r.avg_kva),
                coverage_pct: Math.min(100, Number(r.coverage) * 100),
            })),
            intervals_assessed: rows.length,
            method: `Time-weighted average power over ${intervalMin}-minute intervals, matching utility demand integration. `
                + `Intervals with under ${MIN_COVERAGE * 100}% telemetry coverage are excluded so a gap cannot invent a peak. `
                + `Gaps between readings are capped at ${MAX_GAP_S / 60} minutes.`,
        };
    } finally {
        client.release();
    }
}
