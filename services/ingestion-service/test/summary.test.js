'use strict';
// Coverage per 10-minute slot, the operating fingerprint and the site summary
// (src/reports/dataset.ts, src/reports/summary.ts). Pure functions, no database.
const test = require('node:test');
const assert = require('node:assert');
const { slotCoverage, typicalDay } = require('../dist/reports/dataset.js');
const S = require('../dist/reports/summary.js');

const T0 = Date.parse('2026-11-02T00:00:00Z');
const slot = (i, n, spacing) => ({ n, t_first: new Date(T0 + i * 600_000), t_last: new Date(T0 + i * 600_000 + (n - 1) * spacing * 1000) });

test('coverage: a 5-minute meter fully reporting is 100 %, not more', () => {
    const rows = Array.from({ length: 144 }, (_, i) => slot(i, 2, 300));
    const c = slotCoverage(rows, 300, 86_400);
    assert.strictEqual(c.expected_slots, 144);
    assert.strictEqual(c.fraction, 1);
    assert.strictEqual(c.mixed_cadence, false);
});

test('coverage: mixed cadences are counted per slot and disclosed, never summed past the window', () => {
    // 10 days: the first 9 at 300 s, the last day at 5 s (a live feed). Samples far exceed 300-s expectations.
    const rows = [];
    for (let i = 0; i < 9 * 144; i++) rows.push(slot(i, 2, 300));
    for (let i = 9 * 144; i < 10 * 144; i++) rows.push(slot(i, 120, 5));
    const c = slotCoverage(rows, 300, 10 * 86_400);
    assert.strictEqual(c.fraction, 1);
    assert.strictEqual(c.samples, 9 * 144 * 2 + 144 * 120);
    assert.strictEqual(c.mixed_cadence, true);
    // Half of the slots missing → 50 %.
    const half = slotCoverage(rows.filter((_, i) => i % 2 === 0), 300, 10 * 86_400);
    assert.strictEqual(half.fraction, 0.5);
});

test('coverage: a sparse slot counts only the time its samples represent', () => {
    const c = slotCoverage([slot(0, 1, 60)], 60, 600);
    assert.strictEqual(c.fraction, 0.1);
});

test('typical day: one weekday gives that day, no band; three give a P10–P90 band', () => {
    const t = [], kw = [];
    // Mon 2 Nov – Wed 4 Nov 2026, hourly, SAST = UTC+2.
    for (let d = 0; d < 3; d++) for (let h = 0; h < 24; h++) {
        t.push(new Date(Date.parse('2026-11-01T22:00:00Z') + (d * 24 + h) * 3_600_000).toISOString());
        kw.push(h >= 8 && h < 17 ? 100 + d * 10 : 20);
    }
    const one = typicalDay(t.slice(0, 24), kw.slice(0, 24), false);
    assert.strictEqual(one.days, 1);
    assert.strictEqual(one.band, false);
    assert.strictEqual(one.hours[10].median, 100);
    assert.strictEqual(one.hours[10].p10, null);
    const three = typicalDay(t, kw, false);
    assert.strictEqual(three.days, 3);
    assert.strictEqual(three.hours[10].median, 110);
    assert.ok(three.hours[10].p10 < 110 && three.hours[10].p90 > 110);
    assert.strictEqual(typicalDay(t, kw, true).days, 0);
});

const ds = (over = {}) => ({
    provisional: true, data_cutoff_at: '2026-11-12T10:00:00Z', versions: {},
    assessment: { id: 'a', reference: 'GQ-A-1', site: 'Sandton', observed_days: 10, period_from: '2026-11-02T08:00:00Z', period_to: '2026-11-12T08:00:00Z', start_at: '2026-11-02T08:00:00Z', end_at: '2026-11-16T08:00:00Z' },
    executive: [], limitations: [], feasibility_readiness: { missing: [] },
    points: [{
        id: 'p1', name: 'Main incomer', role: 'incomer', parent_point_id: null,
        coverage: { fraction: 0.97, gaps: [], mixed_cadence: false },
        energy: { import_kwh: 24000, method: 'register' },
        demand: { max_kva: 200, max_kw: 190, contracted_mdi_kva: 400, utilisation: 0.5, intervals_over_mdi: 0 },
        patterns: { baseload_ratio: 0.3, operating_avg_kw: 150, typical_weekday: null },
        power_quality: { voltage: [{ phase: 'A', outside_pct: 0 }], thd_v: [{ phase: 'A', p95: 3, worst_hours: [14] }], pf: { avg_loaded: 0.95 },
                         unbalance: { current_p95: 5 }, frequency: { outside_values: 0 }, interruption_minutes: 0 },
        hourly_series: { t: [] },
        ...over,
    }],
});

test('summary: a healthy site gets a meaningful summary and no follow-up areas', () => {
    const s = S.buildSummary(ds());
    assert.deepStrictEqual(s.categories.map((c) => c.state), ['ok', 'ok', 'ok', 'ok']);
    assert.ok(s.glance.some((g) => /No material issue/.test(g)));
    assert.strictEqual(s.metrics.length, 4);
    assert.strictEqual(s.metrics.find((m) => m.key === 'load_factor').value, Math.round((24000 / 240 / 190) * 100));
    assert.ok(s.next.length >= 1);
});

test('summary: distortion and missing contracted demand are separate states', () => {
    const s = S.buildSummary(ds({
        demand: { max_kva: 200, max_kw: 190, contracted_mdi_kva: null, utilisation: null },
        power_quality: { voltage: [{ phase: 'A', outside_pct: 0 }], thd_v: [{ phase: 'A', p95: 9.5, worst_hours: [13, 14] }], pf: { avg_loaded: 0.93 },
                         unbalance: { current_p95: 5 }, frequency: { outside_values: 0 }, interruption_minutes: 0 },
    }));
    const by = Object.fromEntries(s.categories.map((c) => [c.key, c.state]));
    assert.strictEqual(by.supply, 'investigate');
    assert.strictEqual(by.demand, 'insufficient');
    assert.strictEqual(by.load, 'ok');            // PF 0.93 is not turned into a finding
    assert.ok(s.glance.some((g) => /13:00, 14:00/.test(g)));
});

test('summary: six hours of data is an honest partial assessment', () => {
    const d = ds();
    d.assessment.observed_days = 0.25;
    const s = S.buildSummary(d);
    assert.strictEqual(s.categories.find((c) => c.key === 'measurement').state, 'insufficient');
    assert.ok(/partial/.test(s.glance[0]));
});

test('summary: the requested point is used, else the top-level incomer', () => {
    const d = ds();
    d.points.unshift({ ...d.points[0], id: 'sub', name: 'Sub board', role: 'sub_load', parent_point_id: 'p1' });
    assert.strictEqual(S.buildSummary(d).context.point.id, 'p1');
    assert.strictEqual(S.buildSummary(d, 'sub').context.point.id, 'sub');
});
