// The parameter → column mapping (src/ingest/channels.ts), from payload samples.
//   axm-web2-array.json: a real AXM-WEB2 store-and-forward message (Shoprite site)
//   dict-direct.json:    the direct-dict format, with the Phase 3 1-second channels

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { CHANNELS, CHANNEL_COLUMNS, parseTelemetry, cleanPayload, PayloadError, toNum } = require('../dist/ingest/channels.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('mapping table', async (t) => {
    await t.test('every column is unique', () => {
        assert.strictEqual(new Set(CHANNEL_COLUMNS).size, CHANNEL_COLUMNS.length);
    });

    await t.test('the 15 pre-Phase-3 columns keep their old candidate order', () => {
        const byCol = Object.fromEntries(CHANNELS.map((c) => [c.column, c.params]));
        assert.deepStrictEqual(byCol.voltage_a, ['V1', 'Va', 'Vavg', 'Vnavg_V', 'V_A', 'Voltage_LN', 'voltage_a']);
        assert.deepStrictEqual(byCol.current_a, ['I1', 'Ia', 'Iavg', 'Iavg_A', 'I_A', 'Current', 'current_a']);
        assert.deepStrictEqual(byCol.power_factor_total, ['PF', 'PFavg', 'PF1', 'Power_Factor', 'power_factor_total']);
        assert.deepStrictEqual(byCol.frequency, ['Freq_Hz', 'F', 'Freq', 'frequency']);
        assert.deepStrictEqual(byCol.energy_import_total, ['Ep_imp', 'kWh', 'energy_import_total']);
    });
});

test('AXM-WEB2 array format (real payload)', () => {
    const p = parseTelemetry(fixture('axm-web2-array.json'));
    // Values arrive as strings; they must come out as numbers.
    assert.strictEqual(p.values.voltage_a, 243.538);
    assert.strictEqual(p.values.voltage_b, 241.173);
    assert.strictEqual(p.values.voltage_c, 242.855);
    assert.strictEqual(p.values.current_a, 2.62);
    assert.strictEqual(p.values.current_c, 1.763);
    assert.strictEqual(p.values.power_active_total, 0.019);
    assert.strictEqual(p.values.power_reactive_total, -1.652);
    assert.strictEqual(p.values.power_apparent_total, 1.708);
    assert.strictEqual(p.values.power_factor_total, 0.011);
    assert.strictEqual(p.values.frequency, 50.054);
    // Per-phase channels this payload carries, newly stored in Phase 3
    assert.strictEqual(p.values.power_active_a, 0.171);
    assert.strictEqual(p.values.power_active_b, -0.141);
    assert.strictEqual(p.values.power_reactive_c, -0.425);
    assert.strictEqual(p.values.power_apparent_b, 0.641);
    assert.strictEqual(p.values.power_factor_a, 0.268);
    assert.strictEqual(p.values.power_factor_c, -0.026);
    // Not in this payload
    assert.strictEqual(p.values.voltage_ab, null);
    assert.strictEqual(p.values.energy_import_total, null);
    // Device clock from the top level, serial from device before gateway
    assert.strictEqual(p.rawTimestamp, 1771785069);
    assert.strictEqual(p.serial, 'AHB55050856');
    // Vnavg_V / Iavg_A are mapped (fallbacks), so nothing is unknown here
    assert.deepStrictEqual(p.unknownParams, []);
});

test('direct dict format with the 1-second channel set', () => {
    const p = parseTelemetry(fixture('dict-direct.json'));
    assert.strictEqual(p.values.voltage_a, 230.4);
    assert.strictEqual(p.values.voltage_b, 229.8, 'numeric strings are coerced');
    assert.strictEqual(p.values.voltage_ab, 399.1);
    assert.strictEqual(p.values.voltage_ca, 400.2);
    assert.strictEqual(p.values.current_n, 2.4);
    assert.strictEqual(p.values.thd_voltage_c, 2.0);
    assert.strictEqual(p.values.thd_current_b, 9.1);
    assert.strictEqual(p.values.voltage_unbalance, 0.6);
    assert.strictEqual(p.values.current_unbalance, 3.2);
    assert.strictEqual(p.values.energy_import_total, 128445.2);
    assert.strictEqual(p.values.energy_export_total, 12.5);
    assert.strictEqual(p.values.energy_reactive_import_total, 30211.7);
    assert.strictEqual(p.values.demand_active, 31.9);
    assert.strictEqual(p.values.demand_apparent, 33.0);
    assert.strictEqual(p.values.demand_reactive, null);
    assert.strictEqual(p.rawTimestamp, '2026-11-03T08:15:02Z', 'ISO timestamp kept as the raw string');
    assert.strictEqual(p.serial, null);
    assert.deepStrictEqual(p.unknownParams, ['Vthd_unknown_param']);
});

test('candidate priority and fallbacks', async (t) => {
    await t.test('first present candidate wins', () => {
        const p = parseTelemetry(JSON.stringify({ Va: 231, V1: 229, Vavg: 230 }));
        assert.strictEqual(p.values.voltage_a, 229);
    });
    await t.test('a non-numeric first candidate falls through to the next', () => {
        const p = parseTelemetry(JSON.stringify({ V1: 'n/a', Va: 231 }));
        assert.strictEqual(p.values.voltage_a, 231);
    });
    await t.test('PF1 feeds phase A and, without a total, the total (as before)', () => {
        const p = parseTelemetry(JSON.stringify({ V1: 230, PF1: 0.91 }));
        assert.strictEqual(p.values.power_factor_a, 0.91);
        assert.strictEqual(p.values.power_factor_total, 0.91);
    });
    await t.test('payload under Data', () => {
        const p = parseTelemetry(JSON.stringify({ Data: { I1: 12.5, ts: 1771785069 } }));
        assert.strictEqual(p.values.current_a, 12.5);
        assert.strictEqual(p.rawTimestamp, 1771785069);
    });
    await t.test('gateway serial when the device has none', () => {
        const p = parseTelemetry(JSON.stringify({ timestamp: 1, gateway: { serial: 'AN1' }, device: { readings: [{ param: 'V1', value: '230' }] } }));
        assert.strictEqual(p.serial, 'AN1');
    });
});

test('rejections (these are dead-lettered)', async (t) => {
    await t.test('invalid JSON', () => {
        assert.throws(() => parseTelemetry('{"V1": 230'), (e) => e instanceof PayloadError && /^JSON parse/.test(e.message));
    });
    await t.test('no core measurement', () => {
        assert.throws(() => parseTelemetry(JSON.stringify({ Freq_Hz: 50 })), (e) => e instanceof PayloadError && /No recognized/.test(e.message));
    });
    await t.test('a JSON scalar', () => {
        assert.throws(() => parseTelemetry('5'), (e) => e instanceof PayloadError && /No recognized/.test(e.message));
    });
});

test('cleanPayload strips control characters that break JSON.parse', () => {
    assert.strictEqual(cleanPayload(Buffer.from('\u0000{"V1":230}\u0007\n')), '{"V1":230}');
});

test('toNum', () => {
    assert.strictEqual(toNum('243.5'), 243.5);
    assert.strictEqual(toNum(' 1 '), 1);
    assert.strictEqual(toNum('abc'), null);
    assert.strictEqual(toNum(NaN), null);
    assert.strictEqual(toNum(Infinity), null);
    assert.strictEqual(toNum(null), null);
});
