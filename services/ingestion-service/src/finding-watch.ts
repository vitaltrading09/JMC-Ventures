// ─────────────────────────────────────────────────────────────────────────────
// Finding watches: "Start investigating" starts a watch of the finding's
// condition at its measurement point (migration 1793860000000_finding-watches).
//
//   start      PATCH /recommendations/:id/case with status "investigating"
//              (investigate.ts) → startWatch: until the due date (end of that
//              SAST day) or WATCH_DEFAULT_DAYS, at least a day, never past the
//              assessment end.
//   daily      runWatches (jobs role, every 15 min): each SAST day of the watch,
//              once its aggregates have settled, gets a one-line note.
//   conclusion at the end: a verdict (persists | intermittent | not_seen |
//              insufficient) and a five-section note. Written from the
//              measurements; with an AI provider (and budget left) the model
//              rewrites it from the same evidence and may not add numbers. Shown
//              to clients at once as an automated conclusion; staff may review it
//              and add a note. The owner and the client admins are emailed.
//
// The observation functions are pure and unit-tested (test/finding-watch.test.js).
// ─────────────────────────────────────────────────────────────────────────────

import type { Pool } from 'pg';
import { percentile } from './reports/dataset';
import { windowFacts, correlation, providerConfig, completeOnce, costCents } from './consultant';
import { enqueueEmail, appUrl } from './notify/email';

export const WATCH_DEFAULT_DAYS = 3;
export const SETTLE_MS = 30 * 60_000;            // 10-minute aggregates are final by then
const H = 3_600_000, DAY = 24 * H, SAST = 2 * H;
const THD_V_MAX = 8, PF_MIN = 0.85, UNBALANCE_MAX = 15;

export type WatchKind = 'sags' | 'thd' | 'pf' | 'demand' | 'imbalance' | 'baseload' | 'general';

/** What a finding type is about, for the watch. */
export function kindFor(type: string): WatchKind {
    const t = String(type ?? '').toUpperCase();
    if (/SAG|DIP|UNDERVOLT|LOW_VOLT/.test(t)) return 'sags';
    if (/THD|HARMONIC|DISTORTION/.test(t)) return 'thd';
    if (/PF|POWER_FACTOR|REACTIVE/.test(t)) return 'pf';
    if (/MDI|DEMAND|PEAK/.test(t)) return 'demand';
    if (/IMBALANCE|UNBALANCE/.test(t)) return 'imbalance';
    if (/BASELOAD|BASE_LOAD|STANDBY|NIGHT/.test(t)) return 'baseload';
    return 'general';
}

const LABEL: Record<WatchKind, string> = {
    sags: 'voltage dips', thd: 'voltage distortion', pf: 'low power factor', demand: 'demand above the contracted limit',
    imbalance: 'uneven phase loading', baseload: 'high load outside working hours', general: 'the site load and supply',
};

/** End of the watch: the due date's SAST midnight, else the default; ≥ 1 day; ≤ the assessment end. */
export function watchUntil(now: Date, dueOn: string | null | undefined, endAt: Date): Date {
    let until = dueOn && /^\d{4}-\d{2}-\d{2}$/.test(dueOn)
        ? new Date(Date.parse(`${dueOn}T00:00:00Z`) - SAST + DAY)
        : new Date(now.getTime() + WATCH_DEFAULT_DAYS * DAY);
    if (until.getTime() < now.getTime() + DAY) until = new Date(now.getTime() + DAY);
    return new Date(Math.min(until.getTime(), endAt.getTime()));
}

/** SAST calendar days covering [from, to), each clipped to the window. */
export function daySegments(from: Date, to: Date): { day: string; from: Date; to: Date }[] {
    const out: { day: string; from: Date; to: Date }[] = [];
    const local = new Date(from.getTime() + SAST);
    let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - SAST;
    while (start < to.getTime()) {
        const end = start + DAY;
        const f = Math.max(start, from.getTime()), t = Math.min(end, to.getTime());
        if (t > f) out.push({ day: new Date(start + SAST).toISOString().slice(0, 10), from: new Date(f), to: new Date(t) });
        start = end;
    }
    return out;
}

