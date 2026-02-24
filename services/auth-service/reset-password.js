const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db'
});

async function resetPasswords() {
    const hash = await bcrypt.hash('password123', 10);
    console.log('Generated hash:', hash);

    const client = await pool.connect();
    try {
        // Update demo user
        await client.query(
            "UPDATE users SET password_hash = $1 WHERE email = 'demo@powerguard.com'",
            [hash]
        );
        console.log('Updated demo@powerguard.com');

        // Update admin user
        await client.query(
            "UPDATE users SET password_hash = $1 WHERE email = 'admin@powerguard.com'",
            [hash]
        );
        console.log('Updated admin@powerguard.com');

        // Verify
        const res = await client.query("SELECT email, LEFT(password_hash,20) as hash_preview, role FROM users");
        console.log('Users in DB:', res.rows);
    } finally {
        client.release();
        await pool.end();
    }
}

resetPasswords().catch(console.error);
