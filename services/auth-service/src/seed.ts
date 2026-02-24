
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
// removed uuid import

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db',
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
        const password = 'password123';
        const hashedPassword = await bcrypt.hash(password, 10);

        const userCheck = await client.query("SELECT id FROM users WHERE email = 'demo@powerguard.com'");
        if (userCheck.rows.length === 0) {
            await client.query(`
                INSERT INTO users (tenant_id, email, password_hash, role) 
                VALUES ($1, 'demo@powerguard.com', $2, 'admin')
            `, [tenantId, hashedPassword]);
            console.log(`Created User: demo@powerguard.com`);
        } else {
            console.log("User demo@powerguard.com already exists.");
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
