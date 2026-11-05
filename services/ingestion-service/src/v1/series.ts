// ─────────────────────────────────────────────────────────────────────────────
// Point readings for the public API and exports (plan Phase 9, items 3–4).
//
// Conventions (also in every CSV header and in the OpenAPI spec):
//   - Timestamps are ISO 8601 UTC. Each row covers [period_start, period_end)
//     and is labelled by period_end ("period-ending", as South African utility
//     billing data is). Daily rows are South African calendar days.
//   - Units: V, A, kW, kvar, kVA, Hz, %, kWh. Sign: import / consumption
//     positive, after the deployment's power_sign (and scale correction).
//   - n = samples in the interval; coverage = n ÷ the samples expected at the
//     box's reporting interval (0–1).
//   - Energy per interval comes from the kWh registers: the step from the
//     previous interval's last register value (the first interval of a
//     deployment: its own last − first). A negative step is a register reset:
//     energy left empty and flagged, never summed through.
//   - flags: gap (coverage < 0.8), register_reset, correction_applied.
// Raw rows (interval=raw) are the stored readings, corrected the same way,
// with coverage 1 and no energy steps beyond the register values.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

export type Interval = 'raw' | '1m' | '15m' | '30m' | '1h' | '1d';
export const INTERVALS: Interval[] = ['raw', '1m', '15m', '30m', '1h', '1d'];
export const INTERVAL_SECONDS: Record<Interval, number> = { raw: 0, '1m': 60, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86_400 };
/** Longest range per request, by interval (days). */
export const MAX_RANGE_DAYS: Record<Interval, number> = { raw: 1, '1m': 31, '15m': 366, '30m': 366, '1h': 731, '1d': 3660 };
export const DATASET_VERSION = 1;

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export const COLUMNS = [
    'period_start', 'period_end', 'n', 'coverage',
    'voltage_a', 'voltage_b', 'voltage_c', 'current_a', 'current_b', 'current_c',
    'power_active_kw', 'power_active_kw_max', 'power_reactive_kvar', 'power_apparent_kva', 'power_factor',
    'frequency_hz', 'thd_voltage_a', 'thd_voltage_b', 'thd_voltage_c', 'thd_current_a', 'thd_current_b', 'thd_current_c',
    'energy_import_kwh', 'energy_export_kwh', 'flags',
] as const;
export type Row = Record<(typeof COLUMNS)[number], string | number | null>;

// Weighted average of an _avg column across finer buckets.
const wavg = (c: string) => `SUM(${c}_avg * n) / NULLIF(SUM(n) FILTER (WHERE ${c}_avg IS NOT NULL), 0)`;
const AVG = {
    voltage_a: 'voltage_a', voltage_b: 'voltage_b', voltage_c: 'voltage_c',
    current_a: 'current_a', current_b: 'current_b', current_c: 'current_c',
    power_active_kw: 'power_active_total', power_reactive_kvar: 'power_reactive_total',
    power_apparent_kva: 'power_apparent_total', power_factor: 'power_factor_total', frequency_hz: 'frequency',
    thd_voltage_a: 'thd_voltage_a', thd_voltage_b: 'thd_voltage_b', thd_voltage_c: 'thd_voltage_c',
    thd_current_a: 'thd_current_a', thd_current_b: 'thd_current_b', thd_current_c: 'thd_current_c',
};

/** SQL for the aggregate intervals: one row per (deployment, period start). $1 point, $2 from, $3 to. */
function aggregateSql(interval: Exclude<Interval, 'raw'>): string {
    // Source view, and the bucket expression over it.
    const [view, bucket] = {
        '1m': ['point_readings_1m', 'bucket'],
        '15m': ['point_readings_1m', `time_bucket('15 minutes', bucket)`],
        '30m': ['point_readings_30m', 'bucket'],
        '1h': ['point_readings_1h', 'bucket'],
        // South African calendar days, from the hourly view.
        '1d': ['point_readings_1h', `time_bucket('1 day', bucket, 'Africa/Johannesburg')`],
    }[interval];
    return `
        SELECT deployment_id, ${bucket} AS period_start,
               SUM(n)::bigint AS n, bool_or(correction_applied) AS correction_applied,
               min(t_first) AS t_first, max(t_last) AS t_last,
               ${Object.entries(AVG).map(([k, c]) => `${wavg(c)} AS ${k}`).join(',\n               ')},
               MAX(power_active_total_max) AS power_active_kw_max,
               first(energy_import_total_first, bucket) AS imp_first, last(energy_import_total_last, bucket) AS imp_last,
               first(energy_export_total_first, bucket) AS exp_first, last(energy_export_total_last, bucket) AS exp_last
        FROM ${view}
        WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
        GROUP BY deployment_id, 2
        ORDER BY 2, deployment_id`;
}

