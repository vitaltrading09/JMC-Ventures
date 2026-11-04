'use strict';
// @gridiq/db — migrations live in ./migrations (node-pg-migrate, plain SQL).
// This module holds what the services need at runtime: the shared retention
// constants and the startup check that refuses to run against a database that
// is behind the latest migration. Plain CommonJS with no build step, so every
// workspace can require it.

const fs = require('fs');
const path = require('path');

// ── Retention windows (env-configurable) ────────────────────────────────────
// MAX_BACKFILL_DAYS: mqtt.ts trusts a device timestamp only this far back,
// older ones fall back to arrival time. It must cover the AXM-WEB2
// store-and-forward buffer depth, or a long outage's history lands at the
// wrong time (still flagged time_source = 'ARRIVAL').
//
// COMPRESS_AFTER_DAYS: raw chunks are compressed after this many days, and
// the continuous aggregates refresh this far back. MUST be strictly greater
// than MAX_BACKFILL_DAYS: TimescaleDB does not enforce unique indexes on
// compressed chunks, so a backfilled reading landing in one would bypass the
// ON CONFLICT guard and silently duplicate, and a replay older than the
// refresh window would never reach the aggregates.
//
// The database policies follow these values through the migrate step
// (bin/migrate.js → reconcileRetention); services refuse to start when the
// database disagrees (assertRetentionConsistent).
const DEFAULT_MAX_BACKFILL_DAYS = 14;
const DEFAULT_COMPRESS_AFTER_DAYS = 15;

/** The continuous aggregates whose refresh window must cover the backfill window. */
const AGGREGATE_VIEWS = ['readings_1m', 'readings_10m', 'readings_30m', 'readings_1h', 'readings_1d'];

