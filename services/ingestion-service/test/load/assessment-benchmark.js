'use strict';
// Read-side benchmark of one full assessment: 30 days of 1-second readings at
// one measurement point (2.59 million rows), then what a client and the
// close-out do with it. Run against a THROWAWAY, migrated database only:
//
//   BENCH_DATABASE_URL=postgres://... node services/ingestion-service/test/load/assessment-benchmark.js [--days 30] [--out report.json]
//
// (build the service first: the script uses dist/). It reports: insert rate,
// aggregate materialisation, dataset build, PDF render, the chart queries at
// each resolution, the rule metrics, and the size on disk.

const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { refreshAggregates } = require('@gridiq/db');

const url = process.env.BENCH_DATABASE_URL;
if (!url) { console.error('BENCH_DATABASE_URL is required (a throwaway, migrated database)'); process.exit(2); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('days', '30'));
const DAY = 86_400_000;

(async () => {
    const pool = new Pool({ connectionString: url, max: 8 });
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const results = [];
    const time = async (name, fn, note) => {
        const t0 = performance.now();
        const v = await fn();
        const ms = Math.round(performance.now() - t0);
        results.push({ step: name, ms, note: typeof note === 'function' ? note(v, ms) : note ?? '' });
        console.log(`${name.padEnd(46)} ${String(ms).padStart(8)} ms  ${results[results.length - 1].note}`);
        return v;
    };

    const mark = `bench${crypto.randomBytes(3).toString('hex')}`;
    const end = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const start = new Date(end.getTime() - DAYS * DAY);
    const [tenant] = await q(`INSERT INTO tenants (name, kind) VALUES ($1, 'client') RETURNING id`, [`${mark}-tenant`]);
    const [site] = await q(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenant.id, `${mark}-site`]);
    const [meter] = await q(`INSERT INTO meters (site_id, name, serial_number) VALUES ($1, $2, $3) RETURNING id`, [site.id, `${mark}-incomer`, `${mark}-SN`]);
    await q(`UPDATE deployments SET installed_at = $2 WHERE device_id = $1`, [meter.id, new Date(start.getTime() - 3_600_000)]);
    const point = (await q(`SELECT measurement_point_id AS id FROM deployments WHERE device_id = $1`, [meter.id]))[0].id;
    await q(`UPDATE measurement_points SET contracted_mdi_kva = 600, nominal_voltage_v = 230 WHERE id = $1`, [point]);

    // 1-second readings, one day per statement. Load follows a working-day curve; the
    // energy register is the running integral, so register-based energy is exercised.
    let register = 100_000, rows = 0;
    await time(`insert ${DAYS} days at 1 Hz`, async () => {
        for (let d = 0; d < DAYS; d++) {
            const from = new Date(start.getTime() + d * DAY), to = new Date(from.getTime() + DAY);
            const r = await q(`
                WITH s AS (
                    SELECT t, 180 + 260 * GREATEST(0, sin(((extract(epoch FROM t)::bigint + 7200) % 86400) / 86400.0 * 2 * pi() - 1.4)) + 15 * random() AS kw,
                           extract(epoch FROM t) AS e
                    FROM generate_series($2::timestamptz, $3::timestamptz - INTERVAL '1 second', INTERVAL '1 second') t),
                ins AS (
                    INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, current_b, current_c,
                        power_active_total, power_reactive_total, power_apparent_total, power_factor_total, frequency,
                        thd_voltage_a, thd_voltage_b, thd_voltage_c, thd_current_a, thd_current_b, thd_current_c, current_unbalance,
                        energy_import_total, device_time, time_source)
                    SELECT t, $1, 231 + 2 * sin(e / 900) - kw / 200, 230 + 2 * sin(e / 700) - kw / 200, 229 + 2 * sin(e / 800) - kw / 200,
                           kw * 1.6, kw * 1.55, kw * 1.65, kw, kw * 0.35, kw * 1.06, 0.943, 50 + 0.05 * sin(e / 60),
                           3 + kw / 150, 3.2 + kw / 150, 2.9 + kw / 150, 12 + kw / 40, 12.5 + kw / 40, 11.8 + kw / 40, 4 + 2 * sin(e / 3600),
                           $4::float8 + SUM(kw / 3600.0) OVER (ORDER BY t), t, 'IMPORT'
                    FROM s RETURNING energy_import_total)
                SELECT count(*)::int AS n, max(energy_import_total) AS reg FROM ins`, [meter.id, from, to, register]);
            rows += r[0].n; register = Number(r[0].reg);
        }
    }, (_, ms) => `${rows.toLocaleString('en')} rows, ${Math.round(rows / (ms / 1000)).toLocaleString('en')} rows/s`);

    await time('materialise the aggregates (1m … 1d)', () => refreshAggregates(pool, new Date(start.getTime() - DAY), new Date(end.getTime() + DAY)));
    await q(`ANALYZE`);

    const [a] = await q(`
        INSERT INTO assessments (tenant_id, project_id, title, status, duration_days, start_at, end_at, payment_state)
        VALUES ($1, $2, $3, 'active', $4, $5, $6, 'paid') RETURNING id`, [tenant.id, site.id, `${mark}-assessment`, DAYS, start, new Date(end.getTime() + 3_600_000)]);
    await q(`INSERT INTO assessment_points (assessment_id, measurement_point_id) VALUES ($1, $2)`, [a.id, point]);

    const { buildAssessmentDataset } = require('../../dist/reports/dataset.js');
    const { renderReportPdf } = require('../../dist/reports/pdf.js');
    const { loadPointMetrics } = require('../../dist/findings-rules.js');
    const ds = await time('build the assessment dataset (cold)', () => buildAssessmentDataset(pool, a.id, end, { provisional: true }),
        (v) => `coverage ${Math.round((v.points[0]?.coverage?.fraction ?? 0) * 100)} %, ${Math.round(JSON.stringify(v).length / 1024)} kB`);
    await time('build the assessment dataset (again)', () => buildAssessmentDataset(pool, a.id, end, { provisional: true }));
    for (const kind of ['overview', 'power_quality', 'handover']) {
        try {
            await time(`render the ${kind} PDF`, () => renderReportPdf(kind, ds, { revision: 1, sha256: 'bench', status: 'provisional', generatedAt: new Date() }), (b) => `${Math.round(b.length / 1024)} kB`);
        } catch (e) { results.push({ step: `render the ${kind} PDF`, ms: -1, note: `skipped: ${e.message}` }); }
    }
    const rowsOf = (v) => `${v.length.toLocaleString('en')} rows`;
    const view = (name, from, to) => () => q(`SELECT * FROM ${name} WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [point, from, to]);
    await time('chart: whole assessment, hourly', view('point_readings_1h', start, end), rowsOf);
    await time('chart: whole assessment, 10-minute', view('point_readings_10m', start, end), rowsOf);
    await time('chart: 30-minute demand, whole assessment', view('point_readings_30m', start, end), rowsOf);
    await time('chart: 3 days, 1-minute', view('point_readings_1m', new Date(end.getTime() - 3 * DAY), end), rowsOf);
    await time('chart: 3 days, 1-minute, 20 days back', view('point_readings_1m', new Date(end.getTime() - 20 * DAY), new Date(end.getTime() - 17 * DAY)), rowsOf);
    await time('data explorer: 6 hours raw (1 Hz)', () => q(`SELECT time, power_active_total, thd_current_a FROM meter_readings WHERE meter_id = $1 AND time >= $2 AND time < $3 ORDER BY time`,
        [meter.id, new Date(end.getTime() - 6 * 3_600_000), end]), rowsOf);
    await time('live tile: latest 1-minute value', () => q(`SELECT bucket, power_active_total_avg FROM point_readings_1m WHERE measurement_point_id = $1 AND bucket >= $2 ORDER BY bucket DESC LIMIT 1`, [point, new Date(end.getTime() - 900_000)]));
    await time('rule findings: 7-day metrics', () => loadPointMetrics(pool, point, new Date(end.getTime() - 7 * DAY), end), (m) => `${Math.round(m.hours)} h metered`);
    const [size] = await q(`SELECT pg_size_pretty(hypertable_size('meter_readings')) AS raw, pg_size_pretty(pg_database_size(current_database())) AS db`);
    console.log(`\nraw readings on disk: ${size.raw} (database ${size.db}), ${rows.toLocaleString('en')} rows`);
    const out = arg('out');
    if (out) fs.writeFileSync(out, JSON.stringify({ days: DAYS, rows, size, results }, null, 2));
    await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
