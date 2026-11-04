import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Degradation forecasting — "which parameter is heading for trouble, and when".
//
// Weekly values are regressed with ordinary least squares and projected forward
// to the point where they would cross a published threshold. This is the closest
// thing to genuine predictive maintenance the meter data supports.
//
// Statistical honesty is the whole point. A forecast that cries wolf destroys
// the credibility of every other number in the report, so:
//   · a minimum number of weeks is required before any trend is claimed
//   · R² must show the line actually fits before a direction is asserted
//   · projections beyond the cap are reported as "no near-term crossing"
//     rather than invented dates
//   · we say "at the current rate", never "will fail on <date>"
// ─────────────────────────────────────────────────────────────────────────────

const MIN_POINTS       = 4;    // fewer weeks than this and a slope is meaningless
const MIN_R2           = 0.35; // below this the scatter is noise, not a trend
const MAX_HORIZON_WEEKS = 26;  // beyond ~6 months a linear projection is fantasy
const MIN_WEEK_SAMPLES = 500;  // ignore weeks with too little data to be representative

export interface TrendPoint { week: string; value: number; samples: number; }

export type Direction = 'WORSENING' | 'IMPROVING' | 'FLAT' | 'INSUFFICIENT_DATA';

export interface MetricTrend {
    key:             string;
    label:           string;
    unit:            string;
    decimals:        number;
    threshold:       number;
    threshold_label: string;
    higher_is_worse: boolean;
    points:          TrendPoint[];
    current:         number | null;
    slope_per_week:  number | null;
    r2:              number | null;
    direction:       Direction;
    /** Populated only when a crossing is projected inside the horizon. */
    weeks_to_threshold: number | null;
    projected_date:     string | null;
    /** True when the latest value already sits beyond the limit, regardless of
     *  trend. A parameter parked over its limit is a finding in its own right —
     *  reporting it as "steady" would be true and dangerously misleading. */
    over_threshold:  boolean;
    weeks_over:      number;
    note:            string;
}

export interface ForecastReport {
    meter_id:   string;
    meter_name: string;
    site_name:  string;
    weeks:      number;
    metrics:    MetricTrend[];
    headline:   string;
}

