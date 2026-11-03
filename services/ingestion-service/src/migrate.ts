import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { waitUntil, databaseReachable } from './roles';

// ─────────────────────────────────────────────────────────────────────────────
// Interim migrate step (Phase 1). Phase 2 replaces this with node-pg-migrate.
//
// Applies init.sql only when the base schema is missing (a fresh database),
// so it is a no-op on a restored production database. The api role's startup
// bootstrap then adds everything init.sql does not cover. Never touches
// existing rows.
// ─────────────────────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const INIT_SQL = process.env.INIT_SQL_PATH || path.resolve(__dirname, '../../../init.sql');

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('FATAL: DATABASE_URL is not set.');
        process.exit(1);
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
        await waitUntil('database', () => databaseReachable(pool), { timeoutMs: 120_000 });

        const { rows } = await pool.query(`SELECT to_regclass('public.tenants') IS NOT NULL AS has_base`);
        if (rows[0].has_base) {
            console.log('[migrate] Base schema present; nothing to do.');
            return;
        }

        console.log(`[migrate] Empty database: applying ${INIT_SQL}`);
        const sql = fs.readFileSync(INIT_SQL, 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
        console.log('[migrate] Base schema created.');
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error('[migrate] FAILED:', e?.message || e);
    process.exit(1);
});
