// Retention windows. Compression and the continuous-aggregate refresh windows
// must start strictly later than the MQTT backfill window:
//   - TimescaleDB does not enforce unique indexes on compressed chunks, so a
//     store-and-forward replay landing in one would bypass the ON CONFLICT
//     guard and silently duplicate;
//   - a replay older than an aggregate's refresh window would never reach it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    MAX_BACKFILL_DAYS, COMPRESSION_AFTER_DAYS, DEFAULT_MAX_BACKFILL_DAYS, DEFAULT_COMPRESS_AFTER_DAYS,
    AGGREGATE_VIEWS, MIGRATIONS_DIR, listMigrations, retentionConfig, retentionMismatches,
} = require('..');

const upSql = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8').split(/^-- Down Migration/m)[0];

test('defaults: compression starts strictly after the backfill window', () => {
    assert.strictEqual(DEFAULT_MAX_BACKFILL_DAYS, 14);
    assert.strictEqual(DEFAULT_COMPRESS_AFTER_DAYS, 15);
    assert.ok(DEFAULT_COMPRESS_AFTER_DAYS > DEFAULT_MAX_BACKFILL_DAYS);
    // No env set in the test run: the resolved values are the defaults.
    assert.strictEqual(MAX_BACKFILL_DAYS, DEFAULT_MAX_BACKFILL_DAYS);
    assert.strictEqual(COMPRESSION_AFTER_DAYS, DEFAULT_COMPRESS_AFTER_DAYS);
});

test('retentionConfig: env values, validated', async (t) => {
    await t.test('reads the env', () => {
        assert.deepStrictEqual(retentionConfig({ MAX_BACKFILL_DAYS: '30', COMPRESS_AFTER_DAYS: '35' }), { maxBackfillDays: 30, compressAfterDays: 35 });
        assert.deepStrictEqual(retentionConfig({}), { maxBackfillDays: 14, compressAfterDays: 15 });
        assert.deepStrictEqual(retentionConfig({ MAX_BACKFILL_DAYS: ' ' }), { maxBackfillDays: 14, compressAfterDays: 15 });
    });
    await t.test('refuses compression at or before the backfill window', () => {
        assert.throws(() => retentionConfig({ MAX_BACKFILL_DAYS: '15', COMPRESS_AFTER_DAYS: '15' }), /must be greater than MAX_BACKFILL_DAYS/);
        assert.throws(() => retentionConfig({ MAX_BACKFILL_DAYS: '20' }), /must be greater/);
    });
    await t.test('refuses non-integers', () => {
        assert.throws(() => retentionConfig({ MAX_BACKFILL_DAYS: '7.5' }), /positive whole number/);
        assert.throws(() => retentionConfig({ COMPRESS_AFTER_DAYS: '0' }), /positive whole number/);
        assert.throws(() => retentionConfig({ COMPRESS_AFTER_DAYS: 'abc' }), /positive whole number/);
    });
});

test('migrations: the latest compression policy and every refresh window match the defaults', () => {
    let latestCompression = null;
    const refresh = {};
    for (const name of listMigrations()) {
        const sql = upSql(name);
        for (const m of sql.matchAll(/add_compression_policy\(\s*'meter_readings'\s*,\s*INTERVAL\s*'(\d+)\s*days?'/gi)) {
            latestCompression = Number(m[1]);
        }
        for (const m of sql.matchAll(/add_continuous_aggregate_policy\(\s*'(\w+)'\s*,\s*start_offset\s*=>\s*INTERVAL\s*'(\d+)\s*days?'/gi)) {
            refresh[m[1]] = Number(m[2]);
        }
    }
    assert.strictEqual(latestCompression, DEFAULT_COMPRESS_AFTER_DAYS);
    assert.deepStrictEqual(Object.keys(refresh).sort(), [...AGGREGATE_VIEWS].sort(), 'every aggregate has a refresh policy');
    for (const [view, days] of Object.entries(refresh)) {
        assert.ok(days >= DEFAULT_MAX_BACKFILL_DAYS, `${view} refreshes only ${days} days back`);
        assert.strictEqual(days, DEFAULT_COMPRESS_AFTER_DAYS, `${view}`);
    }
});

test('retentionMismatches: what the services refuse to start on', () => {
    const cfg = { maxBackfillDays: 14, compressAfterDays: 15 };
    const ok = { compression: 15, refresh: Object.fromEntries(AGGREGATE_VIEWS.map((v) => [v, 15])) };
    assert.deepStrictEqual(retentionMismatches(ok, cfg), []);
    assert.match(retentionMismatches({ ...ok, compression: 35 }, cfg)[0], /compression after 35 days, expected 15/);
    assert.match(retentionMismatches({ ...ok, refresh: { ...ok.refresh, readings_10m: 7 } }, cfg)[0], /readings_10m refreshes 7 days back/);
    assert.match(retentionMismatches({ ...ok, refresh: { ...ok.refresh, readings_1h: null } }, cfg)[0], /readings_1h refreshes never/);
    // A schema from before the aggregates existed: only compression is checked.
    assert.deepStrictEqual(retentionMismatches({ compression: 15, refresh: {} }, cfg), []);
});

test('mqtt.ts takes MAX_BACKFILL_DAYS from @gridiq/db instead of its own literal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../services/ingestion-service/src/mqtt.ts'), 'utf8');
    assert.match(src, /import\s*\{[^}]*\bMAX_BACKFILL_DAYS\b[^}]*\}\s*from\s*'@gridiq\/db'/);
    assert.doesNotMatch(src, /const\s+MAX_BACKFILL_DAYS\s*=/);
});
