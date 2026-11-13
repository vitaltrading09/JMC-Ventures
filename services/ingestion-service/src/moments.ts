// ─────────────────────────────────────────────────────────────────────────────
// Close-ups: the worst moments behind a finding, reading by reading.
//
//   GET /points/:id/moments?kind=&from=&to=&limit=   (investigate.ts)
//
// The 1-minute values find the moments (lowest voltage, highest voltage, highest
// distortion, highest demand, worst unbalance, lowest power factor); for each,
// every stored reading around it is returned (the meter's own interval, with the
// installation corrections), together with what those readings show: the exact
// extreme, which phases, how long, and what the load did just before. From that
// a careful reading of where the cause more likely lies: "site", "supply" or
// "unclear". Always a pointer to verify, never a conclusion.
//
// momentFacts is pure and unit-tested (test/moments.test.js).
// ─────────────────────────────────────────────────────────────────────────────

export type MomentKind = 'sags' | 'voltage_high' | 'thd' | 'demand' | 'imbalance' | 'pf';
export const MOMENT_KINDS: MomentKind[] = ['sags', 'voltage_high', 'thd', 'demand', 'imbalance', 'pf'];

/** What to rank the 1-minute values by (SQL over point_readings_1m), worst first. */
export const MOMENT_RANK: Record<MomentKind, { expr: string; order: 'ASC' | 'DESC'; where: string }> = {
    sags: { expr: 'LEAST(voltage_a_min, voltage_b_min, voltage_c_min)', order: 'ASC', where: 'LEAST(voltage_a_min, voltage_b_min, voltage_c_min) > 23' },
    voltage_high: { expr: 'GREATEST(voltage_a_max, voltage_b_max, voltage_c_max)', order: 'DESC', where: 'TRUE' },
    thd: { expr: 'GREATEST(thd_voltage_a_max, thd_voltage_b_max, thd_voltage_c_max)', order: 'DESC', where: 'TRUE' },
    demand: { expr: 'COALESCE(power_apparent_total_max, power_active_total_max)', order: 'DESC', where: 'TRUE' },
    imbalance: { expr: 'current_unbalance_max', order: 'DESC', where: 'power_active_total_avg > 0' },
    pf: { expr: 'abs(power_factor_total_avg)', order: 'ASC', where: 'power_active_total_avg > 0 AND abs(power_factor_total_avg) > 0.05' },
};

export interface RawRow {
    t: string | Date;
    voltage_a: number | null; voltage_b: number | null; voltage_c: number | null;
    current_a: number | null; current_b: number | null; current_c: number | null;
    kw: number | null; kva: number | null; pf: number | null;
    thd_a: number | null; thd_b: number | null; thd_c: number | null; unbalance: number | null;
}

export interface Moment {
    at: string;                    // the exact reading of the extreme
    value: number | null; unit: string; phase: string | null;
    headline: string;
    facts: string[];
    reading: 'site' | 'supply' | 'unclear';
    reading_text: string;
    cadence_s: number | null;      // spacing of the readings shown
    threshold: number | null;
    crossed: boolean;              // the extreme is beyond the level that matters
    clipped: boolean;              // the excursion runs to the edge of the readings shown
}

