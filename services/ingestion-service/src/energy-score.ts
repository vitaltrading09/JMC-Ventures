import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface ScoreWeights {
    pf:               number;
    thd:              number;
    voltageUnbalance: number;
    voltageQuality:   number;
}

export interface EnergyScoreResult {
    score: number;          // 0–100 composite
    components: {
        pf:               number;
        thd:              number;
        voltageUnbalance: number;
        voltageQuality:   number;
    };
    weights:    ScoreWeights;
    tariffType: string;
    metrics: {
        avgPf:            number | null;
        avgThd:           number | null;
        avgKw:            number | null;
        peakKw:           number | null;
        loadFactor:       number | null;   // kept as informational context for AI
        avgV:             number | null;
        minV:             number | null;
        maxV:             number | null;
        // Per-phase averages used for unbalance calculation
        avgVa:            number | null;
        avgVb:            number | null;
        avgVc:            number | null;
        unbalancePct:     number | null;
        energyKwh:        number | null;   // last 30 days
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tariff type detection
// Based on average demand. Client can override in site_settings.tariff_type.
// South African context:
//   Megaflex  — large industrial/commercial, heavy NMD demand charges (> 500 kW avg)
//   TOU       — medium commercial, time-of-use structure (100–500 kW)
//   Flat      — small sites, single rate (< 100 kW)
// ─────────────────────────────────────────────────────────────────────────────
export function detectTariffType(avgKw: number | null): string {
    if (!avgKw || avgKw <= 0) return 'FLAT';
    if (avgKw > 500) return 'MEGAFLEX';
    if (avgKw > 100) return 'TOU';
    return 'FLAT';
}

// ─────────────────────────────────────────────────────────────────────────────
// Default score weights by tariff type
// Weights must sum to 1.0. Reflect what costs clients the most money.
// ─────────────────────────────────────────────────────────────────────────────
export function getDefaultWeights(tariffType: string): ScoreWeights {
    // Voltage unbalance directly degrades motor efficiency + lifespan (a 2%
    // unbalance can cause 25%+ extra winding heating). Weighting it heavier on
    // MEGAFLEX/TOU sites reflects the fact those sites run more motor loads.
    switch (tariffType) {
        case 'MEGAFLEX':
            return { pf: 0.28, thd: 0.20, voltageUnbalance: 0.28, voltageQuality: 0.24 };
        case 'TOU':
            return { pf: 0.32, thd: 0.20, voltageUnbalance: 0.22, voltageQuality: 0.26 };
        case 'FLAT':
        default:
            return { pf: 0.34, thd: 0.20, voltageUnbalance: 0.18, voltageQuality: 0.28 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component scoring functions (0–100 each)
// ─────────────────────────────────────────────────────────────────────────────

// Power factor: < 0.85 incurs Eskom reactive energy penalties
function scorePowerFactor(pf: number | null): number {
    if (pf === null || pf <= 0) return 50;   // no data → neutral
    if (pf >= 0.98) return 100;
    if (pf >= 0.95) return 90;
    if (pf >= 0.90) return 75;
    if (pf >= 0.85) return 55;
    if (pf >= 0.80) return 35;
    if (pf >= 0.75) return 20;
    return 5;
}

// THD voltage: NRS 048 limit 8%, EN 50160 planning level 5%
function scoreTHD(thd: number | null): number {
    if (thd === null) return 70;    // no sensor data → slightly above neutral
    if (thd < 1)     return 100;
    if (thd < 2)     return 90;
    if (thd < 3)     return 78;     // good — under EN 50160 planning level
    if (thd < 5)     return 60;
    if (thd < 8)     return 35;     // approaching NRS 048 limit
    return 10;
}

// Voltage unbalance (%): max deviation of any phase from the 3-phase mean,
// expressed as a percentage of that mean. NEMA definition.
//   < 1% utility-grade  |  2% NRS 048-2 limit  |  > 3% causes motor failure
// Single-phase sites (no Vb/Vc) return a neutral 75 — not penalised, not
// rewarded, since unbalance is meaningless without 3 phases.
function scoreVoltageUnbalance(unbalancePct: number | null): number {
    if (unbalancePct === null) return 75;
    if (unbalancePct < 0.5) return 100;
    if (unbalancePct < 1)   return 88;
    if (unbalancePct < 2)   return 65;   // within NRS 048-2 limit but worth flagging
    if (unbalancePct < 3)   return 35;
    if (unbalancePct < 5)   return 15;
    return 5;
}

function computeUnbalance(va: number | null, vb: number | null, vc: number | null): number | null {
    // Need all three phases above a sensible threshold (50 V) to compute.
    if (va === null || vb === null || vc === null) return null;
    if (va < 50  || vb < 50  || vc < 50)           return null;
    const mean = (va + vb + vc) / 3;
    if (mean <= 0) return null;
    const maxDev = Math.max(Math.abs(va - mean), Math.abs(vb - mean), Math.abs(vc - mean));
    return (maxDev / mean) * 100;
}

// Voltage quality: deviation from SA nominal (230 V phase-neutral, 400 V line-line)
// Also penalises large spread (min→max) which indicates sags/swells
function scoreVoltageQuality(avgV: number | null, minV: number | null, maxV: number | null): number {
    if (avgV === null) return 70;

    // Acuvim V1 is phase-to-neutral for 3-phase, typically ~230 V
    const nominal = avgV > 300 ? 400 : 230;
    const deviationPct = Math.abs(avgV - nominal) / nominal * 100;

    // Spread penalty: large min-max range indicates transients or sustained sags
    const spreadPct = (minV !== null && maxV !== null)
        ? (maxV - minV) / nominal * 100
        : 0;

    const worst = Math.max(deviationPct, spreadPct / 2);

    if (worst < 1)  return 100;
    if (worst < 2)  return 88;
    if (worst < 5)  return 68;   // NRS 048 steady-state limit ±5%
    if (worst < 8)  return 40;
    if (worst < 10) return 20;   // NRS 048 absolute limit ±10%
    return 8;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main computation — queries last 7 days of data for a site, calculates
// the composite energy score, and persists it to energy_scores.
// Returns null if there is insufficient data (< 3 readings).
//
// Why 7 days: long enough for a meaningful weekday/weekend pattern and
// peak/off-peak average, short enough that the score reacts to real changes
// (a new PFC bank installed last week should bump the score *this week*,
// not get diluted in a 30-day rolling average).
// ─────────────────────────────────────────────────────────────────────────────
// When meterId is set the score is computed for that single meter only and
// is NOT persisted to energy_scores (which is site-scoped). Per-meter scores
// are used as ephemeral context for per-meter recommendations.
export async function computeAndStoreSiteScore(
    pool: Pool,
    siteId: string,
    meterId?: string
): Promise<EnergyScoreResult | null> {
    const client = await pool.connect();
    try {
        // Aggregate 7-day stats — across all active meters on this site,
        // or just one meter if meterId is set.
        const metricFilter = meterId
            ? `AND m.id = $2`
            : `AND m.is_active = true`;
        const metricParams: any[] = meterId ? [siteId, meterId] : [siteId];
        // From readings_1h (about 168 rows per meter for the week, instead of
        // ~600k raw 1-second rows every 5 minutes). Averages are re-weighted by
        // sample count. The validity filters that used to apply per reading
        // (PF 0-1.05, THD 0-100 %, voltage above 50 V) now apply per hour: an
        // hour whose minimum voltage dropped to an interruption is left out
        // whole, rather than just its zero-voltage samples.
        const metricsRes = await client.query(`
            SELECT
                SUM(v.power_factor_total_avg * v.n) FILTER (WHERE v.power_factor_total_avg > 0 AND v.power_factor_total_avg <= 1.05)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.power_factor_total_avg > 0 AND v.power_factor_total_avg <= 1.05), 0)
                    AS avg_pf,
                SUM(v.thd_voltage_a_avg * v.n) FILTER (WHERE v.thd_voltage_a_avg >= 0 AND v.thd_voltage_a_avg < 100)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.thd_voltage_a_avg >= 0 AND v.thd_voltage_a_avg < 100), 0)
                    AS avg_thd,
                SUM(v.power_active_total_avg * v.n) FILTER (WHERE v.power_active_total_avg > 0)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.power_active_total_avg > 0), 0)
                    AS avg_kw,
                MAX(v.power_active_total_max)
                    AS peak_kw,
                SUM(v.voltage_a_avg * v.n) FILTER (WHERE v.voltage_a_min > 50)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.voltage_a_min > 50), 0)
                    AS avg_v,
                MIN(v.voltage_a_min) FILTER (WHERE v.voltage_a_min > 50)
                    AS min_v,
                MAX(v.voltage_a_max) FILTER (WHERE v.voltage_a_max > 50)
                    AS max_v,
                SUM(v.voltage_a_avg * v.n) FILTER (WHERE v.voltage_a_min > 50)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.voltage_a_min > 50), 0)
                    AS avg_va,
                SUM(v.voltage_b_avg * v.n) FILTER (WHERE v.voltage_b_min > 50)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.voltage_b_min > 50), 0)
                    AS avg_vb,
                SUM(v.voltage_c_avg * v.n) FILTER (WHERE v.voltage_c_min > 50)
                    / NULLIF(SUM(v.n) FILTER (WHERE v.voltage_c_min > 50), 0)
                    AS avg_vc,
                COALESCE(SUM(v.n), 0)
                    AS reading_count
            FROM readings_1h v
            JOIN meters m ON v.meter_id = m.id
            WHERE m.site_id = $1
              AND v.bucket >= NOW() - INTERVAL '7 days'
              ${metricFilter}
        `, metricParams);

        const row = metricsRes.rows[0];
        if (!row || Number(row.reading_count) < 3) {
            return null; // Not enough data to produce a meaningful score
        }

        // Energy over the last 30 days, integrated from hourly averages over the
        // minutes that carried data. (It used to be SUM(kW × 5/60) per reading,
        // which assumed 5-minute readings: ~300× too high at 1 Hz.)
        const energyRes = await client.query(`
            SELECT ROUND(SUM(v.power_active_total_avg * v.minutes / 60.0)
                       FILTER (WHERE v.power_active_total_avg > 0)::numeric, 1) AS energy_kwh
            FROM readings_1h v
            JOIN meters m ON v.meter_id = m.id
            WHERE m.site_id = $1
              AND v.bucket >= NOW() - INTERVAL '30 days'
              ${metricFilter}
        `, metricParams);
        const energyKwh = energyRes.rows[0]?.energy_kwh;

        const avgKw  = row.avg_kw  ? Number(row.avg_kw)  : null;
        const peakKw = row.peak_kw ? Number(row.peak_kw) : null;
        const lf     = (avgKw && peakKw && peakKw > 0) ? avgKw / peakKw : null;

        // Check for custom weights + tariff type in site_settings
        const settingsRes = await client.query(`
            SELECT tariff_type,
                   weight_pf, weight_thd, weight_voltage_unbalance, weight_voltage_quality
            FROM site_settings
            WHERE site_id = $1
        `, [siteId]);
        const cfg = settingsRes.rows[0];

        const tariffType = cfg?.tariff_type || detectTariffType(avgKw);
        const defaults   = getDefaultWeights(tariffType);

        const weights: ScoreWeights = {
            pf:               cfg?.weight_pf                 ? Number(cfg.weight_pf)                 : defaults.pf,
            thd:              cfg?.weight_thd                ? Number(cfg.weight_thd)                : defaults.thd,
            voltageUnbalance: cfg?.weight_voltage_unbalance  ? Number(cfg.weight_voltage_unbalance)  : defaults.voltageUnbalance,
            voltageQuality:   cfg?.weight_voltage_quality    ? Number(cfg.weight_voltage_quality)    : defaults.voltageQuality,
        };

        const avgPf  = row.avg_pf  ? Number(row.avg_pf)  : null;
        const avgThd = row.avg_thd ? Number(row.avg_thd) : null;
        const avgV   = row.avg_v   ? Number(row.avg_v)   : null;
        const minV   = row.min_v   ? Number(row.min_v)   : null;
        const maxV   = row.max_v   ? Number(row.max_v)   : null;
        const avgVa  = row.avg_va  ? Number(row.avg_va)  : null;
        const avgVb  = row.avg_vb  ? Number(row.avg_vb)  : null;
        const avgVc  = row.avg_vc  ? Number(row.avg_vc)  : null;
        const unbalancePct = computeUnbalance(avgVa, avgVb, avgVc);

        const components = {
            pf:               scorePowerFactor(avgPf),
            thd:              scoreTHD(avgThd),
            voltageUnbalance: scoreVoltageUnbalance(unbalancePct),
            voltageQuality:   scoreVoltageQuality(avgV, minV, maxV),
        };

        const score = Math.round(
            components.pf               * weights.pf +
            components.thd              * weights.thd +
            components.voltageUnbalance * weights.voltageUnbalance +
            components.voltageQuality   * weights.voltageQuality
        );

        // Persist to energy_scores table — only for site-wide computations.
        // Per-meter scores are computed on demand and not stored.
        if (!meterId) {
            await client.query(`
                INSERT INTO energy_scores (
                    site_id, score,
                    pf_score, thd_score, voltage_unbalance_score, voltage_quality_score,
                    weight_pf, weight_thd, weight_voltage_unbalance, weight_voltage_quality,
                    tariff_type
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
                siteId, score,
                components.pf, components.thd, components.voltageUnbalance, components.voltageQuality,
                weights.pf, weights.thd, weights.voltageUnbalance, weights.voltageQuality,
                tariffType,
            ]);
        }

        return {
            score,
            components,
            weights,
            tariffType,
            metrics: {
                avgPf, avgThd, avgKw, peakKw,
                loadFactor: lf,
                avgV, minV, maxV,
                avgVa, avgVb, avgVc, unbalancePct,
                energyKwh: energyKwh ? Number(energyKwh) : null,
            },
        };
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get the latest stored score for a site (no recomputation)
// ─────────────────────────────────────────────────────────────────────────────
export async function getLatestSiteScore(
    pool: Pool,
    siteId: string
): Promise<{ score: number; tariffType: string; calculatedAt: Date } | null> {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT score, tariff_type, calculated_at
            FROM energy_scores
            WHERE site_id = $1
            ORDER BY calculated_at DESC
            LIMIT 1
        `, [siteId]);
        if (res.rows.length === 0) return null;
        return {
            score:       Number(res.rows[0].score),
            tariffType:  res.rows[0].tariff_type,
            calculatedAt: new Date(res.rows[0].calculated_at),
        };
    } finally {
        client.release();
    }
}
