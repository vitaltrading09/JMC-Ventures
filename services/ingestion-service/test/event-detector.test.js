// In-memory event detector: excursions, ongoing vs ended, gaps, ordering.

const test = require('node:test');
const assert = require('node:assert');

const { EventDetector } = require('../dist/ingest/event-detector.js');

const T = { minV: 207, maxV: 253, minFreq: 49, maxFreq: 51 };
const t0 = Date.parse('2026-11-03T10:00:00Z');
const at = (s) => new Date(t0 + s * 1000);
const v = (va, extra = {}) => ({ voltage_a: va, voltage_b: 230, voltage_c: 230, frequency: 50, ...extra });

function run(d, series, meter = 'm1') {
    const out = [];
    series.forEach(([s, values]) => out.push(...d.feed(meter, at(s), values, T)));
    return out;
}

test('a short dip is emitted once, when it ends', () => {
    const d = new EventDetector({ minSeconds: 3 });
    const ev = run(d, [[0, v(230)], [1, v(200)], [2, v(195)], [3, v(229)]]);
    assert.strictEqual(ev.length, 1);
    const e = ev[0];
    assert.strictEqual(e.type, 'UNDERVOLTAGE');
    assert.strictEqual(e.channel, 'voltage_a');
    assert.strictEqual(e.startedAt.toISOString(), at(1).toISOString());
    assert.strictEqual(e.endedAt.toISOString(), at(3).toISOString());
    assert.strictEqual(e.durationS, 2);
    assert.strictEqual(e.extremeValue, 195);
    assert.strictEqual(e.threshold, 207);
    assert.strictEqual(e.samples, 2);
});

test('a long excursion is emitted as ongoing at minSeconds, then updated (same id) when it ends', () => {
    const d = new EventDetector({ minSeconds: 3 });
    const ev = run(d, [[0, v(260)], [1, v(262)], [2, v(261)], [3, v(265)], [4, v(263)], [5, v(240)]]);
    assert.strictEqual(ev.length, 2);
    const [ongoing, ended] = ev;
    assert.strictEqual(ongoing.type, 'OVERVOLTAGE');
    assert.strictEqual(ongoing.endedAt, null);
    assert.strictEqual(ongoing.durationS, 3);
    assert.strictEqual(ongoing.extremeValue, 265);
    assert.strictEqual(ended.id, ongoing.id, 'the ending updates the same row');
    assert.strictEqual(ended.endedAt.toISOString(), at(5).toISOString());
    assert.strictEqual(ended.durationS, 5);
    assert.strictEqual(ended.samples, 5);
});

test('frequency out of band, both directions', () => {
    const d = new EventDetector({ minSeconds: 3 });
    const ev = run(d, [
        [0, v(230, { frequency: 48.7 })], [1, v(230, { frequency: 50 })],
        [2, v(230, { frequency: 51.2 })], [3, v(230, { frequency: 50 })],
    ]);
    assert.deepStrictEqual(ev.map((e) => e.type), ['UNDERFREQUENCY', 'OVERFREQUENCY']);
    assert.strictEqual(ev[0].extremeValue, 48.7);
});

test('phases and meters are tracked independently', () => {
    const d = new EventDetector({ minSeconds: 3 });
    const a = run(d, [[0, v(230, { voltage_c: 190 })], [1, v(230, { voltage_c: 230 })]], 'm1');
    const b = run(d, [[0, v(200)], [1, v(230)]], 'm2');
    assert.deepStrictEqual(a.map((e) => [e.channel, e.meterId]), [['voltage_c', 'm1']]);
    assert.deepStrictEqual(b.map((e) => [e.channel, e.meterId]), [['voltage_a', 'm2']]);
});

test('jumping straight from under- to over-voltage ends one event and starts another', () => {
    const d = new EventDetector({ minSeconds: 3 });
    const ev = run(d, [[0, v(200)], [1, v(260)], [2, v(230)]]);
    assert.deepStrictEqual(ev.map((e) => e.type), ['UNDERVOLTAGE', 'OVERVOLTAGE']);
});

test('a gap longer than maxGapSeconds closes the excursion at its last sample', () => {
    const d = new EventDetector({ minSeconds: 30, maxGapSeconds: 60 });
    const ev = run(d, [[0, v(200)], [1, v(199)], [200, v(198)]]);
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].endedAt.toISOString(), at(1).toISOString());
    assert.strictEqual(d.openCount, 1, 'the sample after the gap opens a new excursion');
});

test('out-of-order samples are ignored; missing values are skipped', () => {
    const d = new EventDetector({ minSeconds: 3 });
    const ev = run(d, [[10, v(230)], [5, v(150)], [11, v(null)], [12, v(231)]]);
    assert.deepStrictEqual(ev, []);
    assert.strictEqual(d.openCount, 0);
});
