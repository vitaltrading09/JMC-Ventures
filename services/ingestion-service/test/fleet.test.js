// Fleet model logic without a database: commissioning checklist, project
// energy balance, API input helpers (src/fleet/*).

const test = require('node:test');
const assert = require('node:assert');

const { evaluateCommissioning } = require('../dist/fleet/commissioning.js');
const { energyBalance } = require('../dist/fleet/balance.js');
const { normaliseCode, mqttUsernameFor, dbErrorResponse, pickFields, CORRECTION_FIELDS, InputError, isInternal } =
    require('../dist/fleet/routes.js');

const T0 = new Date('2026-11-04T08:00:00Z');
const min = (n) => new Date(T0.getTime() + n * 60_000);

// A healthy 15 minutes on a 230 V incomer with a 400 A CT.
const good = {
    total: 900, deviceSourced: 900, minutesWithData: 15, spacingS: 1, driftS: 1.2,
    vA: 231, vB: 229, vC: 233, pAvgKw: 55, pfAvg: 0.93, currentAvgA: 80, currentMaxA: 120,
};
const base = { installedAt: T0, role: 'incomer', nominalV: 230, ctPrimaryA: 400, powerSign: 1, scale: 1 };
const check = (r, id) => r.checks.find((c) => c.id === id);

test('commissioning', async (t) => {
    await t.test('a healthy install passes once the 15 minutes are over', () => {
        const r = evaluateCommissioning({ ...base, now: min(16), stats: good });
        assert.strictEqual(r.final, true);
        assert.strictEqual(r.overall, 'pass');
        assert.strictEqual(check(r, 'phase_rotation').status, 'not_reported');
        assert.strictEqual(r.window_to, min(15).toISOString());
    });

    await t.test('inside the window, missing data is pending; after it, a failure', () => {
        const none = { total: 0, deviceSourced: 0, minutesWithData: 0, spacingS: null, driftS: null, vA: null, vB: null, vC: null,
            pAvgKw: null, pfAvg: null, currentAvgA: null, currentMaxA: null };
        const early = evaluateCommissioning({ ...base, now: min(3), stats: none });
        assert.strictEqual(early.final, false);
        assert.strictEqual(early.overall, 'pending');
        assert.strictEqual(check(early, 'coverage').status, 'pending');
        const late = evaluateCommissioning({ ...base, now: min(20), stats: none });
        assert.strictEqual(late.overall, 'fail');
        assert.strictEqual(check(late, 'time_source').status, 'fail');
    });

    await t.test('a reversed CT fails the sign check on a PV point, and passes with power_sign -1', () => {
        const stats = { ...good, pAvgKw: -40 };
        const r = evaluateCommissioning({ ...base, role: 'pv', now: min(16), stats });
        assert.strictEqual(check(r, 'power_sign').status, 'fail');
        const fixed = evaluateCommissioning({ ...base, role: 'pv', powerSign: -1, now: min(16), stats });
        assert.strictEqual(check(fixed, 'power_sign').status, 'pass');
    });

    await t.test('negative power at an incomer is a warning (export or reversed CT)', () => {
        const r = evaluateCommissioning({ ...base, now: min(16), stats: { ...good, pAvgKw: -10 } });
        assert.strictEqual(check(r, 'power_sign').status, 'warn');
        assert.strictEqual(r.overall, 'warn');
    });

    await t.test('without load, sign and PF are not evaluated rather than failed', () => {
        const r = evaluateCommissioning({ ...base, now: min(16), stats: { ...good, currentAvgA: 5, currentMaxA: 6, pfAvg: 0.2 } });
        assert.strictEqual(check(r, 'power_sign').status, 'not_evaluated');
        assert.strictEqual(check(r, 'power_factor').status, 'not_evaluated');
        assert.strictEqual(r.overall, 'pass');
    });

    await t.test('voltage out of range, a missing phase, a drifted clock, current above the CT', () => {
        const r = evaluateCommissioning({ ...base, now: min(16),
            stats: { ...good, vB: null, vC: 260, driftS: 42, currentMaxA: 450 } });
        assert.strictEqual(check(r, 'voltages').status, 'fail');
        assert.match(check(r, 'voltages').detail, /Missing L2/);
        assert.strictEqual(check(r, 'clock_drift').status, 'fail');
        assert.strictEqual(check(r, 'current_vs_ct').status, 'fail');
        const v = evaluateCommissioning({ ...base, now: min(16), stats: { ...good, vC: 260 } });
        assert.match(check(v, 'voltages').detail, /L3 260 V/);
    });

    await t.test('scale_correction applies to current, so a wrong CT ratio is caught', () => {
        const r = evaluateCommissioning({ ...base, scale: 4, now: min(16), stats: good }); // 120 A × 4 = 480 A > 400 A
        assert.strictEqual(check(r, 'current_vs_ct').status, 'fail');
    });

    await t.test('coverage below 95 % fails at the end', () => {
        const r = evaluateCommissioning({ ...base, now: min(16), stats: { ...good, total: 700 } });
        assert.strictEqual(check(r, 'coverage').status, 'fail');
        assert.match(check(r, 'coverage').detail, /700 of 900 expected readings \(every 1 s\)/);
    });

    await t.test("coverage is judged at the meter's own interval: every 5 minutes passes with 3 readings", () => {
        const r = evaluateCommissioning({ ...base, now: min(16), stats: { ...good, total: 3, deviceSourced: 3, minutesWithData: 3, spacingS: 300 } });
        assert.strictEqual(check(r, 'coverage').status, 'pass');
        assert.match(check(r, 'coverage').detail, /3 of 3 expected readings \(every 300 s\)/);
    });

    await t.test('no CT primary: current check is not applicable', () => {
        const r = evaluateCommissioning({ ...base, ctPrimaryA: null, now: min(16), stats: good });
        assert.strictEqual(check(r, 'current_vs_ct').status, 'not_applicable');
    });
});

