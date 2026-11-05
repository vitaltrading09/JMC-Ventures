// Rule-based findings: drafts from measured data, no AI provider needed.
//
// The jobs role runs this every hour for every point with a box installed. It
// reads the last 7 days of the corrected point views (10-minute values, the
// NRS 048-2 basis, and 30-minute billed demand) and writes one draft
// recommendation per point and rule, with the numbers it used as evidence.
//
// Lifecycle per (device, rule):
//   - fires, no row yet (or the last one was superseded)  -> insert a draft;
//   - fires, a draft / in-review row exists               -> refresh its numbers;
//   - fires, a published row exists                       -> leave it (the reviewer owns it);
//   - fires, dismissed in the last 30 days                -> leave it (respect the reviewer);
//   - no longer fires and the row is still a draft        -> supersede it (condition cleared).
// Rows are recommendations with type RULE_* and evidence.engine = 'rules'.

import type { Pool } from 'pg';

export const WINDOW_DAYS = 7;
const MIN_HOURS = 24;              // less data than this: no verdict
const PF_MIN = 0.85;               // NRS 048-2 / utility minimum (CLAUDE.md)
const PF_TARGET = 0.95;            // what a correction bank is usually sized for
const THD_V_MAX = 8;               // % NRS 048-2
const CURRENT_UNBALANCE_MAX = 15;  // %, sustained: a load-balancing matter, not a standard limit
const SAG_FRACTION = 0.9;          // below 90 % of nominal (207 V at 230 V)
const BASELOAD_RATIO = 0.6;        // night load / working-day load
const AVG_TARIFF_ZAR_KWH = 2.5;    // CLAUDE.md key constant, for savings estimates

/** What the rules read for one point over the window. Null = not measured. */
export interface PointMetrics {
    hours: number;                    // metered hours in the window
    pf_avg_loaded: number | null;     // mean |PF| of 10-min values while loaded (kW > 10 % of the peak)
    pf_low_share: number | null;      // share of loaded 10-min values below 0.85
    kva_peak_10m: number | null;      // highest 10-min apparent power
    thd_v_p95: number | null;         // 95th percentile of 10-min THD-V, worst phase (%)
    thd_v_phase: string | null;
    current_unbalance_avg: number | null; // % mean of 10-min values
    v_nominal: number;                // phase-to-neutral, V
    v_min: number | null;             // lowest voltage seen in a 10-min window (any phase)
    sag_intervals: number;            // 10-min windows with a minimum below 90 % of nominal
    demand_max_kva: number | null;    // highest 30-min billed demand (>= 80 % covered)
    demand_over: number;              // 30-min intervals above the contracted MDI
    mdi_kva: number | null;           // contracted notified maximum demand
    tariff_demand: number | null;     // R/kVA/month, from site settings
    night_kw: number | null;          // mean kW 00:00-05:00 SAST, weekdays
    day_kw: number | null;            // mean kW 09:00-16:00 SAST, weekdays
}