/** Ordinary least squares over (index, value). Returns slope, intercept and R². */
function regress(values: number[]): { slope: number; intercept: number; r2: number } {
    const n = values.length;
    const xs = values.map((_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = values.reduce((a, b) => a + b, 0) / n;

    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - meanX) * (values[i] - meanY);
        sxx += (xs[i] - meanX) ** 2;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = meanY - slope * meanX;

    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
        const predicted = intercept + slope * xs[i];
        ssRes += (values[i] - predicted) ** 2;
        ssTot += (values[i] - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
    return { slope, intercept, r2 };
}

interface MetricSpec {
    key: string; label: string; column: string; unit: string; decimals: number;
    threshold: number; threshold_label: string; higher_is_worse: boolean;
}

// Thresholds are the published limits/guidelines the report is already judged on,
// so a forecast crossing means the same thing as a compliance failure.
const METRICS: MetricSpec[] = [
    {
        key: 'current_unbalance', label: 'Phase current imbalance', column: 'i_unb_p95',
        unit: '%', decimals: 1, threshold: 10, higher_is_worse: true,
        threshold_label: '10% (NEMA investigation guideline)',
    },
    {
        key: 'voltage_unbalance', label: 'Voltage unbalance', column: 'v_unb_p95',
        unit: '%', decimals: 2, threshold: 2, higher_is_worse: true,
        threshold_label: '2% (NRS 048-2 compatibility level)',
    },
    {
        key: 'thd', label: 'Voltage THD', column: 'thd_p95',
        unit: '%', decimals: 2, threshold: 8, higher_is_worse: true,
        threshold_label: '8% (NRS 048-2 compatibility level)',
    },
    {
        key: 'power_factor', label: 'Power factor', column: 'pf_avg',
        unit: '', decimals: 3, threshold: 0.95, higher_is_worse: false,
        threshold_label: '0.95 (typical utility target)',
    },
];

export async function forecastDegradation(
    pool:    Pool,
    meterId: string,
    weeks:   number = 12,
): Promise<ForecastReport | null> {
    const client = await pool.connect();
    try {
        const meta = await client.query(
            `SELECT m.name AS meter_name, s.name AS site_name
             FROM meters m JOIN sites s ON m.site_id = s.id WHERE m.id = $1`,
            [meterId]
        );
        if (meta.rows.length === 0) return null;

        // Weekly series from readings_1h: percentiles over hourly values
        // (sample-weighted averages within each hour), samples = raw readings.
        const q = await client.query(`
            WITH base AS (
                SELECT date_trunc('week', bucket) AS wk, n,
                       voltage_a_avg AS va, voltage_b_avg AS vb, voltage_c_avg AS vc,
                       current_a_avg AS ia, current_b_avg AS ib, current_c_avg AS ic,
                       power_factor_total_avg, thd_voltage_a_avg,
                       NULLIF((COALESCE(voltage_a_avg,0)+COALESCE(voltage_b_avg,0)+COALESCE(voltage_c_avg,0))/3.0,0) AS v_avg,
                       NULLIF((COALESCE(current_a_avg,0)+COALESCE(current_b_avg,0)+COALESCE(current_c_avg,0))/3.0,0) AS i_avg
                FROM readings_1h
                WHERE meter_id = $1 AND bucket >= NOW() - ($2 || ' weeks')::INTERVAL
            ), calc AS (
                SELECT wk, n, power_factor_total_avg, thd_voltage_a_avg,
                    CASE WHEN i_avg IS NOT NULL AND ib IS NOT NULL AND ic IS NOT NULL
                         THEN GREATEST(ABS(ia-i_avg),ABS(ib-i_avg),ABS(ic-i_avg))/i_avg*100 END AS i_unb,
                    CASE WHEN v_avg IS NOT NULL AND vb IS NOT NULL AND vc IS NOT NULL
                         THEN GREATEST(ABS(va-v_avg),ABS(vb-v_avg),ABS(vc-v_avg))/v_avg*100 END AS v_unb
                FROM base
            )
            SELECT wk::date AS week, SUM(n)::int AS samples,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY i_unb) AS i_unb_p95,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY v_unb) AS v_unb_p95,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY thd_voltage_a_avg) AS thd_p95,
                   SUM(power_factor_total_avg * n) / NULLIF(SUM(n) FILTER (WHERE power_factor_total_avg IS NOT NULL), 0) AS pf_avg
            FROM calc
            GROUP BY wk
            ORDER BY wk ASC
        `, [meterId, weeks]);

        // Drop sparse weeks — a week with a handful of readings isn't comparable
        // to a full one and would drag the regression around.
        const rows = q.rows.filter(r => Number(r.samples) >= MIN_WEEK_SAMPLES);

        const metrics: MetricTrend[] = METRICS.map(spec => {
            const points: TrendPoint[] = rows
                .filter(r => r[spec.column] !== null && r[spec.column] !== undefined)
                .map(r => ({
                    week: new Date(r.week).toISOString().slice(0, 10),
                    value: Number(Number(r[spec.column]).toFixed(spec.decimals)),
                    samples: Number(r.samples),
                }));

            const base: MetricTrend = {
                key: spec.key, label: spec.label, unit: spec.unit, decimals: spec.decimals,
                threshold: spec.threshold, threshold_label: spec.threshold_label,
                higher_is_worse: spec.higher_is_worse,
                points, current: points.length ? points[points.length - 1].value : null,
                slope_per_week: null, r2: null,
                direction: 'INSUFFICIENT_DATA',
                weeks_to_threshold: null, projected_date: null,
                over_threshold: false, weeks_over: 0,
                note: `At least ${MIN_POINTS} full weeks of data are needed before a trend can be established. Currently ${points.length}.`,
            };

            if (points.length < MIN_POINTS) return base;

            const { slope, r2 } = regress(points.map(p => p.value));
            const current = points[points.length - 1].value;
            const fmt = (v: number) => `${v.toFixed(spec.decimals)}${spec.unit}`;
            const perWeek = Math.abs(slope);

            const beyond = (v: number) => spec.higher_is_worse ? v >= spec.threshold : v <= spec.threshold;
            const alreadyOver = beyond(current);
            // How many consecutive recent weeks have been beyond the limit.
            let weeksOver = 0;
            for (let i = points.length - 1; i >= 0 && beyond(points[i].value); i--) weeksOver++;
            const overCtx = { over_threshold: alreadyOver, weeks_over: weeksOver };

            // Direction is only asserted when the line genuinely fits.
            if (r2 < MIN_R2) {
                return {
                    ...base, ...overCtx, slope_per_week: slope, r2, direction: 'FLAT',
                    note: alreadyOver
                        // Steady but out of limit is the sustained-damage case: the
                        // stress is constant, so the harm accumulates every week.
                        ? `Persistently beyond ${spec.threshold_label} — sitting at ${fmt(current)} and has been over the limit for ${weeksOver} of the last ${points.length} weeks. It is not getting worse, but it is not self-correcting either: the stress on your equipment is continuous.`
                        : `Fluctuating around ${fmt(current)} with no consistent direction over ${points.length} weeks. Normal operational variation.`,
                };
            }

            const movingWorse = spec.higher_is_worse ? slope > 0 : slope < 0;
            if (!movingWorse) {
                return {
                    ...base, ...overCtx, slope_per_week: slope, r2, direction: 'IMPROVING',
                    note: alreadyOver
                        ? `Improving by ${fmt(perWeek)} per week, but still beyond ${spec.threshold_label} at ${fmt(current)}. Moving the right way — keep going until it is back inside the limit.`
                        : `Improving steadily — ${fmt(perWeek)} per week over ${points.length} weeks, now ${fmt(current)}. No action needed beyond continued monitoring.`,
                };
            }

            // Worsening: project the crossing.
            const gap = spec.threshold - current;
            const weeksToThreshold = slope === 0 ? Infinity : gap / slope;

            if (alreadyOver) {
                return {
                    ...base, ...overCtx, slope_per_week: slope, r2, direction: 'WORSENING',
                    note: `Already beyond ${spec.threshold_label} at ${fmt(current)}, and still worsening by ${fmt(perWeek)} per week. This is deteriorating from an already-out-of-limit position — act now.`,
                };
            }

            if (weeksToThreshold > 0 && weeksToThreshold <= MAX_HORIZON_WEEKS) {
                const wk = Math.round(weeksToThreshold);
                const date = new Date(Date.now() + wk * 7 * 86_400_000);
                return {
                    ...base, ...overCtx, slope_per_week: slope, r2, direction: 'WORSENING',
                    weeks_to_threshold: wk,
                    projected_date: date.toISOString().slice(0, 10),
                    note: `Worsening by ${fmt(perWeek)} per week. At the current rate it reaches ${spec.threshold_label} in about ${wk} week${wk === 1 ? '' : 's'} (around ${date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}). Acting before then is cheaper than acting after.`,
                };
            }

            return {
                ...base, ...overCtx, slope_per_week: slope, r2, direction: 'WORSENING',
                note: `Drifting the wrong way by ${fmt(perWeek)} per week from ${fmt(current)}, but at this rate it stays inside ${spec.threshold_label} for at least the next ${MAX_HORIZON_WEEKS} weeks. Worth watching, not urgent.`,
            };
        });

        // Headline: the nearest projected crossing, else the worst direction.
        const projected = metrics
            .filter(m => m.weeks_to_threshold !== null)
            .sort((a, b) => (a.weeks_to_threshold! - b.weeks_to_threshold!));
        const worsening = metrics.filter(m => m.direction === 'WORSENING');
        const improving = metrics.filter(m => m.direction === 'IMPROVING');

        // A parameter parked beyond its limit outranks a trend — sustained damage
        // now beats a projected crossing later.
        const over = metrics
            .filter(m => m.over_threshold)
            .sort((a, b) => b.weeks_over - a.weeks_over);

        let headline: string;
        if (over.length > 0) {
            const o = over[0];
            headline = `${o.label} has been beyond ${o.threshold_label} for ${o.weeks_over} of the last ${o.points.length} weeks — sustained stress on your equipment.`;
        } else if (projected.length > 0) {
            const p = projected[0];
            headline = `${p.label} is on course to breach ${p.threshold_label} in about ${p.weeks_to_threshold} week${p.weeks_to_threshold === 1 ? '' : 's'}.`;
        } else if (worsening.length > 0) {
            headline = `${worsening.length} parameter${worsening.length > 1 ? 's are' : ' is'} drifting the wrong way, but none are projected to breach their limit within ${MAX_HORIZON_WEEKS} weeks.`;
        } else if (improving.length > 0) {
            headline = `Conditions are improving — ${improving.map(m => m.label.toLowerCase()).join(' and ')} ${improving.length > 1 ? 'are' : 'is'} trending better week on week.`;
        } else if (metrics.every(m => m.direction === 'INSUFFICIENT_DATA')) {
            headline = 'Not enough history yet to forecast. Trends appear once several full weeks of monitoring have accumulated.';
        } else {
            headline = 'All monitored parameters are holding steady with no directional trend.';
        }

        return {
            meter_id: meterId,
            meter_name: meta.rows[0].meter_name,
            site_name:  meta.rows[0].site_name,
            weeks,
            metrics,
            headline,
        };
    } finally {
        client.release();
    }
}