const pt = (over) => ({
    id: over.name, parentPointId: null, parentRole: null, importKwh: 0, exportKwh: 0, coverage: 1,
    method: 'register', dataQuality: { register_resets: 0, implausible_jumps: 0, register_hours: 1, power_hours: 0 },
    ...over,
});

test('energy balance', async (t) => {
    await t.test('consumption = import − export + PV + (discharge − charge); remainder after sub-loads', () => {
        const b = energyBalance([
            pt({ name: 'incomer', role: 'incomer', importKwh: 1000, exportKwh: 50 }),
            pt({ name: 'pv', role: 'pv', importKwh: 300 }),
            pt({ name: 'bess', role: 'bess', importKwh: 80, exportKwh: 100 }),
            pt({ name: 'hvac', role: 'sub_load', importKwh: 400 }),
            pt({ name: 'chiller', role: 'sub_load', parentPointId: 'hvac', parentRole: 'sub_load', importKwh: 150 }),
        ]);
        assert.strictEqual(b.site_consumption_kwh, 1000 - 50 + 300 + (80 - 100));
        assert.strictEqual(b.sub_loads_kwh, 400); // the nested chiller is inside hvac
        assert.strictEqual(b.unmetered_kwh, 1230 - 400);
        assert.strictEqual(b.complete, true);
        assert.deepStrictEqual(b.not_available, []);
    });

    await t.test('a PV point with no data makes consumption "not available", not zero', () => {
        const b = energyBalance([
            pt({ name: 'incomer', role: 'incomer', importKwh: 1000 }),
            pt({ name: 'pv', role: 'pv', coverage: 0 }),
        ]);
        assert.strictEqual(b.grid_import_kwh, 1000);
        assert.strictEqual(b.pv_generation_kwh, null);
        assert.strictEqual(b.site_consumption_kwh, null);
        assert.strictEqual(b.unmetered_kwh, null);
        assert.match(b.not_available[0], /PV generation: no data at pv/);
    });

    await t.test('without PV or BESS those terms are 0; without an incomer nothing is available', () => {
        const b = energyBalance([pt({ name: 'incomer', role: 'incomer', importKwh: 500, exportKwh: 0 })]);
        assert.strictEqual(b.pv_generation_kwh, 0);
        assert.strictEqual(b.site_consumption_kwh, 500);
        assert.strictEqual(b.unmetered_kwh, 500);
        const none = energyBalance([pt({ name: 'feeder', role: 'sub_load', importKwh: 10 })]);
        assert.strictEqual(none.site_consumption_kwh, null);
        assert.match(none.not_available[0], /no incomer/);
    });

    await t.test('partial coverage still gives figures but marks the balance incomplete', () => {
        const b = energyBalance([pt({ name: 'incomer', role: 'incomer', importKwh: 500, coverage: 0.8 })]);
        assert.strictEqual(b.site_consumption_kwh, 500);
        assert.strictEqual(b.complete, false);
    });

    await t.test('two supply incomers are summed', () => {
        const b = energyBalance([
            pt({ name: 'supply 1', role: 'incomer', importKwh: 300 }),
            pt({ name: 'supply 2', role: 'incomer', importKwh: 200 }),
        ]);
        assert.strictEqual(b.grid_import_kwh, 500);
    });
});

test('fleet API helpers', async (t) => {
    await t.test('device codes are normalised; the broker username is the lowercase code', () => {
        assert.strictEqual(normaliseCode(' gq-m01 '), 'GQ-M01');
        assert.strictEqual(mqttUsernameFor('GQ-M01'), 'gq-m01');
        assert.throws(() => normaliseCode('gq m01'), InputError);
        assert.throws(() => normaliseCode(''), InputError);
        assert.throws(() => normaliseCode('-x'), InputError);
    });

    await t.test('constraint errors map to 409/400', () => {
        assert.deepStrictEqual(dbErrorResponse({ code: '23P01', constraint: 'deployments_point_no_overlap' }).status, 409);
        assert.match(dbErrorResponse({ code: '23P01', constraint: 'deployments_device_no_overlap' }).error, /device is already deployed/);
        assert.strictEqual(dbErrorResponse({ code: '23514' }).status, 400);
        assert.strictEqual(dbErrorResponse({ code: 'XX000' }), null);
    });

    await t.test('corrections accept sign ±1 and a positive scale only', () => {
        assert.deepStrictEqual(pickFields({ power_sign: '-1', scale_correction: 2.5, other: 1 }, CORRECTION_FIELDS),
            { power_sign: -1, scale_correction: 2.5 });
        assert.throws(() => pickFields({ power_sign: 0 }, CORRECTION_FIELDS), InputError);
        assert.throws(() => pickFields({ scale_correction: -1 }, CORRECTION_FIELDS), InputError);
    });

    await t.test('only super_admin and engineer are internal', () => {
        assert.strictEqual(isInternal({ role: 'super_admin' }), true);
        assert.strictEqual(isInternal({ role: 'engineer' }), true);
        assert.strictEqual(isInternal({ role: 'admin' }), false);
        assert.strictEqual(isInternal(undefined), false);
    });
});