const n = (v: any): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const r = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const sastTime = (iso: string | Date) => new Date(new Date(iso).getTime() + SAST).toISOString().slice(0, 16).replace('T', ' ');
const hourOf = (iso: string | Date) => new Date(new Date(iso).getTime() + SAST).getUTCHours();
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export interface WatchData {
    rows10m: any[];                                                  // point_readings_10m
    lows1m: { bucket: any; vmin: any; kw_max: any; kw_prev: any }[]; // minutes with a voltage below the dip level
    demand30m: { bucket: any; kva_demand: any }[];                   // point_readings_30m
    nominalV: number;
    mdiKva: number | null;
}

export interface Observation {
    kind: WatchKind;
    values: number;              // 10-minute values received
    expected: number;            // 10-minute values in the window
    seen: boolean;               // the condition showed in this window
    headline: string;            // one sentence
    facts: string[];             // bullets for the conclusion
    hours: number[];             // occurrences per SAST hour of day (24)
    metrics: Record<string, number | string | null>;
}

/** The hours of the day that hold most occurrences, as "06:00–08:00". */
export function busyHours(hours: number[]): string | null {
    const total = hours.reduce((s, x) => s + x, 0);
    if (!total) return null;
    let best = 0, at = 0;
    for (let i = 0; i < 24; i++) { const w = hours[i] + hours[(i + 1) % 24]; if (w > best) { best = w; at = i; } }
    if (best / total < 0.5) return null;
    const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
    return `${hh(at)}–${hh(at + 2)}`;
}

