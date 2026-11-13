// ─────────────────────────────────────────────────────────────────────────────
// The assessment data package (prompt section 15): CSV files and a JSON
// manifest / data dictionary, written to EXPORT_DIR/packages/<assessment>/r<rev>/.
//
// Conventions in every file and in the manifest: UTC timestamps (plus the site
// time zone), period-ending rows, units, sign convention, deployment ids,
// corrected status, coverage and gaps. Missing measurements are empty cells,
// never zero. User-entered text is protected against spreadsheet formula
// injection; numeric values (including negative ones) are written as numbers.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import type { Pool } from 'pg';
import { sha256 } from './dataset';
import { store, pdfKey } from '../storage';

export const PACKAGE_SCHEMA = 'gridiq.assessment-package/1';

/** Same directory as the API exports (EXPORT_DIR, /data/exports in compose). */
export const exportRoot = () => path.resolve(process.env.EXPORT_DIR || '/data/exports');
/** Storage key prefix (area 'exports') of a package revision; kept in assessments.package_path. */
export const packageKey = (assessmentId: string, revision: number) => `packages/${assessmentId}/r${revision}`;
/** Local directory of a package (local store only; kept for older callers). */
export const packageDir = (assessmentId: string, revision: number) => path.join(exportRoot(), 'packages', assessmentId, `r${revision}`);

