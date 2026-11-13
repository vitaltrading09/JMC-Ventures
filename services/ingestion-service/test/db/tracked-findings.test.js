'use strict';
// A rule finding whose condition has cleared is superseded, unless someone is
// following it up: that one stays visible, marked as not seen since.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const url = process.env.TEST_DATABASE_URL;

test('cleared rule findings: untracked are superseded, tracked stay and are marked', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
    const { Pool } = require('pg');
    const { runRuleFindings } = require('../../dist/findings-rules.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const mark = `zzt${crypto.randomBytes(4).toString('hex')}`;
    const [tenant] = await q(`INSERT INTO tenants (name, kind) VALUES ($1, 'client') RETURNING id`, [`${mark}-tenant`]);
    const [site] = await q(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenant.id, `${mark}-site`]);
    const [meter] = await q(`INSERT INTO meters (site_id, name, serial_number) VALUES ($1, $2, $3) RETURNING id`, [site.id, `${mark}-meter`, `${mark}-SN`]);
    const rec = async (type) => (await q(`
        INSERT INTO recommendations (site_id, meter_id, tenant_id, type, priority, title, problem, solution, status, review_status, evidence)
        VALUES ($1, $2, $3, $4, 2, $4, 'p', 's', 'ACTIVE', 'draft', '{"engine":"rules"}') RETURNING id`, [site.id, meter.id, tenant.id, type]))[0].id;
    const untracked = await rec('RULE_LOW_PF'), tracked = await rec('RULE_HIGH_THD_V');
    await q(`INSERT INTO finding_cases (recommendation_id, status, owner) VALUES ($1, 'investigating', 'Facilities')`, [tracked]);

    // No readings for this meter: no rule fires, so both drafts have cleared.
    await runRuleFindings(pool);
    const state = async (id) => (await q(`SELECT status, evidence FROM recommendations WHERE id = $1`, [id]))[0];
    assert.strictEqual((await state(untracked)).status, 'SUPERSEDED');
    const kept = await state(tracked);
    assert.strictEqual(kept.status, 'ACTIVE');
    assert.ok(kept.evidence.cleared_at, 'marked as not seen since');
    // A second run keeps the first mark.
    await runRuleFindings(pool);
    assert.strictEqual((await state(tracked)).evidence.cleared_at, kept.evidence.cleared_at);
});