/** What the window shows for one kind of finding (pure). */
export function observe(kind: WatchKind, d: WatchData, from: Date, to: Date): Observation {
    const expected = Math.max(1, Math.round((to.getTime() - from.getTime()) / 600_000));
    const rows = d.rows10m;
    const hours = new Array(24).fill(0);
    const base = { kind, values: rows.length, expected, hours };
    if (!rows.length) return { ...base, seen: false, headline: 'No measurements were received.', facts: [], metrics: {} };
    const kw = rows.map((x) => n(x.power_active_total_avg));
    const peakKw = Math.max(0, ...rows.map((x) => n(x.power_active_total_max) ?? n(x.power_active_total_avg) ?? 0));

    if (kind === 'sags') {
        const level = 0.9 * d.nominalV;
        // Consecutive low minutes are one dip.
        const lows = d.lows1m.map((x) => ({ t: new Date(x.bucket).getTime(), v: n(x.vmin)!, step: (n(x.kw_max) ?? 0) - (n(x.kw_prev) ?? n(x.kw_max) ?? 0) }))
            .filter((x) => x.v != null && x.v > 23 && x.v < level).sort((a, b) => a.t - b.t);
        const dips: { t: number; end: number; v: number; step: number }[] = [];
        for (const x of lows) {
            const last = dips[dips.length - 1];
            if (last && x.t - last.end <= 2 * 60_000) { last.end = x.t; last.v = Math.min(last.v, x.v); last.step = Math.max(last.step, x.step); }
            else dips.push({ t: x.t, end: x.t, v: x.v, step: x.step });
        }
        const stepMin = Math.max(5, 0.1 * peakKw);
        const withStep = dips.filter((x) => x.step >= stepMin).length;
        for (const x of dips) hours[hourOf(new Date(x.t))]++;
        const low = dips.reduce((m, x) => (m && m.v <= x.v ? m : x), null as null | { t: number; v: number });
        const when = busyHours(hours);
        const seen = dips.length > 0;
        return {
            ...base, seen,
            headline: seen
                ? `${plural(dips.length, 'dip')} below ${Math.round(level)} V (lowest ${r(low!.v)} V at ${sastTime(new Date(low!.t)).slice(11)})${withStep ? `; ${withStep} of them came with a load step of ${Math.round(stepMin)} kW or more` : '; none came with a large load step'}.`
                : `No dips below ${Math.round(level)} V.`,
            facts: seen ? [
                `${plural(dips.length, 'dip')} below ${Math.round(level)} V (90 % of ${d.nominalV} V), lowest ${r(low!.v)} V on ${sastTime(new Date(low!.t))} SAST.`,
                `${withStep} of ${dips.length} started within a minute of the load rising by ${Math.round(stepMin)} kW or more (a large motor or other load starting).`,
                when ? `Most dips fell between ${when} SAST.` : 'The dips were spread through the day.',
            ] : [`The voltage stayed above ${Math.round(level)} V throughout (lowest 1-minute value in the window: ${r(Math.min(...rows.flatMap((x) => [n(x.voltage_a_min), n(x.voltage_b_min), n(x.voltage_c_min)]).filter((v): v is number => v != null && v > 23)))} V).`],
            metrics: { dips: dips.length, with_load_step: withStep, lowest_v: r(low?.v ?? null), level_v: Math.round(level), busy_hours: when },
        };
    }

    if (kind === 'thd') {
        const worst = rows.map((x) => { const v = [n(x.thd_voltage_a_avg), n(x.thd_voltage_b_avg), n(x.thd_voltage_c_avg)].filter((y): y is number => y != null); return v.length ? Math.max(...v) : null; });
        const vals = worst.filter((v): v is number => v != null);
        if (!vals.length) return { ...base, seen: false, headline: 'Voltage distortion was not measured.', facts: [], metrics: {} };
        let iMax = 0; worst.forEach((v, i) => { if (v != null && v > (worst[iMax] ?? -1)) iMax = i; });
        const above = worst.map((v, i) => (v != null && v > THD_V_MAX ? i : -1)).filter((i) => i >= 0);
        for (const i of above) hours[hourOf(rows[i].bucket)]++;
        const corr = r(correlation(kw, worst), 2);
        const when = busyHours(hours);
        const seen = above.length > 0;
        const link = corr != null && corr > 0.5 ? 'it rose and fell with the site load' : corr != null && corr < -0.5 ? 'it was highest when the site load was low' : null;
        return {
            ...base, seen,
            headline: seen
                ? `Distortion above ${THD_V_MAX} % in ${plural(above.length, 'ten-minute value')} (highest ${r(worst[iMax], 1)} % at ${sastTime(rows[iMax].bucket).slice(11)})${link ? `; ${link}` : ''}.`
                : `Distortion stayed at or below ${THD_V_MAX} % (highest ${r(worst[iMax], 1)} %).`,
            facts: [
                `Voltage distortion (worst phase) above ${THD_V_MAX} % in ${above.length} of ${vals.length} ten-minute values; 95th percentile ${r(percentile(vals, 95), 1)} %, highest ${r(worst[iMax], 1)} % on ${sastTime(rows[iMax].bucket)} SAST.`,
                ...(when ? [`The high values clustered between ${when} SAST.`] : []),
                ...(corr != null ? [`Correlation with the site load: r = ${corr}${link ? ` (${link})` : ' (no clear link)'}.`] : []),
            ],
            metrics: { above: above.length, values: vals.length, p95: r(percentile(vals, 95), 1), max: r(worst[iMax], 1), corr_kw: corr, busy_hours: when },
        };
    }

    if (kind === 'pf') {
        const loaded = rows.filter((x) => (n(x.power_active_total_avg) ?? 0) > 0.1 * peakKw && n(x.power_factor_total_avg) != null);
        if (!loaded.length) return { ...base, seen: false, headline: 'The site was not loaded enough to judge the power factor.', facts: [], metrics: {} };
        const pf = loaded.map((x) => Math.abs(n(x.power_factor_total_avg)!));
        const avg = pf.reduce((s, x) => s + x, 0) / pf.length;
        const low = loaded.filter((x) => Math.abs(n(x.power_factor_total_avg)!) < PF_MIN);
        for (const x of low) hours[hourOf(x.bucket)]++;
        const share = low.length / loaded.length;
        const seen = avg < PF_MIN || share > 0.1;
        const when = busyHours(hours);
        return {
            ...base, seen,
            headline: `Power factor while working averaged ${r(avg, 2)}; ${Math.round(share * 100)} % of the working time was below ${PF_MIN}.`,
            facts: [
                `Average power factor while the site was working: ${r(avg, 3)} (lowest ${r(Math.min(...pf), 3)}).`,
                `${Math.round(share * 100)} % of the loaded ten-minute values were below ${PF_MIN}${when ? `, mostly between ${when} SAST` : ''}.`,
            ],
            metrics: { pf_avg: r(avg, 3), pf_min: r(Math.min(...pf), 3), low_share: r(share, 2), busy_hours: when },
        };
    }

    if (kind === 'demand') {
        const dem = d.demand30m.map((x) => ({ t: x.bucket, v: n(x.kva_demand) })).filter((x): x is { t: any; v: number } => x.v != null);
        if (!dem.length) return { ...base, seen: false, headline: 'No complete 30-minute demand intervals.', facts: [], metrics: {} };
        const top = dem.reduce((m, x) => (x.v > m.v ? x : m));
        if (!d.mdiKva) return { ...base, seen: false, headline: `Highest 30-minute demand ${Math.round(top.v)} kVA at ${sastTime(top.t)}; no contracted limit is recorded.`, facts: [`Highest 30-minute demand: ${Math.round(top.v)} kVA on ${sastTime(top.t)} SAST. No contracted maximum demand is recorded for this point, so it cannot be compared.`], metrics: { max_kva: Math.round(top.v) } };
        const over = dem.filter((x) => x.v > d.mdiKva!);
        for (const x of over) hours[hourOf(x.t)]++;
        const when = busyHours(hours);
        const seen = over.length > 0;
        return {
            ...base, seen,
            headline: seen
                ? `${plural(over.length, 'half-hour')} above the ${Math.round(d.mdiKva)} kVA limit (highest ${Math.round(top.v)} kVA at ${sastTime(top.t).slice(11)}).`
                : `Demand stayed under the ${Math.round(d.mdiKva)} kVA limit (highest ${Math.round(top.v)} kVA, ${Math.round((top.v / d.mdiKva) * 100)} % of it).`,
            facts: [
                `${over.length} of ${dem.length} half-hour demand intervals above the contracted ${Math.round(d.mdiKva)} kVA; highest ${Math.round(top.v)} kVA on ${sastTime(top.t)} SAST.`,
                ...(when ? [`The intervals over the limit fell between ${when} SAST.`] : []),
            ],
            metrics: { over: over.length, intervals: dem.length, max_kva: Math.round(top.v), mdi_kva: d.mdiKva, busy_hours: when },
        };
    }

    if (kind === 'imbalance') {
        const u = rows.map((x) => ({ t: x.bucket, v: n(x.current_unbalance_avg) })).filter((x): x is { t: any; v: number } => x.v != null);
        if (!u.length) return { ...base, seen: false, headline: 'Current unbalance was not measured.', facts: [], metrics: {} };
        const high = u.filter((x) => x.v > UNBALANCE_MAX);
        for (const x of high) hours[hourOf(x.t)]++;
        const avg = u.reduce((s, x) => s + x.v, 0) / u.length;
        const share = high.length / u.length;
        const seen = share > 0.1;
        return {
            ...base, seen,
            headline: `Current unbalance averaged ${r(avg, 1)} %; above ${UNBALANCE_MAX} % for ${Math.round(share * 100)} % of the time.`,
            facts: [`Current unbalance averaged ${r(avg, 1)} % (highest ${r(Math.max(...u.map((x) => x.v)), 1)} %), above ${UNBALANCE_MAX} % in ${high.length} of ${u.length} ten-minute values.`],
            metrics: { avg: r(avg, 1), share_above: r(share, 2) },
        };
    }

    if (kind === 'baseload') {
        const at = rows.map((x) => ({ h: hourOf(x.bucket), dow: new Date(new Date(x.bucket).getTime() + SAST).getUTCDay(), kw: n(x.power_active_total_avg) }));
        const mean = (xs: (number | null)[]) => { const v = xs.filter((y): y is number => y != null); return v.length ? v.reduce((s, y) => s + y, 0) / v.length : null; };
        const night = mean(at.filter((x) => x.h < 5).map((x) => x.kw));
        const day = mean(at.filter((x) => x.h >= 9 && x.h < 16 && x.dow >= 1 && x.dow <= 5).map((x) => x.kw));
        if (night == null) return { ...base, seen: false, headline: 'No night-time values (00:00–05:00) in this window.', facts: [], metrics: {} };
        const ratio = day ? night / day : null;
        const seen = ratio != null && ratio > 0.6;
        return {
            ...base, seen,
            headline: `Night load (00:00–05:00) averaged ${Math.round(night)} kW${ratio != null ? `, ${Math.round(ratio * 100)} % of the weekday working-hours load` : ''}.`,
            facts: [`Average load 00:00–05:00 SAST: ${Math.round(night)} kW${day != null ? `; weekdays 09:00–16:00: ${Math.round(day)} kW` : ''}${ratio != null ? ` (night is ${Math.round(ratio * 100)} % of day)` : ''}.`],
            metrics: { night_kw: Math.round(night), day_kw: day != null ? Math.round(day) : null, ratio: r(ratio, 2) },
        };
    }

    const f = windowFacts(rows);
    return {
        ...base, seen: false,
        headline: `Load ${f.kw_min ?? '–'}–${f.kw_max ?? '–'} kW (average ${f.kw_avg ?? '–'} kW)${f.pf_loaded_avg != null ? `, power factor ${f.pf_loaded_avg}` : ''}.`,
        facts: [`Load ranged from ${f.kw_min ?? '–'} to ${f.kw_max ?? '–'} kW (average ${f.kw_avg ?? '–'} kW).`,
            ...(f.thd_v.length ? [`Highest voltage distortion: ${Math.max(...f.thd_v.map((x) => x.max ?? 0))} %.`] : []),
            ...(f.v_min.length ? [`Lowest voltage: ${Math.min(...f.v_min.map((x) => x.min ?? 999))} V.`] : [])],
        metrics: { kw_avg: f.kw_avg, kw_max: f.kw_max },
    };
}

