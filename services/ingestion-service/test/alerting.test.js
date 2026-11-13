// Alert evaluation (src/alerting.ts): thresholds, the averaging basis in every
// message, dedupe keys, and the THD-I rule (no limit claimed unless declared).

const test = require('node:test');
const assert = require('node:assert');

const {
    evaluateTenMinute, evaluateDemand, evaluateInstantMdi, evaluateEvent, evaluateHealth, formatDuration,
} = require('../dist/alerting.js');

const tenMin = (over = {}) => ({
    tenant_id: 't1', meter_id: 'm1', bucket: '2026-11-04T10:20:00Z', n_interrupt: 0,
    v_rms_a: 230, v_rms_b: 231, v_rms_c: 229, thd_v_a: 2, thd_v_b: 2, thd_v_c: 2,
    thd_i_a: 9, thd_i_b: 9, thd_i_c: 9,
    alert_min_v: null, alert_max_v: null, alert_max_thd: null, alert_max_thd_i: null, ...over,
});

test('10-minute values inside limits raise nothing', () => {
    assert.deepStrictEqual(evaluateTenMinute(tenMin()), []);
});

test('undervoltage on 10-minute RMS: NRS 048 defaults, worst phase first, basis stated', () => {
    const [a, ...rest] = evaluateTenMinute(tenMin({ v_rms_b: 201.34, v_rms_c: 205.0 }));
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(a.type, 'VOLTAGE_SAG');
    assert.strictEqual(a.severity, 'CRITICAL');
    assert.match(a.message, /^10-minute RMS voltage below the 207 V limit on L2 201\.3 V, L3 205\.0 V \(12:20–12:30 SAST\)/);
    assert.match(a.message, /10-minute values/);
    assert.strictEqual(a.dedupeKey, '2026-11-04T10', 'one per meter per type per hour');
});

test('site limits override the defaults (e.g. an MV meter configured per site)', () => {
    const row = tenMin({ v_rms_a: 11_000, v_rms_b: 11_050, v_rms_c: 10_980, alert_min_v: '10450', alert_max_v: '11550' });
    assert.deepStrictEqual(evaluateTenMinute(row), []);
    const [hi] = evaluateTenMinute({ ...row, v_rms_a: 11_700 });
    assert.strictEqual(hi.type, 'OVERVOLTAGE');
    assert.match(hi.message, /above the 11550 V limit on L1 11700\.0 V/);
});

test('an interval containing an interruption is not assessed', () => {
    assert.deepStrictEqual(evaluateTenMinute(tenMin({ n_interrupt: 4, v_rms_a: 150 })), []);
});

test('voltage THD on 10-minute values against the 8% default', () => {
    const [a] = evaluateTenMinute(tenMin({ thd_v_c: 8.6 }));
    assert.strictEqual(a.type, 'HIGH_THD');
    assert.match(a.message, /10-minute average voltage THD above the 8% limit on L3 8\.60%/);
});

test('current THD: no alert and no limit claimed unless the site declares one', () => {
    assert.deepStrictEqual(evaluateTenMinute(tenMin({ thd_i_a: 45 })), []);
    const [a] = evaluateTenMinute(tenMin({ thd_i_a: 18.24, alert_max_thd_i: '15.00' }));
    assert.strictEqual(a.type, 'HIGH_THD_I');
    assert.match(a.message, /declared 15% limit on L1 18\.2%/);
    assert.match(a.message, /not NRS 048-2/);
    assert.doesNotMatch(a.message, /NRS 048-2 (limit|assesses)/);
});

test('demand: 30-minute averages against contracted MDI and the kW limit', () => {
    const base = { tenant_id: 't1', meter_id: 'm1', bucket: '2026-11-04T10:00:00Z', minutes: 30, kva_demand: '816.2', kw_demand: '790', contracted_mdi_kva: '800', alert_max_kw: '750' };
    const out = evaluateDemand(base);
    assert.deepStrictEqual(out.map((a) => a.type), ['MDI_EXCEEDED', 'PEAK_DEMAND']);
    assert.match(out[0].message, /^30-minute average demand of 816\.2 kVA \(12:00–12:30 SAST\) exceeded the 800 kVA contracted MDI \(102%\)/);
    assert.match(out[1].message, /^30-minute average demand of 790\.0 kW/);
    assert.strictEqual(out[0].dedupeKey, '2026-11-04T10:00:00.000Z');
    assert.deepStrictEqual(evaluateDemand({ ...base, kva_demand: '730', kw_demand: '700' }).map((a) => a.type), ['MDI_WARNING']);
    assert.deepStrictEqual(evaluateDemand({ ...base, minutes: 20 }), [], 'under 80% coverage is not a billed figure');
});

test('instantaneous MDI warning keeps its careful wording', () => {
    const [a] = evaluateInstantMdi({ tenant_id: 't1', meter_id: 'm1', bucket: '2026-11-04T10:07:00Z', kva_max: '812', contracted_mdi_kva: '800' });
    assert.strictEqual(a.type, 'MDI_INSTANT');
    assert.match(a.message, /^Instantaneous load reached 812\.0 kVA at 12:07 SAST \(highest 1-second reading in that minute\)/);
    assert.match(a.message, /Billed demand is the highest 30-minute average/);
    assert.deepStrictEqual(evaluateInstantMdi({ tenant_id: 't1', meter_id: 'm1', bucket: 'x', kva_max: '700', contracted_mdi_kva: '800' }), []);
});

