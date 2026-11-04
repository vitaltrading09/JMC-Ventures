// /health/deep evaluation (src/health.ts).

const test = require('node:test');
const assert = require('node:assert');

const { evaluateDeepHealth, deepHealthConfig, healthTokenValid } = require('../dist/health.js');

const cfg = deepHealthConfig({});
const good = {
    dbOk: true, pendingMigrations: 0, ingestAliveAgeS: 12, ingestFlushAgeS: 1,
    metersReportingRecently: 20, metersSilent: 0, backupAgeS: 6 * 3600,
};

test('config defaults', () => {
    assert.deepStrictEqual(cfg, { maxIngestAliveAgeS: 120, maxFlushAgeS: 300, maxBackupAgeS: 26 * 3600, requireBackup: true, silentMinutes: 5 });
    assert.strictEqual(deepHealthConfig({ HEALTH_REQUIRE_BACKUP: 'false' }).requireBackup, false);
    assert.strictEqual(deepHealthConfig({ HEALTH_MAX_FLUSH_AGE_S: '60' }).maxFlushAgeS, 60);
});

test('all good → ok', () => {
    const r = evaluateDeepHealth(good, cfg);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'ok');
});

test('ingest stopped: heartbeat goes stale, flush age grows → degraded', () => {
    const r = evaluateDeepHealth({ ...good, ingestAliveAgeS: 400, ingestFlushAgeS: 410 }, cfg);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.checks.ingest.ok, false);
    assert.strictEqual(r.checks.ingest.last_flush_age_s, 410);
    assert.match(r.checks.ingest.problem, /heartbeat stale/);
});

test('ingest alive but nothing committed while meters report → degraded', () => {
    const r = evaluateDeepHealth({ ...good, ingestFlushAgeS: 900 }, cfg);
    assert.strictEqual(r.checks.ingest.ok, false);
    assert.match(r.checks.ingest.problem, /no readings committed/);
});

test('no meters reporting: an old flush is not an outage', () => {
    const r = evaluateDeepHealth({ ...good, metersReportingRecently: 0, ingestFlushAgeS: null }, cfg);
    assert.strictEqual(r.checks.ingest.ok, true);
});

test('pending migration, DB down, missing or old backup', () => {
    assert.strictEqual(evaluateDeepHealth({ ...good, pendingMigrations: 1 }, cfg).checks.migrations.ok, false);
    const down = evaluateDeepHealth({ ...good, dbOk: false, dbError: 'ECONNREFUSED', pendingMigrations: null }, cfg);
    assert.strictEqual(down.ok, false);
    assert.strictEqual(down.checks.db.error, 'ECONNREFUSED');
    assert.match(evaluateDeepHealth({ ...good, backupAgeS: null }, cfg).checks.backup.problem, /no successful backup/);
    assert.match(evaluateDeepHealth({ ...good, backupAgeS: 30 * 3600 }, cfg).checks.backup.problem, /too old/);
    assert.strictEqual(evaluateDeepHealth({ ...good, backupAgeS: null }, deepHealthConfig({ HEALTH_REQUIRE_BACKUP: 'false' })).ok, true);
});

test('silent meters are reported, not failing', () => {
    const r = evaluateDeepHealth({ ...good, metersSilent: 3 }, cfg);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.checks.meters.silent, 3);
});

test('token check', () => {
    assert.strictEqual(healthTokenValid('s3cret-token', 's3cret-token'), true);
    assert.strictEqual(healthTokenValid('s3cret-token', 's3cret-tokex'), false);
    assert.strictEqual(healthTokenValid('s3cret-token', 'short'), false);
    assert.strictEqual(healthTokenValid('s3cret-token', undefined), false);
    assert.strictEqual(healthTokenValid(undefined, 'anything'), false, 'disabled without a configured token');
});