/** A CSV cell: numbers as numbers, null as empty, text quoted and formula-safe. */
export function csvCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (v instanceof Date) return v.toISOString();
    let s = String(v);
    // A text cell that a spreadsheet would run as a formula gets a leading apostrophe.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',');

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/** Writes every file of the package and the manifest; returns the manifest. */
export async function writePackage(db: Pool, ds: any, revision: number, pdfs: { name: string; pdfPath: string }[]) {
    const dir = packageKey(ds.assessment.id, revision);
    const st = store();
    const pending: Promise<void>[] = [];
    const from = new Date(ds.assessment.period_from), to = new Date(ds.assessment.period_to);
    const files: { name: string; description: string; rows: number | null; bytes: number; sha256: string }[] = [];
    const header = [
        `# GridIQ assessment ${ds.assessment.reference} (${ds.assessment.id}), ${ds.assessment.client} · ${ds.assessment.site}`,
        `# period [${from.toISOString()}, ${to.toISOString()}) UTC; site time zone ${ds.assessment.timezone}`,
        '# rows are period-ending: period_start <= t < period_end; empty cell = not measured (never zero)',
        '# import positive; deployment sign and scale corrections applied (corrected = true)',
    ];
    const write = (name: string, description: string, lines: string[], rows: number | null) => {
        const body = [...header, ...lines].join('\n') + '\n';
        pending.push(st.put('exports', `${dir}/${name}`, Buffer.from(body), name.endsWith('.csv') ? 'text/csv; charset=utf-8' : undefined));
        files.push({ name, description, rows, bytes: Buffer.byteLength(body), sha256: sha256(body) });
    };

    // 30-minute load profile (third-party feasibility tools import this).
    const lp: string[] = [csvLine(['point_id', 'point_name', 'deployment_id', 'period_start', 'period_end', 'kw_avg', 'kva_avg', 'kva_demand', 'kw_demand', 'samples', 'minutes', 'coverage', 'corrected'])];
    let lpRows = 0;
    for (const pt of ds.points) {
        const q = await db.query(`
            SELECT deployment_id, bucket, power_active_total_avg, power_apparent_total_avg, kva_demand, kw_demand, n, minutes, correction_applied
            FROM point_readings_30m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [pt.id, from, to]);
        for (const x of q.rows) {
            lp.push(csvLine([pt.id, pt.name, x.deployment_id, new Date(x.bucket).toISOString(), new Date(new Date(x.bucket).getTime() + 1_800_000).toISOString(),
                num(x.power_active_total_avg), num(x.power_apparent_total_avg), num(x.kva_demand), num(x.kw_demand), num(x.n), num(x.minutes),
                Math.min(1, Number(x.minutes) / 30), x.correction_applied ? 'true' : 'false']));
            lpRows++;
        }
    }
    write('load_profile_30min.csv', '30-minute interval load profile per point (kW, kVA, billed-demand basis)', lp, lpRows);

    // 1-minute core channels.
    const cols = ['voltage_a_avg', 'voltage_b_avg', 'voltage_c_avg', 'current_a_avg', 'current_b_avg', 'current_c_avg',
        'power_active_total_avg', 'power_reactive_total_avg', 'power_apparent_total_avg', 'power_factor_total_avg', 'frequency_avg',
        'thd_voltage_a_avg', 'thd_voltage_b_avg', 'thd_voltage_c_avg', 'thd_current_a_avg', 'thd_current_b_avg', 'thd_current_c_avg',
        'energy_import_total_last', 'energy_export_total_last'];
    const units: Record<string, string> = { voltage: 'V', current: 'A', power_active: 'kW', power_reactive: 'kvar', power_apparent: 'kVA', power_factor: '', frequency: 'Hz', thd: '%', energy: 'kWh' };
    const r1: string[] = [csvLine(['point_id', 'deployment_id', 'period_start', 'period_end', 'samples', ...cols])];
    let r1Rows = 0;
    for (const pt of ds.points) {
        const q = await db.query(`
            SELECT deployment_id, bucket, n, ${cols.join(', ')} FROM point_readings_1m
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [pt.id, from, to]);
        for (const x of q.rows) {
            r1.push(csvLine([pt.id, x.deployment_id, new Date(x.bucket).toISOString(), new Date(new Date(x.bucket).getTime() + 60_000).toISOString(), num(x.n), ...cols.map((c) => num(x[c]))]));
            r1Rows++;
        }
    }
    write('readings_1min.csv', '1-minute averages of the core channels per point (raw 1-second data available on request within retention)', r1, r1Rows);

    // Daily energy (from the dataset, so it equals the reports).
    const de: string[] = [csvLine(['point_id', 'point_name', 'date_sast', 'max_kw', 'min_kw', 'kwh_estimate'])];
    for (const pt of ds.points) for (const d of pt.daily) de.push(csvLine([pt.id, pt.name, d.date, d.max_kw, d.min_kw, d.kwh_estimate]));
    write('daily_energy.csv', 'SAST daily peaks and energy (hourly power-integration estimate; period totals use the registers)', de, de.length - 1);

    // Findings.
    const fi: string[] = [csvLine(['point_id', 'point_name', 'type', 'priority', 'title', 'observed', 'recommended_verification', 'review_status', 'engine'])];
    for (const pt of ds.points) for (const g of pt.findings) fi.push(csvLine([pt.id, pt.name, g.type, g.priority, g.title, g.observed, g.recommended_verification, g.review_status, g.engine]));
    write('findings.csv', 'Rule findings with their review state (observations and recommended verification; not engineering conclusions)', fi, fi.length - 1);

    for (const pdf of pdfs) {
        const buf = await st.read('uploads', pdfKey(pdf.pdfPath));
        if (!buf) continue;
        await st.put('exports', `${dir}/${pdf.name}`, buf, 'application/pdf');
        files.push({ name: pdf.name, description: 'report PDF (frozen revision)', rows: null, bytes: buf.length, sha256: sha256(buf) });
    }

    const manifest = {
        schema: PACKAGE_SCHEMA,
        dataset_schema: ds.schema,
        assessment: { id: ds.assessment.id, reference: ds.assessment.reference, client: ds.assessment.client, site: ds.assessment.site,
                      period_from: ds.assessment.period_from, period_to: ds.assessment.period_to, timezone: ds.assessment.timezone, revision },
        points: ds.points.map((p: any) => ({ id: p.id, name: p.name, role: p.role, parent_point_id: p.parent_point_id, deployments: p.deployments,
                                             coverage: p.coverage.fraction, gaps: p.coverage.gaps })),
        conventions: {
            timestamps: 'UTC ISO 8601', rows: 'period-ending: period_start <= t < period_end', missing: 'empty cell (never zero)',
            sign: ds.conventions.sign, corrected: 'deployment sign and scale corrections applied; original raw readings are unchanged',
            units: { voltage: 'V (phase-to-neutral)', current: 'A', power_active: 'kW', power_reactive: 'kvar', power_apparent: 'kVA',
                     power_factor: 'signed ratio', frequency: 'Hz', thd: '% of fundamental', energy: 'kWh (register value)', ...{} },
            column_units: Object.fromEntries(cols.map((c) => [c, units[Object.keys(units).find((k) => c.startsWith(k)) ?? ''] ?? ''])),
        },
        versions: ds.versions,
        files,
        generated_at: new Date().toISOString(),
    };
    const mbody = JSON.stringify(manifest, null, 2);
    await Promise.all(pending);
    await st.put('exports', `${dir}/manifest.json`, Buffer.from(mbody), 'application/json');
    return { dir, manifest, manifest_sha256: sha256(mbody) };
}
