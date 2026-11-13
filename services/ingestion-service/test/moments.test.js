'use strict';
// Close-ups (src/moments.ts): what the readings around a moment show, and the
// careful reading of site or supply. Pure functions, no database.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../dist/moments.js');

const T0 = Date.parse('2026-11-12T04:00:00Z'); // 06:00 SAST
const row = (i, x = {}) => ({ t: new Date(T0 + i * 1000), voltage_a: 231, voltage_b: 230, voltage_c: 229, current_a: 160, current_b: 158, current_c: 162,
    kw: 100, kva: 106, pf: 0.94, thd_a: 3, thd_b: 3.1, thd_c: 2.9, unbalance: 4, ...x });
const secs = (f) => Array.from({ length: 240 }, (_, i) => row(i, f(i)));
const opts = { nominalV: 230, mdiKva: 600 };

test('a dip with a load start reads as on site, with its duration and phases', () => {
    const rows = secs((i) => (i >= 120 && i < 128 ? { voltage_a: 201, voltage_b: 199.6, voltage_c: 202, kw: 190, current_a: 420, current_b: 430, current_c: 425 } : i >= 128 ? { kw: 150 } : {}));
    const m = M.momentFacts('sags', rows, opts);
    assert.strictEqual(m.value, 199.6); assert.strictEqual(m.phase, 'B'); assert.strictEqual(m.threshold, 207);
    assert.strictEqual(m.at, new Date(T0 + 120_000).toISOString());
    assert.strictEqual(m.reading, 'site');
    assert.match(m.facts.join(' '), /all three phases for about 8 s/);
    assert.match(m.facts.join(' '), /\+90 kW/);
    assert.match(m.facts.join(' '), /one per second/);
    assert.match(m.headline, /199\.6 V on phase B for about 8 s, as the load rose 90 kW/);
});

test('a three-phase dip without a load change reads as supply; a one-phase dip stays unclear', () => {
    const supply = M.momentFacts('sags', secs((i) => (i >= 100 && i < 103 ? { voltage_a: 195, voltage_b: 196, voltage_c: 194 } : {})), opts);
    assert.strictEqual(supply.reading, 'supply');
    assert.match(supply.reading_text, /utility/);
    const one = M.momentFacts('sags', secs((i) => (i === 100 ? { voltage_c: 200 } : {})), opts);
    assert.strictEqual(one.reading, 'unclear');
    assert.match(one.facts.join(' '), /on phase C for about 1 s/);
});

test('no reading under the level: says so and gives no duration', () => {
    const m = M.momentFacts('sags', secs((i) => (i === 50 ? { voltage_a: 215 } : {})), opts);
    assert.strictEqual(m.value, 215);
    assert.match(m.facts.join(' '), /No single reading crossed 207 V/);
    assert.doesNotMatch(m.headline, /for about/);
});

test('sparse meters: the cadence is stated', () => {
    const rows = Array.from({ length: 18 }, (_, i) => ({ ...row(0), t: new Date(T0 + i * 300_000), ...(i === 9 ? { voltage_a: 198 } : {}) }));
    const m = M.momentFacts('sags', rows, opts);
    assert.strictEqual(m.cadence_s, 300);
    assert.match(m.facts.join(' '), /5 min apart; anything shorter than that is not resolved/);
});

test('high voltage after load rejection, distortion with the load, demand ramp, unbalance, power factor', () => {
    const hv = M.momentFacts('voltage_high', secs((i) => (i >= 120 ? { voltage_a: 254, voltage_b: 255, voltage_c: 254.5, kw: 20 } : {})), opts);
    assert.strictEqual(hv.threshold, 253); assert.strictEqual(hv.reading, 'site'); assert.match(hv.reading_text, /tap/);
    const thd = M.momentFacts('thd', secs((i) => ({ kw: 100 + i, thd_b: 3 + i / 30 })), opts);
    assert.strictEqual(thd.reading, 'site'); assert.strictEqual(thd.phase, 'B'); assert.ok(thd.value > 10);
    const dem = M.momentFacts('demand', secs((i) => ({ kva: i < 100 ? 300 : Math.min(660, 300 + (i - 100) * 6), kw: 280 })), opts);
    assert.strictEqual(dem.value, 660); assert.match(dem.headline, /660 kVA, 110 % of the contracted limit/);
    assert.match(dem.facts.join(' '), /It climbed 3\d\d kVA in 5\d s \(from 3\d\d kVA at 06:01:4\d\)/);
    assert.match(dem.facts.join(' '), /30-minute average/);
    const unb = M.momentFacts('imbalance', secs((i) => (i === 30 ? { unbalance: 31, current_a: 300, current_b: 180, current_c: 150 } : {})), opts);
    assert.match(unb.headline, /31 % unbalance, phase A heaviest/);
    const pf = M.momentFacts('pf', secs((i) => (i >= 60 && i < 90 ? { pf: 0.71 } : {})), opts);
    assert.strictEqual(pf.value, 0.71); assert.match(pf.facts.join(' '), /Below 0\.85 in 30 of the 240 readings/);
});

test('empty input gives nothing; spread keeps the worst moments apart', () => {
    assert.strictEqual(M.momentFacts('sags', [], opts), null);
    const c = [{ t: 0, v: 1 }, { t: 60_000, v: 2 }, { t: 40 * 60_000, v: 3 }, { t: 41 * 60_000, v: 4 }, { t: 90 * 60_000, v: 5 }];
    assert.deepStrictEqual(M.spread(c, 3).map((x) => x.v), [1, 3, 5]);
});