export type Verdict = 'persists' | 'intermittent' | 'not_seen' | 'insufficient';

/** A day with at least half its expected values counts towards the verdict. */
export const usableDay = (d: { values: number; expected: number }) => d.values >= 0.5 * d.expected;

/** Overall verdict, judged on the days with enough data (days without data are not judged). */
export function verdictOf(whole: Observation, days: { seen: boolean; values: number; expected: number }[]): Verdict {
    const usable = days.filter(usableDay);
    if (!usable.length) return 'insufficient';
    const seenDays = usable.filter((d) => d.seen).length;
    if (seenDays === usable.length) return 'persists';
    return seenDays || whole.seen ? 'intermittent' : 'not_seen';
}

const MEANS: Record<WatchKind, string> = {
    sags: 'Dips below 90 % of nominal can stop drives and contactors and reset controllers. Dips that start with a large load are usually caused on site; dips without one usually come from the supply.',
    thd: 'Sustained distortion heats transformers, motors and neutral conductors and can upset sensitive electronics. Distortion that follows the site load is usually caused by equipment on site.',
    pf: 'A low power factor raises the current, and with it the cable and transformer loading and the kVA demand the utility bills.',
    demand: 'Each half-hour above the notified maximum demand can bring an excess-demand charge on the monthly bill.',
    imbalance: 'Uneven phase loading overloads the heaviest phase and the neutral, and limits how much the supply can carry.',
    baseload: 'Load that stays on outside working hours is paid for every night; part of it is often equipment nobody needs then.',
    general: 'The watch records how the site behaved while the finding was being investigated.',
};

