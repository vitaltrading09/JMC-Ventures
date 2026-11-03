// Compression must start strictly later than the MQTT backfill window.
// TimescaleDB does not enforce unique indexes on compressed chunks, so if a
// store-and-forward replay could land in a compressed chunk, the ON CONFLICT
// guard would be bypassed and readings would silently duplicate.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { MAX_BACKFILL_DAYS, COMPRESSION_AFTER_DAYS, MIGRATIONS_DIR, listMigrations } = require('..');

test('compression starts strictly after the backfill window', () => {
    assert.ok(Number.isInteger(MAX_BACKFILL_DAYS) && MAX_BACKFILL_DAYS > 0);
    assert.ok(
        COMPRESSION_AFTER_DAYS > MAX_BACKFILL_DAYS,
        `COMPRESSION_AFTER_DAYS (${COMPRESSION_AFTER_DAYS}) must be > MAX_BACKFILL_DAYS (${MAX_BACKFILL_DAYS})`,
    );
});

test('every compression policy in the migrations uses COMPRESSION_AFTER_DAYS', () => {
    const policies = [];
    for (const name of listMigrations()) {
        const up = fs.readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8').split(/^-- Down Migration/m)[0];
        for (const m of up.matchAll(/add_compression_policy\(\s*'meter_readings'\s*,\s*INTERVAL\s*'(\d+)\s*days?'/gi)) {
            policies.push({ name, days: Number(m[1]) });
        }
    }
    assert.ok(policies.length >= 1, 'no meter_readings compression policy found in the migrations');
    for (const p of policies) {
        assert.strictEqual(p.days, COMPRESSION_AFTER_DAYS, `${p.name} sets ${p.days} days`);
        assert.ok(p.days > MAX_BACKFILL_DAYS, `${p.name}: ${p.days} days is not beyond the ${MAX_BACKFILL_DAYS}-day backfill window`);
    }
});

test('mqtt.ts takes MAX_BACKFILL_DAYS from @gridiq/db instead of its own literal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../services/ingestion-service/src/mqtt.ts'), 'utf8');
    assert.match(src, /import\s*\{[^}]*\bMAX_BACKFILL_DAYS\b[^}]*\}\s*from\s*'@gridiq\/db'/);
    assert.doesNotMatch(src, /const\s+MAX_BACKFILL_DAYS\s*=/);
});
