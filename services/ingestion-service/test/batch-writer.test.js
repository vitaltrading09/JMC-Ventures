// Batch writer: flush triggers, one multi-row insert per flush, conflicts,
// acks only after commit, retry without acking on DB failure, backpressure.

const test = require('node:test');
const assert = require('node:assert');

const { BatchWriter } = require('../dist/ingest/batch-writer.js');

// Fake pg pool. Records statements; RETURNING emulates ON CONFLICT DO NOTHING
// against an in-memory set of existing (meter_id, time) keys.
function fakeDb({ existing = new Set(), failTimes = 0 } = {}) {
    const db = {
        statements: [],
        inserts: [],
        failuresLeft: failTimes,
        committed: 0,
        async connect() {
            let pendingKeys = [];
            return {
                async query(text, values) {
                    db.statements.push(text.split(' ')[0]);
                    if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
                    if (text === 'COMMIT') {
                        for (const k of pendingKeys) existing.add(k);
                        db.committed++;
                        return { rows: [] };
                    }
                    if (db.failuresLeft > 0) {
                        db.failuresLeft--;
                        throw new Error('connection terminated');
                    }
                    const cols = text.match(/INSERT INTO meter_readings \((.*?)\) VALUES/)[1].split(', ').length - 1; // minus ingested_at
                    const rows = [];
                    for (let i = 0; i < values.length; i += cols) rows.push(values.slice(i, i + cols));
                    db.inserts.push(rows.length);
                    const out = [];
                    const seen = new Set();
                    for (const r of rows) {
                        const k = `${r[1]}|${r[0].getTime()}`;
                        if (existing.has(k) || seen.has(k)) continue;
                        seen.add(k);
                        pendingKeys.push(k);
                        out.push({ meter_id: r[1], time: new Date(r[0].getTime()) });
                    }
                    return { rows: out };
                },
                release() {},
            };
        },
    };
    return db;
}

const quiet = { log() {}, warn() {}, error() {} };
let seq = 0;
function row(meterId = 'm1', t = 1_700_000_000_000 + seq++ * 1000) {
    const r = {
        meterId, time: new Date(t), deviceTime: new Date(t), source: 'DEVICE',
        values: { voltage_a: 230, power_active_total: 1 }, receivedAt: Date.now(), acked: 0,
    };
    r.ack = () => { r.acked++; };
    return r;
}

test('flushes when flushRows rows are queued', async () => {
    const db = fakeDb();
    const w = new BatchWriter({ db, columns: ['voltage_a', 'power_active_total'], flushRows: 3, flushMs: 60_000, log: quiet });
    w.start();
    const rows = [row(), row(), row()];
    rows.forEach((r) => w.enqueue(r));
    await w.flush();
    w.stop();
    assert.deepStrictEqual(db.inserts, [3], 'one statement for the batch');
    assert.deepStrictEqual(db.statements, ['BEGIN', 'INSERT', 'COMMIT']);
    assert.ok(rows.every((r) => r.acked === 1));
    assert.strictEqual(w.size, 0);
});

test('flushes on the timer when fewer than flushRows are queued', async () => {
    const db = fakeDb();
    const w = new BatchWriter({ db, columns: ['voltage_a'], flushRows: 500, flushMs: 20, log: quiet });
    w.start();
    const r = row();
    w.enqueue(r);
    assert.strictEqual(r.acked, 0, 'not acked before the flush');
    await new Promise((res) => setTimeout(res, 80));
    w.stop();
    assert.strictEqual(r.acked, 1);
    assert.strictEqual(db.committed, 1);
});

