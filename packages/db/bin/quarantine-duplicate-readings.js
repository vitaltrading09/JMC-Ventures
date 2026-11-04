#!/usr/bin/env node
'use strict';
// Explicit, documented cleanup step for databases created before the
// ON CONFLICT guard existed, which can hold several readings for one
// (meter_id, time). The baseline migration refuses to run until there are none.
//
//   node packages/db/bin/quarantine-duplicate-readings.js           report only (default)
//   node packages/db/bin/quarantine-duplicate-readings.js --apply   move them aside
//
// --apply moves EVERY row of a duplicated (meter_id, time) into
// meter_readings_quarantine, in one transaction. It keeps none of them in
// meter_readings, because nothing can tell which reading was right (seen in
// practice: the same CSV imported twice with different unit scaling). Nothing
// is permanently deleted: the rows stay in the quarantine table, with the time
// they were moved, for manual review or restore. Reads DATABASE_URL.

const { Client } = require('pg');

const DUP_KEYS = `
    SELECT meter_id, time FROM meter_readings
    GROUP BY meter_id, time HAVING count(*) > 1`;

async function report(client) {
    const r = await client.query(`
        WITH d AS (${DUP_KEYS})
        SELECT r.meter_id, m.name AS meter_name, count(DISTINCT r.time)::int AS timestamps, count(*)::int AS rows,
               min(r.time) AS first, max(r.time) AS last
        FROM meter_readings r
        JOIN d USING (meter_id, time)
        LEFT JOIN meters m ON m.id = r.meter_id
        GROUP BY r.meter_id, m.name
        ORDER BY rows DESC`);
    const total = await client.query(`SELECT count(*)::int AS n FROM meter_readings`);
    return { perMeter: r.rows, totalReadings: total.rows[0].n };
}

async function apply(client) {
    await client.query('BEGIN');
    try {
        // Same columns as meter_readings (whatever this database has), plus
        // when and why each row was moved.
        await client.query(`
            CREATE TABLE IF NOT EXISTS meter_readings_quarantine
                (LIKE meter_readings INCLUDING DEFAULTS)`);
        await client.query(`
            ALTER TABLE meter_readings_quarantine
                ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ADD COLUMN IF NOT EXISTS quarantine_reason TEXT`);
        await client.query(`CREATE TEMP TABLE dup_keys ON COMMIT DROP AS ${DUP_KEYS}`);
        const cols = (await client.query(`
            SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS list
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meter_readings'`)).rows[0].list;
        const moved = await client.query(`
            INSERT INTO meter_readings_quarantine (${cols}, quarantine_reason)
            SELECT ${cols.split(', ').map((c) => `r.${c}`).join(', ')}, 'duplicate (meter_id, time)'
            FROM meter_readings r JOIN dup_keys d USING (meter_id, time)`);
        const removed = await client.query(`
            DELETE FROM meter_readings r USING dup_keys d
            WHERE r.meter_id = d.meter_id AND r.time = d.time`);
        if (moved.rowCount !== removed.rowCount) {
            throw new Error(`copied ${moved.rowCount} rows but would remove ${removed.rowCount}; rolled back`);
        }
        await client.query('COMMIT');
        return moved.rowCount;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    }
}

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('FATAL: DATABASE_URL is not set.');
        process.exit(1);
    }
    const doApply = process.argv.includes('--apply');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        const { perMeter, totalReadings } = await report(client);
        if (perMeter.length === 0) {
            console.log('No duplicate (meter_id, time) readings. Nothing to do.');
            return;
        }
        const rows = perMeter.reduce((n, m) => n + m.rows, 0);
        console.log(`Duplicate (meter_id, time) readings: ${rows} rows of ${totalReadings}`);
        for (const m of perMeter) {
            console.log(`  ${m.meter_name ?? '(no meter row)'} ${m.meter_id}: ${m.timestamps} timestamps, ${m.rows} rows, ` +
                `${m.first.toISOString()} .. ${m.last.toISOString()}`);
        }
        if (!doApply) {
            console.log('\nReport only. Re-run with --apply to move all of these rows to meter_readings_quarantine.');
            return;
        }
        const n = await apply(client);
        console.log(`\nMoved ${n} rows to meter_readings_quarantine. Now run the migrations again.`);
    } finally {
        await client.end();
    }
}

main().catch((e) => {
    console.error('FAILED:', e?.message || e);
    process.exit(1);
});
