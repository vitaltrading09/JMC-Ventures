'use strict';
// Rule-based findings (src/findings-rules.ts) and the metering report maths
// (src/metering-report.ts), on numbers only.

const test = require('node:test');
const assert = require('node:assert');
const { evaluateRules } = require('../dist/findings-rules.js');
const {
    parseWindows, touPeriod, touSplit, loadShape, extremes, peakShaving, arbitrage, pvShape, solarOwnUse,
    buildReport, ASSUMPTIONS,
} = require('../dist/metering-report.js');
const { clientSeesDraftFindings, seesUnpublishedFindings } = require('../dist/scope.js');

const healthy = {
    hours: 168, pf_avg_loaded: 0.96, pf_low_share: 0.01, kva_peak_10m: 400, thd_v_p95: 3, thd_v_phase: 'A',
    current_unbalance_avg: 5, v_nominal: 230, v_min: 221, sag_intervals: 0,
    demand_max_kva: 380, demand_over: 0, mdi_kva: 500, tariff_demand: 245, night_kw: 60, day_kw: 300,
};

test('rules: a healthy point has no findings, and too little data gives no verdict', () => {
    assert.deepStrictEqual(evaluateRules(healthy), []);
    assert.deepStrictEqual(evaluateRules({ ...healthy, hours: 10, pf_avg_loaded: 0.5 }), []);
});

test('rules: each condition produces its finding with the numbers used', () => {
    const types = (m) => evaluateRules({ ...healthy, ...m }).map((f) => f.type);
    assert.deepStrictEqual(types({ pf_avg_loaded: 0.76, pf_low_share: 0.64 }), ['RULE_LOW_PF']);
    assert.deepStrictEqual(types({ thd_v_p95: 9.4 }), ['RULE_HIGH_THD_V']);
    assert.deepStrictEqual(types({ current_unbalance_avg: 31 }), ['RULE_CURRENT_IMBALANCE']);
    assert.deepStrictEqual(types({ demand_max_kva: 1180, demand_over: 7, mdi_kva: 1000 }), ['RULE_MDI_EXCEEDED']);
    assert.deepStrictEqual(types({ sag_intervals: 12, v_min: 190 }), ['RULE_VOLTAGE_SAGS']);
    assert.deepStrictEqual(types({ night_kw: 240, day_kw: 300 }), ['RULE_HIGH_BASELOAD']);
    const base = evaluateRules({ ...healthy, night_kw: 240, day_kw: 300 })[0];
    assert.strictEqual(base.saving_zar, 0);                  // conditional: stated in the text only
    assert.match(base.solution, /around the clock/);

    const pf = evaluateRules({ ...healthy, pf_avg_loaded: 0.76, pf_low_share: 0.64 })[0];
    assert.strictEqual(pf.priority, 1);                      // below 0.85
    assert.strictEqual(pf.values.kva_at_target, Math.round(380 * 0.76 / 0.95));
    assert.strictEqual(pf.saving_zar, Math.round((380 - 380 * 0.76 / 0.95) * 245));
    const mdi = evaluateRules({ ...healthy, demand_max_kva: 1180, demand_over: 7, mdi_kva: 1000 })[0];
    assert.strictEqual(mdi.saving_zar, 180 * 245);
    assert.match(mdi.problem, /7 half-hour intervals/);
});

test('draft findings for clients are a setting, off by default; internal users always see them', () => {
    const before = process.env.CLIENT_SEES_DRAFT_FINDINGS;
    try {
        delete process.env.CLIENT_SEES_DRAFT_FINDINGS;
        assert.strictEqual(clientSeesDraftFindings(), false);
        assert.strictEqual(seesUnpublishedFindings({ isInternal: false }), false);
        assert.strictEqual(seesUnpublishedFindings({ isInternal: true }), true);
        process.env.CLIENT_SEES_DRAFT_FINDINGS = 'true';
        assert.strictEqual(seesUnpublishedFindings({ isInternal: false }), true);
    } finally {
        if (before === undefined) delete process.env.CLIENT_SEES_DRAFT_FINDINGS; else process.env.CLIENT_SEES_DRAFT_FINDINGS = before;
    }
});

// 2026-11-02 is a Monday. SAST = UTC+2.
const at = (day, h, m = 0) => new Date(Date.UTC(2026, 10, day, h - 2, m));
const T = { peak: 5.8, standard: 2.4, offpeak: 1.4, demand: 245, peak_times: '07:00 - 10:00, 18:00 - 20:00', standard_times: '06:00 - 07:00, 10:00 - 18:00, 20:00 - 22:00', offpeak_times: '22:00 - 06:00' };

test('TOU periods: weekday windows, Saturday, Sunday, wrap over midnight', () => {
    assert.deepStrictEqual(parseWindows('22:00 - 06:00'), [[22, 6]]);
    assert.strictEqual(touPeriod(at(2, 8), T), 'peak');
    assert.strictEqual(touPeriod(at(2, 12), T), 'standard');
    assert.strictEqual(touPeriod(at(2, 23), T), 'offpeak');
    assert.strictEqual(touPeriod(at(2, 3), T), 'offpeak');
    assert.strictEqual(touPeriod(at(7, 8), T), 'standard');   // Saturday morning
    assert.strictEqual(touPeriod(at(7, 14), T), 'offpeak');
    assert.strictEqual(touPeriod(at(8, 8), T), 'offpeak');    // Sunday
});

/** Three weekdays of half-hours: 100 kW base, 400 kW from 08:00 to 09:00 (a spike). */
function days(n = 3) {
    const rows = [];
    for (let d = 0; d < n; d++) for (let s = 0; s < 48; s++) {
        const t = at(2 + d, 0, s * 30);
        const h = s / 2;
        const kw = h >= 8 && h < 9 ? 400 : 100;
        rows.push({ t, kw, kva: kw / 0.9, kva_demand: kw / 0.9, pf: 0.9, minutes: 30 });
    }
    return rows;
}