/** The suggested next step, by kind and verdict. */
export function suggestion(kind: WatchKind, v: Verdict, o: Observation): string {
    if (v === 'insufficient') return 'Too little data arrived during the watch to judge. Check that the meter is online (Site details), then start the watch again.';
    if (v === 'not_seen') return `The ${LABEL[kind]} did not show during the watch. Keep the finding open until the end of the assessment, or close it as "no action needed" if the earlier cases match a known, one-off event.`;
    const m = o.metrics;
    switch (kind) {
        case 'sags':
            return Number(m.with_load_step) >= Number(m.dips) / 2
                ? 'Move to Action: check how the large motors that start at the dip times are started (direct-on-line, soft-starter settings) and whether sensitive equipment shares their supply.'
                : 'Move to Action: ask the utility for its supply records at the dip times and have the incomer connections and transformer tap checked; most dips did not line up with load starts on site.';
        case 'thd':
            return Number(m.corr_kw) < -0.5
                ? 'Raise it with the utility: distortion was highest when the site load was low, which points to the network rather than the site.'
                : 'Move to Action: list the drives, UPS units and LED lighting on this supply and have a contractor measure the harmonic currents per load before any filter is chosen.';
        case 'pf': return 'Move to Action: have an electrical contractor check the existing power-factor correction (steps, fuses, contactors) or quote for it; the low power factor held during working hours.';
        case 'demand': return 'Move to Action: stagger the large loads that start together in the peak half-hours, or review the notified maximum demand with the utility.';
        case 'imbalance': return 'Move to Action: have single-phase loads moved from the heaviest phase to the lightest at the distribution boards.';
        case 'baseload': return 'Move to Action: walk the site after hours, list what stays on (HVAC, compressors, lighting, IT) and agree a switch-off schedule.';
        default: return 'Review the daily notes with the consultant and decide on an action, or close the finding if nothing stood out.';
    }
}

