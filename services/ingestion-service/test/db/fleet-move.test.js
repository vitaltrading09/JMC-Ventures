// Phase 6 acceptance, against a real (throwaway) database with the
// migrations applied:
//   - a device moved from project A to project B is attributed correctly on
//     both sides by deployment window, with no reading copied;
//   - the exclusion constraints reject overlapping deployments;
//   - corrections are audit-logged and applied by the point views only.
//
//   TEST_DATABASE_URL=postgres://... node --test test/db/fleet-move.test.js
// Skipped without TEST_DATABASE_URL. Never point it at a real database: the
// test inserts a tenant, projects, a device and readings.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;

test('fleet: move a device between projects', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
    process.env.JWT_SECRET ??= 'unused-in-this-test-but-required-0000';
    const { Pool } = require('pg');
    const express = require('express');
    const { refreshAggregates } = require('@gridiq/db');
    const { fleetRouter } = require('../../dist/fleet/routes.js');

    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const run = Date.now().toString(36);
    const user = { userId: null, email: 'test@grid-iq.local', role: 'super_admin', tenantId: null };

    const app = express();
    app.use(express.json());
    app.use(fleetRouter(pool, (req, _res, next) => { req.user = user; next(); }));
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    };

    // Two projects under one client, an incomer point in each.
    const tenant = (await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`Fleet test ${run}`])).rows[0].id;
    const projA = (await call('POST', '/projects', { tenant_id: tenant, name: `A ${run}` })).body;
    const projB = (await call('POST', '/projects', { tenant_id: tenant, name: `B ${run}` })).body;
    assert.strictEqual(projA.timezone, 'Africa/Johannesburg');
    const pa = (await call('POST', `/projects/${projA.id}/points`, { name: 'Main incomer', role: 'incomer', nominal_voltage_v: 230 })).body;
    const pb = (await call('POST', `/projects/${projB.id}/points`, { name: 'Main incomer', role: 'incomer', ct_primary_a: 400 })).body;

    const dev = await call('POST', '/devices', { code: `t-${run}`, serial_number: `SN-${run}`, model: 'Acuvim II' });
    assert.strictEqual(dev.status, 201);
    assert.strictEqual(dev.body.mqtt_username, `t-${run}`);
    assert.strictEqual(dev.body.status, 'in_stock');
    const device = dev.body.id;

    // Hour-aligned timeline a few hours back.
    const H = 3_600_000;
    const t0 = new Date(Math.floor(Date.now() / H) * H - 5 * H);
    const at = (m) => new Date(t0.getTime() + m * 60_000);

    // 1. Installed at A for an hour: 10 kW, register +10 kWh/h.
    const depA = await call('POST', '/deployments', { device_id: device, measurement_point_id: pa.id, installed_at: at(0) });
    assert.strictEqual(depA.status, 201, JSON.stringify(depA.body));
    const insert = async (fromMin, toMin, kw, reg0) => {
        for (let m = fromMin; m < toMin; m++) {
            await pool.query(`
                INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a,
                                            power_active_total, energy_import_total, energy_export_total, time_source, device_time)
                VALUES ($1, $2, 230, 230, 230, $3, $4, $5, 0, 'DEVICE', $1)`,
                [at(m), device, kw * 1.5, kw, reg0 + (kw * (m - fromMin)) / 60]);
        }
    };
    await insert(0, 60, 10, 1000);

    // 2. Removed, then installed at B for an hour: 20 kW.
    assert.strictEqual((await call('POST', `/deployments/${depA.body.id}/remove`, { removed_at: at(90), reason: 'job done' })).status, 200);
    const depB = await call('POST', '/deployments', { device_id: device, measurement_point_id: pb.id, installed_at: at(120) });
    assert.strictEqual(depB.status, 201, JSON.stringify(depB.body));
    await insert(120, 180, 20, 2000);

    await t.test('overlapping deployments are rejected', async () => {
        // Same device, overlapping window, at A.
        const again = await call('POST', '/deployments', { device_id: device, measurement_point_id: pa.id, installed_at: at(150) });
        assert.strictEqual(again.status, 409);
        assert.match(again.body.error, /device is already deployed/);
        // Another device at B's point while B is still installed.
        const other = (await call('POST', '/devices', { code: `u-${run}` })).body;
        const clash = await call('POST', '/deployments', { device_id: other.id, measurement_point_id: pb.id, installed_at: at(170) });
        assert.strictEqual(clash.status, 409);
        assert.match(clash.body.error, /point already has a device/);
        // And directly against the constraint, bypassing the API.
        await assert.rejects(
            pool.query(`INSERT INTO deployments (device_id, measurement_point_id, installed_at, removed_at) VALUES ($1, $2, $3, $4)`,
                [device, pa.id, at(30), at(45)]),
            (e) => e.code === '23P01' && e.constraint === 'deployments_device_no_overlap');
    });

    await refreshAggregates(pool, new Date(t0.getTime() - 86_400_000), new Date(t0.getTime() + 2 * 86_400_000));

    await t.test('each project sees only its window; no reading was copied', async () => {
        const raw = await pool.query(`SELECT count(*)::int AS n FROM meter_readings WHERE meter_id = $1`, [device]);
        assert.strictEqual(raw.rows[0].n, 120);
        const byPoint = await pool.query(`
            SELECT project_id, sum(n)::int AS n, min(bucket) AS first, max(bucket) AS last, avg(power_active_total_avg) AS kw
            FROM point_readings_1m WHERE device_id = $1 GROUP BY project_id`, [device]);
        const a = byPoint.rows.find((r) => r.project_id === projA.id);
        const b = byPoint.rows.find((r) => r.project_id === projB.id);
        assert.strictEqual(a.n, 60);
        assert.strictEqual(b.n, 60);
        assert.ok(new Date(a.last) < at(90) && new Date(b.first) >= at(120));
        assert.strictEqual(Math.round(a.kw), 10);
        assert.strictEqual(Math.round(b.kw), 20);
        // Hourly view agrees.
        const hourly = await pool.query(`SELECT project_id, sum(n)::int AS n FROM point_readings_1h WHERE device_id = $1 GROUP BY 1`, [device]);
        assert.deepStrictEqual(hourly.rows.map((r) => r.n).sort(), [60, 60]);
    });

    await t.test('the energy balance follows the deployment, from the register', async () => {
        const q = `?from=${at(-60).toISOString()}&to=${at(240).toISOString()}`;
        const ea = (await call('GET', `/projects/${projA.id}/energy-balance${q}`)).body;
        const eb = (await call('GET', `/projects/${projB.id}/energy-balance${q}`)).body;
        // 59 one-minute register steps of 10/60 and 20/60 kWh.
        assert.ok(Math.abs(ea.grid_import_kwh - 9.8) < 0.2, JSON.stringify(ea));
        assert.ok(Math.abs(eb.grid_import_kwh - 19.7) < 0.2, JSON.stringify(eb));
        assert.strictEqual(ea.points[0].method, 'register');
        assert.strictEqual(ea.site_consumption_kwh, ea.grid_import_kwh);
    });

    await t.test('a correction needs a reason, is audit-logged and only changes the point view', async () => {
        const noReason = await call('PATCH', `/deployments/${depB.body.id}/corrections`, { power_sign: -1 });
        assert.strictEqual(noReason.status, 400);
        const ok = await call('PATCH', `/deployments/${depB.body.id}/corrections`, { power_sign: -1, reason: 'CT installed backwards' });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.power_sign, -1);
        const log = await pool.query(`SELECT before, after, reason FROM audit_log WHERE entity_id = $1 AND action = 'deployment.correct'`, [depB.body.id]);
        assert.deepStrictEqual(log.rows[0], { before: { power_sign: 1 }, after: { power_sign: -1 }, reason: 'CT installed backwards' });
        const view = await pool.query(`SELECT avg(power_active_total_avg) AS kw, bool_and(correction_applied) AS c FROM point_readings_1m WHERE deployment_id = $1`, [depB.body.id]);
        assert.strictEqual(Math.round(view.rows[0].kw), -20);
        assert.strictEqual(view.rows[0].c, true);
        const raw = await pool.query(`SELECT avg(power_active_total) AS kw FROM meter_readings WHERE meter_id = $1 AND time >= $2`, [device, at(120)]);
        assert.strictEqual(Math.round(raw.rows[0].kw), 20); // raw untouched
        // A reversed sign swaps the registers: B's import is now on the export side.
        const q = `?from=${at(-60).toISOString()}&to=${at(240).toISOString()}`;
        const eb = (await call('GET', `/projects/${projB.id}/energy-balance${q}`)).body;
        assert.ok(eb.grid_import_kwh < 0.5 && Math.abs(eb.grid_export_kwh - 19.7) < 0.2, JSON.stringify(eb));
    });

    await t.test('device history lists both deployments; /fleet shows it at B', async () => {
        const d = (await call('GET', `/devices/${device}`)).body;
        assert.deepStrictEqual(d.deployments.map((x) => x.project_id), [projB.id, projA.id]);
        assert.strictEqual(d.status, 'deployed');
        assert.strictEqual(d.site_id, projB.id); // the legacy pages follow the device
        const fleet = (await call('GET', '/fleet')).body.find((x) => x.id === device);
        assert.strictEqual(fleet.project_id, projB.id);
    });
});

