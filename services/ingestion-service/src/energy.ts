// ─────────────────────────────────────────────────────────────────────────────
// Period energy (kWh) from the meter's import register, per hour, summed.
//
// The register is a direct measurement, so it wins wherever it is present:
// each hour contributes last − first of its register samples, plus the step
// from the previous register hour's last sample to this hour's first. That
// step covers consumption during a comms gap: the meter keeps counting while
// it is not transmitting, so the energy is real, not invented.
//
// A NEGATIVE delta is a register reset (typical when a portable meter is reset
// between deployments, or a meter is replaced). It is a break: counted in
// data_quality and never summed through. Taking max − min over a period
// containing a reset would report the whole pre-reset register as consumption.
//
// A positive step larger than the measured power could have produced
// (max kW × elapsed hours, with headroom) is a jump, e.g. a replacement
// meter with a higher register. Flagged and skipped, same as a reset.
//
// Hours without register data fall back to power integration (computed by
// the caller from readings_1m with the existing 900 s gap cap). The method
// used is reported per period: register, power_integration or mixed.
// ─────────────────────────────────────────────────────────────────────────────

export interface EnergyHour {
    hour: Date;
    /** First / last import-register value (kWh) in the hour; null when absent. */
    regFirst: number | null;
    regLast: number | null;
    /** First / last sample times in the hour. */
    tFirst: Date | null;
    tLast: Date | null;
    /** Highest 1-minute average active power in the hour (kW), for the plausibility check. */
    pMaxKw: number | null;
    /** Power-integrated energy for the hour (kWh), the fallback. */
    powerKwh: number | null;
}

export type EnergyMethod = 'register' | 'power_integration' | 'mixed' | 'none';

export interface PeriodEnergy {
    period: string;            // grouping key, e.g. '2026-11'
    kwh: number;
    method: EnergyMethod;
    data_quality: {
        register_resets: number;
        implausible_jumps: number;
        register_hours: number;
        power_hours: number;
    };
}

/** Headroom on max kW × hours before a register step counts as implausible. */
const JUMP_HEADROOM = 1.5;
/** Steps below this are never flagged (rounding, very light load). */
const JUMP_MIN_KWH = 1;

export function periodEnergy(hours: EnergyHour[], periodOf: (hour: Date) => string): PeriodEnergy[] {
    const sorted = [...hours].sort((a, b) => a.hour.getTime() - b.hour.getTime());
    const out = new Map<string, PeriodEnergy & { _reg: number; _pow: number }>();
    const periodFor = (key: string) => {
        let p = out.get(key);
        if (!p) {
            p = { period: key, kwh: 0, method: 'none', data_quality: { register_resets: 0, implausible_jumps: 0, register_hours: 0, power_hours: 0 }, _reg: 0, _pow: 0 };
            out.set(key, p);
        }
        return p;
    };

    // The last register value seen and when, for bridging into the next hour.
    let prevLast: number | null = null;
    let prevT: Date | null = null;

    for (const h of sorted) {
        const p = periodFor(periodOf(h.hour));
        const hasRegister = h.regFirst !== null && h.regLast !== null;

        if (!hasRegister) {
            if (h.powerKwh !== null && h.powerKwh > 0) {
                p._pow += h.powerKwh;
                p.data_quality.power_hours++;
            }
            // The power-integrated hour already covers this time: do not bridge
            // the register across it, or that energy would be counted twice.
            prevLast = null;
            prevT = null;
            continue;
        }
        p.data_quality.register_hours++;

        // Step from the previous register sample to this hour's first.
        if (prevLast !== null) {
            const step = h.regFirst! - prevLast;
            if (step < 0) {
                p.data_quality.register_resets++;
            } else if (implausible(step, prevT, h.tFirst, h.pMaxKw)) {
                p.data_quality.implausible_jumps++;
            } else {
                p._reg += step;
            }
        }

        // Within the hour.
        const inside = h.regLast! - h.regFirst!;
        if (inside < 0) {
            p.data_quality.register_resets++;
        } else if (implausible(inside, h.tFirst, h.tLast, h.pMaxKw)) {
            p.data_quality.implausible_jumps++;
        } else {
            p._reg += inside;
        }

        prevLast = h.regLast;
        prevT = h.tLast;
    }

    return [...out.values()].map((p) => {
        const method: EnergyMethod =
            p.data_quality.register_hours > 0 && p.data_quality.power_hours > 0 ? 'mixed'
                : p.data_quality.register_hours > 0 ? 'register'
                    : p.data_quality.power_hours > 0 ? 'power_integration' : 'none';
        return { period: p.period, kwh: round1(p._reg + p._pow), method, data_quality: p.data_quality };
    });
}