/** The five-section conclusion assembled from the measurements. */
export function conclusionText(kind: WatchKind, v: Verdict, whole: Observation, notes: { day: string; headline: string; seen: boolean; values: number; expected: number }[], w: { point: string; from: Date; to: Date }): string {
    const usable = notes.filter(usableDay), days = usable.length, seenDays = usable.filter((x) => x.seen).length;
    const gaps = notes.length - days;
    const withData = gaps ? ' with enough data' : '';
    const short = {
        persists: `The ${LABEL[kind]} showed on every day of the watch${withData} (${plural(days, 'day')}).`,
        intermittent: `The ${LABEL[kind]} showed on ${seenDays} of ${plural(days, 'day')} of the watch${withData}.`,
        not_seen: `The ${LABEL[kind]} did not show on the ${plural(days, 'day')} of the watch${withData}.`,
        insufficient: `Too little data arrived during the watch to judge the ${LABEL[kind]}.`,
    }[v] + (gaps && v !== 'insufficient' ? ` ${plural(gaps, 'day')} had too little data to judge.` : '');
    // The day-by-day lines are shown with the conclusion (and given to the model), not repeated here.
    const shows = whole.facts.length ? whole.facts : [whole.headline];
    const basis = `${w.point}, ${sastTime(w.from)} to ${sastTime(w.to)} SAST: ${whole.values} of ${whole.expected} ten-minute values received. Automated conclusion from the measured data; links in time are correlations to verify on site.`;
    return [`### In short\n${short} ${whole.headline}`, `### What the data shows\n${shows.map((l) => `- ${l}`).join('\n')}`,
        `### What it means\n${MEANS[kind]}`, `### Suggested next step\n${suggestion(kind, v, whole)}`, `### Basis\n${basis}`].join('\n\n');
}

const WATCH_SYSTEM = `You are GridIQ's electrical metering consultant. A client asked GridIQ to watch one finding at their site for a few days while they investigate it. Write the closing note of that watch.
Rules:
- Use only the numbers in WATCH EVIDENCE. Never compute new figures or invent measurements. Times are SAST.
- Correlation is not cause: give causes as things to check on site, never as findings.
- No sizing of capacitor banks or filters, no rand estimates. Never instruct anyone to work on live equipment; recommend a qualified electrician or engineer.
- The finding text was written by an automated rule; the draft note is the measured-data version: keep its verdict and its numbers.
- Exactly these headings (markdown "### "), short bullets or one or two sentences under each:
  ### In short
  ### What the data shows
  ### What it means
  ### Suggested next step
  ### Basis
- At most about 220 words. No tables.`;

// ── Database side ───────────────────────────────────────────────────────────