function positiveInt(env, name, def) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number of days (got "${raw}")`);
    return n;
}

/** Reads and validates the retention windows. Throws on an invalid combination. */
function retentionConfig(env = process.env) {
    const maxBackfillDays = positiveInt(env, 'MAX_BACKFILL_DAYS', DEFAULT_MAX_BACKFILL_DAYS);
    const compressAfterDays = positiveInt(env, 'COMPRESS_AFTER_DAYS', DEFAULT_COMPRESS_AFTER_DAYS);
    if (compressAfterDays <= maxBackfillDays) {
        throw new Error(
            `COMPRESS_AFTER_DAYS (${compressAfterDays}) must be greater than MAX_BACKFILL_DAYS (${maxBackfillDays}): ` +
            'backfilled readings would land in compressed chunks, where the duplicate guard does not apply.'
        );
    }
    return { maxBackfillDays, compressAfterDays };
}

// Resolved once at load, so a bad environment fails at startup.
const { maxBackfillDays: MAX_BACKFILL_DAYS, compressAfterDays: COMPRESSION_AFTER_DAYS } = retentionConfig();

/**
 * The retention policies currently in the database: the raw compression
 * interval and each aggregate's refresh start, in days (null when missing).
 */
async function retentionPolicies(db) {
    const r = await db.query(`
        SELECT 'compression' AS kind, hypertable_name AS name,
               extract(epoch FROM (config->>'compress_after')::interval) / 86400 AS days
        FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_compression' AND hypertable_name = 'meter_readings'
        UNION ALL
        SELECT 'refresh', c.view_name,
               extract(epoch FROM (j.config->>'start_offset')::interval) / 86400
        FROM timescaledb_information.continuous_aggregates c
        LEFT JOIN timescaledb_information.jobs j
               ON j.proc_name = 'policy_refresh_continuous_aggregate'
              AND j.hypertable_schema = c.view_schema
              AND j.hypertable_name = c.view_name
        WHERE c.view_name = ANY($1)`, [AGGREGATE_VIEWS]);
    const out = { compression: null, refresh: {} };
    for (const row of r.rows) {
        const days = row.days === null ? null : Number(row.days);
        if (row.kind === 'compression') out.compression = days;
        else out.refresh[row.name] = days;
    }
    return out;
}

/** Differences between the database policies and the configured windows (empty = consistent). */
function retentionMismatches(policies, cfg) {
    const issues = [];
    if (policies.compression !== cfg.compressAfterDays) {
        issues.push(`meter_readings compression after ${policies.compression ?? 'none'} days, expected ${cfg.compressAfterDays}`);
    }
    for (const view of AGGREGATE_VIEWS) {
        if (!(view in policies.refresh)) continue; // view not created yet (older schema)
        const days = policies.refresh[view];
        if (days === null || days < cfg.maxBackfillDays || days !== cfg.compressAfterDays) {
            issues.push(`${view} refreshes ${days ?? 'never'} days back, expected ${cfg.compressAfterDays}`);
        }
    }
    return issues;
}

class RetentionMismatchError extends Error {
    constructor(issues) {
        super(
            `Database retention policies do not match MAX_BACKFILL_DAYS / COMPRESS_AFTER_DAYS: ${issues.join('; ')}. ` +
            'Run the migrate step ("docker compose run --rm migrate"), which applies them.'
        );
        this.name = 'RetentionMismatchError';
        this.issues = issues;
    }
}

/** Startup check for services: throws RetentionMismatchError when the DB disagrees with the env. */
async function assertRetentionConsistent(db, cfg = retentionConfig()) {
    const issues = retentionMismatches(await retentionPolicies(db), cfg);
    if (issues.length > 0) throw new RetentionMismatchError(issues);
}

/**
 * Migrate step only: bring the database policies to the configured windows.
 * Returns what it changed. Aggregate schedules and end offsets are kept.
 */
async function reconcileRetention(db, cfg = retentionConfig()) {
    const changed = [];
    const policies = await retentionPolicies(db);
    if (policies.compression !== cfg.compressAfterDays) {
        await db.query(`SELECT remove_compression_policy('meter_readings', if_exists => TRUE)`);
        await db.query(`SELECT add_compression_policy('meter_readings', make_interval(days => $1))`, [cfg.compressAfterDays]);
        changed.push(`compression ${policies.compression ?? 'none'} → ${cfg.compressAfterDays} days`);
    }
    for (const [view, days] of Object.entries(policies.refresh)) {
        if (days === cfg.compressAfterDays) continue;
        const job = await db.query(`
            SELECT j.config->>'end_offset' AS end_offset, j.schedule_interval::text AS schedule
            FROM timescaledb_information.continuous_aggregates c
            JOIN timescaledb_information.jobs j
              ON j.proc_name = 'policy_refresh_continuous_aggregate'
             AND j.hypertable_schema = c.view_schema
             AND j.hypertable_name = c.view_name
            WHERE c.view_name = $1`, [view]);
        if (job.rows.length === 0) continue;
        const { end_offset, schedule } = job.rows[0];
        await db.query(`SELECT remove_continuous_aggregate_policy($1::regclass, if_exists => TRUE)`, [view]);
        await db.query(
            `SELECT add_continuous_aggregate_policy($1::regclass, start_offset => make_interval(days => $2),
                    end_offset => $3::interval, schedule_interval => $4::interval)`,
            [view, cfg.compressAfterDays, end_offset, schedule]);
        changed.push(`${view} refresh ${days} → ${cfg.compressAfterDays} days`);
    }
    return changed;
}

// ── Migrations ──────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'pgmigrations';
const MIGRATION_FILE = /^(\d+)_[\w-]+\.sql$/;

/** Migration names (file name without .sql) in the order node-pg-migrate runs them. */
function listMigrations(dir = MIGRATIONS_DIR) {
    return fs.readdirSync(dir)
        .filter((f) => MIGRATION_FILE.test(f))
        .sort((a, b) => {
            const na = BigInt(a.match(MIGRATION_FILE)[1]);
            const nb = BigInt(b.match(MIGRATION_FILE)[1]);
            return na < nb ? -1 : na > nb ? 1 : a.localeCompare(b);
        })
        .map((f) => f.replace(/\.sql$/, ''));
}

/** Names of migrations already applied, or [] if the migrations table does not exist yet. */
async function appliedMigrations(db) {
    const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${MIGRATIONS_TABLE}`]);
    if (!exists.rows[0].present) return [];
    const r = await db.query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY run_on, id`);
    return r.rows.map((row) => row.name);
}

/** Compare the code's migrations with the database's. */
function compareMigrations(expected, applied) {
    const appliedSet = new Set(applied);
    const expectedSet = new Set(expected);
    return {
        pending: expected.filter((n) => !appliedSet.has(n)),
        // Applied in the database but unknown to this code: the code is older
        // than the schema (e.g. a rollback of the image after a migration).
        unknown: applied.filter((n) => !expectedSet.has(n)),
    };
}

class SchemaBehindError extends Error {
    constructor(pending) {
        super(
            `Database schema is behind this build: ${pending.length} migration(s) pending ` +
            `(first: ${pending[0]}). Run the migrate step first: ` +
            `"docker compose run --rm migrate" (or "npm run migrate -w packages/db" outside Docker).`
        );
        this.name = 'SchemaBehindError';
        this.pending = pending;
    }
}

/**
 * Throws SchemaBehindError if any migration is pending. Warns (does not throw)
 * when the database has migrations this build does not know about.
 */
async function assertSchemaCurrent(db, { expected = listMigrations(), log = console } = {}) {
    const { pending, unknown } = compareMigrations(expected, await appliedMigrations(db));
    if (pending.length > 0) throw new SchemaBehindError(pending);
    if (unknown.length > 0) {
        log.warn(`[schema] Database has ${unknown.length} migration(s) newer than this build: ${unknown.join(', ')}`);
    }
    return { applied: expected.length, unknown };
}

/**
 * Materialise the aggregates over [from, to] (null = unbounded), lowest view
 * first so the hierarchical ones read fresh data. Needed when readings older
 * than the refresh window arrive (CSV import, restored dumps): the policies
 * only look COMPRESS_AFTER_DAYS back. Must run outside a transaction.
 */
async function refreshAggregates(db, from = null, to = null) {
    for (const view of AGGREGATE_VIEWS) {
        const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${view}`]);
        if (!exists.rows[0].present) continue;
        await db.query(`CALL refresh_continuous_aggregate($1::regclass, $2::timestamptz, $3::timestamptz)`, [view, from, to]);
    }
}