function implausible(kwh: number, from: Date | null, to: Date | null, pMaxKw: number | null): boolean {
    if (kwh < JUMP_MIN_KWH || pMaxKw === null || pMaxKw <= 0 || !from || !to) return false;
    const hours = Math.max((to.getTime() - from.getTime()) / 3_600_000, 1 / 60);
    return kwh > pMaxKw * hours * JUMP_HEADROOM;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Calendar month key in the site's reporting zone (UTC here, as the existing endpoint). */
export const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

// ── TOU bands and the database side ─────────────────────────────────────────

export type TouBand = 'peak' | 'standard' | 'offpeak';

/**
 * SA commercial time-of-use band for a local hour (0-23), the same rule the
 * analytics page used: peak 07-10 and 18-20, standard 06-22, else off-peak
 * (hour of day only; no weekday or season split).
 */
export function touBand(hour: number): TouBand {
    if ((hour >= 7 && hour < 10) || (hour >= 18 && hour < 20)) return 'peak';
    if (hour >= 6 && hour < 22) return 'standard';
    return 'offpeak';
}

/** Local calendar date (YYYY-MM-DD) and hour of an instant in a time zone. */
export function localDateHour(d: Date, timeZone: string): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/**
 * Hourly register values (readings_1h) plus the power-integration fallback
 * per hour: 1-minute averages × the time to the next minute with data, capped
 * at 900 s (readings_1m). Input for periodEnergy.
 */
export async function loadEnergyHours(db: Queryable, meterId: string, since: Date): Promise<EnergyHour[]> {
    const [reg, pow] = await Promise.all([
        db.query(`
            SELECT bucket AS hour,
                   energy_import_total_first AS reg_first, energy_import_total_last AS reg_last,
                   t_first, t_last, power_active_total_max AS p_max
            FROM readings_1h
            WHERE meter_id = $1 AND bucket >= $2`, [meterId, since]),
        db.query(`
            WITH m AS (
                SELECT bucket, power_active_total_avg AS p,
                       LEAST(EXTRACT(EPOCH FROM (LEAD(bucket) OVER (ORDER BY bucket) - bucket)), 900) AS dt_s
                FROM readings_1m
                WHERE meter_id = $1 AND bucket >= $2 AND power_active_total_avg IS NOT NULL
            )
            SELECT time_bucket('1 hour', bucket) AS hour, SUM(p * COALESCE(dt_s, 60)) / 3600.0 AS kwh
            FROM m GROUP BY 1`, [meterId, since]),
    ]);
    const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
    const hours = new Map<number, EnergyHour>();
    for (const r of reg.rows) {
        hours.set(new Date(r.hour).getTime(), {
            hour: new Date(r.hour), regFirst: num(r.reg_first), regLast: num(r.reg_last),
            tFirst: r.t_first ? new Date(r.t_first) : null, tLast: r.t_last ? new Date(r.t_last) : null,
            pMaxKw: num(r.p_max), powerKwh: null,
        });
    }
    for (const r of pow.rows) {
        const k = new Date(r.hour).getTime();
        const h = hours.get(k) ?? { hour: new Date(r.hour), regFirst: null, regLast: null, tFirst: null, tLast: null, pMaxKw: null, powerKwh: null };
        h.powerKwh = num(r.kwh);
        hours.set(k, h);
    }
    return [...hours.values()];
}

/** Combined method label over several periods. */
export function combinedMethod(methods: EnergyMethod[]): EnergyMethod {
    const set = new Set(methods.filter((m) => m !== 'none'));
    if (set.size === 0) return 'none';
    if (set.size === 1) return [...set][0];
    return 'mixed';
}