export interface RuleFinding {
    type: string;            // RULE_*
    priority: 1 | 2 | 3;     // 1 = act now
    title: string;
    problem: string;
    solution: string;
    saving_zar: number;      // monthly, 0 = not estimated
    standard_reference: string | null;
    values: Record<string, number | string | null>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** The rules, on numbers only (unit-tested). */
export function evaluateRules(m: PointMetrics): RuleFinding[] {
    if (m.hours < MIN_HOURS) return [];
    const out: RuleFinding[] = [];
    const basis = `last ${WINDOW_DAYS} days, ${r1(m.hours)} h metered`;

    // Power factor
    if (m.pf_avg_loaded !== null && (m.pf_avg_loaded < 0.9 || (m.pf_low_share ?? 0) > 0.2)) {
        const pf = m.pf_avg_loaded;
        const kvaNow = m.demand_max_kva ?? m.kva_peak_10m;
        const kvaAfter = kvaNow !== null && pf < PF_TARGET ? kvaNow * pf / PF_TARGET : null;
        const saving = kvaNow !== null && kvaAfter !== null && m.tariff_demand ? (kvaNow - kvaAfter) * m.tariff_demand : 0;
        out.push({
            type: 'RULE_LOW_PF',
            priority: pf < PF_MIN ? 1 : 2,
            title: `Low power factor (${r2(pf)} average while loaded)`,
            problem: `The average power factor while the site was loaded was ${r2(pf)}`
                + (m.pf_low_share !== null ? `, and ${pct(m.pf_low_share)} of loaded 10-minute intervals were below ${PF_MIN}` : '')
                + ` (${basis}). Reactive current raises the kVA the utility bills and loads cables and transformers.`,
            solution: `Have power factor correction (a capacitor bank, detuned if harmonics are present) sized for about ${PF_TARGET}.`
                + (kvaNow !== null && kvaAfter !== null ? ` At ${PF_TARGET} the same load would need about ${Math.round(kvaAfter)} kVA instead of ${Math.round(kvaNow)} kVA.` : ''),
            saving_zar: Math.round(saving),
            standard_reference: 'NRS 048-2 / utility PF minimum 0.85',
            values: { pf_avg_loaded: r2(pf), pf_low_share: m.pf_low_share === null ? null : r2(m.pf_low_share), kva_now: kvaNow === null ? null : Math.round(kvaNow), kva_at_target: kvaAfter === null ? null : Math.round(kvaAfter) },
        });
    }

    // Voltage harmonics
    if (m.thd_v_p95 !== null && m.thd_v_p95 > THD_V_MAX) {
        out.push({
            type: 'RULE_HIGH_THD_V',
            priority: 1,
            title: `Voltage distortion above the NRS 048-2 limit (THD ${r1(m.thd_v_p95)} %)`,
            problem: `The 95th percentile of 10-minute voltage THD was ${r1(m.thd_v_p95)} %${m.thd_v_phase ? ` on phase ${m.thd_v_phase}` : ''}, above the ${THD_V_MAX} % limit (${basis}). Distortion overheats motors and transformers and can trip sensitive equipment.`,
            solution: 'Identify the main harmonic sources (VSDs, UPSs, LED drivers, rectifiers) with a harmonic survey, then consider active or passive filtering. Any capacitor bank on this supply should be detuned.',
            saving_zar: 0,
            standard_reference: 'NRS 048-2: voltage THD 8 %',
            values: { thd_v_p95: r1(m.thd_v_p95), phase: m.thd_v_phase },
        });
    }

    // Phase current imbalance
    if (m.current_unbalance_avg !== null && m.current_unbalance_avg > CURRENT_UNBALANCE_MAX) {
        out.push({
            type: 'RULE_CURRENT_IMBALANCE',
            priority: 2,
            title: `Phase currents out of balance (${r1(m.current_unbalance_avg)} % average)`,
            problem: `Current unbalance averaged ${r1(m.current_unbalance_avg)} % across 10-minute values (${basis}). One phase carries noticeably more load, which heats that phase's cables and breaker, raises neutral current and limits usable capacity.`,
            solution: 'Redistribute single-phase loads across the three phases at the distribution boards, starting with the most loaded phase.',
            saving_zar: 0,
            standard_reference: null,
            values: { current_unbalance_avg: r1(m.current_unbalance_avg) },
        });
    }

    // Maximum demand
    if (m.mdi_kva !== null && m.demand_max_kva !== null && m.demand_over > 0) {
        const excess = m.demand_max_kva - m.mdi_kva;
        out.push({
            type: 'RULE_MDI_EXCEEDED',
            priority: 1,
            title: `Maximum demand exceeded (${Math.round(m.demand_max_kva)} kVA vs ${Math.round(m.mdi_kva)} kVA contracted)`,
            problem: `Billed demand went above the contracted ${Math.round(m.mdi_kva)} kVA in ${m.demand_over} half-hour interval${m.demand_over === 1 ? '' : 's'}, peaking at ${Math.round(m.demand_max_kva)} kVA (${basis}, 30-minute demand). Utilities charge excess-demand penalties and may raise the contracted MDI.`,
            solution: 'Look at what runs during the peak half-hours and stagger large loads (compressors, ovens, chillers, pumps). Power factor correction also lowers kVA. If the peaks are structural, review the contracted MDI with the utility.',
            saving_zar: m.tariff_demand ? Math.round(excess * m.tariff_demand) : 0,
            standard_reference: null,
            values: { demand_max_kva: Math.round(m.demand_max_kva), mdi_kva: Math.round(m.mdi_kva), intervals_over: m.demand_over },
        });
    }

    // Voltage dips
    if (m.sag_intervals > 0 && m.v_min !== null) {
        out.push({
            type: 'RULE_VOLTAGE_SAGS',
            priority: m.sag_intervals > 6 ? 1 : 2,
            title: `Voltage dips below ${Math.round(m.v_nominal * SAG_FRACTION)} V (${m.sag_intervals} ten-minute windows)`,
            problem: `The voltage fell below ${Math.round(m.v_nominal * SAG_FRACTION)} V (90 % of ${Math.round(m.v_nominal)} V) in ${m.sag_intervals} ten-minute window${m.sag_intervals === 1 ? '' : 's'}; the lowest was ${r1(m.v_min)} V (${basis}). Dips stop drives and contactors and reset controllers.`,
            solution: 'Check whether the dips line up with large motor starts on site (then consider soft starters or VSDs) or come from the utility supply (then log them with the utility). Ride-through (UPS or DC bus support) protects critical loads.',
            saving_zar: 0,
            standard_reference: 'NRS 048-2: voltage 207-253 V',
            values: { sag_windows: m.sag_intervals, v_min: r1(m.v_min), v_nominal: m.v_nominal },
        });
    }

    // After-hours baseload
    if (m.night_kw !== null && m.day_kw !== null && m.day_kw > 5 && m.night_kw / m.day_kw > BASELOAD_RATIO) {
        const ratio = m.night_kw / m.day_kw;
        const avoidable = Math.max(0, m.night_kw - 0.3 * m.day_kw);
        out.push({
            type: 'RULE_HIGH_BASELOAD',
            priority: 3,
            title: `High after-hours load (${Math.round(ratio * 100)} % of the working-day load)`,
            problem: `On weekdays the site drew ${r1(m.night_kw)} kW on average between 00:00 and 05:00 SAST, ${Math.round(ratio * 100)} % of the ${r1(m.day_kw)} kW it drew between 09:00 and 16:00 (${basis}).`,
            // Only a saving if the site is not meant to run around the clock (a data centre, cold
            // store or 24/7 plant is), so the estimate is stated as conditional in the text.
            solution: `If the site is not meant to run around the clock, walk it after hours: lighting, HVAC, compressors and equipment left on are the usual causes, and timers or building-management schedules often recover most of it. Bringing the night load down to 30 % of the day load would save roughly R ${Math.round(avoidable * 5 * 22 * AVG_TARIFF_ZAR_KWH).toLocaleString('en-ZA')} a month (00:00-05:00 on weekdays only, at R ${AVG_TARIFF_ZAR_KWH}/kWh). For a 24/7 operation this is expected and can be dismissed.`,
            saving_zar: 0,
            standard_reference: null,
            values: { night_kw: r1(m.night_kw), day_kw: r1(m.day_kw), ratio: r2(ratio) },
        });
    }
    return out;
}

const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

/** The metrics for one point over [from, to). */
export async function loadPointMetrics(db: Pool, pointId: string, from: Date, to: Date): Promise<PointMetrics> {
    const m = (await db.query(`
        WITH w AS (
            SELECT * FROM point_readings_10m
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
        ), pk AS (SELECT max(power_active_total_avg) AS kw_max FROM w),
        loaded AS (SELECT w.* FROM w, pk WHERE pk.kw_max > 0 AND w.power_active_total_avg > 0.1 * pk.kw_max)
        SELECT
            (SELECT COALESCE(sum(minutes), 0) / 60.0 FROM w) AS hours,
            (SELECT avg(abs(power_factor_total_avg)) FROM loaded) AS pf_avg_loaded,
            (SELECT avg((abs(power_factor_total_avg) < ${PF_MIN})::int) FROM loaded WHERE power_factor_total_avg IS NOT NULL) AS pf_low_share,
            (SELECT max(power_apparent_total_avg) FROM w) AS kva_peak_10m,
            (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY thd_voltage_a_avg) FROM w) AS thd_a,
            (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY thd_voltage_b_avg) FROM w) AS thd_b,
            (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY thd_voltage_c_avg) FROM w) AS thd_c,
            (SELECT avg(current_unbalance_avg) FROM w) AS current_unbalance_avg,
            (SELECT min(LEAST(voltage_a_min, voltage_b_min, voltage_c_min)) FROM w) AS v_min,
            (SELECT avg(power_active_total_avg) FROM w
              WHERE extract(isodow FROM bucket AT TIME ZONE 'Africa/Johannesburg') <= 5
                AND extract(hour FROM bucket AT TIME ZONE 'Africa/Johannesburg') < 5) AS night_kw,
            (SELECT avg(power_active_total_avg) FROM w
              WHERE extract(isodow FROM bucket AT TIME ZONE 'Africa/Johannesburg') <= 5
                AND extract(hour FROM bucket AT TIME ZONE 'Africa/Johannesburg') BETWEEN 9 AND 15) AS day_kw
    `, [pointId, from, to])).rows[0];

    const pt = (await db.query(`
        SELECT mp.nominal_voltage_v, COALESCE(mp.contracted_mdi_kva, ss.contracted_mdi_kva) AS mdi, ss.tariff_demand
        FROM measurement_points mp LEFT JOIN site_settings ss ON ss.site_id = mp.project_id
        WHERE mp.id = $1`, [pointId])).rows[0] ?? {};
    const vNominal = num(pt.nominal_voltage_v) ?? 230;
    const mdi = num(pt.mdi);

    const sags = (await db.query(`
        SELECT count(*)::int AS n FROM point_readings_10m
        WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
          AND LEAST(voltage_a_min, voltage_b_min, voltage_c_min) < $4
          AND LEAST(voltage_a_min, voltage_b_min, voltage_c_min) >= 23`,   // below 23 V is an interruption, not a dip
        [pointId, from, to, vNominal * SAG_FRACTION])).rows[0].n;

    const d = (await db.query(`
        SELECT max(kva_demand) AS max_kva, count(*) FILTER (WHERE $4::numeric IS NOT NULL AND kva_demand > $4::numeric)::int AS over
        FROM point_readings_30m
        WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
          -- Covered: 80 % of the minutes have samples, or the samples span 22.5 of the
          -- 30 minutes (sparse boxes, e.g. one reading every 5 minutes).
          AND (minutes >= 24 OR extract(epoch FROM t_last - t_first) >= 1350)`,
        [pointId, from, to, mdi])).rows[0];

    const thd = [['A', num(m.thd_a)], ['B', num(m.thd_b)], ['C', num(m.thd_c)]]
        .filter(([, v]) => v !== null) as [string, number][];
    const worst = thd.sort((a, b) => b[1] - a[1])[0];
    return {
        hours: Number(m.hours),
        pf_avg_loaded: num(m.pf_avg_loaded),
        pf_low_share: num(m.pf_low_share),
        kva_peak_10m: num(m.kva_peak_10m),
        thd_v_p95: worst ? worst[1] : null,
        thd_v_phase: worst ? worst[0] : null,
        current_unbalance_avg: num(m.current_unbalance_avg),
        v_nominal: vNominal,
        v_min: num(m.v_min),
        sag_intervals: Number(sags),
        demand_max_kva: num(d.max_kva),
        demand_over: Number(d.over),
        mdi_kva: mdi,
        tariff_demand: num(pt.tariff_demand),
        night_kw: num(m.night_kw),
        day_kw: num(m.day_kw),
    };
}

/** One pass over every installed point. Returns counts for the log. */
export async function runRuleFindings(db: Pool, now = new Date()) {
    const to = now;
    const from = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
    const points = (await db.query(`
        SELECT d.measurement_point_id AS point_id, d.device_id, mp.project_id, p.tenant_id
        FROM deployments d
        JOIN measurement_points mp ON mp.id = d.measurement_point_id AND mp.archived_at IS NULL
        JOIN projects p ON p.id = mp.project_id AND p.archived_at IS NULL
        WHERE d.removed_at IS NULL`)).rows;
    const counts = { points: points.length, inserted: 0, refreshed: 0, cleared: 0 };
    for (const pt of points) {
        const metrics = await loadPointMetrics(db, pt.point_id, from, to);
        const found = evaluateRules(metrics);
        const firing = new Set(found.map((f) => f.type));
        for (const f of found) {
            const evidence = JSON.stringify({
                engine: 'rules', site_id: pt.project_id, meter_id: pt.device_id, measurement_point_id: pt.point_id,
                from: from.toISOString(), to: to.toISOString(), metric: f.type,
                calculation: `findings-rules: ${WINDOW_DAYS}-day point_readings_10m / point_readings_30m (corrected, per deployment window)`,
                values: f.values, chart: { meter_id: pt.device_id, days: WINDOW_DAYS },
            });
            const last = (await db.query(`
                SELECT id, review_status, reviewed_at, created_at FROM recommendations
                WHERE meter_id = $1 AND type = $2 AND status = 'ACTIVE'
                ORDER BY created_at DESC LIMIT 1`, [pt.device_id, f.type])).rows[0];
            if (last && (last.review_status === 'published')) continue;
            if (last && last.review_status === 'dismissed'
                && new Date(last.reviewed_at ?? last.created_at).getTime() > now.getTime() - 30 * 86_400_000) continue;
            if (last && (last.review_status === 'draft' || last.review_status === 'in_review')) {
                await db.query(`
                    UPDATE recommendations SET priority = $2, title = $3, problem = $4, solution = $5,
                        estimated_monthly_saving_zar = $6, standard_reference = $7, evidence = $8
                    WHERE id = $1`,
                    [last.id, f.priority, f.title, f.problem, f.solution, f.saving_zar, f.standard_reference, evidence]);
                counts.refreshed++;
                continue;
            }
            await db.query(`
                INSERT INTO recommendations (site_id, meter_id, tenant_id, type, priority, title, problem, solution,
                    estimated_monthly_saving_zar, confidence, standard_reference, status, review_status, evidence)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'HIGH', $10, 'ACTIVE', 'draft', $11)`,
                [pt.project_id, pt.device_id, pt.tenant_id, f.type, f.priority, f.title, f.problem, f.solution,
                 f.saving_zar, f.standard_reference, evidence]);
            counts.inserted++;
        }
        // A draft whose condition has cleared is no longer a finding.
        const cleared = await db.query(`
            UPDATE recommendations SET status = 'SUPERSEDED'
            WHERE meter_id = $1 AND type LIKE 'RULE\\_%' AND status = 'ACTIVE' AND review_status = 'draft'
              AND NOT (type = ANY($2::text[]))`, [pt.device_id, [...firing]]);
        counts.cleared += cleared.rowCount ?? 0;
    }
    return counts;
}