/** Start a watch for a finding that moved to "investigating" (no-op if one runs). */
export async function startWatch(db: Pool, rec: { id: string; site_id: string; type: string; evidence: any }, userId: string | null, dueOn: string | null, now = new Date()) {
    const a = (await db.query(`
        SELECT id, end_at FROM assessments
        WHERE project_id = $1 AND status = 'active' AND closed_at IS NULL AND start_at <= $2 AND $2 < end_at
        ORDER BY start_at DESC LIMIT 1`, [rec.site_id, now])).rows[0];
    if (!a) return null;
    const pts = (await db.query(`
        SELECT mp.id, mp.role, mp.parent_point_id FROM assessment_points ap JOIN measurement_points mp ON mp.id = ap.measurement_point_id
        WHERE ap.assessment_id = $1`, [a.id])).rows;
    const wanted = rec.evidence?.measurement_point_id;
    const point = pts.find((p) => p.id === wanted) ?? pts.find((p) => p.role === 'incomer' && !p.parent_point_id) ?? pts[0];
    if (!point) return null;
    const until = watchUntil(now, dueOn, new Date(a.end_at));
    if (until.getTime() - now.getTime() < H) return null;
    const row = (await db.query(`
        INSERT INTO finding_watches (recommendation_id, assessment_id, measurement_point_id, kind, started_by, started_at, until_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING *`,
        [rec.id, a.id, point.id, kindFor(rec.type), userId, now, until])).rows[0];
    if (row) await db.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'finding_watch.start', 'recommendation', $2, $3)`,
        [userId, rec.id, JSON.stringify({ watch: row.id, until: until.toISOString(), point: point.id })]);
    return row ?? null;
}

async function loadData(db: Pool, w: any, from: Date, to: Date): Promise<WatchData> {
    const nominalV = Number(w.nominal_voltage_v) || 230;
    const rows10m = (await db.query(`
        SELECT bucket, power_active_total_avg, power_active_total_max, power_factor_total_avg,
               voltage_a_min, voltage_b_min, voltage_c_min,
               thd_voltage_a_avg, thd_voltage_b_avg, thd_voltage_c_avg, current_unbalance_avg
        FROM point_readings_10m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [w.measurement_point_id, from, to])).rows;
    const lows1m = w.kind === 'sags' ? (await db.query(`
        SELECT * FROM (
            SELECT bucket, LEAST(voltage_a_min, voltage_b_min, voltage_c_min) AS vmin, power_active_total_max AS kw_max,
                   lag(power_active_total_avg) OVER (ORDER BY bucket) AS kw_prev
            FROM point_readings_1m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3) x
        WHERE vmin > 23 AND vmin < $4 ORDER BY bucket LIMIT 5000`, [w.measurement_point_id, new Date(from.getTime() - 60_000), to, 0.9 * nominalV])).rows
        .filter((x) => new Date(x.bucket).getTime() >= from.getTime()) : [];
    const demand30m = w.kind === 'demand' ? (await db.query(`
        SELECT bucket, kva_demand FROM point_readings_30m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`,
        [w.measurement_point_id, from, to])).rows : [];
    return { rows10m, lows1m, demand30m, nominalV, mdiKva: w.contracted_mdi_kva != null ? Number(w.contracted_mdi_kva) : null };
}

const WATCH_SQL = `
    SELECT w.*, r.title, r.problem, r.type, r.site_id AS project_id, a.end_at, a.closed_at, a.status AS a_status, a.ai_budget_cents,
           mp.name AS point_name, mp.nominal_voltage_v, mp.contracted_mdi_kva
    FROM finding_watches w
    JOIN recommendations r ON r.id = w.recommendation_id
    JOIN assessments a ON a.id = w.assessment_id
    JOIN measurement_points mp ON mp.id = w.measurement_point_id`;

/** The end of a watch: its own end, the assessment end or its close, whichever is first. */
const endOf = (w: any) => new Date(Math.min(new Date(w.until_at).getTime(), new Date(w.end_at).getTime(), w.closed_at ? new Date(w.closed_at).getTime() : Infinity));

/** Add a note for each day of the watch up to `upTo` that has none (a day still running only when `partial`). */
async function fillNotes(db: Pool, w: any, upTo: Date, now: Date, partial: boolean) {
    const notes = [...((w.notes ?? []) as any[])];
    const have = new Set(notes.map((x) => x.day));
    let added = false;
    for (const seg of daySegments(new Date(w.started_at), upTo)) {
        if (have.has(seg.day)) continue;
        if (!partial && seg.to.getTime() + SETTLE_MS > now.getTime()) continue;
        const o = observe(w.kind, await loadData(db, w, seg.from, seg.to), seg.from, seg.to);
        notes.push({ day: seg.day, from: seg.from.toISOString(), to: seg.to.toISOString(), seen: o.seen, headline: o.headline, values: o.values, expected: o.expected });
        added = true;
    }
    if (added) {
        await db.query(`UPDATE finding_watches SET notes = $2 WHERE id = $1 AND status = 'watching'`, [w.id, JSON.stringify(notes)]);
        w.notes = notes;
    }
    return added;
}

