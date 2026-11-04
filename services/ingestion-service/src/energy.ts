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
