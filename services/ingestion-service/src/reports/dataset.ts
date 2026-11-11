// ─────────────────────────────────────────────────────────────────────────────
// The assessment dataset (prompt section 11): ONE structured, deterministic
// result per assessment and data cutoff. The report HTML/PDF, the export
// manifest, the portal's deliverables and the consultant all read this, so
// they cannot disagree. Once a report revision is issued its dataset is
// frozen in the database (trigger reports_freeze_issued).
//
// Every number states its basis. Observations, derived indicators, rule
// findings, possible causes and recommended verification are kept apart.
// Nothing is estimated that one net meter cannot measure (PV production,
// battery state, equipment-level loads), and no harmonic order is invented
// from THD.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import type { Pool } from 'pg';
import { loadPointEnergy } from '../fleet/balance';

export const SCHEMA = 'gridiq.assessment-dataset/1';
export const CALC_VERSION = 'gridiq-calc-2026.11.1';
export const RULE_VERSION = 'gridiq-rules-2026.11.1';
export const TEMPLATE_VERSION = 'gridiq-templates-2026.11.1';

/** NRS 048-2 screening thresholds (the basis is stated with every use). */
export const SCREENING = {
    source: 'NRS 048-2 (screening thresholds; formal compliance needs a Class A instrument, one full week and ≥ 95 % valid 10-minute values)',
    voltage_tolerance: 0.10, thd_v_pct: 8, pf_min: 0.85, f_low: 49, f_high: 51, interruption_v: 23,
};

const SAST_MS = 2 * 3_600_000;
const r = (v: number | null | undefined, d = 1): number | null =>
    v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/** Canonical JSON (sorted keys) and its SHA-256: the dataset's identity. */