/** Write the conclusion of one watch now (job, or staff "conclude now"). */
export async function concludeWatch(db: Pool, w: any, now = new Date()) {
    const from = new Date(w.started_at), to = new Date(Math.min(endOf(w).getTime(), now.getTime()));
    await fillNotes(db, w, to, now, true);
    const data = await loadData(db, w, from, to);
    const whole = observe(w.kind, data, from, to);
    const notes = (w.notes ?? []) as any[];
    const verdict = verdictOf(whole, notes);
    const win = { point: w.point_name, from, to };
    let text = conclusionText(w.kind, verdict, whole, notes, win);
    let provider = 'none', model: string | null = null;
    const cfg = providerConfig();
    if (cfg.provider !== 'none') {
        const spent = Number((await db.query(`SELECT COALESCE(sum(cost_cents), 0) AS c FROM ai_messages WHERE assessment_id = $1`, [w.assessment_id])).rows[0].c);
        if (spent < Number(w.ai_budget_cents ?? 0)) {
            try {
                const evidence = { finding: { title: w.title, text: w.problem }, watch: { point: w.point_name, from: sastTime(from), to: sastTime(to), verdict }, overall: whole, days: notes };
                const out = await completeOnce(cfg, WATCH_SYSTEM, `WATCH EVIDENCE (authoritative):\n${JSON.stringify(evidence)}\n\nDRAFT NOTE (measured-data version):\n${text}`);
                if (out.text && out.text.includes('### ')) {
                    text = out.text; provider = cfg.provider; model = out.model ?? cfg.model;
                    await db.query(`INSERT INTO ai_messages (assessment_id, user_id, role, content, provider, model, input_tokens, output_tokens, cost_cents)
                                    VALUES ($1, NULL, 'assistant', $2, $3, $4, $5, $6, $7)`, [w.assessment_id, text, provider, model, out.in, out.out, costCents(model, out.in, out.out)]);
                }
            } catch (e: any) { console.error('[watch] model failed, using the measured-data note:', e?.message ?? e); }
        }
    }
    const conclusion = { text, verdict, provider, model, generated_at: now.toISOString(), observation: whole };
    const row = (await db.query(`UPDATE finding_watches SET status = 'concluded', conclusion = $2, concluded_at = $3 WHERE id = $1 AND status = 'watching' RETURNING *`,
        [w.id, JSON.stringify(conclusion), now])).rows[0];
    if (!row) return null;
    await db.query(`INSERT INTO audit_log (action, entity_type, entity_id, after) VALUES ('finding_watch.conclude', 'recommendation', $1, $2)`,
        [w.recommendation_id, JSON.stringify({ watch: w.id, verdict, provider })]);
    // The person who started it and the client admins with access to the assessment.
    const to_ = (await db.query(`
        SELECT DISTINCT lower(u.email) AS email FROM users u WHERE u.id = $2 AND u.email IS NOT NULL
        UNION
        SELECT DISTINCT g.email FROM assessment_grants g JOIN users u ON u.id = g.user_id OR lower(u.email) = g.email
        WHERE g.assessment_id = $1 AND g.revoked_at IS NULL AND u.role = 'client_admin'`, [w.assessment_id, w.started_by])).rows;
    const link = `${appUrl()}/portal/projects/${w.project_id}?view=finding&f=${w.recommendation_id}`;
    const inShort = text.split('### ')[1]?.replace(/^In short\s*/, '').trim() ?? '';
    for (const { email } of to_) {
        await enqueueEmail(db, {
            dedupeKey: `watch:${w.id}:${email}`, to: email, assessmentId: w.assessment_id, purpose: 'finding_watch',
            subject: `GridIQ: the watch on "${w.title}" has a conclusion`,
            text: `${inShort}\n\nThe full note, with the daily observations and the suggested next step:\n${link}\n\nThis is an automated conclusion from the measured data; GridIQ may add a review note.`,
        });
    }
    return row;
}

/** Jobs role: daily notes and conclusions for every running watch. */
export async function runWatches(db: Pool, now = new Date()): Promise<number> {
    let changed = 0;
    for (const w of (await db.query(`${WATCH_SQL} WHERE w.status = 'watching'`)).rows) {
        if (w.a_status === 'cancelled') {
            await db.query(`UPDATE finding_watches SET status = 'cancelled', cancelled_at = $2 WHERE id = $1`, [w.id, now]);
            changed++; continue;
        }
        const end = endOf(w);
        if (await fillNotes(db, w, end, now, false)) changed++;
        if (end.getTime() + SETTLE_MS <= now.getTime()) { if (await concludeWatch(db, w, now)) changed++; }
    }
    return changed;
}

/** One watch with what concludeWatch needs, for the staff "conclude now" route. */
export async function watchForConclusion(db: Pool, recommendationId: string) {
    return (await db.query(`${WATCH_SQL} WHERE w.recommendation_id = $1 AND w.status = 'watching'`, [recommendationId])).rows[0] ?? null;
}
