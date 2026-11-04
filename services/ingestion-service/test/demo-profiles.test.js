// Run with: npm run build && npm test
//
// The demo data generator (scripts/seed-readings.ts) exists so the UI and the
// engines have something real-looking to work on. Data that is subtly wrong —
// an energy register that steps backwards, a "problem" site that never quite
// crosses its threshold — would make every screen built on it misleading, so
// these pin the curves down against the same limits the engines apply.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    DEMO_PROFILES, NRS048, SIMULATED_TIME_SOURCE, SIMULATED_ALERT_PREFIX, ENERGY_EPOCH_MS,
    generateReadings, instantReading, touPeriod, localTime, sagEvents, joinRegister,
    evaluateDemoAlerts, currentImbalancePct, maxIntervalKva,
} = require('../dist/demo-profiles.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// 90 days ending on a Monday 00:00 SAST, so whole weeks line up.
const TO = Date.UTC(2026, 10, 1, 22);            // 2026-11-02 00:00 SAST
const FROM = TO - 90 * DAY;

const profile = (key) => DEMO_PROFILES.find(p => p.key === key);
const series = new Map(DEMO_PROFILES.map(p => [p.key, generateReadings(p, FROM, TO, 5)]));
const rowsOf = (key) => series.get(key);
const between = (rows, from, to) => rows.filter(r => r.time.getTime() >= from && r.time.getTime() < to);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(0.95 * (s.length - 1))]; };
/** Every complete 24 h window ending on an hour boundary over the series. */
function dailyWindows(rows, fn) {
    for (let end = FROM + DAY; end <= TO; end += 6 * HOUR) fn(between(rows, end - DAY, end), end);
}

test('profiles', async (t) => {
    await t.test('there is one healthy site and every listed problem is covered', () => {
        assert.strictEqual(DEMO_PROFILES.filter(p => p.problems.length === 0).length, 1);
        const covered = new Set(DEMO_PROFILES.flatMap(p => p.problems));
        for (const p of ['LOW_PF', 'HIGH_THD', 'PHASE_IMBALANCE', 'VOLTAGE_SAG', 'MDI_EXCEEDED']) {
            assert.ok(covered.has(p), `no profile covers ${p}`);
        }
    });

    await t.test('keys, serials and seeds are unique', () => {
        for (const k of ['key', 'meterSerial', 'seed', 'siteName']) {
            assert.strictEqual(new Set(DEMO_PROFILES.map(p => p[k])).size, DEMO_PROFILES.length, k);
        }
    });

    await t.test('every site and meter serial exists in the auth-service seed', () => {
        const seed = fs.readFileSync(path.join(__dirname, '../../auth-service/src/seed.ts'), 'utf8');
        for (const p of DEMO_PROFILES) {
            assert.ok(seed.includes(`'${p.siteName}'`), `seed.ts has no site '${p.siteName}'`);
            assert.ok(seed.includes(`'${p.meterSerial}'`), `seed.ts has no meter serial '${p.meterSerial}'`);
        }
    });

    await t.test('time_source marker fits the VARCHAR(10) column', () => {
        assert.ok(SIMULATED_TIME_SOURCE.length <= 10);
        assert.notStrictEqual(SIMULATED_TIME_SOURCE, 'DEVICE');
        assert.notStrictEqual(SIMULATED_TIME_SOURCE, 'ARRIVAL');
    });
});

test('calendar', async (t) => {
    await t.test('local time is SAST (UTC+2)', () => {
        const lt = localTime(Date.UTC(2026, 10, 2, 5, 30));   // Monday 07:30 SAST
        assert.strictEqual(lt.hour, 7.5);
        assert.strictEqual(lt.dow, 1);
    });

    await t.test('Eskom TOU periods', () => {
        const at = (d, h) => touPeriod(Date.UTC(2026, 10, d, h - 2, 30));
        assert.strictEqual(at(2, 7), 'PEAK');       // Monday 07:30
        assert.strictEqual(at(2, 18), 'PEAK');
        assert.strictEqual(at(2, 12), 'STANDARD');
        assert.strictEqual(at(2, 23), 'OFFPEAK');
        assert.strictEqual(at(7, 8), 'STANDARD');   // Saturday
        assert.strictEqual(at(8, 8), 'OFFPEAK');    // Sunday
    });
});