/** Raw readings at a point: stored rows inside its deployment windows, corrected. */
const RAW_SQL = `
    SELECT d.id AS deployment_id, r.time AS period_start, 1 AS n,
           (d.power_sign <> 1 OR d.scale_correction <> 1) AS correction_applied,
           r.time AS t_first, r.time AS t_last,
           r.voltage_a, r.voltage_b, r.voltage_c,
           r.current_a * d.scale_correction AS current_a, r.current_b * d.scale_correction AS current_b, r.current_c * d.scale_correction AS current_c,
           r.power_active_total * d.power_sign * d.scale_correction AS power_active_kw,
           r.power_active_total * d.power_sign * d.scale_correction AS power_active_kw_max,
           r.power_reactive_total * d.power_sign * d.scale_correction AS power_reactive_kvar,
           r.power_apparent_total * d.scale_correction AS power_apparent_kva,
           r.power_factor_total * d.power_sign AS power_factor, r.frequency AS frequency_hz,
           r.thd_voltage_a, r.thd_voltage_b, r.thd_voltage_c, r.thd_current_a, r.thd_current_b, r.thd_current_c,
           CASE WHEN d.power_sign = 1 THEN r.energy_import_total ELSE r.energy_export_total END * d.scale_correction AS imp_first,
           CASE WHEN d.power_sign = 1 THEN r.energy_import_total ELSE r.energy_export_total END * d.scale_correction AS imp_last,
           CASE WHEN d.power_sign = 1 THEN r.energy_export_total ELSE r.energy_import_total END * d.scale_correction AS exp_first,
           CASE WHEN d.power_sign = 1 THEN r.energy_export_total ELSE r.energy_import_total END * d.scale_correction AS exp_last
    FROM deployments d
    JOIN meter_readings r ON r.meter_id = d.device_id AND r.time >= d.installed_at AND (d.removed_at IS NULL OR r.time < d.removed_at)
    WHERE d.measurement_point_id = $1 AND r.time >= $2 AND r.time < $3
    ORDER BY r.time`;

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const r3 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

/** Median sample spacing (s) from rows' first/last sample times and counts. */
export function medianSpacing(rows: { n: any; t_first: any; t_last: any }[]): number | null {
    const s = rows.filter((x) => Number(x.n) > 1)
        .map((x) => (new Date(x.t_last).getTime() - new Date(x.t_first).getTime()) / 1000 / (Number(x.n) - 1))
        .filter((v) => v > 0).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
}

/** Turns database rows into API rows: period end, coverage, energy steps, flags. Exported for tests. */
export function shapeRows(dbRows: any[], interval: Interval, spacingS: number | null = null): Row[] {
    const step = INTERVAL_SECONDS[interval];
    // The box's reporting interval: given (from the hourly view), else from these rows.
    const spacing = interval === 'raw' ? null : spacingS ?? medianSpacing(dbRows);
    const lastReg = new Map<string, { imp: number | null; exp: number | null }>();
    const out: Row[] = [];
    for (const x of dbRows) {
        const start = new Date(x.period_start);
        // A local day can be 23–25 h only with DST; South Africa has none, so step seconds hold.
        const end = interval === 'raw' ? start : new Date(start.getTime() + step * 1000);
        const n = Number(x.n);
        const coverage = interval === 'raw' ? 1 : spacing ? Math.min(1, (n * spacing) / step) : null;
        const flags: string[] = [];
        if (coverage !== null && coverage < 0.8) flags.push('gap');
        if (x.correction_applied) flags.push('correction_applied');
        const energy = (dir: 'imp' | 'exp') => {
            const first = num(x[`${dir}_first`]), last = num(x[`${dir}_last`]);
            if (last === null) return null;
            const prev = lastReg.get(x.deployment_id)?.[dir] ?? null;
            const delta = prev !== null ? last - prev : first !== null ? last - first : null;
            if (delta !== null && delta < 0) { if (!flags.includes('register_reset')) flags.push('register_reset'); return null; }
            return delta;
        };
        const imp = energy('imp'), exp = energy('exp');
        lastReg.set(x.deployment_id, { imp: num(x.imp_last), exp: num(x.exp_last) });
        const row: any = {
            period_start: start.toISOString(), period_end: end.toISOString(), n,
            coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000,
        };
        for (const k of Object.keys(AVG)) row[k] = r3(num(x[k]));
        row.power_active_kw_max = r3(num(x.power_active_kw_max));
        row.energy_import_kwh = interval === 'raw' ? r3(num(x.imp_last)) : r3(imp);
        row.energy_export_kwh = interval === 'raw' ? r3(num(x.exp_last)) : r3(exp);
        row.flags = flags.join(' ');
        out.push(row as Row);
    }
    return out;
}

