// Metering report for one point and period (portal + ops), 2026-11.
//
// What happened at the point over [from, to): energy (registers) and its TOU
// split, maximum demand and when, the load shape, the best and worst values
// with timestamps, the points an engineer looks at for a feasibility study, and
// rough sizing for peak shaving, TOU arbitrage and solar own consumption.
//
// Every figure states its basis. The feasibility numbers are first-pass
// estimates from the measured profile with the assumptions listed in
// `assumptions`; they are a starting point for a proper study, not a quote.
//
// Sources: point_readings_30m (load shape, billed demand, TOU split),
// point_readings_10m (extremes, the NRS 048-2 basis), register energy through
// loadPointEnergy. All corrected and attributed by deployment window.

import type { Pool } from 'pg';
import { loadPointEnergy } from './fleet/balance';

export const MAX_REPORT_DAYS = 93;
const TZ_OFFSET_H = 2; // SAST, no DST

// Assumptions for the rough feasibility figures (stated in the report).
export const ASSUMPTIONS = {
    bess_cost_zar_per_kwh: 6500,       // installed, usable kWh, 2026 SA ballpark
    bess_round_trip: 0.9,
    bess_depth_of_discharge: 0.9,
    pv_cost_zar_per_kwp: 11000,        // installed, commercial rooftop ballpark
    pv_yield_kwh_per_kwp_day: 4.6,     // Gauteng-ish annual average, fixed tilt
    pv_hours: [6, 18] as [number, number], // sun window, SAST, bell-shaped output
    weekdays_per_month: 22,
    days_per_month: 30.4,
};

export interface Tariffs {
    peak: number | null; standard: number | null; offpeak: number | null; demand: number | null;
    peak_times: string | null; standard_times: string | null; offpeak_times: string | null;
}
export interface Row30 { t: Date; kw: number | null; kva: number | null; kva_demand: number | null; pf: number | null; minutes: number }
export interface Row10 {
    t: Date;
    v: (number | null)[]; vmin: (number | null)[]; vmax: (number | null)[];
    imax: (number | null)[]; thdv: (number | null)[]; thdi: (number | null)[];
    pf: number | null; kw: number | null; fmin: number | null; fmax: number | null;
    vunb: number | null; iunb: number | null;
}

type Period = 'peak' | 'standard' | 'offpeak';

/** "07:00 - 10:00, 18:00 - 20:00" → [[7, 10], [18, 20]] (hours, may wrap midnight). */
export function parseWindows(s: string | null | undefined): [number, number][] {
    if (!s) return [];
    const out: [number, number][] = [];
    for (const m of s.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)) {
        out.push([Number(m[1]) + Number(m[2]) / 60, Number(m[3]) + Number(m[4]) / 60]);
    }
    return out;
}
const inWindow = (h: number, [a, b]: [number, number]) => (a <= b ? h >= a && h < b : h >= a || h < b);

/** SAST hour (fractional) and ISO weekday (1 = Monday) of an instant. */
export function sast(t: Date): { hour: number; dow: number; day: string } {
    const s = new Date(t.getTime() + TZ_OFFSET_H * 3_600_000);
    return { hour: s.getUTCHours() + s.getUTCMinutes() / 60, dow: ((s.getUTCDay() + 6) % 7) + 1, day: s.toISOString().slice(0, 10) };
}

/**
 * TOU period of an instant. Weekdays follow the site's windows (Eskom defaults
 * when unset). Saturday: standard 07-12 and 18-20, else off-peak. Sunday:
 * off-peak (Eskom Megaflex-style; public holidays are not modelled).
 */
