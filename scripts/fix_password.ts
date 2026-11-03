
import { Pool } from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

// Demo accounts must never be created by accident on a real server.
if (process.env.ALLOW_DEMO_SEED !== 'true') {
    console.error('Refusing to seed: set ALLOW_DEMO_SEED=true to create demo data (local dev only).');
    process.exit(1);
}
if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set.');
    process.exit(1);
}
const DEMO_USER_PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!DEMO_USER_PASSWORD || DEMO_USER_PASSWORD.length < 12) {
    console.error('FATAL: set DEMO_USER_PASSWORD (12+ chars) for the demo login.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function fixPassword() {
    const client = await pool.connect();
    try {
        console.log('🔒 Updating password for demo user...');

        const saltRounds = 10;
        const password = DEMO_USER_PASSWORD;
        const hash = await bcrypt.hash(password, saltRounds);

        const res = await client.query(`
            UPDATE users 
            SET password_hash = $1 
            WHERE email = 'demo@grid-iq.co.za'
        `, [hash]);

        console.log(`✅ Updated ${res.rowCount} user(s) to DEMO_USER_PASSWORD.`);

    } catch (err) {
        console.error('❌ Password update failed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

fixPassword();
