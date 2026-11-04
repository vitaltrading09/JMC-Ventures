// Chart read planning over the continuous aggregates (src/aggregates.ts).

const test = require('node:test');
const assert = require('node:assert');

const { planRead, intervalText, meterSeriesSql, tenantPowerSql, MAX_POINTS } = require('../dist/aggregates.js');

const H = 3_600_000;
const now = new Date('2026-11-04T12:00:00Z');
const plan = (hours) => planRead(new Date(now.getTime() - hours * H), now);

test('raw data only for ranges of 2 h or less', () => {
    assert.strictEqual(plan(0.5).source, 'raw');
    assert.strictEqual(plan(2).source, 'raw');
    assert.notStrictEqual(plan(2.01).source, 'raw');
});

test('typical chart ranges: source, bucket, and 300-700 points', () => {
    const cases = [
        // hours, expected source, expected bucket
        [1, 'raw', '10 seconds'],
        [2, 'raw', '15 seconds'],
        [24, 'readings_1m', '5 minutes'],
        [7 * 24, 'readings_1m', '15 minutes'],
        [14 * 24, 'readings_30m', '30 minutes'],
        [30 * 24, 'readings_1h', '2 hours'],
        [90 * 24, 'readings_1h', '6 hours'],
        [365 * 24, 'readings_1d', '1 day'],
    ];
    for (const [hours, source, bucket] of cases) {
        const p = plan(hours);
        assert.deepStrictEqual([p.source, p.bucket], [source, bucket], `${hours} h`);
        const points = (hours * 3600) / p.bucketSeconds;
        assert.ok(points <= MAX_POINTS, `${hours} h → ${points} points`);
        if (hours >= 24) assert.ok(points >= 250, `${hours} h → only ${points} points`);
    }
});

test('the chart bucket is always a multiple of the source bucket', () => {
    const viewSeconds = { readings_1m: 60, readings_10m: 600, readings_30m: 1800, readings_1h: 3600, readings_1d: 86400 };
    for (let hours = 2.5; hours < 3 * 365 * 24; hours *= 1.37) {
        const p = plan(hours);
        assert.strictEqual(p.bucketSeconds % viewSeconds[p.source], 0, `${hours} h: ${p.bucket} from ${p.source}`);
    }
});

test('intervalText', () => {
    assert.strictEqual(intervalText(15), '15 seconds');
    assert.strictEqual(intervalText(60), '1 minute');
    assert.strictEqual(intervalText(300), '5 minutes');
    assert.strictEqual(intervalText(7200), '2 hours');
    assert.strictEqual(intervalText(86400), '1 day');
});

test('aggregate SQL re-weights by sample count and keeps the response columns', () => {
    const sql = meterSeriesSql('readings_1h');
    assert.match(sql, /FROM readings_1h/);
    assert.match(sql, /SUM\(voltage_a_avg \* n\) \/ NULLIF\(SUM\(n\) FILTER \(WHERE voltage_a_avg IS NOT NULL\), 0\) AS voltage_a/);
    assert.match(sql, /MAX\(energy_import_total_last\) AS energy_import_total/);
    for (const col of ['power_active_total', 'power_factor_total', 'current_c', 'thd_current_a', 'frequency']) {
        assert.match(sql, new RegExp(`AS ${col}\\b`));
    }
    assert.match(meterSeriesSql('raw'), /FROM meter_readings/);
    assert.match(tenantPowerSql('readings_10m', ''), /FROM readings_10m v/);
});

test('the aggregates count interruptions at the compliance engine\'s threshold', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '../../../packages/db/migrations');
    const mig = fs.readdirSync(dir).find((f) => f.endsWith('_aggregates-and-alerting.sql'));
    const sql = fs.readFileSync(path.join(dir, mig), 'utf8');
    const pq = fs.readFileSync(path.join(__dirname, '../src/power-quality.ts'), 'utf8');
    const vNom = Number(pq.match(/const V_NOM = (\d+)/)[1]);
    const factor = Number(pq.match(/const V_INTERRUPTION = V_NOM \* ([\d.]+)/)[1]);
    const inView = Number(sql.match(/count\(\*\) FILTER \(WHERE voltage_a < (\d+(?:\.\d+)?)\) AS n_interrupt/)[1]);
    assert.strictEqual(inView, vNom * factor);
});