test('fleet: legacy Add Meter and the commissioning job', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
    const { Pool } = require('pg');
    const { runCommissioning } = require('../../dist/fleet/commissioning.js');
    const { MeterCache } = require('../../dist/ingest/meter-cache.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const run = Date.now().toString(36);

    const tenant = (await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`Legacy ${run}`])).rows[0].id;
    // Through the legacy view names, exactly as POST /sites and POST /meters do.
    const site = (await pool.query(`INSERT INTO sites (tenant_id, name, address, timezone) VALUES ($1, 'Plant', NULL, 'UTC') RETURNING *`, [tenant])).rows[0];
    const meter = (await pool.query(`INSERT INTO meters (site_id, name, serial_number, model) VALUES ($1, 'Main', $2, 'Acuvim II') RETURNING *`,
        [site.id, `L-${run}`])).rows[0];

    await t.test('the legacy path creates a point and an open deployment', async () => {
        const d = await pool.query(`
            SELECT d.*, p.role, p.project_id, dv.status FROM deployments d
            JOIN measurement_points p ON p.id = d.measurement_point_id JOIN devices dv ON dv.id = d.device_id
            WHERE d.device_id = $1`, [meter.id]);
        assert.strictEqual(d.rows.length, 1);
        assert.strictEqual(d.rows[0].role, 'incomer');
        assert.strictEqual(d.rows[0].project_id, site.id);
        assert.strictEqual(d.rows[0].removed_at, null);
        assert.strictEqual(d.rows[0].status, 'deployed');
    });

    await t.test('legacy archive keeps project status in step', async () => {
        await pool.query(`UPDATE sites SET archived_at = NOW() WHERE id = $1`, [site.id]);
        assert.strictEqual((await pool.query(`SELECT status FROM projects WHERE id = $1`, [site.id])).rows[0].status, 'archived');
        await pool.query(`UPDATE sites SET archived_at = NULL WHERE id = $1`, [site.id]);
        assert.strictEqual((await pool.query(`SELECT status FROM projects WHERE id = $1`, [site.id])).rows[0].status, 'active');
    });

    await t.test('contracted MDI written to site_settings is mirrored to the incomer point', async () => {
        await pool.query(`INSERT INTO site_settings (site_id, contracted_mdi_kva) VALUES ($1, 250)`, [site.id]);
        const p = await pool.query(`SELECT contracted_mdi_kva FROM measurement_points WHERE project_id = $1`, [site.id]);
        assert.strictEqual(Number(p.rows[0].contracted_mdi_kva), 250);
    });

    await t.test('the commissioning job evaluates the new deployment', async () => {
        const dep = (await pool.query(`SELECT id, installed_at FROM deployments WHERE device_id = $1`, [meter.id])).rows[0];
        const t0 = new Date(dep.installed_at);
        for (let s = 0; s < 16 * 60; s += 60) {
            const time = new Date(t0.getTime() + s * 1000);
            await pool.query(`
                INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, current_b, current_c,
                                            power_active_total, power_factor_total, time_source, device_time, ingested_at)
                VALUES ($1, $2, 231, 230, 229, 50, 52, 49, 30, 0.95, 'DEVICE', $1, $1::timestamptz + interval '1 second')`,
                [time, meter.id]);
        }
        await runCommissioning(pool, new Date(t0.getTime() + 16 * 60_000));
        const c = (await pool.query(`SELECT commissioning FROM deployments WHERE id = $1`, [dep.id])).rows[0].commissioning;
        assert.strictEqual(c.final, true);
        assert.strictEqual(c.overall, 'pass', JSON.stringify(c.checks));
        // Final results are not re-evaluated.
        assert.strictEqual(await runCommissioning(pool, new Date(t0.getTime() + 20 * 60_000)) >= 0, true);
        const again = (await pool.query(`SELECT commissioning FROM deployments WHERE id = $1`, [dep.id])).rows[0].commissioning;
        assert.strictEqual(again.evaluated_at, c.evaluated_at);
    });

    await t.test('ingest finds a fleet device by its broker username, even before it is installed', async () => {
        await pool.query(`INSERT INTO devices (name, code, mqtt_username) VALUES ($1, $2, $3)`,
            [`GQ-${run}`.toUpperCase(), `GQ-${run}`.toUpperCase(), `gq-${run}`]);
        const cache = new MeterCache(pool);
        await cache.refresh();
        const hit = await cache.lookup(`gq-${run}`, null);
        assert.ok(hit, 'device not found by mqtt_username');
        assert.strictEqual(hit.tenantId, null);
        await pool.query(`UPDATE devices SET status = 'retired' WHERE mqtt_username = $1`, [`gq-${run}`]);
        await cache.refresh();
        assert.strictEqual(await cache.lookup(`gq-${run}`, null), null);
    });
});