const PH = ['a', 'b', 'c'] as const;
const n = (v: any): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const r = (v: number | null, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const ms = (t: string | Date) => new Date(t).getTime();
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const sastClock = (t: number) => new Date(t + 2 * 3_600_000).toISOString().slice(11, 19);
const dur = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** Median spacing of the readings, in seconds. */
export function cadenceOf(rows: RawRow[]): number | null {
    const gaps: number[] = [];
    for (let i = 1; i < rows.length; i++) gaps.push((ms(rows[i].t) - ms(rows[i - 1].t)) / 1000);
    const m = median(gaps);
    return m == null ? null : Math.round(m * 10) / 10;
}

/** What the readings around one moment show (pure). */
export function momentFacts(kind: MomentKind, rows: RawRow[], opts: { nominalV: number; mdiKva?: number | null }): Moment | null {
    if (!rows.length) return null;
    const cadence = cadenceOf(rows);
    const phaseVals = (x: RawRow, pre: 'voltage' | 'thd') => PH.map((p) => ({ p: p.toUpperCase(), v: n((x as any)[`${pre}_${p}`]) })).filter((y): y is { p: string; v: number } => y.v != null);
    // The extreme reading for this kind.
    let iX = -1, value: number | null = null, phase: string | null = null;
    const consider = (i: number, v: number | null, p: string | null, lower: boolean) => {
        if (v == null) return;
        if (value == null || (lower ? v < value : v > value)) { value = v; iX = i; phase = p; }
    };
    rows.forEach((x, i) => {
        if (kind === 'sags') for (const y of phaseVals(x, 'voltage')) { if (y.v > 23) consider(i, y.v, y.p, true); }
        else if (kind === 'voltage_high') for (const y of phaseVals(x, 'voltage')) consider(i, y.v, y.p, false);
        else if (kind === 'thd') for (const y of phaseVals(x, 'thd')) consider(i, y.v, y.p, false);
        else if (kind === 'demand') consider(i, n(x.kva) ?? n(x.kw), null, false);
        else if (kind === 'imbalance') consider(i, n(x.unbalance), null, false);
        else if (kind === 'pf') { if ((n(x.kw) ?? 0) > 0 && n(x.pf) != null) consider(i, Math.abs(n(x.pf)!), null, true); }
    });
    if (iX < 0 || value == null) return null;
    const tX = ms(rows[iX].t);
    // Load just before the extreme (up to a minute, at least two readings) and at it.
    const before = rows.filter((x) => ms(x.t) < tX && ms(x.t) >= tX - Math.max(60_000, 3 * (cadence ?? 1) * 1000));
    const kwBefore = median(before.map((x) => n(x.kw)).filter((v): v is number => v != null));
    const iAvg = (x: RawRow) => { const v = [n(x.current_a), n(x.current_b), n(x.current_c)].filter((y): y is number => y != null); return v.length ? v.reduce((s, y) => s + y, 0) / v.length : null; };
    const iBefore = median(before.map(iAvg).filter((v): v is number => v != null));
    const around = rows.filter((x) => Math.abs(ms(x.t) - tX) <= Math.max(10_000, (cadence ?? 1) * 1000));
    const kwAt = Math.max(...around.map((x) => n(x.kw) ?? -Infinity)), iAt = Math.max(...around.map((x) => iAvg(x) ?? -Infinity));
    // A dip is judged against the highest load around it (the start); a voltage peak against the
    // load from the peak on (what dropped off).
    const kwAfter = median(rows.filter((x) => ms(x.t) >= tX && ms(x.t) <= tX + Math.max(10_000, (cadence ?? 1) * 1000)).map((x) => n(x.kw)).filter((v): v is number => v != null));
    const kwNow = kind === 'voltage_high' ? kwAfter : Number.isFinite(kwAt) ? kwAt : null;
    const kwStep = kwBefore != null && kwNow != null ? kwNow - kwBefore : null;
    const iRise = iBefore != null && iBefore > 0 && Number.isFinite(iAt) ? (iAt - iBefore) / iBefore : null;
    const peakKw = Math.max(1, ...rows.map((x) => n(x.kw) ?? 0));
    const bigStep = kwStep != null && kwStep >= Math.max(5, 0.1 * peakKw);
    const at = new Date(tX).toISOString();
    const facts: string[] = [];
    const base = { at, value: r(value, kind === 'pf' ? 3 : 1), phase, cadence_s: cadence, crossed: true, clipped: false };
    const delta = (d: number, unit: string) => (Math.abs(d) < 1 ? 'no change' : `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d))} ${unit}`);
    const resolution = cadence != null ? `Readings here are ${cadence <= 1.5 ? 'one per second' : `${dur(cadence)} apart`}; anything shorter than that is not resolved.` : '';

    if (kind === 'sags' || kind === 'voltage_high') {
        const low = kind === 'sags';
        const threshold = Math.round((low ? 0.9 : 1.1) * opts.nominalV);
        const beyond = (x: RawRow) => phaseVals(x, 'voltage').filter((y) => (low ? y.v < threshold && y.v > 23 : y.v > threshold));
        const phases = new Set<string>(); let run = 0, i0 = iX, i1 = iX;
        while (i0 > 0 && beyond(rows[i0 - 1]).length) i0--;
        while (i1 < rows.length - 1 && beyond(rows[i1 + 1]).length) i1++;
        for (let i = i0; i <= i1; i++) for (const y of beyond(rows[i])) phases.add(y.p);
        run = beyond(rows[iX]).length ? (ms(rows[i1].t) - ms(rows[i0].t)) / 1000 + (cadence ?? 0) : 0;
        const clipped = run > 0 && (i0 === 0 || i1 === rows.length - 1);
        const about = clipped ? 'at least' : 'about';
        const which = phases.size === 3 ? 'all three phases' : phases.size ? `phase${phases.size > 1 ? 's' : ''} ${[...phases].sort().join(' and ')}` : `phase ${phase}`;
        facts.push(`${low ? 'Lowest' : 'Highest'} reading: ${r(value)} V on phase ${phase} at ${sastClock(tX)} SAST (${low ? '90' : '110'} % of ${opts.nominalV} V is ${threshold} V).`);
        if (run > 0) facts.push(`${low ? 'Below' : 'Above'} ${threshold} V on ${which} for ${about} ${dur(run)}.`);
        else facts.push(`No single reading crossed ${threshold} V; this is the ${low ? 'lowest' : 'highest'} point of the period.`);
        if (kwStep != null) facts.push(`Load just before: ${Math.round(kwBefore!)} kW; at the ${low ? 'dip' : 'peak'}: ${Math.round(kwNow!)} kW (${delta(kwStep, 'kW')}).`);
        if (iRise != null && Math.abs(iRise) >= 0.1) facts.push(`Current ${iRise > 0 ? 'rose' : 'fell'} by about ${Math.round(Math.abs(iRise) * 100)} % at the same moment.`);
        if (resolution) facts.push(resolution);
        let reading: Moment['reading'] = 'unclear', text = 'The readings do not show clearly whether this started on site or on the supply.';
        if (low) {
            if (bigStep || (iRise != null && iRise >= 0.25)) { reading = 'site'; text = 'The load and current jumped as the voltage fell: this looks like a large load starting on site (motor, compressor, charger) pulling the voltage down. To verify: match the time with what started.'; }
            else if (phases.size === 3 && !bigStep && (iRise == null || iRise < 0.1)) { reading = 'supply'; text = 'All three phases dipped together with no load start on site: this looks like a disturbance on the supply side (network fault or switching). To verify: ask the utility for its records at this time.'; }
            else if (phases.size && phases.size < 3 && !bigStep) text = 'Only part of the supply dipped and the site load did not jump: check single-phase loads and connections on that phase, and ask the utility whether a network fault was recorded.';
        } else if (kwStep != null && kwStep <= -Math.max(5, 0.1 * peakKw)) { reading = 'site'; text = 'The voltage rose as a large load dropped off: the supply voltage sits high when the site is lightly loaded. To verify: check the transformer tap setting with the utility or your electrician.'; }
        else if (phases.size === 3) { reading = 'supply'; text = 'All three phases were high with no change in the site load: the supply voltage itself was high. To verify: compare with the utility\'s voltage records and the transformer tap.'; }
        return { ...base, unit: 'V', threshold, facts, reading, reading_text: text, crossed: run > 0, clipped,
            headline: `${r(value)} V on phase ${phase}${run > 0 ? ` for ${about} ${dur(run)}` : ''}${bigStep ? `, as the load rose ${Math.round(kwStep!)} kW` : ''}` };
    }

    if (kind === 'thd') {
        const kwAtX = n(rows[iX].kw);
        facts.push(`Highest reading: ${r(value)} % voltage distortion on phase ${phase} at ${sastClock(tX)} SAST (screening level 8 %).`);
        const above = rows.filter((x) => phaseVals(x, 'thd').some((y) => y.v > 8));
        if (above.length) facts.push(`Above 8 % in ${above.length} of the ${rows.length} readings shown.`);
        if (kwAtX != null) facts.push(`Site load at that moment: ${Math.round(kwAtX)} kW${kwBefore != null ? ` (${Math.round(kwBefore)} kW just before)` : ''}.`);
        const thdMax = rows.map((x) => { const v = phaseVals(x, 'thd'); return v.length ? Math.max(...v.map((y) => y.v)) : null; });
        const kws = rows.map((x) => n(x.kw));
        const c = corr(kws, thdMax);
        if (c != null) facts.push(`Within these readings distortion ${c > 0.5 ? 'moved with the load' : c < -0.5 ? 'moved against the load' : 'did not follow the load'} (r = ${r(c, 2)}).`);
        if (resolution) facts.push(resolution);
        const reading: Moment['reading'] = c != null && c > 0.5 ? 'site' : c != null && c < -0.5 ? 'supply' : 'unclear';
        const text = reading === 'site' ? 'Distortion climbed as the site drew more power: equipment on site (drives, UPS, LED lighting, chargers) is the likely source. To verify: note which of them was running at this time.'
            : reading === 'supply' ? 'Distortion was higher while the site drew less: it likely arrives from the network or a neighbour. To verify: ask the utility about distortion at the point of supply.'
            : 'Distortion did not clearly follow the site load in these readings; compare a working day with a day off.';
        return { ...base, unit: '%', threshold: 8, facts, reading, reading_text: text, crossed: value > 8, headline: `${r(value)} % distortion on phase ${phase}${kwAtX != null ? ` at ${Math.round(kwAtX)} kW` : ''}` };
    }

    if (kind === 'demand') {
        const unit = n(rows[iX].kva) != null ? 'kVA' : 'kW';
        const mdi = opts.mdiKva ?? null;
        facts.push(`Highest reading: ${Math.round(value)} ${unit} at ${sastClock(tX)} SAST${mdi && unit === 'kVA' ? ` (${Math.round((value / mdi) * 100)} % of the contracted ${Math.round(mdi)} kVA)` : ''}.`);
        // How fast the load climbed: from the lowest reading before the peak.
        const pre = rows.slice(0, iX + 1).map((x) => ({ t: ms(x.t), v: n(x.kva) ?? n(x.kw) })).filter((x): x is { t: number; v: number } => x.v != null);
        // The climb starts at the last reading still near the lowest level before the peak.
        const floor = pre.reduce((m, x) => Math.min(m, x.v), Infinity);
        const lowBefore = [...pre].reverse().find((x) => x.v <= floor + 0.1 * (value! - floor)) ?? null;
        if (lowBefore && value - lowBefore.v >= Math.max(5, 0.1 * value)) facts.push(`It climbed ${Math.round(value - lowBefore.v)} ${unit} in ${dur((tX - lowBefore.t) / 1000)} (from ${Math.round(lowBefore.v)} ${unit} at ${sastClock(lowBefore.t)}).`);
        const pfX = n(rows[iX].pf);
        if (pfX != null) facts.push(`Power factor at the peak: ${r(Math.abs(pfX), 2)}${Math.abs(pfX) < 0.9 ? ', so part of this kVA is reactive power' : ''}.`);
        if (resolution) facts.push(resolution);
        facts.push('Billing uses the 30-minute average, which is lower than a short peak like this one.');
        const fast = !!lowBefore && value - lowBefore.v >= 0.2 * value && tX - lowBefore.t <= 5 * 60_000;
        return { ...base, unit, threshold: unit === 'kVA' ? mdi : null, facts, reading: 'site', crossed: !(mdi && unit === 'kVA') || value > mdi,
            reading_text: fast ? 'The load climbed quickly, which is typical of several large loads starting together. To verify: list what switches on at this time and whether the starts can be staggered.'
                : 'The load built up gradually to this peak: it is the combined running load, not one start. To verify: list what runs at this time and what could move to another hour.',
            headline: `${Math.round(value)} ${unit}${mdi && unit === 'kVA' ? `, ${Math.round((value / mdi) * 100)} % of the contracted limit` : ''}` };
    }

    if (kind === 'imbalance') {
        const x = rows[iX];
        const cur = PH.map((p) => ({ p: p.toUpperCase(), v: n((x as any)[`current_${p}`]) })).filter((y): y is { p: string; v: number } => y.v != null).sort((a, b) => b.v - a.v);
        facts.push(`Highest current unbalance: ${r(value)} % at ${sastClock(tX)} SAST.`);
        if (cur.length === 3) facts.push(`Currents then: ${cur.map((y) => `${y.p} ${Math.round(y.v)} A`).join(', ')}; phase ${cur[0].p} carried ${Math.round(((cur[0].v - cur[2].v) / Math.max(cur[0].v, 1)) * 100)} % more than phase ${cur[2].p}.`);
        if (resolution) facts.push(resolution);
        return { ...base, unit: '%', threshold: 15, facts, reading: 'site', phase: cur[0]?.p ?? null, crossed: value > 15,
            reading_text: 'Unbalance comes from how single-phase loads are spread across the phases on site. To verify: check which boards and loads sit on the heaviest phase.',
            headline: `${r(value)} % unbalance${cur.length === 3 ? `, phase ${cur[0].p} heaviest` : ''}` };
    }

    // pf
    const kwAtX = n(rows[iX].kw);
    facts.push(`Lowest power factor: ${r(value, 2)} at ${sastClock(tX)} SAST${kwAtX != null ? `, at ${Math.round(kwAtX)} kW` : ''}.`);
    const low = rows.filter((x) => (n(x.kw) ?? 0) > 0 && n(x.pf) != null && Math.abs(n(x.pf)!) < 0.85);
    facts.push(`Below 0.85 in ${low.length} of the ${rows.length} readings shown.`);
    if (resolution) facts.push(resolution);
    return { ...base, unit: 'PF', threshold: 0.85, facts, reading: 'site', crossed: value < 0.85,
        reading_text: 'Power factor is set by the equipment on site (motors, lightly loaded transformers, a correction bank that is off or too small). To verify: check whether a correction bank exists and whether its steps were switched in at this time.',
        headline: `Power factor ${r(value, 2)}${kwAtX != null ? ` at ${Math.round(kwAtX)} kW` : ''}` };
}

function corr(a: (number | null)[], b: (number | null)[]): number | null {
    const pairs = a.map((x, i) => [x, b[i]] as const).filter(([x, y]) => x != null && y != null) as [number, number][];
    if (pairs.length < 6) return null;
    const mx = pairs.reduce((s, [x]) => s + x, 0) / pairs.length, my = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Keep the worst candidates that are at least `apartMs` from one already kept. */
export function spread<T extends { t: number }>(cands: T[], limit: number, apartMs = 30 * 60_000): T[] {
    const out: T[] = [];
    for (const c of cands) { if (out.every((o) => Math.abs(o.t - c.t) >= apartMs)) out.push(c); if (out.length >= limit) break; }
    return out;
}
