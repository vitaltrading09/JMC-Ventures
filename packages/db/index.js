'use strict';
// @gridiq/db — migrations live in ./migrations (node-pg-migrate, plain SQL).
// This module holds what the services need at runtime: the shared retention
// constants and the startup check that refuses to run against a database that
// is behind the latest migration. Plain CommonJS with no build step, so every
// workspace can require it.

const fs = require('fs');
const path = require('path');

// ── Retention constants ─────────────────────────────────────────────────────
// Store-and-forward buffers hold hours, not weeks. mqtt.ts rejects device
// timestamps older than this and falls back to arrival time.
const MAX_BACKFILL_DAYS = 30;
// meter_readings chunks are compressed after this many days. MUST be strictly
// greater than MAX_BACKFILL_DAYS: TimescaleDB does not enforce unique indexes
// on compressed chunks, so a backfilled reading landing in one would bypass
// the ON CONFLICT guard and silently duplicate. The baseline migration's
// add_compression_policy interval must equal this (test/constants.test.js).
const COMPRESSION_AFTER_DAYS = 35;

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

module.exports = {
    MAX_BACKFILL_DAYS,
    COMPRESSION_AFTER_DAYS,
    MIGRATIONS_DIR,
    MIGRATIONS_TABLE,
    listMigrations,
    appliedMigrations,
    compareMigrations,
    assertSchemaCurrent,
    SchemaBehindError,
};
