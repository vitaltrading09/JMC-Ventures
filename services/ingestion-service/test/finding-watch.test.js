'use strict';
// Finding watches (src/finding-watch.ts): window, day segments, observations,
// verdict and the measured-data conclusion. Pure functions, no database.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../dist/finding-watch.js');

const T0 = Date.parse('2026-11-10T00:00:00+02:00'); // SAST midnight
const row = (i, x) => ({ bucket: new Date(T0 + i * 600_000), power_active_total_avg: 100, power_active_total_max: 110, power_factor_total_avg: 0.95,
    voltage_a_min: 228, voltage_b_min: 229, voltage_c_min: 230, thd_voltage_a_avg: 3, thd_voltage_b_avg: 3, thd_voltage_c_avg: 3, current_unbalance_avg: 5, ...x });
const day = (f) => Array.from({ length: 144 }, (_, i) => row(i, f ? f(i) : {}));
const data = (rows, extra = {}) => ({ rows10m: rows, lows1m: [], demand30m: [], nominalV: 230, mdiKva: null, ...extra });
const D0 = new Date(T0), D1 = new Date(T0 + 86_400_000);

test('kind follows the finding type', () => {
    assert.strictEqual(W.kindFor('RULE_VOLTAGE_SAGS'), 'sags');
    assert.strictEqual(W.kindFor('RULE_HIGH_THD_V'), 'thd');
    assert.strictEqual(W.kindFor('RULE_LOW_PF'), 'pf');
    assert.strictEqual(W.kindFor('RULE_MDI_EXCEEDED'), 'demand');
    assert.strictEqual(W.kindFor('RULE_CURRENT_IMBALANCE'), 'imbalance');
    assert.strictEqual(W.kindFor('RULE_HIGH_BASELOAD'), 'baseload');
    assert.strictEqual(W.kindFor('MAINTENANCE'), 'general');
});

test('watch ends at the end of the due day (SAST), at least a day, never past the assessment', () => {
    const now = new Date('2026-11-12T08:00:00Z');
    const far = new Date('2026-12-30T00:00:00Z');
    assert.strictEqual(W.watchUntil(now, '2026-11-14', far).toISOString(), '2026-11-14T22:00:00.000Z');
    assert.strictEqual(W.watchUntil(now, null, far).toISOString(), '2026-11-15T08:00:00.000Z');
    assert.strictEqual(W.watchUntil(now, '2026-11-12', far).toISOString(), '2026-11-13T08:00:00.000Z'); // due today → a full day
    assert.strictEqual(W.watchUntil(now, null, new Date('2026-11-13T10:00:00Z')).toISOString(), '2026-11-13T10:00:00.000Z');
});

test('day segments are SAST days clipped to the watch', () => {
    const s = W.daySegments(new Date('2026-11-12T08:00:00Z'), new Date('2026-11-14T10:00:00Z'));
    assert.deepStrictEqual(s.map((x) => x.day), ['2026-11-12', '2026-11-13', '2026-11-14']);
    assert.strictEqual(s[0].from.toISOString(), '2026-11-12T08:00:00.000Z');
    assert.strictEqual(s[1].from.toISOString(), '2026-11-12T22:00:00.000Z');
    assert.strictEqual(s[2].to.toISOString(), '2026-11-14T10:00:00.000Z');
});

test('dips: consecutive low minutes are one dip; load steps are counted', () => {
    const at = (h, m) => new Date(T0 + (h * 60 + m) * 60_000);
    const lows1m = [
        { bucket: at(6, 0), vmin: 200, kw_max: 300, kw_prev: 100 },   // motor start
        { bucket: at(6, 1), vmin: 203, kw_max: 290, kw_prev: 280 },   // same dip
        { bucket: at(6, 30), vmin: 205, kw_max: 300, kw_prev: 120 },  // another start
        { bucket: at(14, 0), vmin: 199, kw_max: 110, kw_prev: 105 },  // no load step
    ];
    const o = W.observe('sags', data(day(), { lows1m }), D0, D1);
    assert.strictEqual(o.seen, true);
    assert.strictEqual(o.metrics.dips, 3);
    assert.strictEqual(o.metrics.with_load_step, 2);
    assert.strictEqual(o.metrics.lowest_v, 199);
    assert.match(o.headline, /3 dips below 207 V/);
    assert.match(W.suggestion('sags', 'persists', o), /motors/);
    const none = W.observe('sags', data(day()), D0, D1);
    assert.strictEqual(none.seen, false);
    assert.match(none.headline, /No dips/);
});