/**
 * Migrate step: materialise history an aggregate does not cover yet. The first
 * migration onto a database with history creates the views WITH NO DATA, and
 * their refresh policies may run straight away, covering only the last
 * COMPRESS_AFTER_DAYS. "Not empty" therefore proves nothing: compare the
 * earliest materialised bucket with the earliest raw reading, and refresh
 * everything before it. Returns the views it refreshed.
 */
async function materialiseNewAggregates(db) {
    const r = await db.query(`
        SELECT view_name, format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name) AS mat
        FROM timescaledb_information.continuous_aggregates WHERE view_name = ANY($1)`, [AGGREGATE_VIEWS]);
    const mats = new Map(r.rows.map((row) => [row.view_name, row.mat]));
    const raw = await db.query(`SELECT min(time) AS first FROM meter_readings`);
    const rawFirst = raw.rows[0].first;
    if (!rawFirst) return [];
    const done = [];
    for (const view of AGGREGATE_VIEWS) {
        const mat = mats.get(view);
        if (!mat) continue;
        const m = await db.query(`SELECT min(bucket) AS first FROM ${mat}`);
        const matFirst = m.rows[0].first;
        // Covered when the earliest bucket starts within a day of the earliest reading.
        if (matFirst && new Date(matFirst).getTime() - new Date(rawFirst).getTime() <= 86_400_000) continue;
        await db.query(`CALL refresh_continuous_aggregate($1::regclass, NULL, $2::timestamptz)`, [view, matFirst]);
        done.push(view);
    }
    return done;
}

module.exports = {
    refreshAggregates,
    materialiseNewAggregates,
    MAX_BACKFILL_DAYS,
    COMPRESSION_AFTER_DAYS,
    DEFAULT_MAX_BACKFILL_DAYS,
    DEFAULT_COMPRESS_AFTER_DAYS,
    AGGREGATE_VIEWS,
    retentionConfig,
    retentionPolicies,
    retentionMismatches,
    assertRetentionConsistent,
    reconcileRetention,
    RetentionMismatchError,
    MIGRATIONS_DIR,
    MIGRATIONS_TABLE,
    listMigrations,
    appliedMigrations,
    compareMigrations,
    assertSchemaCurrent,
    SchemaBehindError,
};
