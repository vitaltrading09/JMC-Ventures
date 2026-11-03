
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
// removed uuid import

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

async function main() {
    const client = await pool.connect();
    try {
        console.log("Seeding database (Idempotent 5 Sites)...");

        // 1. Get or Create Tenant
        let tenantId;
        const tenantCheck = await client.query("SELECT id FROM tenants WHERE name = 'Demo Corporation'");
        if (tenantCheck.rows.length > 0) {
            tenantId = tenantCheck.rows[0].id;
            console.log(`Using existing Tenant: ${tenantId}`);
        } else {
            const tenantRes = await client.query(`
                INSERT INTO tenants (name) 
                VALUES ('Demo Corporation') 
                RETURNING id
            `);
            tenantId = tenantRes.rows[0].id;
            console.log(`Created Tenant: ${tenantId}`);
        }

        // 2. Get or Create User
        const password = DEMO_USER_PASSWORD;
        const hashedPassword = await bcrypt.hash(password, 10);

        const userCheck = await client.query("SELECT id FROM users WHERE email = 'demo@grid-iq.co.za'");
        if (userCheck.rows.length === 0) {
            await client.query(`
                INSERT INTO users (tenant_id, email, password_hash, role) 
                VALUES ($1, 'demo@grid-iq.co.za', $2, 'admin')
            `, [tenantId, hashedPassword]);
            console.log(`Created User: demo@grid-iq.co.za`);
        } else {
            console.log("User demo@grid-iq.co.za already exists.");
        }

        // 3. Create Sites & Meters (5 Demo Sites)
        const sites = [
            { name: 'Headquarters', address: '123 Power Lane, Johannesburg', timezone: 'Africa/Johannesburg', meterName: 'Main Incomer', model: 'Acuvim II' },
            { name: 'Cape Town Factory', address: '45 Industry Rd, Cape Town', timezone: 'Africa/Johannesburg', meterName: 'Production Line A', model: 'PM8000' },
            { name: 'Durban Distribution Ctr', address: '88 Logistics Blvd, Durban', timezone: 'Africa/Johannesburg', meterName: 'Warehouse Main', model: 'EM6400' },
            { name: 'Sandton Mall', address: '99 Retail St, Sandton', timezone: 'Africa/Johannesburg', meterName: 'HVAC Feed', model: 'Acuvim II' },
            { name: 'Pretoria Data Center', address: '12 Server Ave, Pretoria', timezone: 'Africa/Johannesburg', meterName: 'UPS Input', model: 'Janitza UMG' }
        ];

        for (const site of sites) {
            // Check if site exists
            const siteCheck = await client.query("SELECT id FROM sites WHERE name = $1 AND tenant_id = $2", [site.name, tenantId]);
            let siteId;

            if (siteCheck.rows.length > 0) {
                siteId = siteCheck.rows[0].id;
                console.log(`Site '${site.name}' already exists (${siteId}).`);
            } else {
                const siteRes = await client.query(`
                    INSERT INTO sites (tenant_id, name, address, timezone) 
                    VALUES ($1, $2, $3, $4) 
                    RETURNING id
                `, [tenantId, site.name, site.address, site.timezone]);
                siteId = siteRes.rows[0].id;
                console.log(`Created Site: ${site.name} (${siteId})`);
            }

            // Check if meter exists for this site
            const meterCheck = await client.query("SELECT id FROM meters WHERE site_id = $1", [siteId]);
            if (meterCheck.rows.length === 0) {
                await client.query(`
                    INSERT INTO meters (site_id, name, serial_number, model) 
                    VALUES ($1, $2, 'SN-' + substring(md5(random()::text), 1, 8), $3)
                `, [siteId, site.meterName, site.model]);
                console.log(`Created Meter: ${site.meterName}`);
            } else {
                console.log(`Meter for '${site.name}' already exists.`);
            }
        }

        console.log("Seeding complete! 5 Sites verified.");

    } catch (err) {
        console.error("Error seeding database:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
