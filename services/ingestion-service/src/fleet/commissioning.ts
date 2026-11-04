// ─────────────────────────────────────────────────────────────────────────────
// Commissioning checklist for a new deployment (plan Phase 6, item 9).
//
// Evaluated by the jobs role every minute for the first 15 minutes after an
// install, over the raw readings since installed_at, and stored in
// deployments.commissioning. After 15 minutes the result is final.
//
// The checks use the deployment's corrections (power_sign, scale_correction),
// so a reversed CT fixed in the deployment passes the sign check.
// ─────────────────────────────────────────────────────────────────────────────

export const COMMISSIONING_WINDOW_MIN = 15;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'pending' | 'not_evaluated' | 'not_reported' | 'not_applicable';

export interface CommissioningCheck {
    id: string;
    label: string;
    status: CheckStatus;
    detail: string;
}

export interface Commissioning {
    evaluated_at: string;
    window_from: string;
    window_to: string;
    final: boolean;
    overall: 'pass' | 'warn' | 'fail' | 'pending';
    checks: CommissioningCheck[];
}

export interface CommissioningInput {
    now: Date;
    installedAt: Date;
    role: string;
    /** Phase-to-neutral nominal; 230 V when the point has none. */
    nominalV: number | null;
    ctPrimaryA: number | null;
    powerSign: number;
    scale: number;
    stats: {
        total: number;
        deviceSourced: number;
        minutesWithData: number;
        /** Median per-minute freshest |ingested_at − device_time| (s); null without device times. */
        driftS: number | null;
        vA: number | null; vB: number | null; vC: number | null;
        /** Raw (uncorrected) averages / maxima from the meter. */
        pAvgKw: number | null;
        pfAvg: number | null;
        currentAvgA: number | null;
        currentMaxA: number | null;
    };
}

