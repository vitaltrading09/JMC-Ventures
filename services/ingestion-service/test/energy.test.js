// Period energy from register deltas (src/energy.ts). The acceptance case:
// a register reset must not create negative or inflated monthly energy.

const test = require('node:test');
const assert = require('node:assert');

const { periodEnergy, monthKey } = require('../dist/energy.js');

const H = 3_600_000;
const t0 = Date.parse('2026-10-01T00:00:00Z');

// Hourly rows for a steady 10 kW load: 10 kWh per hour on the register.
function steady(hours, { start = t0, reg0 = 1000, kw = 10 } = {}) {
    const out = [];
    for (let i = 0; i < hours; i++) {
        const hour = new Date(start + i * H);
        const first = reg0 + i * kw;
        out.push({
            hour, regFirst: first, regLast: first + kw * (59 / 60),
            tFirst: hour, tLast: new Date(hour.getTime() + 59 * 60_000),
            pMaxKw: kw, powerKwh: kw,
        });
    }
    return out;
}

test('steady register: energy is the register delta, bridged between hours', () => {
    const [m] = periodEnergy(steady(24), monthKey);
    assert.strictEqual(m.period, '2026-10');
    // 24 hours × 10 kWh, minus the last hour's final minute not yet registered
    assert.strictEqual(m.kwh, 239.8);
    assert.strictEqual(m.method, 'register');
    assert.deepStrictEqual(m.data_quality, { register_resets: 0, implausible_jumps: 0, register_hours: 24, power_hours: 0 });
});

test('a register reset between hours is a break: no negative, no inflation', () => {
    const before = steady(10, { reg0: 50_000 });
    // Portable meter reset between deployments: the register restarts near 0.
    const after = steady(10, { start: t0 + 10 * H, reg0: 2 });
    const [m] = periodEnergy([...before, ...after], monthKey);
    assert.ok(m.kwh > 0, 'never negative');
    // 10 kWh/h for ~20 hours; the reset step (−50,098 kWh) is dropped, and the
    // pre-reset register value is never counted as consumption.
    assert.ok(m.kwh <= 200, `not inflated (got ${m.kwh})`);
    // each 10-hour segment ends one minute short of its last full hour
    assert.ok(Math.abs(m.kwh - 199.7) < 0.01, `got ${m.kwh}`);
    assert.strictEqual(m.data_quality.register_resets, 1);
});

test('a reset inside an hour drops that hour only', () => {
    const rows = steady(5);
    rows[2] = { ...rows[2], regFirst: 1020, regLast: 3 }; // reset mid-hour
    rows[3] = { ...rows[3], regFirst: 4, regLast: 13.8 };
    rows[4] = { ...rows[4], regFirst: 14, regLast: 23.8 };
    const [m] = periodEnergy(rows, monthKey);
    assert.strictEqual(m.data_quality.register_resets, 1);
    assert.ok(m.kwh > 0 && m.kwh < 50, `got ${m.kwh}`);
});

test('a jump larger than the load could produce is flagged and skipped', () => {
    const rows = steady(6);
    // Replacement meter with a register 90,000 kWh higher.
    for (let i = 3; i < 6; i++) rows[i] = { ...rows[i], regFirst: rows[i].regFirst + 90_000, regLast: rows[i].regLast + 90_000 };
    const [m] = periodEnergy(rows, monthKey);
    assert.strictEqual(m.data_quality.implausible_jumps, 1);
    assert.ok(m.kwh < 70, `got ${m.kwh}`);
});

test('a comms gap is bridged by the register (the meter kept counting)', () => {
    const a = steady(2);
    // 3 hours with no data at all, then data resumes; the register advanced 30 kWh meanwhile.
    const b = steady(2, { start: t0 + 5 * H, reg0: 1050 });
    const [m] = periodEnergy([...a, ...b], monthKey);
    assert.strictEqual(m.data_quality.implausible_jumps, 0);
    assert.ok(Math.abs(m.kwh - 69.8) < 0.01, `got ${m.kwh}`);
});

test('hours without a register fall back to power integration; method is labelled', () => {
    const rows = steady(4).map((r, i) => (i < 2 ? { ...r, regFirst: null, regLast: null, powerKwh: 9.5 } : r));
    const [m] = periodEnergy(rows, monthKey);
    assert.strictEqual(m.method, 'mixed');
    assert.strictEqual(m.data_quality.power_hours, 2);
    assert.strictEqual(m.data_quality.register_hours, 2);
    // 2 × 9.5 power + register for 2 hours (no bridge across the power hours)
    assert.ok(Math.abs(m.kwh - (19 + 19.8)) < 0.01, `got ${m.kwh}`);

    const [p] = periodEnergy(steady(3).map((r) => ({ ...r, regFirst: null, regLast: null })), monthKey);
    assert.strictEqual(p.method, 'power_integration');
    assert.strictEqual(p.kwh, 30);
});

test('periods split by month', () => {
    const rows = steady(4, { start: Date.parse('2026-10-31T22:00:00Z') });
    const out = periodEnergy(rows, monthKey);
    assert.deepStrictEqual(out.map((p) => p.period), ['2026-10', '2026-11']);
    assert.ok(out.every((p) => p.kwh > 0));
});
