
import { Pool } from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db',
});

async function fixPassword() {
    const client = await pool.connect();
    try {
        console.log('🔒 Updating password for demo user...');

        const saltRounds = 10;
        const password = 'demo123';
        const hash = await bcrypt.hash(password, saltRounds);

        const res = await client.query(`
            UPDATE users 
            SET password_hash = $1 
            WHERE email = 'demo@powerguard.com'
        `, [hash]);

        console.log(`✅ Updated ${res.rowCount} user(s). Password is now '${password}'`);

    } catch (err) {
        console.error('❌ Password update failed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

fixPassword();