test('series shape', async (t) => {
    await t.test('5-minute grid, no gaps, covering the window', () => {
        for (const [key, rows] of series) {
            assert.strictEqual(rows.length, 90 * 288 + 1, key);
            for (let i = 1; i < rows.length; i++) {
                assert.strictEqual(rows[i].time - rows[i - 1].time, 5 * MIN, `${key} gap at ${rows[i].time.toISOString()}`);
            }
        }
    });

    await t.test('energy register increases monotonically and matches integrated kW', () => {
        for (const [key, rows] of series) {
            for (let i = 1; i < rows.length; i++) {
                const d = rows[i].energy_import_total - rows[i - 1].energy_import_total;
                assert.ok(d > 0, `${key} register did not increase at ${rows[i].time.toISOString()}`);
                assert.ok(Math.abs(d - rows[i].power_active_total / 12) < 0.02, `${key} step energy ≠ kW × 5 min`);
            }
        }
    });

    await t.test('the register does not depend on the requested window', () => {
        const p = profile('mall');
        const full = rowsOf('mall');
        const tail = generateReadings(p, TO - 2 * DAY, TO, 5);
        const atFull = full.find(r => r.time.getTime() === tail[0].time.getTime());
        assert.strictEqual(tail[0].energy_import_total, atFull.energy_import_total);
        assert.deepStrictEqual(tail.at(-1), full.at(-1));
    });

    await t.test('joinRegister: an unchanged profile tops up with identical values', () => {
        const p = profile('hq');
        const full = rowsOf('hq');
        const cut = full.length - 100;
        const stored = full.slice(0, cut).map(r => ({ time: r.time.getTime(), energy: r.energy_import_total }));
        const byTime = new Map(full.map(r => [r.time.getTime(), r.energy_import_total]));
        assert.deepStrictEqual(joinRegister(full.slice(cut), stored, ms => byTime.get(ms)), full.slice(cut));
    });

    await t.test('joinRegister: after a profile change the register still joins the stored rows', () => {
        // Stored with the original curve; generated again with a bigger site.
        const old = rowsOf('mall');
        const changed = { ...profile('mall'), peakKw: 1300, energyStartKwh: 10 };
        const regen = generateReadings(changed, FROM, TO, 5);
        const byTime = new Map(regen.map(r => [r.time.getTime(), r.energy_import_total]));
        const toStored = rows => rows.map(r => ({ time: r.time.getTime(), energy: r.energy_import_total }));
        const mid = Math.floor(old.length / 2);

        // Top-up after the stored half.
        const after = joinRegister(regen.slice(mid), toStored(old.slice(0, mid)), ms => byTime.get(ms));
        const joined = [...old.slice(0, mid), ...after];
        for (let i = 1; i < joined.length; i++) assert.ok(joined[i].energy_import_total > joined[i - 1].energy_import_total, `after: step ${i}`);

        // Backfill before the stored half.
        const before = joinRegister(regen.slice(0, mid), toStored(old.slice(mid)), ms => byTime.get(ms));
        const joined2 = [...before, ...old.slice(mid)];
        for (let i = 1; i < joined2.length; i++) assert.ok(joined2[i].energy_import_total > joined2[i - 1].energy_import_total, `before: step ${i}`);
    });

    await t.test('readings are deterministic', () => {
        const p = profile('factory');
        assert.deepStrictEqual(instantReading(p, TO - 3 * HOUR), instantReading(p, TO - 3 * HOUR));
    });

    await t.test('rejects a window before the energy epoch and a bad step', () => {
        assert.throws(() => generateReadings(profile('hq'), ENERGY_EPOCH_MS - DAY, ENERGY_EPOCH_MS, 5));
        assert.throws(() => generateReadings(profile('hq'), FROM, TO, 0));
        assert.throws(() => generateReadings(profile('hq'), FROM, TO, 2.5));
    });

    await t.test('electrical values are physically consistent and in plausible ranges', () => {
        for (const [key, rows] of series) {
            for (const r of rows) {
                const where = `${key} @ ${r.time.toISOString()}`;
                for (const v of [r.voltage_a, r.voltage_b, r.voltage_c]) assert.ok(v > 180 && v < 245, `${where} V=${v}`);
                for (const i of [r.current_a, r.current_b, r.current_c]) assert.ok(i >= 0 && i < 2500, `${where} I=${i}`);
                assert.ok(r.frequency >= 49.8 && r.frequency <= 50.2, where);
                assert.ok(r.power_factor_total > 0.5 && r.power_factor_total < 1, where);
                assert.ok(r.power_active_total > 0, where);
                // S² = P² + Q², and S = P / PF (within rounding)
                const s = Math.hypot(r.power_active_total, r.power_reactive_total);
                assert.ok(Math.abs(s - r.power_apparent_total) < 0.05, `${where} S≠√(P²+Q²)`);
                assert.ok(Math.abs(r.power_active_total / r.power_factor_total - r.power_apparent_total) / r.power_apparent_total < 0.002, where);
                // 3-phase power balances: Σ V·I ≈ S
                const vi = (r.voltage_a * r.current_a + r.voltage_b * r.current_b + r.voltage_c * r.current_c) / 1000;
                assert.ok(Math.abs(vi - r.power_apparent_total) / r.power_apparent_total < 0.05, `${where} ΣVI=${vi} S=${r.power_apparent_total}`);
                assert.ok(r.thd_voltage_a > 0 && r.thd_voltage_a < 15, where);
                assert.ok(r.thd_current_a > 0 && r.thd_current_a < 60, where);
            }
        }
    });
});

