#!/usr/bin/env node
'use strict';
// Grid-IQ migrate step.
//
//   node packages/db/bin/migrate.js up       apply every pending migration (default)
//   node packages/db/bin/migrate.js status   list applied / pending, exit 1 if pending
//   node packages/db/bin/migrate.js down 1   roll back N migrations (dev only)
//
// Reads DATABASE_URL. Waits up to 2 minutes for the database to accept
// connections. `up` first updates the timescaledb extension if the image ships
// a newer version than the database has, then runs the node-pg-migrate CLI
// (ESM-only, so it runs as its own process) against packages/db/migrations
// with a lock, so two concurrent runs cannot interleave, and finally applies
// the retention windows from the environment (MAX_BACKFILL_DAYS,
// COMPRESS_AFTER_DAYS) to the compression and aggregate-refresh policies.

const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const {
    MIGRATIONS_DIR, MIGRATIONS_TABLE, listMigrations, appliedMigrations, compareMigrations,
    retentionConfig, reconcileRetention, materialiseNewAggregates,
} = require('..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url, timeoutMs = 120_000) {
    const started = Date.now();
    for (;;) {
        const client = new Client({ connectionString: url });
        try {
            await client.connect();
            return client;
        } catch (e) {
            await client.end().catch(() => {});
            if (Date.now() - started > timeoutMs) throw e;
            console.log(`[migrate] Waiting for database (${e.message})`);
            await sleep(2_000);
        }
    }
}

/**
 * After a TimescaleDB image upgrade the database still carries the old
 * extension version. ALTER EXTENSION ... UPDATE must be the first statement
 * of a fresh session, so it gets its own connection. Only runs when the image
 * ships a different default version than the one installed; never on `status`.
 */
async function updateTimescaleExtension(url) {
    const probe = await connect(url);
    let versions;
    try {
        const r = await probe.query(`
            SELECT e.extversion AS installed, a.default_version AS available
            FROM pg_extension e JOIN pg_available_extensions a ON a.name = e.extname
            WHERE e.extname = 'timescaledb'`);
        versions = r.rows[0];
    } finally {
        await probe.end();
    }
    if (!versions || versions.installed === versions.available) return;
    console.log(`[migrate] Updating timescaledb extension ${versions.installed} -> ${versions.available}`);
    const client = await connect(url);
    try {
        await client.query('ALTER EXTENSION timescaledb UPDATE');
    } finally {
        await client.end();
    }
}

async function status(client) {
    const expected = listMigrations();
    const applied = await appliedMigrations(client);
    const { pending, unknown } = compareMigrations(expected, applied);
    for (const n of expected) console.log(`${pending.includes(n) ? 'PENDING' : 'applied'}  ${n}`);
    for (const n of unknown) console.log(`unknown  ${n}  (in the database, not in this build)`);
    return pending.length === 0;
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.error('[migrate] FATAL: DATABASE_URL is not set.');
        process.exit(1);
    }
    const [command = 'up', ...rest] = process.argv.slice(2);

    const client = await connect(url);
    try {
        if (command === 'status') {
            process.exit((await status(client)) ? 0 : 1);
        }
    } finally {
        await client.end();
    }

    if (command !== 'up' && command !== 'down') {
        console.error(`[migrate] Unknown command "${command}". Use up, status or down [N].`);
        process.exit(1);
    }
    if (command === 'up') await updateTimescaleExtension(url);

    const cli = path.join(path.dirname(require.resolve('node-pg-migrate/package.json')), 'bin', 'node-pg-migrate.js');
    const args = [
        cli, command, ...rest,
        '--migrations-dir', MIGRATIONS_DIR,
        '--migrations-table', MIGRATIONS_TABLE,
        '--check-order',
        // One transaction for the whole run: a failure leaves the schema untouched.
        '--single-transaction',
        '--no-verbose',
    ];
    console.log(`[migrate] node-pg-migrate ${command} ${rest.join(' ')}`.trim());
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
    if (r.status !== 0) {
        console.error(`[migrate] FAILED (exit ${r.status})`);
        process.exit(r.status || 1);
    }

    // Retention windows come from the environment (MAX_BACKFILL_DAYS,
    // COMPRESS_AFTER_DAYS); bring the compression and aggregate-refresh
    // policies in line. Services refuse to start until they match.
    if (command === 'up') {
        const cfg = retentionConfig(process.env);
        const db = await connect(url);
        try {
            const changed = await reconcileRetention(db, cfg);
            console.log(changed.length
                ? `[migrate] Retention policies updated: ${changed.join('; ')}`
                : `[migrate] Retention policies match (backfill ${cfg.maxBackfillDays} d, compression and aggregate refresh ${cfg.compressAfterDays} d)`);
            // First run of the aggregates migration on a database with history:
            // materialise everything once (the policies only look back
            // COMPRESS_AFTER_DAYS). Can take a while on a large database.
            const started = Date.now();
            const views = await materialiseNewAggregates(db);
            if (views.length) {
                console.log(`[migrate] Materialised ${views.join(', ')} over all history in ${((Date.now() - started) / 1000).toFixed(1)} s`);
            }
        } finally {
            await db.end();
        }
    }
    console.log('[migrate] Done.');
}

main().catch((e) => {
    console.error('[migrate] FAILED:', e?.message || e);
    process.exit(1);
});
