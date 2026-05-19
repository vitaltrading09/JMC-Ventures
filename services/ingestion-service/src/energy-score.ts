import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface ScoreWeights {
    pf:             number;
    thd:            number;
    loadFactor:     number;
    voltageQuality: number;
}

export interface EnergyScoreResult {
    score: number;          // 0–100 composite
    components: {
        pf:             number;
        thd:            number;
        loadFactor:     number;
        voltageQuality: number;
    };
    weights:    ScoreWeights;
    tariffType: string;
    metrics: {
        avgPf:       number | null;
        avgThd:      number | null;
        avgKw:       number | null;
        peakKw:      number | null;
        loadFactor:  number | null;
        avgV:        number | null;
        minV:        number | null;
        maxV:        number | null;
        energyKwh:   number | null;
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
    switch (tariffType) {
        case 'MEGAFLEX':
            // Demand charge dominates → load factor weighted highest
            return { pf: 0.25, thd: 0.18, loadFactor: 0.35, voltageQuality: 0.22 };
        case 'TOU':
            // PF penalties + peak demand both significant
            return { pf: 0.30, thd: 0.18, loadFactor: 0.28, voltageQuality: 0.24 };
        case 'FLAT':
        default:
            // PF still matters, energy efficiency more so than load factor
            return { pf: 0.32, thd: 0.20, loadFactor: 0.22, voltageQuality: 0.26 };
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

// Load factor = avg_demand / peak_demand. Low LF = paying for demand not used.
function scoreLoadFactor(lf: number | null): number {
    if (lf === null) return 50;
    if (lf > 0.85) return 100;
    if (lf > 0.75) return 85;
    if (lf > 0.65) return 68;
    if (lf > 0.50) return 48;
    if (lf > 0.35) return 28;
    return 10;
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
        const metricsRes = await client.query(`
            SELECT
                AVG(mr.power_factor_total)
                    FILTER (WHERE mr.power_factor_total > 0 AND mr.power_factor_total <= 1.05)
                    AS avg_pf,
                AVG(mr.thd_voltage_a)
                    FILTER (WHERE mr.thd_voltage_a >= 0 AND mr.thd_voltage_a < 100)
                    AS avg_thd,
                AVG(mr.power_active_total)
                    FILTER (WHERE mr.power_active_total > 0)
                    AS avg_kw,
                MAX(mr.power_active_total)
                    AS peak_kw,
                AVG(mr.voltage_a)
                    FILTER (WHERE mr.voltage_a > 50)
                    AS avg_v,
                MIN(mr.voltage_a)
                    FILTER (WHERE mr.voltage_a > 50)
                    AS min_v,
                MAX(mr.voltage_a)
                    FILTER (WHERE mr.voltage_a > 50)
                    AS max_v,
                COUNT(*)
                    AS reading_count,
                ROUND(
                    (SUM(mr.power_active_total * 5.0 / 60.0)
                        FILTER (WHERE mr.power_active_total > 0))::numeric,
                    1
                ) AS energy_kwh
            FROM meter_readings mr
            JOIN meters m ON mr.meter_id = m.id
            WHERE m.site_id = $1
              AND mr.time >= NOW() - INTERVAL '7 days'
              ${metricFilter}
        `, metricParams);

        const row = metricsRes.rows[0];
        if (!row || Number(row.reading_count) < 3) {
            return null; // Not enough data to produce a meaningful score
        }

        const avgKw  = row.avg_kw  ? Number(row.avg_kw)  : null;
        const peakKw = row.peak_kw ? Number(row.peak_kw) : null;
        const lf     = (avgKw && peakKw && peakKw > 0) ? avgKw / peakKw : null;

        // Check for custom weights + tariff type in site_settings
        const settingsRes = await client.query(`
            SELECT tariff_type,
                   weight_pf, weight_thd, weight_load_factor, weight_voltage_quality
            FROM site_settings
            WHERE site_id = $1
        `, [siteId]);
        const cfg = settingsRes.rows[0];

        const tariffType = cfg?.tariff_type || detectTariffType(avgKw);
        const defaults   = getDefaultWeights(tariffType);

        const weights: ScoreWeights = {
            pf:             cfg?.weight_pf             ? Number(cfg.weight_pf)             : defaults.pf,
            thd:            cfg?.weight_thd            ? Number(cfg.weight_thd)            : defaults.thd,
            loadFactor:     cfg?.weight_load_factor    ? Number(cfg.weight_load_factor)    : defaults.loadFactor,
            voltageQuality: cfg?.weight_voltage_quality? Number(cfg.weight_voltage_quality): defaults.voltageQuality,
        };

        const avgPf  = row.avg_pf  ? Number(row.avg_pf)  : null;
        const avgThd = row.avg_thd ? Number(row.avg_thd) : null;
        const avgV   = row.avg_v   ? Number(row.avg_v)   : null;
        const minV   = row.min_v   ? Number(row.min_v)   : null;
        const maxV   = row.max_v   ? Number(row.max_v)   : null;

        const components = {
            pf:             scorePowerFactor(avgPf),
            thd:            scoreTHD(avgThd),
            loadFactor:     scoreLoadFactor(lf),
            voltageQuality: scoreVoltageQuality(avgV, minV, maxV),
        };

        const score = Math.round(
            components.pf             * weights.pf +
            components.thd            * weights.thd +
            components.loadFactor     * weights.loadFactor +
            components.voltageQuality * weights.voltageQuality
        );

        // Persist to energy_scores table — only for site-wide computations.
        // Per-meter scores are computed on demand and not stored.
        if (!meterId) {
            await client.query(`
                INSERT INTO energy_scores (
                    site_id, score,
                    pf_score, thd_score, load_factor_score, voltage_quality_score,
                    weight_pf, weight_thd, weight_load_factor, weight_voltage_quality,
                    tariff_type
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
                siteId, score,
                components.pf, components.thd, components.loadFactor, components.voltageQuality,
                weights.pf, weights.thd, weights.loadFactor, weights.voltageQuality,
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
                energyKwh: row.energy_kwh ? Number(row.energy_kwh) : null,
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