test('events: by type and duration, per-site minimum, keyed on the event', () => {
    const ev = { tenant_id: 't1', meter_id: 'm1', id: 'e-1', type: 'UNDERVOLTAGE', channel: 'voltage_b',
        started_at: '2026-11-04T10:05:00Z', ended_at: '2026-11-04T10:05:42Z', duration_s: 42, extreme_value: 196.21, threshold: 207, event_alert_min_s: null };
    const [a] = evaluateEvent(ev, 10);
    assert.strictEqual(a.type, 'EVENT_UNDERVOLTAGE');
    assert.strictEqual(a.dedupeKey, 'e-1');
    assert.match(a.message, /^Undervoltage on L2 lasting 42 s from 12:05 SAST: lowest 196\.2 V against the 207 V limit \(event duration from 1-second readings/);
    assert.deepStrictEqual(evaluateEvent({ ...ev, duration_s: 6 }, 10), [], 'shorter than the default minimum');
    assert.deepStrictEqual(evaluateEvent({ ...ev, event_alert_min_s: 60 }, 10), [], 'site minimum wins');
    const [ongoing] = evaluateEvent({ ...ev, ended_at: null, duration_s: 400, type: 'OVERFREQUENCY', channel: 'frequency', extreme_value: 51.37, threshold: 51 }, 10);
    assert.strictEqual(ongoing.severity, 'CRITICAL');
    assert.match(ongoing.message, /^Overfrequency on frequency ongoing for 7 min .* highest 51\.37 Hz against the 51 Hz limit/);
});

test('data health', async (t) => {
    const now = new Date('2026-11-04T10:12:00Z');
    const row = (over) => ({ tenant_id: 't1', meter_id: 'm1', meter_name: 'Main', last_reading: '2026-11-04T10:11:58Z',
        hour_samples: 3600, typical_spacing_s: 1, drift_s: 1, drift_prev_s: 1, conflicts: 0, conflicts_prev: 0, ...over });

    await t.test('healthy meter: nothing', () => assert.deepStrictEqual(evaluateHealth(row({}), now, 5), []));

    await t.test('silent meter: one alert per silence, nothing else', () => {
        const out = evaluateHealth(row({ last_reading: '2026-11-04T09:55:00Z', hour_samples: 100 }), now, 5);
        assert.deepStrictEqual(out.map((a) => a.type), ['METER_SILENT']);
        assert.strictEqual(out[0].dedupeKey, 'silent:2026-11-04T09:55:00.000Z');
        assert.match(out[0].message, /no readings for 17 min/);
    });

    await t.test('coverage below 95% relative to the meter\'s usual interval', () => {
        const [a] = evaluateHealth(row({ hour_samples: 3240 }), now, 5);
        assert.strictEqual(a.type, 'LOW_COVERAGE');
        assert.match(a.message, /90% data coverage in the hour from 11:00 SAST \(3240 of about 3600 readings/);
        // A meter that reports every 5 minutes is complete with 12 readings an hour.
        assert.deepStrictEqual(evaluateHealth(row({ hour_samples: 12, typical_spacing_s: 300 }), now, 5), []);
    });

    await t.test('clock drift above 120 s, or growing', () => {
        assert.strictEqual(evaluateHealth(row({ drift_s: 185 }), now, 5)[0].type, 'CLOCK_DRIFT');
        assert.strictEqual(evaluateHealth(row({ drift_s: 75, drift_prev_s: 20 }), now, 5)[0].type, 'CLOCK_DRIFT');
        assert.deepStrictEqual(evaluateHealth(row({ drift_s: 75, drift_prev_s: 70 }), now, 5), []);
    });

    await t.test('rising duplicate-timestamp counts', () => {
        assert.strictEqual(evaluateHealth(row({ conflicts: 400, conflicts_prev: 10 }), now, 5)[0].type, 'CONFLICTS_RISING');
        assert.deepStrictEqual(evaluateHealth(row({ conflicts: 400, conflicts_prev: 380 }), now, 5), [], 'steady, not rising');
        assert.deepStrictEqual(evaluateHealth(row({ conflicts: 30, conflicts_prev: 0 }), now, 5), [], 'too few to matter');
    });
});

test('every alert message states its averaging basis', () => {
    const all = [
        ...evaluateTenMinute(tenMin({ v_rms_a: 190, v_rms_b: 260, thd_v_a: 9, thd_i_a: 30, alert_max_thd_i: 20 })),
        ...evaluateDemand({ tenant_id: 't', meter_id: 'm', bucket: '2026-11-04T10:00:00Z', minutes: 30, kva_demand: 900, kw_demand: 900, contracted_mdi_kva: 800, alert_max_kw: 800 }),
        ...evaluateInstantMdi({ tenant_id: 't', meter_id: 'm', bucket: '2026-11-04T10:00:00Z', kva_max: 900, contracted_mdi_kva: 800 }),
        ...evaluateEvent({ tenant_id: 't', meter_id: 'm', id: 'e', type: 'OVERVOLTAGE', channel: 'voltage_a', started_at: '2026-11-04T10:00:00Z', ended_at: null, duration_s: 30, extreme_value: 270, threshold: 253, event_alert_min_s: null }, 10),
    ];
    assert.strictEqual(all.length, 8);
    for (const a of all) assert.match(a.message, /10-minute|30-minute|1-second|event duration/, `${a.type}: ${a.message}`);
});

test('formatDuration', () => {
    assert.strictEqual(formatDuration(42), '42 s');
    assert.strictEqual(formatDuration(400), '7 min');
    assert.strictEqual(formatDuration(7200), '2.0 h');
});