const DRIFT_MAX_S = 5;
const COVERAGE_MIN = 0.95;
const V_TOLERANCE = 0.10;
/** "Under load": highest-phase current ≥ 5 % of CT primary (1 A without a CT primary). */
const LOAD_FRACTION_OF_CT = 0.05;
const LOAD_MIN_A = 1;
/** Roles whose active power is positive in normal operation (after power_sign). */
const POSITIVE_ROLES = new Set(['incomer', 'sub_load', 'pv']);

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function evaluateCommissioning(inp: CommissioningInput): Commissioning {
    const s = inp.stats;
    const windowEnd = new Date(Math.min(inp.now.getTime(), inp.installedAt.getTime() + COMMISSIONING_WINDOW_MIN * 60_000));
    const final = inp.now.getTime() >= inp.installedAt.getTime() + COMMISSIONING_WINDOW_MIN * 60_000;
    const elapsedMin = Math.max(1, Math.floor((windowEnd.getTime() - inp.installedAt.getTime()) / 60_000));
    const noData = s.total === 0;
    // Waiting for data: pending while the window runs, a failure once it is over.
    const waiting = (detail: string): Pick<CommissioningCheck, 'status' | 'detail'> =>
        ({ status: final ? 'fail' : 'pending', detail });
    // Needs load to judge: pending, then not_evaluated (not a failure).
    const needsLoad = (detail: string): Pick<CommissioningCheck, 'status' | 'detail'> =>
        ({ status: final ? 'not_evaluated' : 'pending', detail });

    const checks: CommissioningCheck[] = [];
    const add = (id: string, label: string, r: Pick<CommissioningCheck, 'status' | 'detail'>) =>
        checks.push({ id, label, ...r });

    // 1. Device timestamps
    add('time_source', 'Readings carry the meter\'s own timestamp (time_source DEVICE)',
        noData ? waiting('No readings yet')
            : s.deviceSourced / s.total >= COVERAGE_MIN
                ? { status: 'pass', detail: `${s.deviceSourced} of ${s.total} readings` }
                : { status: 'fail', detail: `Only ${s.deviceSourced} of ${s.total} readings have a device time: check NTP and the payload timestamp` });

    // 2. Clock drift
    add('clock_drift', `Clock drift < ${DRIFT_MAX_S} s`,
        s.driftS === null ? waiting('No device timestamps yet')
            : s.driftS < DRIFT_MAX_S
                ? { status: 'pass', detail: `${round(s.driftS)} s` }
                : { status: 'fail', detail: `${round(s.driftS)} s: set NTP on the meter or comms module` });

    // 3. Phase voltages
    const nominal = inp.nominalV ?? 230;
    const phases: Array<[string, number | null]> = [['L1', s.vA], ['L2', s.vB], ['L3', s.vC]];
    if (noData) {
        add('voltages', `All three phase voltages present, within ±10 % of ${nominal} V`, waiting('No readings yet'));
    } else {
        const missing = phases.filter(([, v]) => v === null).map(([p]) => p);
        const off = phases.filter(([, v]) => v !== null && Math.abs(v - nominal) > nominal * V_TOLERANCE)
            .map(([p, v]) => `${p} ${round(v as number)} V`);
        const list = phases.map(([p, v]) => `${p} ${v === null ? '–' : round(v)} V`).join(', ');
        add('voltages', `All three phase voltages present, within ±10 % of ${nominal} V`,
            missing.length ? { status: 'fail', detail: `Missing ${missing.join(', ')} (${list})` }
                : off.length ? { status: 'fail', detail: `Out of range: ${off.join(', ')}. Check PT ratio and wiring, or the point's nominal voltage` }
                    : { status: 'pass', detail: list });
    }

    // 4. Phase rotation: no channel in the mapped payloads.
    add('phase_rotation', 'Phase rotation plausible', { status: 'not_reported', detail: 'The meter does not report phase sequence' });

    // Load, from the corrected current.
    const iAvg = s.currentAvgA === null ? null : s.currentAvgA * inp.scale;
    const loadThreshold = inp.ctPrimaryA ? inp.ctPrimaryA * LOAD_FRACTION_OF_CT : LOAD_MIN_A;
    const underLoad = iAvg !== null && iAvg >= loadThreshold;
    const noLoad = `No load yet (current below ${round(loadThreshold)} A)`;

    // 5. Power sign
    const p = s.pAvgKw === null ? null : s.pAvgKw * inp.powerSign * inp.scale;
    if (!POSITIVE_ROLES.has(inp.role)) {
        add('power_sign', 'Active power sign matches the point role',
            { status: 'not_applicable', detail: `A ${inp.role} point can import or export` });
    } else if (noData || p === null) {
        add('power_sign', 'Active power sign matches the point role', waiting('No active power readings yet'));
    } else if (!underLoad) {
        add('power_sign', 'Active power sign matches the point role', needsLoad(noLoad));
    } else if (p > 0) {
        add('power_sign', 'Active power sign matches the point role', { status: 'pass', detail: `${round(p)} kW` });
    } else if (inp.role === 'incomer') {
        add('power_sign', 'Active power sign matches the point role',
            { status: 'warn', detail: `${round(p)} kW: the site is exporting, or the CT is reversed (set power_sign −1)` });
    } else {
        add('power_sign', 'Active power sign matches the point role',
            { status: 'fail', detail: `${round(p)} kW: CT reversed? Set power_sign −1 on the deployment` });
    }

    // 6. Power factor under load
    const pf = s.pfAvg === null ? null : Math.abs(s.pfAvg);
    add('power_factor', 'PF between 0.5 and 1.0 under load',
        noData || pf === null ? waiting('No power factor readings yet')
            : !underLoad ? needsLoad(noLoad)
                : pf >= 0.5 && pf <= 1.0 ? { status: 'pass', detail: `${round(pf, 2)}` }
                    : { status: 'fail', detail: `${round(pf, 2)}: check CT-to-phase mapping` });

    // 7. Current below CT primary
    const iMax = s.currentMaxA === null ? null : s.currentMaxA * inp.scale;
    add('current_vs_ct', 'Current below the CT primary rating',
        !inp.ctPrimaryA ? { status: 'not_applicable', detail: 'CT primary not set on the point' }
            : noData || iMax === null ? waiting('No current readings yet')
                : iMax < inp.ctPrimaryA ? { status: 'pass', detail: `max ${round(iMax)} A of ${inp.ctPrimaryA} A` }
                    : { status: 'fail', detail: `max ${round(iMax)} A ≥ CT primary ${inp.ctPrimaryA} A: check the CT ratio` });

    // 8. Coverage
    const coverage = s.minutesWithData / elapsedMin;
    add('coverage', 'Coverage ≥ 95 %',
        noData ? waiting('No readings yet')
            : coverage >= COVERAGE_MIN ? { status: 'pass', detail: `${s.minutesWithData} of ${elapsedMin} minutes` }
                : final ? { status: 'fail', detail: `${s.minutesWithData} of ${elapsedMin} minutes: check signal and the reporting interval` }
                    : { status: 'pending', detail: `${s.minutesWithData} of ${elapsedMin} minutes so far` });

    const has = (st: CheckStatus) => checks.some((c) => c.status === st);
    const overall = has('fail') ? 'fail' : has('pending') ? 'pending' : has('warn') ? 'warn' : 'pass';
    return {
        evaluated_at: inp.now.toISOString(),
        window_from: inp.installedAt.toISOString(),
        window_to: windowEnd.toISOString(),
        final,
        overall,
        checks,
    };
}

