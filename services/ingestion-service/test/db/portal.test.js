// Phase 8 client portal API (src/portal.ts), against a throwaway database
// with the migrations applied:
//   - a box that moved from client A to client B: each client's point shows
//     only its own window, with the deployment's corrections applied;
//   - project tiles (current incomer kW, today's kWh, coverage);
//   - load profile, demand and power quality per point, the latter from the
//     current deployment only;
//   - a project without a live assessment answers 403 for its points.
//
//   TEST_DATABASE_URL=postgres://... node --test test/db/portal.test.js

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;

test('client portal API', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
    const { Pool } = require('pg');
    const express = require('express');
    const { refreshAggregates } = require('@gridiq/db');
    const { portalRouter } = require('../../dist/portal.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const run = Date.now().toString(36);
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const H = 3_600_000;

    const tenantA = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`PA ${run}`]))[0].id;
    const tenantB = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`PB ${run}`]))[0].id;
    const project = async (tenant, name, live = true) =>
        (await q(`INSERT INTO projects (tenant_id, name, live_data_visible) VALUES ($1, $2, $3) RETURNING id`, [tenant, name, live]))[0].id;
    const pA = await project(tenantA, `A site ${run}`);
    const pB = await project(tenantB, `B site ${run}`);
    const pHidden = await project(tenantB, `B hidden ${run}`, false);
    const point = async (proj, role = 'incomer', mdi = null) =>
        (await q(`INSERT INTO measurement_points (project_id, name, role, contracted_mdi_kva) VALUES ($1, 'Incomer', $2, $3) RETURNING id`, [proj, role, mdi]))[0].id;
    const ptA = await point(pA), ptB = await point(pB, 'incomer', 100), ptHidden = await point(pHidden);
    const box = (await q(`INSERT INTO devices (name, code, mqtt_username, status) VALUES ($1, $2, $3, 'deployed') RETURNING id`,
        [`GQ-P${run}`, `GQ-P${run}`.toUpperCase(), `gq-p${run}`]))[0].id;
    const hiddenBox = (await q(`INSERT INTO devices (name) VALUES ($1) RETURNING id`, [`hidden ${run}`]))[0].id;

    // Hour-aligned: 3 h at A (10 kW), moved, then 3 h up to now at B (40 kW, CT reversed → sign −1).
    const now = Date.now();
    const t0 = Math.floor((now - 7 * H) / H) * H;
    const moveAt = t0 + 3.5 * H;
    await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at, removed_at) VALUES ($1, $2, $3, $4)`, [box, ptA, new Date(t0), new Date(moveAt)]);
    await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at, power_sign) VALUES ($1, $2, $3, -1)`, [box, ptB, new Date(moveAt + 60_000)]);
    await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at) VALUES ($1, $2, $3)`, [hiddenBox, ptHidden, new Date(t0)]);
    // As POST /deployments does: the box's current project.
    await q(`UPDATE devices SET site_id = $2 WHERE id = $1`, [box, pB]);
    await q(`UPDATE devices SET site_id = $2 WHERE id = $1`, [hiddenBox, pHidden]);
    const insert = async (dev, from, to, kw, reg0) => {
        for (let ts = from; ts < to; ts += 60_000) {
            await q(`INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, power_active_total,
                                                 power_apparent_total, power_factor_total, energy_import_total, energy_export_total, time_source, device_time)
                     VALUES ($1, $2, 230, 231, 229, $3, $4, $5, 0.9, $6, 0, 'DEVICE', $1)`,
                [new Date(ts), dev, Math.abs(kw) * 1.5, kw, Math.abs(kw) / 0.9, reg0 + (Math.abs(kw) * (ts - from)) / H]);
        }
    };
    await insert(box, t0, t0 + 3 * H, 10, 100);
    // At B the CT is reversed: the meter sees −40 kW and counts on its export register.
    for (let ts = moveAt + 60_000; ts < now; ts += 60_000) {
        await q(`INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, power_active_total,
                                             power_apparent_total, power_factor_total, energy_import_total, energy_export_total, time_source, device_time)
                 VALUES ($1, $2, 230, 231, 229, 60, -40, 44, -0.9, 130, $3, 'DEVICE', $1)`,
            [new Date(ts), box, 5000 + (40 * (ts - moveAt)) / H]);
    }
    await insert(hiddenBox, t0, now, 5, 0);
    await refreshAggregates(pool, new Date(t0 - 86_400_000), new Date(now + 86_400_000));

    const serve = async (user) => {
        const app = express();
        app.use(portalRouter(pool, (req, _res, next) => { req.user = user; next(); }));
        const s = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
        t.after(() => s.close());
        return async (p) => {
            const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`);
            return { status: r.status, body: await r.json(), source: r.headers.get('x-readings-source') };
        };
    };
    // GridIQ assessments: each client holds a live assessment of its site that
    // covers the data; the hidden project has none (so its points answer 403).
    const userOf = async (tenant, role) => (await q(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [tenant, `${role}.${tenant}@t.local`, role]))[0].id;
    const uA = await userOf(tenantA, 'client_admin'), uB = await userOf(tenantB, 'client_viewer');
    for (const [tenant, proj, user] of [[tenantA, pA, uA], [tenantB, pB, uB]]) {
        const a = (await q(`INSERT INTO assessments (tenant_id, project_id, title, status, duration_days, start_at, end_at, payment_state)
                            VALUES ($1, $2, 't', 'active', 7, $3, $4, 'paid') RETURNING id`, [tenant, proj, new Date(t0 - H), new Date(t0 - H + 7 * 86_400_000)]))[0].id;
        await q(`INSERT INTO assessment_grants (assessment_id, user_id, email) VALUES ($1, $2, $3)`, [a, user, `u.${user}@t.local`]);
    }
    const asA = await serve({ role: 'client_admin', tenantId: tenantA, userId: uA });
    const asB = await serve({ role: 'client_viewer', tenantId: tenantB, userId: uB });
    const range = `from=${new Date(t0 - H).toISOString()}&to=${new Date(now).toISOString()}`;

    await t.test('each client sees only its own window of the moved box, corrected', async () => {
        const a = await asA(`/points/${ptA}/readings?${range}`);
        const b = await asB(`/points/${ptB}/readings?${range}`);
        assert.strictEqual(a.status, 200);
        assert.match(a.source, /^point_readings_/);
        assert.ok(a.body.length > 0 && a.body.every((r) => new Date(r.time).getTime() < moveAt), 'A sees only its window');
        assert.ok(b.body.length > 0 && b.body.every((r) => new Date(r.time).getTime() >= moveAt - H), 'B sees only its window');
        assert.ok(a.body.every((r) => Math.round(r.power_active_total) === 10));
        // B's reversed CT: positive after the deployment's power_sign.
        assert.ok(b.body.every((r) => Math.round(r.power_active_total) === 40), JSON.stringify(b.body.slice(0, 2)));
        // Neither reaches the other's point.
        assert.strictEqual((await asA(`/points/${ptB}/readings?${range}`)).status, 403);
        assert.strictEqual((await asB(`/points/${ptA}/demand`)).status, 403);
    });

    await t.test('projects list: own projects only, with live tiles', async () => {
        const a = (await asA('/portal/projects')).body;
        assert.deepStrictEqual(a.map((p) => p.id), [pA]);
        assert.strictEqual(a[0].tiles.incomer_kw, null); // A's box left hours ago: no current reading
        const b = (await asB('/portal/projects')).body;
        assert.deepStrictEqual(b.map((p) => p.id).sort(), [pB, pHidden].sort());
        const live = b.find((p) => p.id === pB);
        assert.strictEqual(live.tiles.incomer_kw, 40);
        assert.ok(live.tiles.today_kwh === null || live.tiles.today_kwh >= 0);
        assert.ok(live.tiles.coverage_24h > 0);
        const hidden = b.find((p) => p.id === pHidden);
        assert.strictEqual(hidden.telemetry_visible, false);
        assert.strictEqual(hidden.tiles, null);
    });

    await t.test('project detail carries no internal fields', async () => {
        const d = await asB(`/portal/projects/${pB}`);
        assert.strictEqual(d.status, 200);
        const text = JSON.stringify(d.body);
        for (const field of ['power_sign', 'scale_correction', 'commissioning', 'installed_by', 'notes', 'code', 'mqtt_username']) {
            assert.ok(!text.includes(`"${field}"`), `${field} leaked`);
        }
        assert.strictEqual(d.body.points[0].live.kw, 40);
        assert.strictEqual((await asA(`/portal/projects/${pB}`)).status, 403);
    });

    await t.test('demand, load profile and power quality per point', async () => {
        const dem = (await asB(`/points/${ptB}/demand?days=2`)).body;
        assert.ok(dem.max_kva > 40 && dem.max_kva < 50, JSON.stringify(dem));
        assert.strictEqual(dem.contracted_mdi_kva, 100);
        assert.match(dem.basis, /30-minute/);
        const lp = (await asA(`/points/${ptA}/load-profile?days=7`)).body;
        assert.ok(lp.cells.length >= 3 && lp.cells.every((c) => c.kw === 10), JSON.stringify(lp.cells));
        assert.strictEqual(lp.timezone, 'Africa/Johannesburg');
        // The device-keyed assessment would reach back a whole day, into A's time
        // with the box: a client gets it only after a full day of its own.
        const pq = (await asB(`/points/${ptB}/power-quality?days=30`)).body;
        assert.strictEqual(pq.reason, 'insufficient_data');
        assert.strictEqual(pq.report, null);
    });

    await t.test('a project without a live assessment answers 403 for its points', async () => {
        assert.strictEqual((await asB(`/points/${ptHidden}/readings?${range}`)).status, 403);
        assert.strictEqual((await asB(`/points/${ptHidden}/load-profile`)).status, 403);
        const d = (await asB(`/portal/projects/${pHidden}`)).body;
        assert.strictEqual(d.telemetry_visible, false);
        assert.strictEqual(d.points[0].live, null);
    });
});
