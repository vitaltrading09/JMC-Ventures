// Phase 8 (ops console) backend, against a throwaway database with the
// migrations applied:
//   - coverage and the reporting interval per box (device_coverage /
//     device_spacing_s), at 10 s and at 5-minute intervals;
//   - the commissioning job waits for the first reading instead of failing
//     an empty window;
//   - /ops/data-health lists unknown parameters and judges silence against
//     each box's own interval.
//
//   TEST_DATABASE_URL=postgres://... node --test test/db/ops-console.test.js

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;

test('ops console backend', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
    const { Pool } = require('pg');
    const express = require('express');
    const { refreshAggregates } = require('@gridiq/db');
    const { runCommissioning } = require('../../dist/fleet/commissioning.js');
    const { opsRouter } = require('../../dist/ops.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const run = Date.now().toString(36);
    const H = 3_600_000;
    const now = Date.now();

    const tenant = (await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`Ops ${run}`])).rows[0].id;
    const site = (await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Plant') RETURNING id`, [tenant])).rows[0].id;
    const meter = async (name) => (await pool.query(`INSERT INTO meters (site_id, name) VALUES ($1, $2) RETURNING id`, [site, `${name} ${run}`])).rows[0].id;
    const fast = await meter('fast');   // every 10 s
    const slow = await meter('slow');   // every 5 min
    const empty = await meter('empty'); // never reports
    // The last 3 hours: the fast box drops out for the last 30 minutes; the slow one is complete.
    const from = Math.floor((now - 3 * H) / 60_000) * 60_000;
    for (let ts = from; ts < now - 30 * 60_000; ts += 10_000) {
        await pool.query(`INSERT INTO meter_readings (time, meter_id, power_active_total, time_source, device_time) VALUES ($1, $2, 10, 'DEVICE', $1)`, [new Date(ts), fast]);
    }
    for (let ts = from; ts < now; ts += 300_000) {
        await pool.query(`INSERT INTO meter_readings (time, meter_id, power_active_total, time_source, device_time) VALUES ($1, $2, 10, 'DEVICE', $1)`, [new Date(ts), slow]);
    }
    await refreshAggregates(pool, new Date(from - 86_400_000), new Date(now + 86_400_000));

    await t.test('coverage is judged at each box\'s own reporting interval', async () => {
        const since = new Date(from);
        const q = async (dev) => (await pool.query(`SELECT device_spacing_s($1, $2) AS s, device_coverage($1, $2) AS c`, [dev, since])).rows[0];
        const f = await q(fast), s = await q(slow), e = await q(empty);
        assert.strictEqual(Math.round(f.s), 10);
        assert.strictEqual(Math.round(s.s), 300);
        // 2.5 of 3 hours for the fast box; all of it for the slow one.
        assert.ok(Math.abs(f.c - 2.5 / 3) < 0.03, `fast coverage ${f.c}`);
        assert.ok(s.c > 0.95, `slow coverage ${s.c}`);
        assert.strictEqual(e.c, null); // interval unknown: no data
    });

    await t.test('commissioning waits for the first reading, then evaluates from it', async () => {
        const dep = (await pool.query(`SELECT id, installed_at FROM deployments WHERE device_id = $1`, [empty])).rows[0];
        await runCommissioning(pool, new Date(new Date(dep.installed_at).getTime() + 20 * 60_000));
        const waiting = (await pool.query(`SELECT commissioning FROM deployments WHERE id = $1`, [dep.id])).rows[0].commissioning;
        assert.strictEqual(waiting.final, false);
        assert.strictEqual(waiting.overall, 'pending');
        assert.match(waiting.note, /first reading/);
        // The box starts reporting an hour after the meter was added.
        const start = new Date(dep.installed_at).getTime() + H;
        for (let s = 0; s < 16 * 60; s += 30) {
            const time = new Date(start + s * 1000);
            await pool.query(`
                INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, power_active_total,
                                            power_factor_total, time_source, device_time, ingested_at)
                VALUES ($1, $2, 230, 231, 229, 40, 25, 0.95, 'DEVICE', $1, $1::timestamptz + interval '1 second')`, [time, empty]);
        }
        await runCommissioning(pool, new Date(start + 16 * 60_000));
        const c = (await pool.query(`SELECT commissioning FROM deployments WHERE id = $1`, [dep.id])).rows[0].commissioning;
        assert.strictEqual(c.final, true);
        assert.strictEqual(new Date(c.window_from).getTime(), start);
        assert.strictEqual(c.checks.find((x) => x.id === 'coverage').status, 'pass', JSON.stringify(c.checks));
    });

    await t.test('/ops/data-health: unknown parameters, interval-aware silence', async () => {
        await pool.query(`INSERT INTO ingest_unknown_params (meter_id, name) VALUES ($1, 'Vthd_new'), ($1, 'Freq_Hz2')`, [fast]);
        const app = express();
        app.use(opsRouter(pool, (req, _res, next) => { req.user = { role: 'engineer', userId: null }; next(); }));
        const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
        t.after(() => server.close());
        const body = await (await fetch(`http://127.0.0.1:${server.address().port}/ops/data-health`)).json();
        const names = body.unknown_params.filter((u) => u.meter_id === fast).map((u) => u.name).sort();
        assert.deepStrictEqual(names, ['Freq_Hz2', 'Vthd_new']);
        const silent = body.silent.map((d) => d.id);
        assert.ok(silent.includes(fast), 'the 10 s box, quiet for 30 min, is silent');
        assert.ok(!silent.includes(slow), 'the 5-minute box, last heard < 3 intervals ago, is not');
        // Client users are refused.
        const clientApp = express();
        clientApp.use(opsRouter(pool, (req, _res, next) => { req.user = { role: 'client_admin', tenantId: tenant }; next(); }));
        const s2 = await new Promise((resolve) => { const s = clientApp.listen(0, () => resolve(s)); });
        t.after(() => s2.close());
        assert.strictEqual((await fetch(`http://127.0.0.1:${s2.address().port}/ops/data-health`)).status, 403);
    });
});
