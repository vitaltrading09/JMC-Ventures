'use strict';
// Rule findings and the metering report against a migrated database:
// a meter with two days of 1-minute readings at PF 0.75 and 133 kVA, above a
// 120 kVA contracted MDI.
//   TEST_DATABASE_URL=postgres://... node --test services/ingestion-service/test/db/findings-report.test.js

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;

test('rule findings and the metering report', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 180_000 }, async (t) => {
    const { Pool } = require('pg');
    const { refreshAggregates } = require('@gridiq/db');
    const { runRuleFindings } = require('../../dist/findings-rules.js');
    const { meteringReport } = require('../../dist/metering-report.js');
    const { getSiteRecommendations } = require('../../dist/ai-recommendations.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const run = Date.now().toString(36);

    const tenant = (await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`Findings ${run}`])).rows[0].id;
    const site = (await pool.query(`INSERT INTO sites (tenant_id, name, timezone) VALUES ($1, 'Plant', 'UTC') RETURNING id`, [tenant])).rows[0].id;
    const meter = (await pool.query(`INSERT INTO meters (site_id, name, serial_number) VALUES ($1, 'Main', $2) RETURNING id`, [site, `F-${run}`])).rows[0].id;
    await pool.query(`INSERT INTO site_settings (site_id, contracted_mdi_kva, tariff_demand, tariff_peak, tariff_standard, tariff_offpeak)
                      VALUES ($1, 120, 250, 5.8, 2.4, 1.4)`, [site]);
    const now = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);  // on the hour
    const from = new Date(now.getTime() - 2 * 86_400_000);
    await pool.query(`UPDATE deployments SET installed_at = $2 WHERE device_id = $1`, [meter, new Date(from.getTime() - 3_600_000)]);
    const point = (await pool.query(`SELECT measurement_point_id FROM deployments WHERE device_id = $1`, [meter])).rows[0].measurement_point_id;

    // 100 kW at PF 0.75 = 133 kVA, every minute for two days; the register integrates it.
    await pool.query(`
        INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, current_b, current_c,
            power_active_total, power_apparent_total, power_factor_total, frequency, energy_import_total, time_source, device_time)
        SELECT t, $1, 231, 230, 229, 193, 193, 193, 100, 133.33, 0.75, 50,
               1000 + extract(epoch FROM t - $2::timestamptz) / 3600 * 100, 'DEVICE', t
        FROM generate_series($2::timestamptz, $3::timestamptz - interval '1 minute', interval '1 minute') AS t`,
        [meter, from, now]);
    await refreshAggregates(pool, new Date(from.getTime() - 86_400_000), new Date(now.getTime() + 3_600_000));

    const active = () => pool.query(`
        SELECT type, review_status, evidence FROM recommendations WHERE meter_id = $1 AND status = 'ACTIVE' ORDER BY type`, [meter]).then((r) => r.rows);

    await t.test('the rules write drafts with their evidence', async () => {
        const c = await runRuleFindings(pool, now);
        assert.ok(c.inserted >= 2, JSON.stringify(c));
        const rows = await active();
        const types = rows.map((r) => r.type);
        assert.ok(types.includes('RULE_LOW_PF'), types.join());
        assert.ok(types.includes('RULE_MDI_EXCEEDED'), types.join());
        for (const r of rows) {
            assert.strictEqual(r.review_status, 'draft');
            assert.strictEqual(r.evidence.engine, 'rules');
            assert.strictEqual(r.evidence.measurement_point_id, point);
        }
        assert.strictEqual(rows.find((r) => r.type === 'RULE_LOW_PF').evidence.values.pf_avg_loaded, 0.75);
    });

    await t.test('a second run refreshes instead of duplicating; a dismissal is respected', async () => {
        const before = (await active()).length;
        const c = await runRuleFindings(pool, now);
        assert.strictEqual(c.inserted, 0);
        assert.strictEqual((await active()).length, before);
        await pool.query(`UPDATE recommendations SET review_status = 'dismissed', reviewed_at = NOW()
                          WHERE meter_id = $1 AND type = 'RULE_LOW_PF'`, [meter]);
        await runRuleFindings(pool, now);
        const pf = (await active()).filter((r) => r.type === 'RULE_LOW_PF');
        assert.deepStrictEqual(pf.map((r) => r.review_status), ['dismissed']);
    });

    await t.test('clients see drafts only when allowed; never dismissed ones', async () => {
        const published = await getSiteRecommendations(pool, site, false);
        assert.strictEqual(published.filter((r) => r.meter_id === meter).length, 0);
        const withDrafts = (await getSiteRecommendations(pool, site, true)).filter((r) => r.meter_id === meter).map((r) => r.type);
        assert.ok(withDrafts.includes('RULE_MDI_EXCEEDED'));
        assert.ok(!withDrafts.includes('RULE_LOW_PF'));   // dismissed
    });

    await t.test('the metering report on the same data', async () => {
        const rep = await meteringReport(pool, point, from, now);
        assert.ok(Math.abs(rep.energy.import_kwh - 4800) < 5, `import ${rep.energy.import_kwh}`);
        assert.ok(rep.energy.coverage > 0.95);
        assert.ok(Math.abs(rep.demand.max_demand_kva - 133.3) < 1, `max demand ${rep.demand.max_demand_kva}`);
        assert.strictEqual(rep.demand.contracted_mdi_kva, 120);
        assert.strictEqual(rep.demand.avg_power_factor, 0.75);
        const kwh = rep.tou.reduce((a, x) => a + x.kwh, 0);
        assert.ok(Math.abs(kwh - 4800) < 5, `tou ${kwh}`);
        assert.ok(rep.feasibility.notes.some((n) => n.level === 'act' && /contracted 120 kVA/.test(n.text)));
        assert.strictEqual(rep.feasibility.peak_shaving.length, 3);
        assert.strictEqual(rep.extremes.power_factor_loaded.worst.value, 0.75);
        assert.strictEqual(rep.extremes.voltage_low.worst.value, 229);
        assert.strictEqual(rep.extremes.voltage_low.worst.phase, 'C');
    });
});