test('load curves', async (t) => {
    const hourMean = (rows, predicate) => mean(rows.filter(r => predicate(localTime(r.time.getTime()))).map(r => r.power_active_total));

    await t.test('weekdays carry more load than weekends at the office and factory', () => {
        for (const key of ['hq', 'factory', 'durban']) {
            const rows = rowsOf(key);
            const weekday = hourMean(rows, lt => lt.dow >= 1 && lt.dow <= 5);
            const weekend = hourMean(rows, lt => lt.dow === 0 || lt.dow === 6);
            assert.ok(weekday > 1.4 * weekend, `${key}: weekday ${weekday.toFixed(0)} kW vs weekend ${weekend.toFixed(0)} kW`);
        }
    });

    await t.test('office: working hours well above night, morning ramp into the 07:00 peak window', () => {
        const rows = rowsOf('hq');
        const wd = (h0, h1) => hourMean(rows, lt => lt.dow >= 1 && lt.dow <= 5 && lt.hour >= h0 && lt.hour < h1);
        assert.ok(wd(10, 16) > 3 * wd(0, 5));
        assert.ok(wd(8, 10) > 2 * wd(5, 6), 'load should be ramping through the morning peak');
    });

    await t.test('data centre is flat around the clock', () => {
        const rows = rowsOf('datacentre');
        const kw = rows.map(r => r.power_active_total);
        assert.ok(Math.min(...kw) > 0.75 * Math.max(...kw));
    });

    await t.test('mall trades seven days, closed at night', () => {
        const rows = rowsOf('mall');
        const sundayNoon = hourMean(rows, lt => lt.dow === 0 && lt.hour >= 11 && lt.hour < 15);
        const night = hourMean(rows, lt => lt.hour >= 1 && lt.hour < 5);
        assert.ok(sundayNoon > 3 * night);
    });
});

test('healthy site stays inside every limit', () => {
    const p = profile('hq');
    const rows = rowsOf('hq');
    assert.ok(mean(rows.map(r => r.power_factor_total)) >= 0.95);
    assert.ok(Math.min(...rows.map(r => r.power_factor_total)) >= NRS048.minPf);
    assert.ok(Math.max(...rows.map(r => r.thd_voltage_a)) < 5);
    assert.ok(Math.min(...rows.map(r => r.voltage_a)) > NRS048.minV);
    assert.ok(Math.max(...rows.map(r => r.voltage_a)) < NRS048.maxV);
    assert.ok(currentImbalancePct(rows) < 5);
    assert.ok(maxIntervalKva(rows, p.settings.demand_interval_min) < 0.8 * p.settings.contracted_mdi_kva);
    // Demand distortion (TDD) as power-quality.ts computes it: THD-I scaled by
    // load current over peak current. IEEE 519's strictest limit is 5 %.
    const iAvg = rows.map(r => (r.current_a + r.current_b + r.current_c) / 3);
    const iPeak = Math.max(...iAvg);
    assert.ok(p95(rows.map((r, i) => r.thd_current_a * iAvg[i] / iPeak)) <= 5);
    assert.deepStrictEqual(rows.flatMap(r => evaluateDemoAlerts(r, p.settings)), []);
});