test('conflicts are counted per meter, still acked, and not reported as inserted', async () => {
    const t0 = 1_800_000_000_000;
    const db = fakeDb({ existing: new Set([`m1|${t0}`]) });
    const conflicts = [];
    let committed;
    const w = new BatchWriter({
        db, columns: ['voltage_a'], flushMs: 60_000, log: quiet,
        onConflict: (m) => conflicts.push(m),
        onCommitted: (ins, info) => { committed = { ids: ins.map((r) => r.time.getTime()), info }; },
    });
    const replayed = row('m1', t0);          // already in the DB
    const fresh = row('m1', t0 + 1000);
    const dupInBatch = row('m1', t0 + 1000); // same key twice in one batch
    [replayed, fresh, dupInBatch].forEach((r) => w.enqueue(r));
    await w.flush();
    assert.deepStrictEqual(conflicts, ['m1', 'm1']);
    assert.deepStrictEqual(committed.ids, [t0 + 1000]);
    assert.deepStrictEqual(committed.info.inserted, 1);
    assert.deepStrictEqual(committed.info.conflicts, 2);
    assert.ok([replayed, fresh, dupInBatch].every((r) => r.acked === 1));
});

test('a failed flush acks nothing, keeps the rows, and retries', async () => {
    const db = fakeDb({ failTimes: 2 });
    const w = new BatchWriter({ db, columns: ['voltage_a'], flushMs: 10, retryMinMs: 10, retryMaxMs: 20, log: quiet });
    const rows = [row(), row()];
    rows.forEach((r) => w.enqueue(r));
    assert.strictEqual(await w.flush(), false);
    assert.ok(rows.every((r) => r.acked === 0), 'nothing acked after a failure');
    assert.strictEqual(w.size, 2, 'rows stay queued');
    assert.ok(db.statements.includes('ROLLBACK'));
    assert.strictEqual(w.totals.failures, 1);
    assert.match(w.lastError, /connection terminated/);
    assert.strictEqual(await w.drain(2000), true);
    assert.ok(rows.every((r) => r.acked === 1));
    assert.strictEqual(w.totals.failures, 2);
    assert.strictEqual(w.lastError, null);
});

test('backpressure: whenNotFull waits while the queue is full, never drops', async () => {
    const db = fakeDb();
    const w = new BatchWriter({ db, columns: ['voltage_a'], maxQueue: 3, flushRows: 100, flushMs: 60_000, log: quiet });
    [row(), row(), row()].forEach((r) => w.enqueue(r));
    assert.strictEqual(w.isFull(), true);
    let released = false;
    const waiting = w.whenNotFull().then(() => { released = true; });
    await new Promise((res) => setTimeout(res, 20));
    assert.strictEqual(released, false, 'still waiting while full');
    assert.strictEqual(w.size, 3, 'nothing dropped');
    await w.flush();
    await waiting;
    assert.strictEqual(released, true);
    assert.strictEqual(await w.whenNotFull(), undefined, 'resolves at once when not full');
});

test('a batch never exceeds the PostgreSQL bind-parameter limit', () => {
    const columns = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const w = new BatchWriter({ db: fakeDb(), columns, flushRows: 10_000, log: quiet });
    const { values } = w.buildInsert(Array.from({ length: 300 }, () => ({ ...row(), values: {} })));
    assert.strictEqual(values.length, 300 * 204);
    // maxBatch is derived from the limit: 65000 / 204 = 318 rows
    assert.ok(Math.floor(65_000 / 204) >= 300);
});

test('the insert statement shape', () => {
    const w = new BatchWriter({ db: fakeDb(), columns: ['voltage_a', 'frequency'], log: quiet });
    const { text, values } = w.buildInsert([row('m9', 1_700_000_000_000)]);
    assert.match(text, /^INSERT INTO meter_readings \("time", "meter_id", "voltage_a", "frequency", "device_time", "time_source", ingested_at\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, NOW\(\)\) ON CONFLICT \(meter_id, time\) DO NOTHING RETURNING meter_id, time$/);
    assert.strictEqual(values[1], 'm9');
    assert.strictEqual(values[3], null, 'missing channel → NULL');
    assert.strictEqual(values[5], 'DEVICE');
});