test('TOU split and load shape on a known profile', () => {
    const rows = days();
    const tou = touSplit(rows, T);
    const kwh = Object.fromEntries(tou.map((x) => [x.period, x.kwh]));
    // Per day: peak 07-10 = 1 h at 100 + 1 h at 400 + 1 h at 100 = 600; 18-20 = 200 -> 800 peak.
    assert.strictEqual(kwh.peak, 3 * 800);
    assert.strictEqual(kwh.peak + kwh.standard + kwh.offpeak, 3 * (100 * 23 + 400));
    assert.strictEqual(tou.find((x) => x.period === 'peak').cost_zar, Math.round(3 * 800 * 5.8));

    const shape = loadShape(rows);
    assert.strictEqual(shape.max_kw, 400);
    assert.strictEqual(Math.round(shape.max_demand_kva), Math.round(400 / 0.9));
    assert.strictEqual(shape.intervals_within_10pct_of_max, 6);   // 2 half-hours a day, 3 days
    assert.strictEqual(shape.weekday_profile[16].avg_kw, 400);    // 08:00 slot
    assert.strictEqual(shape.weekend_profile[16].avg_kw, null);
    assert.strictEqual(shape.baseload_kw, 100);
});

test('extremes keep the phase and the time of the worst and best values', () => {
    const rows = [
        { t: at(2, 1), vmin: [228, 226, 229], vmax: [236, 237, 235], imax: [10, 12, 11], thdv: [2, 3, 2], thdi: [10, 9, 8], pf: 0.95, kw: 100, fmin: 49.95, fmax: 50.05, vunb: 0.5, iunb: 4 },
        { t: at(2, 2), vmin: [205, 227, 228], vmax: [240, 246, 239], imax: [30, 25, 28], thdv: [4, 9.5, 3], thdi: [12, 15, 11], pf: 0.71, kw: 300, fmin: 49.8, fmax: 50.1, vunb: 1.2, iunb: 22 },
    ];
    const e = extremes(rows);
    assert.deepStrictEqual(e.voltage_low.worst, { value: 205, at: at(2, 2), phase: 'A' });
    assert.deepStrictEqual(e.voltage_high.worst, { value: 246, at: at(2, 2), phase: 'B' });
    assert.deepStrictEqual(e.thd_voltage.worst, { value: 9.5, at: at(2, 2), phase: 'B' });
    assert.strictEqual(e.power_factor_loaded.worst.value, 0.71);
    assert.strictEqual(e.power_factor_loaded.best.value, 0.95);
    assert.strictEqual(e.frequency_low.worst.value, 49.8);
});

test('peak shaving sizes the battery from the energy above each target', () => {
    const rows = days();
    const maxKva = 400 / 0.9;
    const [p90, p80] = peakShaving(rows, T, maxKva, 0.9);
    // 90 %: target 360 kW; excess 40 kW for 1 h a day = 40 kWh usable, /0.9 DoD nameplate.
    assert.strictEqual(p90.battery_power_kw, 40);
    assert.strictEqual(p90.battery_energy_kwh, Math.round(40 / ASSUMPTIONS.bess_depth_of_discharge));
    assert.strictEqual(p90.monthly_saving_zar, Math.round(maxKva * 0.1 * 245));
    assert.strictEqual(p80.battery_power_kw, 80);
    assert.strictEqual(p90.days_with_shaving, 3);
});

test('arbitrage displaces only the site\'s own peak-window load', () => {
    const a = arbitrage(days(), T, 1000);
    assert.strictEqual(a.avg_weekday_peak_kwh, 800);
    assert.strictEqual(a.displaced_kwh_per_day, 800);           // battery (900 usable) > peak load
    const small = arbitrage(days(), T, 100);
    assert.strictEqual(small.displaced_kwh_per_day, 90);
    assert.strictEqual(small.margin_zar_per_kwh, Math.round((5.8 - 1.4 / 0.9) * 100) / 100);
    assert.strictEqual(arbitrage(days(), { ...T, peak: null }, 100), null);
});

test('PV shape integrates to the daily yield; solar sizes start at the no-export size', () => {
    let e = 0;
    for (let h = 0; h < 24; h += 0.01) e += pvShape(h) * 0.01;
    assert.ok(Math.abs(e - ASSUMPTIONS.pv_yield_kwh_per_kwp_day) < 0.01);
    const s = solarOwnUse(days(), T);
    assert.strictEqual(s.lowest_midday_load_kw, 100);
    assert.strictEqual(s.no_export_kwp, Math.round(100 / pvShape(12)));
    // At the no-export size nearly all generation is used on site (shape mismatch aside).
    assert.ok(s.options[0].self_consumption > 0.95);
    assert.ok(s.options[2].self_consumption < s.options[0].self_consumption);
});

test('the report states its basis and flags a peaky load near its MDI', () => {
    const rep = buildReport({ rows30: days(), rows10: [], tariffs: T, mdiKva: 450, vNominal: 230,
        energy: { importKwh: 7800, exportKwh: 0, coverage: 1 } });
    assert.match(rep.demand.basis, /30-minute/);
    assert.ok(rep.feasibility.notes.some((n) => n.level === 'watch' && /of the contracted 450 kVA/.test(n.text)));
    assert.ok(rep.feasibility.notes.some((n) => /short spikes/.test(n.text)));
    assert.strictEqual(rep.feasibility.peak_shaving.length, 3);
    assert.ok(rep.feasibility.arbitrage);
    assert.match(rep.feasibility.disclaimer, /not as a quote/);
});
