// Guards for bugs fixed after Phases 1-4. The behaviour itself was verified
// against a database (see the fix PR); these keep the specific mistakes from
// coming back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', '..', '..', p), 'utf8');

test('energy score energy is not "kW × 5/60 per reading" (assumed 5-minute readings)', () => {
    const s = src('services/ingestion-service/src/energy-score.ts');
    assert.doesNotMatch(s, /\*\s*5(\.0)?\s*\/\s*60/);
    assert.match(s, /FROM readings_1h v/);
});

test('both services survive a database restart (pool error handler)', () => {
    for (const p of ['services/ingestion-service/src/main.ts', 'services/auth-service/src/main.ts']) {
        assert.match(src(p), /pool\.on\('error'/, p);
    }
});

test('CSV import counts only rows actually inserted, and tags them IMPORT', () => {
    const s = src('services/ingestion-service/src/main.ts');
    assert.match(s, /if \(ins\.rowCount === 1\) inserted\+\+; else duplicates\+\+;/);
    assert.match(s, /\$10,'IMPORT'\)/);
});

test('value ledger does not COUNT(*) the raw hypertable', () => {
    const s = src('services/ingestion-service/src/main.ts');
    const i = s.indexOf("app.get('/value-ledger'");
    const block = s.slice(i, s.indexOf('app.get(', i + 10));
    assert.doesNotMatch(block, /COUNT\(\*\)[^`]*FROM meter_readings/);
    assert.match(block, /FROM readings_1d v/);
});

test('AI context demand is per meter, never averaged across meters', () => {
    const s = src('services/ingestion-service/src/main.ts');
    assert.doesNotMatch(s, /AVG\(v\.kva_demand\)/);
    assert.match(s, /GROUP BY v\.meter_id, m\.name/);
});

test('compliance voltage covers every phase', () => {
    const s = src('services/ingestion-service/src/power-quality.ts');
    assert.match(s, /unnest\(ARRAY\[v_rms_a, v_rms_b, v_rms_c\]\)/);
});