test('problem sites breach their thresholds', async (t) => {
    await t.test('factory: 24 h average PF below 0.80 in every window (predictive scan)', () => {
        dailyWindows(rowsOf('factory'), (w, end) => {
            const pf = mean(w.map(r => r.power_factor_total));
            assert.ok(pf < 0.80, `24h PF ${pf.toFixed(3)} ending ${new Date(end).toISOString()}`);
        });
    });

    await t.test('factory: billed (30-min) demand exceeds contracted MDI at least once every week', () => {
        const p = profile('factory');
        const rows = rowsOf('factory');
        for (let start = FROM; start + 7 * DAY <= TO; start += 7 * DAY) {
            const kva = maxIntervalKva(between(rows, start, start + 7 * DAY), p.settings.demand_interval_min);
            assert.ok(kva > p.settings.contracted_mdi_kva, `week of ${new Date(start).toISOString()}: ${kva.toFixed(0)} kVA`);
        }
        // ...and it is spikes, not the normal load, that do it.
        const normalPeak = Math.max(...rows.map(r => instantReading({ ...p, demandSpikes: undefined }, r.time.getTime()).power_apparent_total));
        assert.ok(normalPeak < 0.95 * p.settings.contracted_mdi_kva);
    });

    await t.test('durban: 24 h phase current imbalance above 20 % in every window (predictive scan)', () => {
        dailyWindows(rowsOf('durban'), (w, end) => {
            const pct = currentImbalancePct(w);
            assert.ok(pct > 20, `imbalance ${pct.toFixed(1)}% ending ${new Date(end).toISOString()}`);
        });
    });

    await t.test('mall: voltage THD above the NRS 048-2 limit while trading, 95th percentile above 8 %', () => {
        const rows = rowsOf('mall');
        assert.ok(p95(rows.map(r => r.thd_voltage_a)) > NRS048.maxThd);
        dailyWindows(rows, (w, end) => {
            assert.ok(w.some(r => r.thd_voltage_a > NRS048.maxThd), `no THD breach in 24h ending ${new Date(end).toISOString()}`);
        });
        // Overnight, with the HVAC plant off, it is back inside the limit.
        const night = rows.filter(r => { const h = localTime(r.time.getTime()).hour; return h >= 0 && h < 6; });
        assert.ok(Math.max(...night.map(r => r.thd_voltage_a)) < NRS048.maxThd);
    });

    await t.test('mall: THD alerts cluster in the afternoon HVAC peak, not every trading hour', () => {
        const p = profile('mall');
        const hours = new Set();
        for (const r of between(rowsOf('mall'), TO - 7 * DAY, TO)) {
            if (evaluateDemoAlerts(r, p.settings).some(a => a.type === 'HIGH_THD')) {
                hours.add(Math.floor(r.time.getTime() / HOUR));
            }
        }
        // At most one alert per hour (the dedup), so this is the alert count.
        assert.ok(hours.size > 7 && hours.size < 7 * 7, `${hours.size} alert-hours in a week`);
    });

    await t.test('data centre: voltage sags below 207 V at least once a day', () => {
        const p = profile('datacentre');
        const rows = rowsOf('datacentre');
        for (let start = FROM; start + DAY <= TO; start += DAY) {
            const w = between(rows, start, start + DAY);
            assert.ok(w.some(r => r.voltage_a < NRS048.minV), `no sag on ${new Date(start).toISOString()}`);
        }
        // Outside sag events the supply is within limits.
        const sagFree = rows.filter(r => !sagEvents(p, localTime(r.time.getTime()).day)
            .some(e => r.time.getTime() >= e.startMs && r.time.getTime() < e.endMs));
        assert.ok(Math.min(...sagFree.map(r => r.voltage_a)) > NRS048.minV);
    });

    await t.test('each problem shows up only where it is meant to', () => {
        for (const p of DEMO_PROFILES) {
            const rows = rowsOf(p.key);
            const has = (x) => p.problems.includes(x);
            assert.strictEqual(mean(rows.map(r => r.power_factor_total)) < 0.80, has('LOW_PF'), `${p.key} LOW_PF`);
            assert.strictEqual(p95(rows.map(r => r.thd_voltage_a)) > NRS048.maxThd, has('HIGH_THD'), `${p.key} HIGH_THD`);
            assert.strictEqual(currentImbalancePct(rows) > 20, has('PHASE_IMBALANCE'), `${p.key} PHASE_IMBALANCE`);
            assert.strictEqual(rows.some(r => r.voltage_a < NRS048.minV), has('VOLTAGE_SAG'), `${p.key} VOLTAGE_SAG`);
            assert.strictEqual(maxIntervalKva(rows, p.settings.demand_interval_min) > p.settings.contracted_mdi_kva, has('MDI_EXCEEDED'), `${p.key} MDI_EXCEEDED`);
        }
    });
});

test('simulated real-time alerts', async (t) => {
    const types = (key) => new Set(rowsOf(key).flatMap(r => evaluateDemoAlerts(r, profile(key).settings)).map(a => a.type));

    await t.test('raise the expected alert types per site', () => {
        assert.ok(types('mall').has('HIGH_THD'));
        assert.ok(types('datacentre').has('VOLTAGE_SAG'));
        assert.ok(types('factory').has('MDI_EXCEEDED'));
        assert.ok(types('factory').has('PEAK_DEMAND'));
        assert.ok(!types('durban').has('HIGH_THD'));
    });

    await t.test('are marked as simulated', () => {
        const r = rowsOf('datacentre').find(x => x.voltage_a < NRS048.minV);
        const alerts = evaluateDemoAlerts(r, profile('datacentre').settings);
        assert.ok(alerts.length > 0);
        for (const a of alerts) assert.ok(a.message.startsWith(SIMULATED_ALERT_PREFIX));
    });
});