test('distortion that follows the load points to the site; quiet days are not seen', () => {
    const busy = day((i) => { const on = i >= 42 && i < 102; return { power_active_total_avg: on ? 400 : 80, thd_voltage_b_avg: on ? 9.5 : 3 }; });
    const o = W.observe('thd', data(busy), D0, D1);
    assert.strictEqual(o.seen, true);
    assert.strictEqual(o.metrics.above, 60);
    assert.ok(o.metrics.corr_kw > 0.9);
    assert.match(o.headline, /rose and fell with the site load/);
    assert.strictEqual(o.metrics.busy_hours, null); // 10 hours: not clustered in two
    assert.strictEqual(W.observe('thd', data(day()), D0, D1).seen, false);
});

test('power factor, demand, unbalance and baseload', () => {
    assert.strictEqual(W.observe('pf', data(day(() => ({ power_factor_total_avg: 0.78 }))), D0, D1).seen, true);
    assert.strictEqual(W.observe('pf', data(day()), D0, D1).seen, false);
    const dem = [{ bucket: new Date(T0 + 9 * 3_600_000), kva_demand: 1100 }, { bucket: new Date(T0 + 10 * 3_600_000), kva_demand: 900 }];
    const d = W.observe('demand', data(day(), { demand30m: dem, mdiKva: 1000 }), D0, D1);
    assert.strictEqual(d.seen, true); assert.strictEqual(d.metrics.over, 1);
    assert.strictEqual(W.observe('demand', data(day(), { demand30m: dem }), D0, D1).seen, false); // no limit recorded
    assert.strictEqual(W.observe('imbalance', data(day(() => ({ current_unbalance_avg: 22 }))), D0, D1).seen, true);
    const b = W.observe('baseload', data(day((i) => ({ power_active_total_avg: i < 30 ? 90 : 100 }))), D0, D1);
    assert.strictEqual(b.metrics.night_kw, 90);
});

test('verdict: persists, intermittent, not seen, insufficient', () => {
    const seen = { seen: true, values: 144, expected: 144 }, clear = { seen: false, values: 144, expected: 144 };
    const whole = (s, values = 432) => ({ seen: s, values, expected: 432 });
    assert.strictEqual(W.verdictOf(whole(true), [seen, seen, seen]), 'persists');
    assert.strictEqual(W.verdictOf(whole(true), [seen, clear, seen]), 'intermittent');
    assert.strictEqual(W.verdictOf(whole(false), [clear, clear, clear]), 'not_seen');
    const empty = { seen: false, values: 10, expected: 144 };
    assert.strictEqual(W.verdictOf(whole(true, 100), [empty, seen]), 'persists'); // judged on the days with data
    assert.strictEqual(W.verdictOf(whole(false, 10), [empty]), 'insufficient');
});

test('conclusion: five sections, day lines, and the next step', () => {
    const o = W.observe('pf', data(day(() => ({ power_factor_total_avg: 0.78 }))), D0, D1);
    const notes = [{ day: '2026-11-09', headline: 'No measurements were received.', seen: false, values: 0, expected: 144 },
        { day: '2026-11-10', headline: o.headline, seen: true, values: 144, expected: 144 }];
    const t = W.conclusionText('pf', 'persists', o, notes, { point: 'Main incomer', from: D0, to: D1 });
    assert.deepStrictEqual(t.match(/^### .+$/gm), ['### In short', '### What the data shows', '### What it means', '### Suggested next step', '### Basis']);
    assert.match(t, /Average power factor while the site was working: 0\.78/);
    assert.match(t, /Move to Action/);
    assert.match(t, /every day of the watch with enough data \(1 day\)\. 1 day had too little data/);
    assert.match(t, /144 of 144 ten-minute values/);
    assert.doesNotMatch(t, /R\s?\d/); // no rand estimates
});
