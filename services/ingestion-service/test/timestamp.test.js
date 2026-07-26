// Run with: npm run build && npm test   (Node's built-in runner — no dependencies)
//
// resolveReadingTime decides the timestamp every downstream figure is computed
// against. Getting it wrong is not a visible crash — it silently misplaces data
// on the timeline, which is the worst kind of bug in a product whose output is
// evidence. These cases pin the behaviour down.

const test = require('node:test');
const assert = require('node:assert');

const { parseDeviceTime, resolveReadingTime } = require('../dist/mqtt.js');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('parseDeviceTime', async (t) => {
    await t.test('accepts epoch seconds as a number', () => {
        assert.strictEqual(parseDeviceTime(1785066264).toISOString(), '2026-07-26T11:44:24.000Z');
    });

    await t.test('accepts epoch seconds as a string (the real SPAR payload form)', () => {
        assert.strictEqual(parseDeviceTime('1785066264').toISOString(), '2026-07-26T11:44:24.000Z');
    });

    await t.test('accepts epoch milliseconds', () => {
        assert.strictEqual(parseDeviceTime(1785066264000).toISOString(), '2026-07-26T11:44:24.000Z');
    });

    await t.test('accepts ISO-8601', () => {
        assert.strictEqual(parseDeviceTime('2026-07-26T11:44:24Z').toISOString(), '2026-07-26T11:44:24.000Z');
    });

    await t.test('rejects absent, empty and non-time values', () => {
        for (const v of [null, undefined, '', '   ', 'not-a-date', 0, -1, {}, []]) {
            assert.strictEqual(parseDeviceTime(v), null, `expected null for ${JSON.stringify(v)}`);
        }
    });
});

test('resolveReadingTime', async (t) => {
    const now = Date.parse('2026-07-26T12:00:00Z');

    await t.test('trusts a current device clock', () => {
        const r = resolveReadingTime((now - 30 * SEC) / 1000, now);
        assert.strictEqual(r.source, 'DEVICE');
        assert.strictEqual(r.time.getTime(), now - 30 * SEC);
    });

    await t.test('trusts a store-and-forward replay from hours ago', () => {
        // The case the whole change exists for: a buffered batch must land at
        // the time it was measured, not the time it arrived.
        const measured = now - 6 * HOUR;
        const r = resolveReadingTime(measured / 1000, now);
        assert.strictEqual(r.source, 'DEVICE');
        assert.strictEqual(r.time.getTime(), measured);
    });

    await t.test('falls back to arrival when there is no device timestamp', () => {
        const r = resolveReadingTime(null, now);
        assert.strictEqual(r.source, 'ARRIVAL');
        assert.strictEqual(r.time.getTime(), now);
        assert.strictEqual(r.deviceTime, null);
        assert.match(r.reason, /no device timestamp/);
    });

    await t.test('rejects a clock too far behind, but keeps what it claimed', () => {
        const claimed = now - 60 * DAY;
        const r = resolveReadingTime(claimed / 1000, now);
        assert.strictEqual(r.source, 'ARRIVAL');
        assert.strictEqual(r.time.getTime(), now, 'reading is stamped with arrival time');
        assert.strictEqual(r.deviceTime.getTime(), claimed, 'device claim is retained for audit');
        assert.match(r.reason, /behind/);
    });

    await t.test('rejects a clock running ahead of real time', () => {
        const r = resolveReadingTime((now + 2 * HOUR) / 1000, now);
        assert.strictEqual(r.source, 'ARRIVAL');
        assert.strictEqual(r.time.getTime(), now);
        assert.match(r.reason, /ahead/);
    });

    await t.test('tolerates minor forward drift within the skew window', () => {
        const drifted = now + 30 * SEC;
        const r = resolveReadingTime(drifted / 1000, now);
        assert.strictEqual(r.source, 'DEVICE', '30s of drift should not force a fallback');
        assert.strictEqual(r.time.getTime(), drifted);
    });

    await t.test('a rejected timestamp never yields an invalid date', () => {
        for (const v of ['garbage', '', undefined, {}]) {
            const r = resolveReadingTime(v, now);
            assert.ok(!isNaN(r.time.getTime()), `invalid Date produced for ${JSON.stringify(v)}`);
            assert.strictEqual(r.source, 'ARRIVAL');
        }
    });
});