// ── Database side (jobs role) ───────────────────────────────────────────────

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/** Evaluates every deployment still inside (or just past) its window and not yet final. */
export async function runCommissioning(db: Queryable, now = new Date()): Promise<number> {
    const due = await db.query(`
        SELECT d.id, d.device_id, d.installed_at, d.power_sign, d.scale_correction,
               p.role, p.nominal_voltage_v, p.ct_primary_a
        FROM deployments d JOIN measurement_points p ON p.id = d.measurement_point_id
        WHERE d.removed_at IS NULL
          AND d.created_at >= $1::timestamptz - INTERVAL '1 day'
          AND d.installed_at <= $1::timestamptz
          AND COALESCE((d.commissioning->>'final')::boolean, false) = false`, [now]);
    for (const d of due.rows) {
        const result = evaluateCommissioning({
            now,
            installedAt: new Date(d.installed_at),
            role: d.role,
            nominalV: num(d.nominal_voltage_v),
            ctPrimaryA: num(d.ct_primary_a),
            powerSign: Number(d.power_sign),
            scale: Number(d.scale_correction),
            stats: await commissioningStats(db, d.device_id, new Date(d.installed_at), now),
        });
        await db.query(`UPDATE deployments SET commissioning = $2 WHERE id = $1`, [d.id, JSON.stringify(result)]);
    }
    return due.rows.length;
}

async function commissioningStats(db: Queryable, deviceId: string, from: Date, now: Date): Promise<CommissioningInput['stats']> {
    const to = new Date(Math.min(now.getTime(), from.getTime() + COMMISSIONING_WINDOW_MIN * 60_000));
    const r = await db.query(`
        WITH w AS (
            SELECT * FROM meter_readings WHERE meter_id = $1 AND time >= $2 AND time < $3
        ), lag AS (
            SELECT date_trunc('minute', ingested_at) AS minute,
                   min(abs(extract(epoch FROM ingested_at - device_time))) AS lag_s
            FROM w WHERE device_time IS NOT NULL GROUP BY 1
        )
        SELECT count(*) AS total,
               count(*) FILTER (WHERE time_source = 'DEVICE') AS device_n,
               count(DISTINCT date_trunc('minute', time)) AS minutes,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_s) FROM lag) AS drift_s,
               avg(voltage_a) AS va, avg(voltage_b) AS vb, avg(voltage_c) AS vc,
               avg(power_active_total) AS p, avg(power_factor_total) AS pf,
               avg(GREATEST(current_a, current_b, current_c)) AS i_avg,
               max(GREATEST(current_a, current_b, current_c)) AS i_max
        FROM w`, [deviceId, from, to]);
    const x = r.rows[0];
    return {
        total: Number(x.total), deviceSourced: Number(x.device_n), minutesWithData: Number(x.minutes),
        driftS: num(x.drift_s), vA: num(x.va), vB: num(x.vb), vC: num(x.vc),
        pAvgKw: num(x.p), pfAvg: num(x.pf), currentAvgA: num(x.i_avg), currentMaxA: num(x.i_max),
    };
}
