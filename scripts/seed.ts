
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db',
});

async function seed() {
    const client = await pool.connect();
    try {
        console.log('🌱 Seeding database...');

        // 1. Create Tenant
        const tenantRes = await client.query(`
            INSERT INTO tenants (name) 
            VALUES ('Demo Enterprise') 
            RETURNING id
        `);
        const tenantId = tenantRes.rows[0].id;
        console.log(`✅ Created Tenant: ${tenantId}`);

        // 2. Create User
        await client.query(`
            INSERT INTO users (tenant_id, email, password_hash, role)
            VALUES ($1, 'demo@powerguard.com', 'hashed_secret', 'admin')
        `, [tenantId]);
        console.log(`✅ Created User: demo@powerguard.com`);

        // 3. Create Site
        const siteRes = await client.query(`
            INSERT INTO sites (tenant_id, name, address, timezone)
            VALUES ($1, 'Headquarters (Sandton)', '123 Rivonia Rd, Sandton, 2196', 'Africa/Johannesburg')
            RETURNING id
        `, [tenantId]);
        const siteId = siteRes.rows[0].id;
        console.log(`✅ Created Site: Headquarters (Sandton)`);

        // 4. Create Meters
        const meters = [
            { name: "Main Incomer A", type: "grid_incomer", location: "Sandton HQ" },
            { name: "Production Line 1", type: "sub_meter", location: "Factory Floor" },
            { name: "HVAC System", type: "sub_meter", location: "Rooftop" },
            { name: "Solar Inverter 1", type: "solar_inverter", location: "Carport" },
            { name: "Battery Storage", type: "bess", location: "Basement" }
        ];

        for (const m of meters) {
            await client.query(`
                INSERT INTO meters (site_id, name, serial_number, model)
                VALUES ($1, $2, $3, 'Acuvim II')
            `, [siteId, m.name, `SN-${Math.floor(Math.random() * 10000)}`]);
        }
        console.log(`✅ Created ${meters.length} Meters`);

        console.log('🌱 Seeding complete!');
    } catch (err) {
        console.error('❌ Seeding failed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

seed();