export function canonical(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v instanceof Date ? v.toISOString() : v);
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** p-th percentile (0–100) of numbers, linear interpolation; null when empty. */
export function percentile(values: number[], p: number): number | null {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const i = (p / 100) * (v.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

export type Severity = 'act' | 'investigate' | 'note';
export interface ExecItem { severity: Severity; point: string; text: string; evidence: string; confidence: 'high' | 'medium' | 'low'; who: string }

interface PointPQ {
    nominal_v: number;
    voltage: { phase: string; min: number | null; max: number | null; p05: number | null; p95: number | null; outside_pct: number | null; values: number }[];
    thd_v: { phase: string; p95: number | null; max: number | null; over_limit_pct: number | null; worst_hours: number[] }[] | null;
    thd_i: { phase: string; p95: number | null; max: number | null }[] | null;
    pf: { avg_loaded: number | null; p05: number | null; share_below_min: number | null } | null;
    unbalance: { voltage_p95: number | null; current_p95: number | null; metric: string };
    frequency: { min: number | null; max: number | null; outside_values: number };
    interruption_minutes: number;
    events: { count: number; source: string; capability: string; list: any[] };
    harmonic_orders: { available: boolean; reason: string };
    verdict: { type: 'screening' | 'formal'; reason: string };
}

/** Plain-language executive items from the computed numbers, most significant first. */
export function executiveItems(points: any[]): ExecItem[] {
    const out: ExecItem[] = [];
    for (const p of points) {
        const pq: PointPQ | null = p.power_quality;
        const name = p.name;
        if (p.coverage.fraction !== null && p.coverage.fraction < 0.8) {
            out.push({ severity: 'investigate', point: name, confidence: 'high', who: 'GridIQ',
                text: `Only ${Math.round(p.coverage.fraction * 100)} % of the expected measurements were received; conclusions for this point are limited.`,
                evidence: 'coverage' });
        }
        const d = p.demand;
        if (d.max_kva !== null && d.contracted_mdi_kva) {
            const u = d.max_kva / d.contracted_mdi_kva;
            if (u > 1) out.push({ severity: 'act', point: name, confidence: 'high', who: 'site / energy manager',
                text: `Billed demand reached ${r(d.max_kva)} kVA, ${Math.round((u - 1) * 100)} % above the contracted ${d.contracted_mdi_kva} kVA, in ${d.intervals_over_mdi} half-hour interval(s). Exceeding the notified demand normally attracts penalty charges.`,
                evidence: 'demand' });
            else if (u > 0.9) out.push({ severity: 'investigate', point: name, confidence: 'high', who: 'site / energy manager',
                text: `Billed demand peaked at ${Math.round(u * 100)} % of the contracted ${d.contracted_mdi_kva} kVA: little headroom.`, evidence: 'demand' });
        }
        if (pq?.pf?.avg_loaded !== null && pq?.pf?.avg_loaded !== undefined && pq.pf.avg_loaded < SCREENING.pf_min) {
            out.push({ severity: 'act', point: name, confidence: 'high', who: 'electrical contractor',
                text: `Average power factor while loaded was ${pq.pf.avg_loaded}. Low PF raises kVA demand and reactive charges; it is not by itself a supply-quality breach. Check the PF-correction equipment before sizing anything new.`,
                evidence: 'power_quality.pf' });
        }
        for (const t of pq?.thd_v ?? []) {
            if (t.p95 !== null && t.p95 > SCREENING.thd_v_pct) {
                out.push({ severity: 'act', point: name, confidence: 'medium', who: 'electrical engineer',
                    text: `Voltage THD on phase ${t.phase} exceeded ${SCREENING.thd_v_pct} % (95th percentile ${t.p95} %), worst around ${t.worst_hours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}. Individual harmonic orders were not recorded, so the source cannot be identified from this data.`,
                    evidence: 'power_quality.thd_v' });
                break;
            }
        }
        for (const v of pq?.voltage ?? []) {
            if (v.outside_pct !== null && v.outside_pct > 5) {
                out.push({ severity: 'investigate', point: name, confidence: 'medium', who: 'electrical engineer / supply authority',
                    text: `Phase ${v.phase} voltage was outside ±10 % of ${pq!.nominal_v} V in ${v.outside_pct} % of 10-minute values (range ${v.min}–${v.max} V). Whether the cause is the supply or the site's own load needs the measurement location and transformer data.`,
                    evidence: 'power_quality.voltage' });
                break;
            }
        }
        if (pq && pq.unbalance.current_p95 !== null && pq.unbalance.current_p95 > 15) {
            out.push({ severity: 'investigate', point: name, confidence: 'medium', who: 'electrical contractor',
                text: `Current unbalance reached ${pq.unbalance.current_p95} % (95th percentile, ${pq.unbalance.metric}). Rebalancing single-phase loads usually helps.`,
                evidence: 'power_quality.unbalance' });
        }
        if (pq && pq.interruption_minutes > 0) {
            out.push({ severity: 'investigate', point: name, confidence: 'medium', who: 'site',
                text: `Voltage was below ${SCREENING.interruption_v} V for ${pq.interruption_minutes} minute(s) (supply interruptions or the meter losing its reference).`,
                evidence: 'power_quality.interruptions' });
        }
        if (p.patterns.baseload_ratio !== null && p.patterns.baseload_ratio > 0.6) {
            out.push({ severity: 'note', point: name, confidence: 'medium', who: 'site',
                text: `Outside operating hours the load stays at ${Math.round(p.patterns.baseload_ratio * 100)} % of the operating-hours average. If the site is not meant to run around the clock, look for equipment left on.`,
                evidence: 'patterns' });
        }
    }
    const rank: Record<Severity, number> = { act: 0, investigate: 1, note: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Formal standards verdict only when method, instrument, duration and completeness allow it. */
export function verdictFor(capability: any, days: number, coverage: number | null): { type: 'screening' | 'formal'; reason: string } {
    const cls = String(capability?.iec_61000_4_30_class ?? '').toUpperCase();
    if (cls !== 'A') return { type: 'screening', reason: 'The meter is not confirmed as an IEC 61000-4-30 Class A instrument; values are screened against NRS 048-2 thresholds, not certified.' };
    if (days < 7) return { type: 'screening', reason: `Observed ${r(days, 1)} days; NRS 048-2 assessment needs at least one full week.` };
    if (coverage === null || coverage < 0.95) return { type: 'screening', reason: 'Fewer than 95 % of the 10-minute values are valid.' };
    return { type: 'formal', reason: 'Class A instrument, ≥ 7 days, ≥ 95 % valid 10-minute values.' };
}

/** Build the dataset for an assessment, up to a data cutoff (≤ its effective end). */
export async function buildAssessmentDataset(db: Pool, assessmentId: string, cutoff: Date, opts: { provisional?: boolean } = {}) {
    const a = (await db.query(`
        SELECT a.*, p.name AS project_name, p.address, p.site_context, p.gps_lat, p.gps_lon, t.name AS client_name,
               pk.name AS package_name, LEAST(a.end_at, COALESCE(a.closed_at, a.end_at)) AS effective_end
        FROM assessments a JOIN projects p ON p.id = a.project_id JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN assessment_packages pk ON pk.id = a.package_id
        WHERE a.id = $1`, [assessmentId])).rows[0];
    if (!a) throw new Error('assessment not found');
    if (!a.start_at) throw new Error('assessment has not started');
    const from = new Date(a.start_at);
    const to = new Date(Math.min(new Date(a.effective_end).getTime(), cutoff.getTime()));
    const days = Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);
    const ctx = a.site_context ?? {};

    const pts = (await db.query(`
        SELECT mp.id, mp.name, mp.role, mp.parent_point_id, mp.nominal_voltage_v, mp.ct_primary_a,
               COALESCE(mp.contracted_mdi_kva, ss.contracted_mdi_kva) AS mdi
        FROM assessment_points ap JOIN measurement_points mp ON mp.id = ap.measurement_point_id
        LEFT JOIN site_settings ss ON ss.site_id = mp.project_id
        WHERE ap.assessment_id = $1 ORDER BY mp.sort_order, mp.name`, [assessmentId])).rows;

    const points = [];
    for (const pt of pts) points.push(await pointSection(db, pt, from, to, days, ctx));

    // Site totals: topology-aware. Only top-level incomers are summed; sub-loads
    // are never added to their incomer (that would double count).
    const top = points.filter((p) => p.role === 'incomer' && !p.parent_point_id);
    const site_totals = top.length ? {
        basis: `sum of ${top.length} top-level incomer(s); sub-meters are inside these and are not added`,
        import_kwh: r(top.reduce((s, p) => s + (p.energy.import_kwh ?? 0), 0), 1),
        export_kwh: r(top.reduce((s, p) => s + (p.energy.export_kwh ?? 0), 0), 1),
        // Coincident demand across incomers needs a common interval; reported per point only.
        demand_note: 'Maximum demand is reported per point; non-coincident maxima are never added.',
    } : { basis: 'no top-level incomer is metered: no site total is stated', import_kwh: null, export_kwh: null };

    const executive = executiveItems(points);
    const limitations: string[] = [
        `Observation period ${r(days, 1)} days (${from.toISOString()} to ${to.toISOString()}); results describe this period only. No annual figure is extrapolated.`,
        'One-second RMS trends cannot prove that no sub-second disturbance occurred; events listed are inferred from sampled trends unless marked device-recorded.',
        'A single net grid meter cannot separate PV production, battery behaviour or individual equipment loads.',
    ];
    for (const p of points) {
        if (p.coverage.fraction !== null && p.coverage.fraction < 0.95) limitations.push(`${p.name}: ${Math.round(p.coverage.fraction * 100)} % of expected measurements received (${p.coverage.gaps.length} gap(s) of 30 min or more).`);
        if (!p.capability.confirmed) limitations.push(`${p.name}: the meter's capability profile is not confirmed; only channels present in the data are reported.`);
    }
    if (opts.provisional) limitations.unshift('PROVISIONAL: the assessment is still running; these results cover the elapsed period only and are not final.');

    const missing: string[] = [];
    if (!ctx.operating_hours) missing.push('declared operating hours (default 06:00–18:00 weekdays used)');
    if (!ctx.supply) missing.push('supply details and tariff');
    if (!ctx.generation) missing.push('existing PV / generator / battery details');
    if (!ctx.fault_level) missing.push('fault level at the point of supply');
    if (days < 28) missing.push('a full month or more of data (seasonal and monthly patterns)');

    return {
        schema: SCHEMA,
        provisional: !!opts.provisional,
        versions: { calc: CALC_VERSION, rules: RULE_VERSION, template: TEMPLATE_VERSION },
        data_cutoff_at: cutoff.toISOString(),
        assessment: {
            id: a.id, reference: a.reference, title: a.title, client: a.client_name, site: a.project_name, address: a.address,
            coordinates: a.gps_lat !== null ? { lat: a.gps_lat, lon: a.gps_lon, source: 'recorded installation location' } : null,
            package: a.package_name, duration_days: a.duration_days, timezone: a.timezone,
            start_at: from.toISOString(), end_at: new Date(a.effective_end).toISOString(),
            period_from: from.toISOString(), period_to: to.toISOString(), observed_days: r(days, 2),
        },
        site_context: ctx,
        conventions: {
            time: 'UTC ISO 8601 in the data; site-local (SAST, UTC+2) in the report text',
            intervals: '[start, end): a value at bucket B covers B ≤ t < B + interval',
            sign: 'import positive; the deployment sign correction is applied',
            screening: SCREENING,
        },
        points,
        site_totals,
        executive,
        limitations,
        feasibility_readiness: {
            supplied: ['30-minute interval load profile (kW, kVA)', 'daily energy', 'billed maximum demand with timestamps', 'power-quality screening results', 'metering topology and observation limits'],
            missing,
            note: 'GridIQ supplies measured data; system sizing and financial modelling belong to the feasibility study.',
        },
    };
}

async function pointSection(db: Pool, pt: any, from: Date, to: Date, days: number, ctx: any) {
    const id = pt.id;
    const deps = (await db.query(`
        SELECT d.installed_at, d.removed_at, d.power_sign, d.scale_correction, dv.code, dv.model, dv.capability_profile
        FROM deployments d JOIN devices dv ON dv.id = d.device_id
        WHERE d.measurement_point_id = $1 AND d.installed_at < $3 AND (d.removed_at IS NULL OR d.removed_at > $2)
        ORDER BY d.installed_at`, [id, from, to])).rows;
    const caps = deps.reduce((acc: any, d: any) => ({ ...acc, ...(d.capability_profile ?? {}) }), {});
    const confirmed = Object.keys(caps).length > 0;

    // Coverage at the box's own cadence (sparse boxes are not penalised).
    const cov = (await db.query(`
        SELECT COALESCE(sum(n), 0)::bigint AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t_last - t_first) / NULLIF(n - 1, 0)) AS spacing
        FROM point_readings_1h WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3`, [id, from, to])).rows[0];
    const spacing = Math.max(1, Number(cov.spacing) || 60);
    const windowS = (to.getTime() - from.getTime()) / 1000;
    const fraction = windowS > 0 ? Math.min(1, (Number(cov.n) * spacing) / windowS) : null;
    const tenRows = (await db.query(`
        SELECT bucket, voltage_a_avg, voltage_b_avg, voltage_c_avg, voltage_a_min, voltage_b_min, voltage_c_min,
               voltage_a_max, voltage_b_max, voltage_c_max,
               thd_voltage_a_avg, thd_voltage_b_avg, thd_voltage_c_avg, thd_current_a_avg, thd_current_b_avg, thd_current_c_avg,
               voltage_unbalance_avg, current_unbalance_avg, power_factor_total_avg, power_active_total_avg,
               frequency_min, frequency_max, n_interrupt
        FROM point_readings_10m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [id, from, to])).rows;
    // Gaps of 30 min or more (missing 10-minute values).
    const gaps: { from: string; to: string }[] = [];
    let prev = from.getTime();
    for (const row of [...tenRows, { bucket: to }]) {
        const t = new Date(row.bucket).getTime();
        if (t - prev >= 30 * 60_000 + 10 * 60_000 - 1) gaps.push({ from: new Date(prev).toISOString(), to: new Date(t).toISOString() });
        prev = t + 10 * 60_000;
    }

    const energy = await loadPointEnergy(db, id, from, to);

    // Daily energy and peaks (SAST days), from hourly values.
    const daily = (await db.query(`
        SELECT (bucket AT TIME ZONE 'Africa/Johannesburg')::date AS day,
               max(power_active_total_max) AS max_kw, min(power_active_total_min) AS min_kw,
               sum(power_active_total_avg * LEAST(1, n::float8 * $4 / 3600)) AS kwh_integrated,
               sum(n) AS n
        FROM point_readings_1h WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
        GROUP BY 1 ORDER BY 1`, [id, from, to, spacing])).rows.map((x) => ({
            date: String(x.day instanceof Date ? x.day.toISOString().slice(0, 10) : x.day).slice(0, 10),
            max_kw: r(num(x.max_kw)), min_kw: r(num(x.min_kw)),
            kwh_estimate: r(num(x.kwh_integrated)),
        }));

    // Billed demand: 30-minute intervals, covered by minutes or by sample span.
    const iv = (await db.query(`
        SELECT bucket, kva_demand, kw_demand FROM point_readings_30m
        WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
          AND (minutes >= 24 OR extract(epoch FROM t_last - t_first) >= 1350)
        ORDER BY kva_demand DESC NULLS LAST`, [id, from, to])).rows;
    const mdi = num(pt.mdi);
    const max = iv[0] ?? null;
    const inst = (await db.query(`
        SELECT bucket, power_active_total_max AS kw FROM point_readings_1m
        WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND power_active_total_max IS NOT NULL
        ORDER BY power_active_total_max DESC LIMIT 1`, [id, from, to])).rows[0] ?? null;

    // Operating patterns: declared hours if parseable ("HH:MM–HH:MM"), else 06–18 weekdays.
    const hours = parseHours(ctx.operating_hours);
    const hourly = (await db.query(`
        SELECT extract(isodow FROM bucket AT TIME ZONE 'Africa/Johannesburg')::int AS dow,
               extract(hour FROM bucket AT TIME ZONE 'Africa/Johannesburg')::int AS h,
               avg(power_active_total_avg) AS kw
        FROM point_readings_1h WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND power_active_total_avg IS NOT NULL
        GROUP BY 1, 2`, [id, from, to])).rows;
    const prof = (weekend: boolean) => Array.from({ length: 24 }, (_, h) => {
        const v = hourly.filter((x) => (x.dow >= 6) === weekend && x.h === h).map((x) => Number(x.kw));
        return v.length ? r(v.reduce((s, x) => s + x, 0) / v.length) : null;
    });
    const wk = prof(false), we = prof(true);
    const inHours = wk.filter((_, h) => h >= hours.from && h < hours.to).filter((x): x is number => x !== null);
    const outHours = [...wk.filter((_, h) => h < hours.from || h >= hours.to), ...we].filter((x): x is number => x !== null);
    const avg = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
    const dayAvg = avg(inHours), nightAvg = avg(outHours);
    const kws = tenRows.map((x) => num(x.power_active_total_avg)).filter((x): x is number => x !== null);

    // Power quality from 10-minute values.
    const nominal = num(pt.nominal_voltage_v) ?? 230;
    const lo = nominal * (1 - SCREENING.voltage_tolerance), hi = nominal * (1 + SCREENING.voltage_tolerance);
    const phases = ['a', 'b', 'c'];
    const voltage = phases.map((ph) => {
        const avgs = tenRows.map((x) => num(x[`voltage_${ph}_avg`])).filter((x): x is number => x !== null && x >= SCREENING.interruption_v);
        if (!avgs.length) return null;
        const mins = tenRows.map((x) => num(x[`voltage_${ph}_min`])).filter((x): x is number => x !== null && x >= SCREENING.interruption_v);
        const maxs = tenRows.map((x) => num(x[`voltage_${ph}_max`])).filter((x): x is number => x !== null);
        return { phase: ph.toUpperCase(), min: r(Math.min(...mins)), max: r(Math.max(...maxs)), p05: r(percentile(avgs, 5)), p95: r(percentile(avgs, 95)),
                 outside_pct: r((avgs.filter((v) => v < lo || v > hi).length / avgs.length) * 100), values: avgs.length };
    }).filter(Boolean) as PointPQ['voltage'];
    const thdV = phases.map((ph) => {
        const vals = tenRows.map((x) => ({ t: new Date(x.bucket), v: num(x[`thd_voltage_${ph}_avg`]) })).filter((x) => x.v !== null) as { t: Date; v: number }[];
        if (!vals.length) return null;
        const byHour = new Map<number, number[]>();
        for (const x of vals) { const h = new Date(x.t.getTime() + SAST_MS).getUTCHours(); byHour.set(h, [...(byHour.get(h) ?? []), x.v]); }
        const worst = Array.from(byHour.entries()).map(([h, v]) => [h, avg(v)!] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h).sort((a, b) => a - b);
        const v = vals.map((x) => x.v);
        return { phase: ph.toUpperCase(), p95: r(percentile(v, 95), 2), max: r(Math.max(...v), 2),
                 over_limit_pct: r((v.filter((x) => x > SCREENING.thd_v_pct).length / v.length) * 100), worst_hours: worst };
    }).filter(Boolean) as NonNullable<PointPQ['thd_v']>;
    const thdI = phases.map((ph) => {
        const v = tenRows.map((x) => num(x[`thd_current_${ph}_avg`])).filter((x): x is number => x !== null);
        return v.length ? { phase: ph.toUpperCase(), p95: r(percentile(v, 95), 2), max: r(Math.max(...v), 2) } : null;
    }).filter(Boolean) as NonNullable<PointPQ['thd_i']>;
    const pfLoaded = tenRows.filter((x) => num(x.power_factor_total_avg) !== null && (num(x.power_active_total_avg) ?? 0) > 0)
        .map((x) => Math.abs(num(x.power_factor_total_avg)!));
    const fmins = tenRows.map((x) => num(x.frequency_min)).filter((x): x is number => x !== null && x > 0);
    const fmaxs = tenRows.map((x) => num(x.frequency_max)).filter((x): x is number => x !== null && x > 0);
    const interruptions = (await db.query(`
        SELECT count(*)::int AS n FROM point_readings_1m
        WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND n_interrupt > 0`, [id, from, to])).rows[0].n;
    const events = (await db.query(`
        SELECT e.type, e.channel AS phase, e.started_at, e.ended_at, e.duration_s, e.extreme_value
        FROM pq_events e JOIN deployments d ON d.device_id = e.meter_id
        WHERE d.measurement_point_id = $1 AND e.started_at >= GREATEST($2, d.installed_at)
          AND e.started_at < LEAST($3, COALESCE(d.removed_at, 'infinity'::timestamptz))
        ORDER BY e.started_at LIMIT 200`, [id, from, to])).rows;
    const tenCoverage = tenRows.length / Math.max(1, Math.floor(windowS / 600));

    const power_quality: PointPQ = {
        nominal_v: nominal,
        voltage,
        thd_v: thdV.length ? thdV : null,
        thd_i: thdI.length ? thdI : null,
        pf: pfLoaded.length ? { avg_loaded: r(avg(pfLoaded), 3), p05: r(percentile(pfLoaded, 5), 3), share_below_min: r(pfLoaded.filter((x) => x < SCREENING.pf_min).length / pfLoaded.length, 3) } : null,
        unbalance: {
            voltage_p95: r(percentile(tenRows.map((x) => num(x.voltage_unbalance_avg)).filter((x): x is number => x !== null), 95), 2),
            current_p95: r(percentile(tenRows.map((x) => num(x.current_unbalance_avg)).filter((x): x is number => x !== null), 95), 2),
            metric: 'unbalance as computed by the meter (per its configuration); not stated to be negative-sequence unbalance',
        },
        frequency: { min: fmins.length ? r(Math.min(...fmins), 2) : null, max: fmaxs.length ? r(Math.max(...fmaxs), 2) : null,
                     outside_values: tenRows.filter((x) => (num(x.frequency_min) ?? 50) < SCREENING.f_low || (num(x.frequency_max) ?? 50) > SCREENING.f_high).length },
        interruption_minutes: interruptions,
        events: {
            count: events.length,
            source: caps.events ? 'device-recorded events where present; otherwise inferred from the 1-second RMS trend' : 'inferred from the sampled RMS trend (pq_events), not device-recorded',
            capability: caps.events ? 'device events confirmed in the capability profile' : 'device event/waveform capture not confirmed: transient and sub-second claims are not made',
            list: events.slice(0, 50).map((e: any) => ({ type: e.type, phase: e.phase, started_at: e.started_at, duration_s: num(e.duration_s), extreme: num(e.extreme_value) })),
        },
        harmonic_orders: Array.isArray(caps.harmonic_orders) && caps.harmonic_orders.length
            ? { available: false, reason: `The meter is configured for orders ${caps.harmonic_orders.join(', ')}, but individual orders are not yet ingested: only THD is reported.` }
            : { available: false, reason: 'Individual harmonic orders were not recorded (THD only). No spectrum is shown or inferred. To identify harmonic sources, log individual orders (e.g. 3, 5, 7, 11, 13) per phase.' },
        verdict: verdictFor(caps, days, tenCoverage),
    };

    // Compact hourly series for the report charts (same values the portal charts read).
    const h1 = (await db.query(`
        SELECT bucket, power_active_total_avg AS kw, voltage_a_avg AS va, voltage_b_avg AS vb, voltage_c_avg AS vc,
               thd_voltage_a_avg AS ta, thd_voltage_b_avg AS tb, thd_voltage_c_avg AS tc, power_factor_total_avg AS pf
        FROM point_readings_1h WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [id, from, to])).rows;
    const col = (k: string, d = 1) => h1.map((x) => r(num(x[k]), d));
    const hourly_series = { basis: 'hourly averages (point_readings_1h), UTC bucket start; gaps are absent hours, never zero',
        t: h1.map((x) => new Date(x.bucket).toISOString()), kw: col('kw'), v_a: col('va'), v_b: col('vb'), v_c: col('vc'),
        thd_v_a: col('ta', 2), thd_v_b: col('tb', 2), thd_v_c: col('tc', 2), pf: col('pf', 3) };

    const findings = (await db.query(`
        SELECT r.type, r.title, r.priority, r.problem, r.solution, r.evidence, r.review_status, r.created_at
        FROM recommendations r JOIN deployments d ON d.device_id = r.meter_id
        WHERE d.measurement_point_id = $1 AND r.status = 'ACTIVE' AND r.review_status <> 'dismissed'
          AND r.created_at >= $2::timestamptz - INTERVAL '1 day' AND r.created_at < $3::timestamptz + INTERVAL '3 hours'
        ORDER BY r.priority, r.created_at`, [id, from, to])).rows.map((f) => ({
            type: f.type, title: f.title, priority: f.priority, review_status: f.review_status,
            observed: f.problem, recommended_verification: f.solution, evidence: f.evidence?.values ?? null,
            engine: f.evidence?.engine ?? 'ai',
        }));

    return {
        id, name: pt.name, role: pt.role, parent_point_id: pt.parent_point_id,
        nominal_voltage_v: nominal, ct_primary_a: num(pt.ct_primary_a), contracted_mdi_kva: mdi,
        deployments: deps.map((d) => ({ device: d.code, model: d.model, installed_at: d.installed_at, removed_at: d.removed_at,
            sign: d.power_sign, scale: Number(d.scale_correction) })),
        capability: { confirmed, profile: caps,
            channels_present: { thd_v: thdV.length > 0, thd_i: thdI.length > 0, unbalance: tenRows.some((x) => x.voltage_unbalance_avg !== null), frequency: fmins.length > 0 } },
        coverage: { fraction: r(fraction, 3), samples: Number(cov.n), median_spacing_s: r(spacing, 1), ten_minute_values: tenRows.length,
                    gaps: gaps.slice(0, 50), basis: 'samples received × the box’s median reporting interval ÷ the observation window' },
        energy: { import_kwh: r(energy.importKwh, 1), export_kwh: r(energy.exportKwh, 1), method: energy.method ?? 'register', coverage: r(energy.coverage, 3),
                  basis: 'kWh registers per deployment (resets never summed through); power-integrated only where registers are absent' },
        daily,
        demand: {
            max_kva: max ? r(num(max.kva_demand)) : null, max_kva_at: max?.bucket ?? null, max_kw: max ? r(num(max.kw_demand)) : null,
            contracted_mdi_kva: mdi, utilisation: mdi && max ? r(num(max.kva_demand)! / mdi, 3) : null,
            intervals_assessed: iv.length, intervals_over_mdi: mdi ? iv.filter((x) => num(x.kva_demand)! > mdi).length : 0,
            top: iv.slice(0, 5).map((x) => ({ at: x.bucket, kva: r(num(x.kva_demand)), kw: r(num(x.kw_demand)) })),
            basis: '30-minute minute-weighted kVA (billing basis); intervals with ≥ 80 % of minutes or samples spanning ≥ 22.5 min',
        },
        instantaneous: { max_kw: inst ? r(num(inst.kw)) : null, at: inst?.bucket ?? null,
                         basis: 'highest active-power value inside any minute; not a billed demand' },
        patterns: {
            operating_hours: hours,
            weekday_kw_by_hour: wk, weekend_kw_by_hour: we,
            operating_avg_kw: r(dayAvg), outside_avg_kw: r(nightAvg),
            baseload_kw: r(percentile(kws, 10)),
            baseload_ratio: dayAvg && nightAvg !== null && dayAvg > 0 ? r(nightAvg / dayAvg, 3) : null,
            basis: `hourly averages, SAST; operating hours ${hours.declared ? 'as declared' : 'assumed'} ${hours.from}:00–${hours.to}:00 weekdays`,
        },
        power_quality,
        hourly_series,
        findings,
    };
}

/** "06:00–18:00" (or 6-18) from the declared operating hours; default weekdays 06–18. */
export function parseHours(v: unknown): { from: number; to: number; declared: boolean } {
    const m = /(\d{1,2})(?::\d{2})?\s*[–-]\s*(\d{1,2})(?::\d{2})?/.exec(String(v ?? ''));
    if (m) {
        const f = Number(m[1]), t = Number(m[2]);
        if (f >= 0 && f < 24 && t > f && t <= 24) return { from: f, to: t, declared: true };
    }
    return { from: 6, to: 18, declared: false };
}
