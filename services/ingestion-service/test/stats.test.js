// Unknown-parameter logging (once per meter per hour) and payload sizes.

const test = require('node:test');
const assert = require('node:assert');

const { IngestStats } = require('../dist/ingest/stats.js');

test('unknown parameters: logged once per meter per hour, with everything seen meanwhile', () => {
    let now = 0;
    const logs = [];
    const s = new IngestStats({ now: () => now, log: (m) => logs.push(m) });
    s.noteUnknownParams('m1', ['X1']);
    s.noteUnknownParams('m1', ['X2']); // within the hour: collected, not logged
    s.noteUnknownParams('m2', ['Y1']); // other meter: its own budget
    s.noteUnknownParams('m1', []);     // nothing to note
    assert.strictEqual(logs.length, 2);
    assert.match(logs[0], /m1 sends 1 unmapped parameter\(s\): X1/);
    now = 3_600_000;
    s.noteUnknownParams('m1', ['X3']);
    assert.strictEqual(logs.length, 3);
    assert.match(logs[2], /m1 sends 2 unmapped parameter\(s\): X2, X3/);
});

test('payload sizes: average bytes per message per meter, then the window resets', () => {
    let now = 0;
    const logs = [];
    const s = new IngestStats({ now: () => now, log: (m) => logs.push(m) });
    s.notePayload('m1', 1000);
    s.notePayload('m1', 1200);
    s.notePayload('m2', 300);
    now = 3_600_000;
    assert.deepStrictEqual(s.reportPayloadSizes(), [
        { meter: 'm1', messages: 2, avgBytes: 1100 },
        { meter: 'm2', messages: 1, avgBytes: 300 },
    ]);
    assert.match(logs[0], /m1: 2 msgs in 60 min, avg 1100 B\/msg/);
    assert.deepStrictEqual(s.reportPayloadSizes(), []);
});
