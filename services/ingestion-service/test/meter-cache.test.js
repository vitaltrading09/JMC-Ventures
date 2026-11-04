// Meter lookup cache: match order, thresholds, refresh on miss (rate-limited).

const test = require('node:test');
const assert = require('node:assert');

const { MeterCache, NRS048_DEFAULTS } = require('../dist/ingest/meter-cache.js');

function fakeDb(meters, { usernameColumn = false } = {}) {
    const db = {
        meters,
        loads: 0,
        async query(text) {
            if (/information_schema/.test(text)) return { rows: [{ present: usernameColumn }] };
            db.loads++;
            db.lastSql = text;
            return { rows: db.meters };
        },
    };
    return db;
}
const M1 = { id: 'aaaa-1', serial_number: 'SN-1', mqtt_username: null, tenant_id: 't1', alert_min_v: '210.00', alert_max_v: null, alert_min_freq: null, alert_max_freq: '50.50' };
const M2 = { id: 'bbbb-2', serial_number: 'SN-2', mqtt_username: 'gq-m02', tenant_id: 't1', alert_min_v: null, alert_max_v: null, alert_min_freq: null, alert_max_freq: null };

test('matches the topic segment on id, then serial, then mqtt_username, then the payload serial', async () => {
    const c = new MeterCache(fakeDb([M1, M2], { usernameColumn: true }));
    await c.refresh();
    assert.strictEqual(c.peek('aaaa-1').id, 'aaaa-1');
    assert.strictEqual(c.peek('SN-2').id, 'bbbb-2');
    assert.strictEqual(c.peek('gq-m02').id, 'bbbb-2');
    assert.strictEqual(c.peek('unknown', 'SN-1').id, 'aaaa-1');
    assert.strictEqual(c.peek('unknown'), null);
});

test('tolerates a schema without meters.mqtt_username', async () => {
    const db = fakeDb([M1]);
    const c = new MeterCache(db);
    await c.refresh();
    assert.match(db.lastSql, /NULL::text AS mqtt_username/);
    assert.strictEqual(c.peek('aaaa-1').id, 'aaaa-1');
});

test('thresholds from site_settings (DECIMAL strings) with NRS 048 defaults', async () => {
    const c = new MeterCache(fakeDb([M1, M2]));
    await c.refresh();
    assert.deepStrictEqual(c.peek('aaaa-1').thresholds, { minV: 210, maxV: 253, minFreq: 49, maxFreq: 50.5 });
    assert.deepStrictEqual(c.peek('bbbb-2').thresholds, { ...NRS048_DEFAULTS });
});

test('a miss refreshes, but at most once per minMissRefreshMs', async () => {
    let now = 0;
    const db = fakeDb([M1]);
    const c = new MeterCache(db, { minMissRefreshMs: 5000, now: () => now });
    await c.refresh();
    db.meters = [M1, M2]; // meter added after the last refresh
    now = 6000;
    assert.strictEqual((await c.lookup('bbbb-2')).id, 'bbbb-2', 'found after the refresh on miss');
    assert.strictEqual(db.loads, 2);
    now = 7000;
    assert.strictEqual(await c.lookup('nope'), null);
    assert.strictEqual(db.loads, 2, 'no second refresh within 5 s');
    now = 12_000;
    await c.lookup('nope');
    assert.strictEqual(db.loads, 3);
});