export function touPeriod(t: Date, tariffs: Pick<Tariffs, 'peak_times' | 'standard_times'>): Period {
    const { hour, dow } = sast(t);
    if (dow === 7) return 'offpeak';
    if (dow === 6) return (hour >= 7 && hour < 12) || (hour >= 18 && hour < 20) ? 'standard' : 'offpeak';
    const peak = parseWindows(tariffs.peak_times ?? '07:00 - 10:00, 18:00 - 20:00');
    const std = parseWindows(tariffs.standard_times ?? '06:00 - 07:00, 10:00 - 18:00, 20:00 - 22:00');
    if (peak.some((w) => inWindow(hour, w))) return 'peak';
    if (std.some((w) => inWindow(hour, w))) return 'standard';
    return 'offpeak';
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const r = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const kwhOf = (row: Row30) => (row.kw ?? 0) * row.minutes / 60;

/** Energy and cost per TOU period, from 30-minute average power. */
export function touSplit(rows: Row30[], tariffs: Tariffs) {
    const kwh: Record<Period, number> = { peak: 0, standard: 0, offpeak: 0 };
    for (const row of rows) if (row.kw !== null && row.kw > 0) kwh[touPeriod(row.t, tariffs)] += kwhOf(row);
    const price: Record<Period, number | null> = { peak: tariffs.peak, standard: tariffs.standard, offpeak: tariffs.offpeak };
    const total = sum(Object.values(kwh));
    return (['peak', 'standard', 'offpeak'] as Period[]).map((p) => ({
        period: p, kwh: r(kwh[p]), share: total > 0 ? r(kwh[p] / total, 3) : null,
        rate_zar_kwh: price[p], cost_zar: price[p] === null ? null : r(kwh[p] * price[p]!, 0),
    }));
}

/** Load shape: demand, load factor, baseload, the average day (48 half-hours) for weekdays and weekends. */
export function loadShape(rows: Row30[]) {
    const withKw = rows.filter((x) => x.kw !== null);
    const demand = rows.filter((x) => x.kva_demand !== null && x.minutes >= 24);
    const maxD = demand.reduce<Row30 | null>((m, x) => (!m || x.kva_demand! > m.kva_demand! ? x : m), null);
    const maxKw = withKw.reduce<Row30 | null>((m, x) => (!m || x.kw! > m.kw! ? x : m), null);
    const kws = withKw.map((x) => x.kw!).sort((a, b) => a - b);
    const avgKw = kws.length ? sum(kws) / kws.length : null;
    const p = (q: number) => (kws.length ? kws[Math.min(kws.length - 1, Math.floor(q * kws.length))] : null);
    const profile = (weekday: boolean) => {
        const acc = Array.from({ length: 48 }, () => ({ s: 0, n: 0, max: -Infinity }));
        for (const x of withKw) {
            const { hour, dow } = sast(x.t);
            if ((dow <= 5) !== weekday) continue;
            const slot = acc[Math.floor(hour * 2) % 48];
            slot.s += x.kw!; slot.n++; slot.max = Math.max(slot.max, x.kw!);
        }
        return acc.map((a, i) => ({
            slot: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
            avg_kw: a.n ? r(a.s / a.n) : null, max_kw: a.n ? r(a.max) : null,
        }));
    };
    // How peaky: half-hours within 10 % of the maximum demand. Few = short spikes (cheap to shave).
    const nearPeak = maxD ? demand.filter((x) => x.kva_demand! >= 0.9 * maxD.kva_demand!).length : 0;
    return {
        max_demand_kva: r(maxD?.kva_demand ?? null), max_demand_at: maxD?.t ?? null,
        max_kw: r(maxKw?.kw ?? null), max_kw_at: maxKw?.t ?? null,
        avg_kw: r(avgKw), load_factor: avgKw !== null && maxKw?.kw ? r(avgKw / maxKw.kw, 2) : null,
        baseload_kw: r(p(0.05)), p95_kw: r(p(0.95)),
        intervals_within_10pct_of_max: nearPeak,
        weekday_profile: profile(true), weekend_profile: profile(false),
    };
}

type Extreme = { value: number | null; at: Date | null; phase?: string };
/** Best and worst values from 10-minute data, with when they happened. */
export function extremes(rows: Row10[]) {
    const pick = (get: (x: Row10) => (number | null)[] | number | null, worstIsMax: boolean, phases = ['A', 'B', 'C']): { worst: Extreme; best: Extreme } => {
        let worst: Extreme = { value: null, at: null }, best: Extreme = { value: null, at: null };
        for (const x of rows) {
            const v = get(x);
            const vals = Array.isArray(v) ? v.map((y, i) => [y, phases[i]] as const) : [[v, undefined] as const];
            for (const [y, ph] of vals) {
                if (y === null || y === undefined || !Number.isFinite(y)) continue;
                const worse = worstIsMax ? y > (worst.value ?? -Infinity) : y < (worst.value ?? Infinity);
                const better = worstIsMax ? y < (best.value ?? Infinity) : y > (best.value ?? -Infinity);
                if (worse) worst = { value: y, at: x.t, ...(ph ? { phase: ph } : {}) };
                if (better) best = { value: y, at: x.t, ...(ph ? { phase: ph } : {}) };
            }
        }
        return { worst: { ...worst, value: r(worst.value, 2) }, best: { ...best, value: r(best.value, 2) } };
    };
    const loaded = (() => { const m = Math.max(0, ...rows.map((x) => x.kw ?? 0)); return rows.filter((x) => (x.kw ?? 0) > 0.1 * m); })();
    const pfPick = (() => {
        const pr = loaded.map((x) => ({ ...x, pfa: x.pf === null ? null : Math.abs(x.pf) }));
        return extremes0(pr);
        function extremes0(xs: (Row10 & { pfa: number | null })[]) {
            let worst: Extreme = { value: null, at: null }, best: Extreme = { value: null, at: null };
            for (const x of xs) {
                if (x.pfa === null) continue;
                if (worst.value === null || x.pfa < worst.value) worst = { value: x.pfa, at: x.t };
                if (best.value === null || x.pfa > best.value) best = { value: x.pfa, at: x.t };
            }
            return { worst: { ...worst, value: r(worst.value, 3) }, best: { ...best, value: r(best.value, 3) } };
        }
    })();
    return {
        voltage_low: pick((x) => x.vmin, false),        // worst = lowest minimum
        voltage_high: pick((x) => x.vmax, true),        // worst = highest maximum
        current_max: pick((x) => x.imax, true),
        thd_voltage: pick((x) => x.thdv, true),
        thd_current: pick((x) => x.thdi, true),
        power_factor_loaded: pfPick,                    // worst = lowest |PF| while loaded
        frequency_low: pick((x) => x.fmin, false),
        frequency_high: pick((x) => x.fmax, true),
        voltage_unbalance: pick((x) => x.vunb, true),
        current_unbalance: pick((x) => x.iunb, true),
    };
}

/** Per-day energy above a power threshold (kWh) and the largest excess (kW). */
function excessAbove(rows: Row30[], thresholdKw: number) {
    const perDay = new Map<string, number>();
    let maxExcess = 0;
    for (const x of rows) {
        if (x.kw === null || x.kw <= thresholdKw) continue;
        const e = x.kw - thresholdKw;
        maxExcess = Math.max(maxExcess, e);
        const d = sast(x.t).day;
        perDay.set(d, (perDay.get(d) ?? 0) + e * x.minutes / 60);
    }
    const days = [...perDay.values()];
    return { max_daily_kwh: days.length ? Math.max(...days) : 0, days_needed: days.length, max_excess_kw: maxExcess };
}

/** Peak shaving: cap billed demand at 90 / 80 / 70 % of the measured maximum. */
export function peakShaving(rows: Row30[], tariffs: Tariffs, maxDemandKva: number | null, pfAvg: number | null) {
    if (!maxDemandKva || maxDemandKva <= 0) return [];
    const pf = pfAvg && pfAvg > 0.3 ? pfAvg : 0.9;
    return [0.9, 0.8, 0.7].map((f) => {
        const targetKva = maxDemandKva * f;
        const ex = excessAbove(rows, targetKva * pf);
        const usable = ex.max_daily_kwh;
        const nameplate = usable / ASSUMPTIONS.bess_depth_of_discharge;
        const monthly = tariffs.demand ? (maxDemandKva - targetKva) * tariffs.demand : null;
        const cost = nameplate * ASSUMPTIONS.bess_cost_zar_per_kwh;
        return {
            target_kva: r(targetKva, 0), demand_reduction_kva: r(maxDemandKva - targetKva, 0),
            battery_power_kw: r(ex.max_excess_kw, 0), battery_energy_kwh: r(nameplate, 0),
            days_with_shaving: ex.days_needed,
            monthly_saving_zar: r(monthly, 0), indicative_cost_zar: r(cost, -3),
            simple_payback_years: monthly && monthly > 0 ? r(cost / (monthly * 12), 1) : null,
        };
    });
}

/** TOU arbitrage: charge off-peak, discharge into the site's own weekday peak-window load. */
export function arbitrage(rows: Row30[], tariffs: Tariffs, batteryKwh: number) {
    if (tariffs.peak === null || tariffs.offpeak === null) return null;
    const perDay = new Map<string, number>();
    for (const x of rows) {
        if (x.kw === null || x.kw <= 0 || touPeriod(x.t, tariffs) !== 'peak') continue;
        const d = sast(x.t).day;
        perDay.set(d, (perDay.get(d) ?? 0) + kwhOf(x));
    }
    const days = [...perDay.values()];
    const avgPeakKwh = days.length ? sum(days) / days.length : 0;
    const usable = batteryKwh * ASSUMPTIONS.bess_depth_of_discharge;
    const displaced = Math.min(usable, avgPeakKwh);
    const marginPerKwh = tariffs.peak - tariffs.offpeak / ASSUMPTIONS.bess_round_trip;
    const monthly = displaced * marginPerKwh * ASSUMPTIONS.weekdays_per_month;
    const cost = batteryKwh * ASSUMPTIONS.bess_cost_zar_per_kwh;
    return {
        battery_kwh: r(batteryKwh, 0), avg_weekday_peak_kwh: r(avgPeakKwh, 0), displaced_kwh_per_day: r(displaced, 0),
        margin_zar_per_kwh: r(marginPerKwh, 2), monthly_saving_zar: r(monthly, 0),
        indicative_cost_zar: r(cost, -3), simple_payback_years: monthly > 0 ? r(cost / (monthly * 12), 1) : null,
    };
}

/** PV output (kW per kWp) at a SAST hour: a half-sine over the sun window, scaled to the daily yield. */
export function pvShape(hour: number): number {
    const [a, b] = ASSUMPTIONS.pv_hours;
    if (hour <= a || hour >= b) return 0;
    const peak = ASSUMPTIONS.pv_yield_kwh_per_kwp_day * Math.PI / (2 * (b - a)); // integral of the half-sine = yield
    return peak * Math.sin(Math.PI * (hour - a) / (b - a));
}

/** Solar own consumption: simulate sizes against the measured load, report self-use and savings. */
export function solarOwnUse(rows: Row30[], tariffs: Tariffs) {
    const valid = rows.filter((x) => x.kw !== null);
    if (valid.length < 48) return null;
    const days = new Set(valid.map((x) => sast(x.t).day)).size;
    // The no-export size: PV at its noon peak never exceeds the lowest daytime load (10:00-14:00).
    const midday = valid.filter((x) => { const h = sast(x.t).hour; return h >= 10 && h < 14; }).map((x) => x.kw!).sort((a, b) => a - b);
    const lowMidday = midday.length ? midday[Math.floor(0.05 * midday.length)] : 0;
    const noonPerKwp = pvShape(12);
    const noExportKwp = noonPerKwp > 0 ? Math.max(0, lowMidday / noonPerKwp) : 0;
    const price = (t: Date) => {
        const p = touPeriod(t, tariffs);
        return (p === 'peak' ? tariffs.peak : p === 'standard' ? tariffs.standard : tariffs.offpeak) ?? 2.5;
    };
    const simulate = (kwp: number) => {
        let gen = 0, used = 0, value = 0;
        for (const x of valid) {
            const h = sast(x.t).hour + x.minutes / 120; // mid-interval
            const pv = kwp * pvShape(h);
            const self = Math.min(pv, Math.max(0, x.kw!));
            gen += pv * x.minutes / 60; used += self * x.minutes / 60; value += self * x.minutes / 60 * price(x.t);
        }
        const perMonth = (v: number) => v / days * ASSUMPTIONS.days_per_month;
        const cost = kwp * ASSUMPTIONS.pv_cost_zar_per_kwp;
        const monthly = perMonth(value);
        return {
            kwp: r(kwp, 0), self_consumption: gen > 0 ? r(used / gen, 2) : null,
            share_of_load: null as number | null,
            monthly_generation_kwh: r(perMonth(gen), 0), monthly_self_used_kwh: r(perMonth(used), 0),
            monthly_saving_zar: r(monthly, 0), indicative_cost_zar: r(cost, -3),
            simple_payback_years: monthly > 0 ? r(cost / (monthly * 12), 1) : null,
        };
    };
    const load = sum(valid.map((x) => Math.max(0, x.kw!) * x.minutes / 60));
    const sizes = [...new Set([noExportKwp, noExportKwp * 1.5, noExportKwp * 2].map((k) => Math.round(k)))].filter((k) => k > 0);
    const options = sizes.map((k) => {
        const s = simulate(k);
        s.share_of_load = load > 0 && s.monthly_self_used_kwh !== null ? r((s.monthly_self_used_kwh / ASSUMPTIONS.days_per_month * days) / load, 2) : null;
        return s;
    });
    return { lowest_midday_load_kw: r(lowMidday), no_export_kwp: r(noExportKwp, 0), options };
}

export interface ReportInput {
    rows30: Row30[]; rows10: Row10[]; tariffs: Tariffs;
    mdiKva: number | null; vNominal: number;
    energy: { importKwh: number; exportKwh: number; coverage: number } | null;
}

/** The points to look at for a feasibility study, from the numbers above. */
export function feasibilityNotes(i: ReportInput, shape: ReturnType<typeof loadShape>, ex: ReturnType<typeof extremes>, pfAvg: number | null) {
    const notes: { level: 'info' | 'watch' | 'act'; text: string }[] = [];
    const cov = i.energy?.coverage ?? null;
    if (cov !== null && cov < 0.9) notes.push({ level: 'watch', text: `Data covers ${Math.round(cov * 100)} % of the period. Extend the measurement or treat totals as a lower bound.` });
    if (shape.max_demand_kva !== null && i.mdiKva) {
        const u = shape.max_demand_kva / i.mdiKva;
        notes.push({ level: u > 1 ? 'act' : u > 0.9 ? 'watch' : 'info', text: `Maximum demand ${Math.round(shape.max_demand_kva)} kVA is ${Math.round(u * 100)} % of the contracted ${Math.round(i.mdiKva)} kVA.` });
    }
    if (shape.intervals_within_10pct_of_max > 0) {
        notes.push({ level: 'info', text: shape.intervals_within_10pct_of_max <= 6
            ? `Only ${shape.intervals_within_10pct_of_max} half-hour${shape.intervals_within_10pct_of_max === 1 ? '' : 's'} came within 10 % of the maximum: short spikes, a good case for peak shaving or load scheduling.`
            : `${shape.intervals_within_10pct_of_max} half-hours came within 10 % of the maximum: the peak is broad, so shaving it needs a larger battery.` });
    }
    if (shape.load_factor !== null) notes.push({ level: 'info', text: `Load factor ${shape.load_factor} (average ÷ maximum kW). ${shape.load_factor < 0.4 ? 'Peaky load: demand charges weigh heavily.' : shape.load_factor > 0.7 ? 'Flat load: energy, not demand, drives the bill.' : ''}`.trim() });
    if (pfAvg !== null && pfAvg < 0.9) notes.push({ level: pfAvg < 0.85 ? 'act' : 'watch', text: `Average power factor ${pfAvg.toFixed(2)}: correct it before sizing a battery or PV inverter, as it inflates kVA.` });
    if (shape.baseload_kw !== null && shape.avg_kw) notes.push({ level: 'info', text: `Baseload (5th percentile) ${shape.baseload_kw} kW, ${Math.round(shape.baseload_kw / shape.avg_kw * 100)} % of the average load: the floor PV can always use.` });
    if (ex.voltage_high.worst.value !== null && ex.voltage_high.worst.value > i.vNominal * 1.06) notes.push({ level: 'watch', text: `Voltage reached ${ex.voltage_high.worst.value} V. Exporting PV raises it further; check headroom to 253 V with the utility before sizing for export.` });
    if (ex.thd_voltage.worst.value !== null && ex.thd_voltage.worst.value > 5) notes.push({ level: ex.thd_voltage.worst.value > 8 ? 'act' : 'watch', text: `Voltage THD reached ${ex.thd_voltage.worst.value} %. Inverters and capacitor banks need to be specified for this distortion.` });
    if (ex.current_unbalance.worst.value !== null && ex.current_unbalance.worst.value > 20) notes.push({ level: 'watch', text: `Current unbalance reached ${ex.current_unbalance.worst.value} %. Three-phase inverters and batteries assume a reasonably balanced load.` });
    if ((i.energy?.exportKwh ?? 0) > 1) notes.push({ level: 'info', text: `${Math.round(i.energy!.exportKwh)} kWh was exported: there is generation behind this point already.` });
    return notes;
}

/** The whole report from loaded rows (no database: unit-testable). */
export function buildReport(i: ReportInput, opts: { sizing?: boolean } = {}) {
    const sizing = opts.sizing !== false;
    const shape = loadShape(i.rows30);
    const ex = extremes(i.rows10);
    const pfVals = i.rows30.filter((x) => x.pf !== null && (x.kw ?? 0) > 0).map((x) => Math.abs(x.pf!));
    const pfAvg = pfVals.length ? sum(pfVals) / pfVals.length : null;
    const shaving = peakShaving(i.rows30, i.tariffs, shape.max_demand_kva, pfAvg);
    const mid = shaving[1];
    return {
        energy: i.energy ? {
            import_kwh: r(i.energy.importKwh), export_kwh: r(i.energy.exportKwh), coverage: r(i.energy.coverage, 3),
            basis: 'energy registers, per deployment (resets never summed through)',
        } : null,
        tou: touSplit(i.rows30, i.tariffs),
        demand: { ...shape, contracted_mdi_kva: i.mdiKva, avg_power_factor: r(pfAvg, 3),
            basis: '30-minute billed demand (kVA), intervals at least 80 % covered' },
        extremes: ex,
        extremes_basis: '10-minute values (NRS 048-2 basis); minima and maxima are of the samples in each window',
        feasibility: !sizing ? {
            notes: feasibilityNotes(i, shape, ex, pfAvg),
            sizing_available: false,
            handover: 'GridIQ supplies the measured profile, demand and power-quality findings for an independent feasibility study (exports and API). System sizing is not part of this report.',
        } : {
            notes: feasibilityNotes(i, shape, ex, pfAvg),
            sizing_available: true,
            peak_shaving: shaving,
            arbitrage: mid ? arbitrage(i.rows30, i.tariffs, mid.battery_energy_kwh ?? 0) : null,
            solar: solarOwnUse(i.rows30, i.tariffs),
            assumptions: ASSUMPTIONS,
            disclaimer: 'First-pass estimates from the measured profile and the stated assumptions. Use them to decide what to study, not as a quote: battery and PV pricing, tariffs, export rules and the site itself need a proper feasibility study.',
        },
        tariffs: i.tariffs,
    };
}

const n = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/** Load everything for a point and period, then build the report. */
export async function meteringReport(db: Pool, pointId: string, from: Date, to: Date, opts: { sizing?: boolean } = {}) {
    const pt = (await db.query(`
        SELECT mp.id, mp.name, mp.role, mp.nominal_voltage_v, mp.project_id, p.name AS project_name,
               COALESCE(mp.contracted_mdi_kva, ss.contracted_mdi_kva) AS mdi,
               ss.tariff_peak, ss.tariff_standard, ss.tariff_offpeak, ss.tariff_demand,
               ss.peak_times, ss.standard_times, ss.offpeak_times, ss.tariff_type
        FROM measurement_points mp JOIN projects p ON p.id = mp.project_id
        LEFT JOIN site_settings ss ON ss.site_id = mp.project_id
        WHERE mp.id = $1`, [pointId])).rows[0];
    const r30 = (await db.query(`
        SELECT bucket, power_active_total_avg AS kw, power_apparent_total_avg AS kva, kva_demand,
               power_factor_total_avg AS pf,
               -- A covered interval: 80 % of its minutes have samples, or (sparse boxes, e.g. one
               -- reading every 5 minutes) its samples span at least 22.5 of the 30 minutes.
               CASE WHEN (minutes >= 24 OR extract(epoch FROM t_last - t_first) >= 1350) THEN 30 ELSE minutes END AS minutes
        FROM point_readings_30m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
        ORDER BY bucket`, [pointId, from, to])).rows;
    const r10 = (await db.query(`
        SELECT bucket, voltage_a_min, voltage_b_min, voltage_c_min, voltage_a_max, voltage_b_max, voltage_c_max,
               current_a_max, current_b_max, current_c_max,
               thd_voltage_a_avg, thd_voltage_b_avg, thd_voltage_c_avg, thd_current_a_avg, thd_current_b_avg, thd_current_c_avg,
               power_factor_total_avg, power_active_total_avg, frequency_min, frequency_max,
               voltage_unbalance_avg, current_unbalance_avg
        FROM point_readings_10m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
        ORDER BY bucket`, [pointId, from, to])).rows;
    const energy = await loadPointEnergy(db, pointId, from, to);
    const tariffs: Tariffs = {
        peak: n(pt.tariff_peak), standard: n(pt.tariff_standard), offpeak: n(pt.tariff_offpeak), demand: n(pt.tariff_demand),
        peak_times: pt.peak_times ?? null, standard_times: pt.standard_times ?? null, offpeak_times: pt.offpeak_times ?? null,
    };
    const report = buildReport({
        rows30: r30.map((x) => ({ t: new Date(x.bucket), kw: n(x.kw), kva: n(x.kva), kva_demand: n(x.kva_demand), pf: n(x.pf), minutes: Number(x.minutes) })),
        rows10: r10.map((x) => ({
            t: new Date(x.bucket),
            v: [], vmin: [n(x.voltage_a_min), n(x.voltage_b_min), n(x.voltage_c_min)],
            vmax: [n(x.voltage_a_max), n(x.voltage_b_max), n(x.voltage_c_max)],
            imax: [n(x.current_a_max), n(x.current_b_max), n(x.current_c_max)],
            thdv: [n(x.thd_voltage_a_avg), n(x.thd_voltage_b_avg), n(x.thd_voltage_c_avg)],
            thdi: [n(x.thd_current_a_avg), n(x.thd_current_b_avg), n(x.thd_current_c_avg)],
            pf: n(x.power_factor_total_avg), kw: n(x.power_active_total_avg),
            fmin: n(x.frequency_min), fmax: n(x.frequency_max),
            vunb: n(x.voltage_unbalance_avg), iunb: n(x.current_unbalance_avg),
        })),
        tariffs, mdiKva: n(pt.mdi), vNominal: n(pt.nominal_voltage_v) ?? 230,
        energy: energy.coverage > 0 ? { importKwh: energy.importKwh, exportKwh: energy.exportKwh, coverage: energy.coverage } : null,
    }, opts);
    return {
        point: { id: pt.id, name: pt.name, role: pt.role, project_id: pt.project_id, project_name: pt.project_name, tariff_type: pt.tariff_type ?? null },
        period: { from, to, time_zone: 'Africa/Johannesburg (SAST, UTC+2)' },
        ...report,
    };
}
