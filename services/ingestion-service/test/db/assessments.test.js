'use strict';
// GridIQ assessment model against a migrated database:
//   - boundary attribution: a device moved from client A to client B at
//     10:00:30 splits the straddling minute/10 min/hour/day exactly; a late
//     (out-of-order) upload stays with the deployment of its timestamp;
//   - an asset's history survives the move;
//   - a 24-hour synthetic 1-second stream yields exactly 86,400 rows, and a
//     replay adds none;
//   - 100 kW for one continuous hour is 100 kWh (registers and integration);
//   - export entitlement follows the assessment.
//   TEST_DATABASE_URL=postgres://... node --test test/db/assessments.test.js

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;

test('assessment model: boundaries, history, collection, energy, exports', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 300_000 }, async (t) => {
    const { Pool } = require('pg');
    const { refreshAggregates } = require('@gridiq/db');
    const { loadPointEnergy } = require('../../dist/fleet/balance.js');
    const { exportEntitledSql } = require('../../dist/scope.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const run = Date.now().toString(36);

    // Two clients, one point each; one device.
    const mk = async (label) => {
        const tenant = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${label} ${run}`]))[0].id;
        const project = (await q(`INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenant, `${label} site`]))[0].id;
        const point = (await q(`INSERT INTO measurement_points (project_id, name, role) VALUES ($1, 'Incomer', 'incomer') RETURNING id`, [project]))[0].id;
        return { tenant, project, point };
    };
    const A = await mk('Client A'), B = await mk('Client B');
    const dev = (await q(`INSERT INTO devices (name, code, mqtt_username, status) VALUES ('box', $1, $2, 'available') RETURNING id`,
        [`T-${run}`.toUpperCase(), `t-${run}`]))[0].id;

    // Day D (UTC). A from 09:00 to 10:00:30, B from 10:00:30.
    const day = '2026-10-20';
    const at = (hms) => new Date(`${day}T${hms}Z`);
    const move = at('10:00:30');
    await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at, removed_at) VALUES ($1, $2, $3, $4)`, [dev, A.point, at('09:00:00'), move]);
    await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at) VALUES ($1, $2, $3)`, [dev, B.point, move]);

    // 1 Hz from 09:58:00 to 10:03:00 (exclusive): 10 kW before the move, 20 kW after;
    // the register (kWh) integrates it.
    const rows = [];
    let reg = 1000;
    for (let s = at('09:58:00').getTime(); s < at('10:03:00').getTime(); s += 1000) {
        const kw = s < move.getTime() ? 10 : 20;
        rows.push([new Date(s), kw, reg]);
        reg += kw / 3600;
    }
    const lateAt = at('10:00:10');
    const insert = (list) => q(`
        INSERT INTO meter_readings (time, meter_id, power_active_total, energy_import_total, time_source, device_time)
        SELECT x.t, $1, x.kw, x.reg, 'DEVICE', x.t FROM unnest($2::timestamptz[], $3::float8[], $4::float8[]) AS x(t, kw, reg)
        ON CONFLICT (meter_id, time) DO NOTHING`,
        [dev, list.map((r) => r[0]), list.map((r) => r[1]), list.map((r) => r[2])]);
    // Hold back 10:00:10 and upload it last (out of order).
    await insert(rows.filter((r) => r[0].getTime() !== lateAt.getTime()));
    await refreshAggregates(pool, at('00:00:00'), new Date(at('00:00:00').getTime() + 2 * 86_400_000));
    await insert(rows.filter((r) => r[0].getTime() === lateAt.getTime()));
    await refreshAggregates(pool, at('00:00:00'), new Date(at('00:00:00').getTime() + 2 * 86_400_000));

    const bucket = async (view, point, b) => (await q(
        `SELECT n::int, power_active_total_avg::float8 AS kw FROM ${view} WHERE measurement_point_id = $1 AND bucket = $2`, [point, b]))[0] ?? null;

    await t.test('the 10:00 minute is split at 10:00:30: 30 samples each, no mixing', async () => {
        const a = await bucket('point_readings_1m', A.point, at('10:00:00'));
        const b = await bucket('point_readings_1m', B.point, at('10:00:00'));
        assert.deepStrictEqual(a, { n: 30, kw: 10 });     // includes the late 10:00:10 sample
        assert.deepStrictEqual(b, { n: 30, kw: 20 });
        // Interior minutes are untouched.
        assert.deepStrictEqual(await bucket('point_readings_1m', A.point, at('09:59:00')), { n: 60, kw: 10 });
        assert.deepStrictEqual(await bucket('point_readings_1m', B.point, at('10:01:00')), { n: 60, kw: 20 });
        assert.strictEqual(await bucket('point_readings_1m', B.point, at('09:59:00')), null);
    });

    await t.test('coarser buckets straddling the move are split the same way', async () => {
        for (const [view, start] of [['point_readings_10m', '10:00:00'], ['point_readings_30m', '10:00:00'], ['point_readings_1h', '10:00:00'], ['point_readings_1d', '00:00:00']]) {
            const a = await bucket(view, A.point, at(start));
            const b = await bucket(view, B.point, at(start));
            const aBefore = start === '00:00:00' ? 150 : 30;   // the day also holds 09:58–10:00
            assert.deepStrictEqual(a, { n: aBefore, kw: 10 }, view);
            assert.deepStrictEqual(b, { n: 150, kw: 20 }, view);
        }
        // Every sample is counted exactly once across the two clients.
        const total = (await q(`SELECT sum(n)::int AS n FROM point_readings_1d WHERE measurement_point_id IN ($1, $2)`, [A.point, B.point]))[0].n;
        assert.strictEqual(total, rows.length);
    });

    await t.test('energy registers are split at the move as well', async () => {
        const ea = await loadPointEnergy(pool, A.point, at('09:00:00'), at('11:00:00'));
        const eb = await loadPointEnergy(pool, B.point, at('09:00:00'), at('11:00:00'));
        // A: 150 s at 10 kW; B: 150 s at 20 kW (register steps inside each window;
        // loadPointEnergy reports to 0.1 kWh).
        assert.ok(Math.abs(ea.importKwh - 149 * 10 / 3600) < 0.05, `A ${ea.importKwh}`);
        assert.ok(Math.abs(eb.importKwh - 149 * 20 / 3600) < 0.05, `B ${eb.importKwh}`);
    });

    await t.test("the asset's history keeps both installations and its maintenance", async () => {
        await q(`INSERT INTO maintenance_events (device_id, occurred_at, kind, description, next_due_on) VALUES ($1, $2, 'calibration', 'bench check', '2027-10-20')`, [dev, at('09:30:00')]);
        const deps = await q(`SELECT mp.project_id FROM deployments d JOIN measurement_points mp ON mp.id = d.measurement_point_id WHERE d.device_id = $1 ORDER BY installed_at`, [dev]);
        assert.deepStrictEqual(deps.map((d) => d.project_id), [A.project, B.project]);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM maintenance_events WHERE device_id = $1`, [dev]))[0].n, 1);
        // Overlapping deployments of one device are refused by the database.
        await assert.rejects(q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at) VALUES ($1, $2, $3)`, [dev, A.point, at('11:00:00')]));
    });

    await t.test('a synthetic 1 Hz day gives exactly 86,400 rows; a replay adds none', async () => {
        const d2 = (await q(`INSERT INTO devices (name, code, mqtt_username) VALUES ('hz', $1, $2) RETURNING id`, [`H-${run}`.toUpperCase(), `h-${run}`]))[0].id;
        const sql = `INSERT INTO meter_readings (time, meter_id, power_active_total, time_source, device_time)
                     SELECT t, $1, 1, 'DEVICE', t FROM generate_series($2::timestamptz, $2::timestamptz + INTERVAL '1 day' - INTERVAL '1 second', INTERVAL '1 second') t
                     ON CONFLICT (meter_id, time) DO NOTHING`;
        const first = await pool.query(sql, [d2, '2026-10-01T00:00:00Z']);
        const replay = await pool.query(sql, [d2, '2026-10-01T00:00:00Z']);
        assert.strictEqual(first.rowCount, 86_400);
        assert.strictEqual(replay.rowCount, 0);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM meter_readings WHERE meter_id = $1`, [d2]))[0].n, 86_400);
    });

    await t.test('golden energy: 100 kW for one continuous hour is 100 kWh', async () => {
        const g = await mk('Golden');
        const d3 = (await q(`INSERT INTO devices (name, code, mqtt_username) VALUES ('g', $1, $2) RETURNING id`, [`G-${run}`.toUpperCase(), `g-${run}`]))[0].id;
        await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at) VALUES ($1, $2, '2026-09-01T00:00:00Z')`, [d3, g.point]);
        // One sample per second from 12:00:00 to 13:00:00 inclusive; the register
        // integrates exactly 100 kW (100/3600 kWh per second).
        await q(`INSERT INTO meter_readings (time, meter_id, power_active_total, energy_import_total, time_source, device_time)
                 SELECT t, $1, 100, 5000 + extract(epoch FROM t - '2026-09-10T12:00:00Z'::timestamptz) * 100 / 3600, 'DEVICE', t
                 FROM generate_series('2026-09-10T11:59:00Z'::timestamptz, '2026-09-10T13:01:00Z', INTERVAL '1 second') t`, [d3]);
        await refreshAggregates(pool, new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'));
        const e = await loadPointEnergy(pool, g.point, new Date('2026-09-10T12:00:00Z'), new Date('2026-09-10T13:00:00Z'));
        // Register steps per hour bucket: documented tolerance 0.1 kWh (one sample spacing at 100 kW is 0.028 kWh).
        assert.ok(Math.abs(e.importKwh - 100) < 0.1, `register energy ${e.importKwh}`);
    });

    await t.test('an export is deliverable only while its requester is entitled', async () => {
        const user = (await q(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'client_admin') RETURNING id`, [B.tenant, `b.${run}@t.local`]))[0].id;
        const exp = (await q(`
            INSERT INTO exports (tenant_id, measurement_point_id, interval, period_from, period_to, created_by)
            VALUES ($1, $2, '1h', $3, $4, $5) RETURNING id`, [B.tenant, B.point, at('00:00:00'), at('12:00:00'), user]))[0].id;
        const ok = async () => (await q(`SELECT 1 FROM exports e WHERE e.id = $1 AND ${exportEntitledSql('e')}`, [exp])).length === 1;
        assert.strictEqual(await ok(), false);   // no assessment
        const a = (await q(`INSERT INTO assessments (tenant_id, project_id, title, status, duration_days, start_at, end_at, payment_state)
                            VALUES ($1, $2, 't', 'active', 7, NOW() - INTERVAL '1 day', NOW() + INTERVAL '6 days', 'paid') RETURNING id`, [B.tenant, B.project]))[0].id;
        assert.strictEqual(await ok(), false);   // no grant
        await q(`INSERT INTO assessment_grants (assessment_id, user_id, email) VALUES ($1, $2, $3)`, [a, user, `b.${run}@t.local`]);
        assert.strictEqual(await ok(), true);
        await q(`UPDATE assessments SET end_at = NOW() - INTERVAL '1 second', start_at = NOW() - INTERVAL '7 days' WHERE id = $1`, [a]);
        assert.strictEqual(await ok(), false);   // ended (status still 'active': no job needed)
    });
});