export async function loadSeries(db: Queryable, pointId: string, interval: Interval, from: Date, to: Date): Promise<Row[]> {
    // One interval of context before `from`, so the first row's energy step has its previous register.
    const lead = interval === 'raw' ? 0 : INTERVAL_SECONDS[interval] * 1000;
    const r = await db.query(interval === 'raw' ? RAW_SQL : aggregateSql(interval), [pointId, new Date(from.getTime() - lead), to]);
    // Hourly buckets hold several samples even for a meter that reports every few minutes.
    const sp = interval === 'raw' ? null : num((await db.query(`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t_last - t_first) / (n - 1)) AS s
        FROM point_readings_1h WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND n > 1`,
        [pointId, new Date(from.getTime() - 3_600_000), to])).rows[0]?.s);
    return shapeRows(r.rows, interval, sp && sp > 0 ? sp : null).filter((x) => new Date(String(x.period_start)) >= from);
}

export function datasetId(pointId: string, interval: Interval, from: Date, to: Date): string {
    return createHash('sha256').update(`${pointId}|${interval}|${from.toISOString()}|${to.toISOString()}|v${DATASET_VERSION}`).digest('hex').slice(0, 16);
}

export function conventions(interval: Interval) {
    return {
        version: DATASET_VERSION,
        timestamps: interval === 'raw'
            ? 'ISO 8601 UTC; period_start = period_end = the sample time'
            : 'ISO 8601 UTC; period-ending: each row covers [period_start, period_end) and is labelled by period_end',
        time_zone: 'Africa/Johannesburg (SAST, UTC+2, no daylight saving); daily rows are SAST calendar days',
        units: { voltage: 'V (phase-to-neutral)', current: 'A', power_active: 'kW', power_reactive: 'kvar', power_apparent: 'kVA', frequency: 'Hz', thd: '%', energy: 'kWh' },
        sign: 'import / consumption positive, after the deployment power_sign and scale_correction',
        n: 'samples in the interval',
        coverage: "n divided by the samples expected at the box's reporting interval (0–1)",
        energy: interval === 'raw' ? 'register values (kWh) as read' : 'per interval, from the kWh registers; a negative step (register reset) is left empty and flagged',
        flags: { gap: 'coverage below 0.8', register_reset: 'the register went backwards; energy left empty', correction_applied: 'a sign or scale correction of the deployment was applied' },
    };
}

export interface CsvMeta { dataset_id: string; point: string; project: string; interval: Interval; from: Date; to: Date }

/** The # comment lines with the dataset conventions, then the column header. */
export function csvHeader(meta: CsvMeta): string {
    const c = conventions(meta.interval);
    return [
        `# Grid-IQ dataset ${meta.dataset_id} (version ${c.version}): readings of "${meta.point}", project "${meta.project}"`,
        `# interval: ${meta.interval}; range: ${meta.from.toISOString()} to ${meta.to.toISOString()}`,
        `# timestamps: ${c.timestamps}`,
        `# time zone: ${c.time_zone}`,
        `# units: V, A, kW, kvar, kVA, Hz, %, kWh; sign: ${c.sign}`,
        `# n: ${c.n}; coverage: ${c.coverage}`,
        `# energy: ${c.energy}`,
        `# flags: gap = ${c.flags.gap}; register_reset = ${c.flags.register_reset}; correction_applied = ${c.flags.correction_applied}`,
        COLUMNS.join(','),
    ].join('\n') + '\n';
}

const esc = (v: unknown) => (v === null || v === undefined ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** CSV data lines (no header). */
export function csvRows(rows: Row[]): string {
    return rows.map((r) => COLUMNS.map((k) => esc(r[k])).join(',') + '\n').join('');
}

/** CSV with the dataset conventions as leading # comment lines. */
export function toCsv(rows: Row[], meta: CsvMeta): string {
    return csvHeader(meta) + csvRows(rows);
}
