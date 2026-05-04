import dotenv from 'dotenv';
import { Pool } from 'pg';
import cron from 'node-cron';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { initMqtt } from './mqtt';
import { computeAndStoreSiteScore, getLatestSiteScore } from './energy-score';
import {
    generateAndStoreSiteRecommendations,
    getSiteRecommendations,
    getTenantRecommendations,
} from './ai-recommendations';

dotenv.config();

// Redis Connection
const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null,
});

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db',
    max: 20, // Connection pool size from env
    idleTimeoutMillis: 30000,
});

// Initialize schema for site settings
(async () => {
    const client = await pool.connect();
    try {
        // Energy score weight columns (added to existing site_settings)
        await client.query(`
            ALTER TABLE site_settings
            ADD COLUMN IF NOT EXISTS tariff_type VARCHAR(50),
            ADD COLUMN IF NOT EXISTS weight_pf DECIMAL(4,3),
            ADD COLUMN IF NOT EXISTS weight_thd DECIMAL(4,3),
            ADD COLUMN IF NOT EXISTS weight_load_factor DECIMAL(4,3),
            ADD COLUMN IF NOT EXISTS weight_voltage_quality DECIMAL(4,3);
        `);

        // NRS 048 alert thresholds + MDI + demand tariff
        await client.query(`
            ALTER TABLE site_settings
            ADD COLUMN IF NOT EXISTS alert_max_v DECIMAL(10,2),
            ADD COLUMN IF NOT EXISTS alert_min_freq DECIMAL(6,2),
            ADD COLUMN IF NOT EXISTS alert_max_freq DECIMAL(6,2),
            ADD COLUMN IF NOT EXISTS contracted_mdi_kva DECIMAL(10,2),
            ADD COLUMN IF NOT EXISTS tariff_demand DECIMAL(10,2);
        `);

        // Energy scores table
        await client.query(`
            CREATE TABLE IF NOT EXISTS energy_scores (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
                score DECIMAL(5,2) NOT NULL,
                pf_score DECIMAL(5,2), thd_score DECIMAL(5,2),
                load_factor_score DECIMAL(5,2), voltage_quality_score DECIMAL(5,2),
                weight_pf DECIMAL(4,3), weight_thd DECIMAL(4,3),
                weight_load_factor DECIMAL(4,3), weight_voltage_quality DECIMAL(4,3),
                tariff_type VARCHAR(50), calculated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_energy_scores_site ON energy_scores (site_id, calculated_at DESC);
        `);

        // Recommendations table
        await client.query(`
            CREATE TABLE IF NOT EXISTS recommendations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
                tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
                type VARCHAR(100) NOT NULL, priority INTEGER DEFAULT 1,
                title VARCHAR(255) NOT NULL, problem TEXT, solution TEXT,
                estimated_monthly_saving_zar DECIMAL(12,2) DEFAULT 0,
                estimated_implementation_cost_zar DECIMAL(12,2) DEFAULT 0,
                payback_months INTEGER DEFAULT 0,
                confidence VARCHAR(20) DEFAULT 'MEDIUM',
                standard_reference VARCHAR(255),
                status VARCHAR(50) DEFAULT 'ACTIVE',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_recommendations_site ON recommendations (site_id, status, created_at DESC);
        `);

        // Leads table
        await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
                tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
                recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
                status VARCHAR(50) DEFAULT 'NEW',
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at DESC);
        `);

        console.log('DB Schema initialized: energy_scores, recommendations, leads verified');
        await client.query(`
            CREATE TABLE IF NOT EXISTS site_settings (
                site_id UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
                tariff_peak DECIMAL(10,2),
                peak_times VARCHAR(255),
                tariff_standard DECIMAL(10,2),
                standard_times VARCHAR(255),
                tariff_offpeak DECIMAL(10,2),
                offpeak_times VARCHAR(255),
                alert_max_kw DECIMAL(10,2),
                alert_min_v DECIMAL(10,2),
                alert_max_thd DECIMAL(10,2),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("DB Schema initialized: site_settings verified");
    } catch (e) {
        console.error("DB Schema initialization failed", e);
    } finally {
        client.release();
    }

    // Start MQTT Listener bridging Mosquitto to TimescaleDB
    await initMqtt(pool);
})();

// Queue Definition
const ingestionQueue = new Queue('ingestion-queue', { connection: redisConnection });

// Worker Definition (Consumer)
const worker = new Worker('ingestion-queue', async (job) => {
    const { meterId } = job.data;
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start transaction for atomicity

        // 1. Fetch Tenant ID and their Alert Settings for this meter
        const settingsQuery = `
            SELECT s.tenant_id, ss.alert_max_kw as max_peak_kw, ss.alert_min_v as min_voltage, ss.alert_max_thd as max_thd
            FROM meters m
            JOIN sites s ON m.site_id = s.id
            LEFT JOIN site_settings ss ON s.id = ss.site_id
            WHERE m.id = $1
        `;
        const settingsRes = await client.query(settingsQuery, [meterId]);
        const tenantInfo = settingsRes.rows[0];

        if (!tenantInfo) {
            throw new Error(`Meter ${meterId} not found or has no linked tenant.`);
        }

        // 2. Generate/Simulate Reading (or read from real hardware payload)
        const voltage = 400 + (Math.random() * 20 - 10); // ~400V (3-phase line-to-line base)
        const power = 200 + Math.random() * 800; // 200 - 1000 kW
        const current = (power * 1000) / (voltage * 1.732 * 0.95);

        // 3. Insert Reading into Hypertable
        const insertQuery = `
            INSERT INTO meter_readings (
                time, meter_id, voltage_a, current_a, power_active_total
            ) VALUES (
                NOW(), $1, $2, $3, $4
            )
        `;
        await client.query(insertQuery, [meterId, voltage, current, power]);

        // 4. Alerting Engine: Evaluate Thresholds
        if (tenantInfo.max_peak_kw && power > Number(tenantInfo.max_peak_kw)) {
            await client.query(`
                INSERT INTO alerts (tenant_id, meter_id, type, severity, message)
                VALUES ($1, $2, 'PEAK_DEMAND', 'WARNING', $3)
             `, [tenantInfo.tenant_id, meterId, `Peak demand threshold exceeded: ${power.toFixed(2)}kW (Limit: ${tenantInfo.max_peak_kw}kW)`]);
        }

        if (tenantInfo.min_voltage && voltage < Number(tenantInfo.min_voltage)) {
            await client.query(`
               INSERT INTO alerts (tenant_id, meter_id, type, severity, message)
               VALUES ($1, $2, 'VOLTAGE_SAG', 'CRITICAL', $3)
            `, [tenantInfo.tenant_id, meterId, `Critical voltage sag detected: ${voltage.toFixed(2)}V (Min Limit: ${tenantInfo.min_voltage}V). Machinery at risk.`]);
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error processing job ${job.id}:`, err);
        throw err;
    } finally {
        client.release();
    }
}, {
    connection: redisConnection,
    concurrency: 50 // Process 50 jobs in parallel
});

worker.on('completed', (job) => {
    // console.log(`Job ${job.id} completed!`);
});

worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed with ${err.message}`);
});

// Producer Logic (Scheduler)
async function scheduleIngestion() {
    // console.log('Scheduling ingestion jobs...');
    const client = await pool.connect();
    try {
        // Get all meters
        const metersRes = await client.query('SELECT id FROM meters');
        const meters = metersRes.rows;

        if (meters.length === 0) {
            // console.log('No meters found. Skipping scheduling.');
            return;
        }

        // Add jobs to queue using bulk add for efficiency
        const jobs = meters.map(meter => ({
            name: 'ingest-meter',
            data: { meterId: meter.id },
            opts: { removeOnComplete: true } // Don't clog Redis with completed jobs
        }));

        await ingestionQueue.addBulk(jobs);
        // console.log(`Scheduled ${jobs.length} ingestion jobs.`);
    } catch (err) {
        console.error('Scheduling error:', err);
    } finally {
        client.release();
    }
}

// -----------------------------------------------------------------------------
// VIRTUAL METER LOAD GENERATOR (DISABLED FOR PRODUCTION HARDWARE)
// -----------------------------------------------------------------------------
// Run scheduler every 5 seconds to simulate high frequency enterprise data
// cron.schedule('*/5 * * * * *', () => {
//     scheduleIngestion();
// });

// -----------------------------------------------------------------------------
// ENERGY SCORE ENGINE — recalculates every 5 minutes for all sites
// -----------------------------------------------------------------------------
cron.schedule('*/5 * * * *', async () => {
    const client = await pool.connect();
    try {
        const sites = await client.query(`SELECT id FROM sites`);
        for (const site of sites.rows) {
            try {
                const result = await computeAndStoreSiteScore(pool, site.id);
                if (result) {
                    console.log(`[SCORE] Site ${site.id} → ${result.score}/100 (${result.tariffType})`);
                }
            } catch (e) {
                console.error(`[SCORE] Error for site ${site.id}:`, e);
            }
        }
    } catch (err) {
        console.error('[SCORE] Cron error:', err);
    } finally {
        client.release();
    }
});

// -----------------------------------------------------------------------------
// PREDICTIVE MAINTENANCE SCANNER
// Runs every 30 minutes — analyses last 24h per meter for:
//   1. High voltage variance (StdDev > 5V on ~230V L-N system)
//      → potential motor insulation breakdown, loose connections, capacitor aging
//   2. Phase current imbalance > 20%
//      → unbalanced loads, failing motor windings, neutral fault
// One alert per meter per 24 hours to prevent spam.
// -----------------------------------------------------------------------------
cron.schedule('*/30 * * * *', async () => {
    const client = await pool.connect();
    try {
        const anomalies = await client.query(`
            WITH stats AS (
                SELECT
                    m.id                        AS meter_id,
                    s.tenant_id,
                    m.name                      AS meter_name,
                    ROUND(AVG(r.voltage_a)::numeric, 2)   AS avg_v,
                    ROUND(STDDEV(r.voltage_a)::numeric, 2) AS stddev_v,
                    ROUND(MIN(r.voltage_a)::numeric, 2)   AS min_v,
                    ROUND(MAX(r.voltage_a)::numeric, 2)   AS max_v,
                    -- Phase imbalance: highest deviation from avg current across phases
                    ROUND(AVG(r.current_a)::numeric, 1)   AS avg_i1,
                    ROUND(AVG(r.current_b)::numeric, 1)   AS avg_i2,
                    ROUND(AVG(r.current_c)::numeric, 1)   AS avg_i3,
                    COUNT(*) AS reading_count
                FROM meters m
                JOIN sites s ON m.site_id = s.id
                JOIN meter_readings r ON m.id = r.meter_id
                WHERE r.time >= NOW() - INTERVAL '24 hours'
                  AND r.voltage_a IS NOT NULL
                GROUP BY m.id, s.tenant_id, m.name
                HAVING COUNT(*) >= 10
            )
            SELECT *,
                -- Current imbalance % = max deviation / avg * 100
                CASE
                    WHEN (avg_i1 + avg_i2 + avg_i3) > 0 THEN
                        ROUND((
                            GREATEST(
                                ABS(avg_i1 - (avg_i1 + avg_i2 + avg_i3) / 3.0),
                                ABS(avg_i2 - (avg_i1 + avg_i2 + avg_i3) / 3.0),
                                ABS(avg_i3 - (avg_i1 + avg_i2 + avg_i3) / 3.0)
                            ) / NULLIF((avg_i1 + avg_i2 + avg_i3) / 3.0, 0) * 100
                        )::numeric, 1)
                    ELSE 0
                END AS current_imbalance_pct
            FROM stats
            WHERE stddev_v > 5              -- >5V stddev on 230V L-N = >2.2% variation (NRS 048 limit is ±5%)
               OR min_v < 207              -- Below NRS 048 lower limit (230V - 10%)
               OR min_v > 253              -- Above NRS 048 upper limit (230V + 10%)
        `);

        for (const m of anomalies.rows) {
            // Deduplicate — one predictive alert per meter per 24h
            const recent = await client.query(`
                SELECT id FROM alerts
                WHERE meter_id = $1
                  AND type = 'PREDICTIVE_WARNING'
                  AND created_at >= NOW() - INTERVAL '24 hours'
                LIMIT 1
            `, [m.meter_id]);
            if (recent.rows.length > 0) continue;

            // Build a specific, actionable message
            const parts: string[] = [];

            if (m.stddev_v > 5) {
                parts.push(
                    `Voltage instability detected: StdDev ${m.stddev_v} V over 24h ` +
                    `(avg ${m.avg_v} V, range ${m.min_v}–${m.max_v} V). ` +
                    `This level of variance (>${((m.stddev_v / 230) * 100).toFixed(1)}%) suggests loose connections, ` +
                    `failing capacitor banks, or intermittent load switching.`
                );
            }
            if (m.min_v < 207) {
                parts.push(
                    `Sustained undervoltage: minimum ${m.min_v} V L-N recorded ` +
                    `(NRS 048 lower limit: 207 V). ` +
                    `Check upstream transformer tap settings and cable sizing.`
                );
            }
            if (m.min_v > 253) {
                parts.push(
                    `Sustained overvoltage: minimum ${m.max_v} V L-N recorded ` +
                    `(NRS 048 upper limit: 253 V). ` +
                    `Check transformer tap settings — equipment insulation at risk.`
                );
            }
            if (Number(m.current_imbalance_pct) > 20) {
                parts.push(
                    `Phase current imbalance: ${m.current_imbalance_pct}% ` +
                    `(L1 ${m.avg_i1} A / L2 ${m.avg_i2} A / L3 ${m.avg_i3} A avg). ` +
                    `Imbalance >20% accelerates motor winding heating — check load distribution and neutral continuity.`
                );
            }

            if (parts.length === 0) continue;

            const message = `Predictive anomaly on ${m.meter_name}: ${parts.join(' | ')} — Recommendation: inspect within 72 hours.`;

            await client.query(`
                INSERT INTO alerts (tenant_id, meter_id, type, severity, message)
                VALUES ($1, $2, 'PREDICTIVE_WARNING', 'WARNING', $3)
            `, [m.tenant_id, m.meter_id, message]);

            console.log(`[PREDICTIVE] Warning: ${m.meter_name} — ${parts.length} anomaly(ies) flagged`);
        }
    } catch (err) {
        console.error('[PREDICTIVE] Scan error:', err);
    } finally {
        client.release();
    }
});

// Express API for Data Access
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';

const app = express();
const port = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'powerguard-super-secret-key-change-in-prod';

app.use(cors());
app.use(express.json());

// JWT Middleware
const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ingestion-service', mode: 'queue+api' });
});

// Secure endpoint: Get Sites (filtered by Tenant)
app.get('/sites', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;

    try {
        let query = `SELECT * FROM sites`;
        let params: any[] = [];

        if (role !== 'super_admin') {
            query += ` WHERE tenant_id = $1`;
            params.push(tenantId);
        }

        query += ` ORDER BY created_at DESC`;

        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching sites' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Create Site
app.post('/sites', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;
    const { name, address, timezone } = req.body;

    if (!name) return res.status(400).json({ error: 'Site name is required' });

    // For clients, force their tenantId. For super_admin, they could potentially pass a tenantId, but defaulting to their own for simplicity unless specified.
    const targetTenantId = (role === 'super_admin' && req.body.tenant_id) ? req.body.tenant_id : tenantId;

    try {
        const query = `
            INSERT INTO sites (tenant_id, name, address, timezone)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        const result = await client.query(query, [targetTenantId, name, address, timezone || 'UTC']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error creating site' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Delete Site (Cascade deletes meters and readings)
app.delete('/sites/:id', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;
    const siteId = req.params.id;

    try {
        await client.query('BEGIN'); // Start transaction

        // 1. Verify ownership
        if (role !== 'super_admin') {
            const checkQuery = `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`;
            const checkRes = await client.query(checkQuery, [siteId, tenantId]);
            if (checkRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Forbidden: Cannot delete this site' });
            }
        }

        // 2. Delete the site (PostgreSQL CASCADE on the foreign keys will automatically delete meters, readings, and alerts if configured, otherwise we do it manually to be safe)

        // Delete alerts linked to this site's meters
        await client.query(`DELETE FROM alerts WHERE meter_id IN (SELECT id FROM meters WHERE site_id = $1)`, [siteId]);

        // Delete readings linked to this site's meters
        await client.query(`DELETE FROM meter_readings WHERE meter_id IN (SELECT id FROM meters WHERE site_id = $1)`, [siteId]);

        // Delete meters linked to this site
        await client.query(`DELETE FROM meters WHERE site_id = $1`, [siteId]);

        // Delete site settings
        await client.query(`DELETE FROM site_settings WHERE site_id = $1`, [siteId]);

        // Finally, delete the site itself
        const deleteQuery = `DELETE FROM sites WHERE id = $1 RETURNING id`;
        const result = await client.query(deleteQuery, [siteId]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Site not found' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Site and all associated data deleted successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Database error deleting site' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Create Meter
app.post('/meters', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;
    const { site_id, name, serial_number, model } = req.body;

    if (!site_id || !name) return res.status(400).json({ error: 'site_id and name are required' });

    try {
        // First verify the site belongs to the user's tenant (unless super_admin)
        if (role !== 'super_admin') {
            const siteCheck = await client.query(`SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`, [site_id, tenantId]);
            if (siteCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Forbidden: Site does not belong to your tenant or does not exist.' });
            }
        }

        const query = `
            INSERT INTO meters (site_id, name, serial_number, model)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        const result = await client.query(query, [site_id, name, serial_number, model]);
        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        console.error(err);
        if (err.code === '23505') { // Unique violation for serial_number
            return res.status(409).json({ error: 'A meter with this serial number already exists.' });
        }
        res.status(500).json({ error: 'Database error creating meter' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Get Meters (filtered by Tenant)
app.get('/meters', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;

    try {
        let query = `
            SELECT m.*, 
            (
                SELECT row_to_json(r) 
                FROM (
                    SELECT * FROM meter_readings 
                    WHERE meter_id = m.id 
                    ORDER BY time DESC 
                    LIMIT 1
                ) r
            ) as latest_reading
            FROM meters m
            JOIN sites s ON m.site_id = s.id
        `;
        let params: any[] = [];

        // Tenant Isolation
        if (role !== 'super_admin') {
            query += ` WHERE s.tenant_id = $1`;
            params.push(tenantId);
        }

        query += ` ORDER BY m.created_at ASC`;

        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Get Site Settings
app.get('/sites/:id/settings', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const { tenantId, role } = req.user;

    try {
        // Validate site ownership
        const siteCheck = await client.query(`SELECT id FROM sites WHERE id = $1 ${role !== 'super_admin' ? 'AND tenant_id = $2' : ''}`, role !== 'super_admin' ? [id, tenantId] : [id]);
        if (siteCheck.rows.length === 0) return res.status(403).json({ error: 'Site not found or access denied' });

        const result = await client.query(`SELECT * FROM site_settings WHERE site_id = $1`, [id]);
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching site settings' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Update Site Settings (Upsert)
app.post('/sites/:id/settings', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const {
        tariff_peak, tariff_standard, tariff_offpeak,
        peak_times, standard_times, offpeak_times,
        alert_max_kw, alert_min_v, alert_max_thd,
        alert_max_v, alert_min_freq, alert_max_freq,
        contracted_mdi_kva, tariff_demand,
    } = req.body;

    try {
        // Validate site ownership
        const siteCheck = await client.query(`SELECT id FROM sites WHERE id = $1 ${role !== 'super_admin' ? 'AND tenant_id = $2' : ''}`, role !== 'super_admin' ? [id, tenantId] : [id]);
        if (siteCheck.rows.length === 0) return res.status(403).json({ error: 'Site not found or access denied' });

        const query = `
            INSERT INTO site_settings (
                site_id,
                tariff_peak, tariff_standard, tariff_offpeak,
                peak_times, standard_times, offpeak_times,
                alert_max_kw, alert_min_v, alert_max_thd,
                alert_max_v, alert_min_freq, alert_max_freq,
                contracted_mdi_kva, tariff_demand,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
            ON CONFLICT (site_id)
            DO UPDATE SET
                tariff_peak         = COALESCE(EXCLUDED.tariff_peak,         site_settings.tariff_peak),
                tariff_standard     = COALESCE(EXCLUDED.tariff_standard,     site_settings.tariff_standard),
                tariff_offpeak      = COALESCE(EXCLUDED.tariff_offpeak,      site_settings.tariff_offpeak),
                peak_times          = COALESCE(EXCLUDED.peak_times,          site_settings.peak_times),
                standard_times      = COALESCE(EXCLUDED.standard_times,      site_settings.standard_times),
                offpeak_times       = COALESCE(EXCLUDED.offpeak_times,       site_settings.offpeak_times),
                alert_max_kw        = COALESCE(EXCLUDED.alert_max_kw,        site_settings.alert_max_kw),
                alert_min_v         = COALESCE(EXCLUDED.alert_min_v,         site_settings.alert_min_v),
                alert_max_thd       = COALESCE(EXCLUDED.alert_max_thd,       site_settings.alert_max_thd),
                alert_max_v         = COALESCE(EXCLUDED.alert_max_v,         site_settings.alert_max_v),
                alert_min_freq      = COALESCE(EXCLUDED.alert_min_freq,      site_settings.alert_min_freq),
                alert_max_freq      = COALESCE(EXCLUDED.alert_max_freq,      site_settings.alert_max_freq),
                contracted_mdi_kva  = COALESCE(EXCLUDED.contracted_mdi_kva,  site_settings.contracted_mdi_kva),
                tariff_demand       = COALESCE(EXCLUDED.tariff_demand,       site_settings.tariff_demand),
                updated_at = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const result = await client.query(query, [
            id,
            tariff_peak ?? null, tariff_standard ?? null, tariff_offpeak ?? null,
            peak_times ?? null, standard_times ?? null, offpeak_times ?? null,
            alert_max_kw ?? null, alert_min_v ?? null, alert_max_thd ?? null,
            alert_max_v ?? null, alert_min_freq ?? null, alert_max_freq ?? null,
            contracted_mdi_kva ?? null, tariff_demand ?? null,
        ]);
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error("Error upserting site settings:", err);
        res.status(500).json({ error: 'Database error saving site settings' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Get Active Alerts
app.get('/alerts', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;

    try {
        let query = `
            SELECT a.*, m.name as meter_name 
            FROM alerts a
            JOIN meters m ON a.meter_id = m.id
        `;
        let params: any[] = [];

        if (role !== 'super_admin') {
            query += ` WHERE a.tenant_id = $1`;
            params.push(tenantId);
        }

        query += ` ORDER BY a.created_at DESC LIMIT 50`;

        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching alerts' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Mark Alert as Read
app.post('/alerts/:id/read', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;
    const { id } = req.params;

    try {
        let query = `UPDATE alerts SET is_read = true WHERE id = $1`;
        let params: any[] = [id];

        if (role !== 'super_admin') {
            query += ` AND tenant_id = $2`;
            params.push(tenantId);
        }

        await client.query(query, params);
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error updating alert' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Generate AI Context String (Tenant specific)
app.get('/ai-context', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();
    const { tenantId, role } = req.user;
    const effectiveTenantId = role !== 'super_admin' ? tenantId : null;

    try {
        // 1. Metering data with PF, THD, energy
        let meterQuery = `
            SELECT s.name as site_name, m.name as meter_name,
            (
                SELECT row_to_json(r)
                FROM (
                    SELECT power_active_total, voltage_a, current_a,
                           power_factor_total, thd_voltage_a, energy_import_total, time
                    FROM meter_readings
                    WHERE meter_id = m.id
                    ORDER BY time DESC
                    LIMIT 1
                ) r
            ) as latest_reading
            FROM meters m
            JOIN sites s ON m.site_id = s.id
        `;
        const meterParams: any[] = [];
        if (effectiveTenantId) {
            meterQuery += ` WHERE s.tenant_id = $1`;
            meterParams.push(effectiveTenantId);
        }
        const meterResult = await client.query(meterQuery, meterParams);

        // 2. Active alerts (last 48h, unread)
        let alertQuery = `
            SELECT type, severity, message, created_at
            FROM alerts
            WHERE is_read = false
            AND created_at > NOW() - INTERVAL '48 hours'
        `;
        const alertParams: any[] = [];
        if (effectiveTenantId) {
            alertQuery += ` AND tenant_id = $1`;
            alertParams.push(effectiveTenantId);
        }
        alertQuery += ` ORDER BY created_at DESC LIMIT 5`;
        const alertResult = await client.query(alertQuery, alertParams);

        // 3. Alert & Tariff settings per site (thresholds configured by the client)
        let settingsQuery = `
            SELECT s.name as site_name, ss.* 
            FROM sites s
            JOIN site_settings ss ON s.id = ss.site_id
        `;
        const settingsParams: any[] = [];
        if (effectiveTenantId) {
            settingsQuery += ` WHERE s.tenant_id = $1`;
            settingsParams.push(effectiveTenantId);
        }
        const settingsResult = await client.query(settingsQuery, settingsParams);
        const settingsList = settingsResult.rows;


        // 4. Monthly usage aggregate
        let monthlyQuery = `
            SELECT
                ROUND((SUM(mr.power_active_total) * (5.0/3600.0))::numeric, 1) as kwh_this_month,
                ROUND(MAX(mr.power_active_total)::numeric, 1) as peak_kw_this_month
            FROM meter_readings mr
            JOIN meters m ON mr.meter_id = m.id
            JOIN sites s ON m.site_id = s.id
            WHERE mr.time >= date_trunc('month', NOW())
        `;
        const monthlyParams: any[] = [];
        if (effectiveTenantId) {
            monthlyQuery += ` AND s.tenant_id = $1`;
            monthlyParams.push(effectiveTenantId);
        }
        const monthlyResult = await client.query(monthlyQuery, monthlyParams);
        const monthly = monthlyResult.rows[0];

        // --- Build rich context string ---
        let contextString = `=== POWERGUARD LIVE DATA SNAPSHOT ===\n`;
        contextString += `Timestamp: ${new Date().toLocaleString()}\n\n`;

        // Meters
        if (meterResult.rows.length === 0) {
            contextString += `METERS: No sites or meters configured.\n`;
        } else {
            contextString += `METERING DATA:\n`;
            meterResult.rows.forEach(row => {
                contextString += `• ${row.site_name} / ${row.meter_name}:\n`;
                if (row.latest_reading) {
                    const r = row.latest_reading;
                    contextString += `  - Active Power: ${r.power_active_total ? r.power_active_total.toFixed(1) : 'N/A'} kW\n`;
                    contextString += `  - Voltage: ${r.voltage_a ? r.voltage_a.toFixed(1) : 'N/A'} V\n`;
                    contextString += `  - Current: ${r.current_a ? r.current_a.toFixed(1) : 'N/A'} A\n`;
                    contextString += `  - Power Factor: ${r.power_factor_total ? r.power_factor_total.toFixed(3) : 'N/A'}\n`;
                    contextString += `  - Voltage THD: ${r.thd_voltage_a ? r.thd_voltage_a.toFixed(2) : 'N/A'}%\n`;
                    contextString += `  - Energy Import (total): ${r.energy_import_total ? r.energy_import_total.toFixed(1) : 'N/A'} kWh\n`;
                    contextString += `  - Reading Time: ${new Date(r.time).toLocaleString()}\n`;
                } else {
                    contextString += `  - Status: Offline\n`;
                }
            });
        }

        // Monthly summary
        contextString += `\nMONTHLY USAGE (current month):\n`;
        contextString += `• Estimated Energy: ${monthly?.kwh_this_month ?? 'N/A'} kWh\n`;
        contextString += `• Peak Demand: ${monthly?.peak_kw_this_month ?? 'N/A'} kW\n`;

        // Alert thresholds
        if (settingsList && settingsList.length > 0) {
            contextString += `\nPER-SITE SETTINGS AND ALERT THRESHOLDS:\n`;
            settingsList.forEach(s => {
                contextString += `• Site: ${s.site_name}\n`;
                if (s.alert_max_kw) contextString += `  - Max Peak Demand: ${s.alert_max_kw} kW\n`;
                if (s.alert_min_v) contextString += `  - Min Voltage Limit: ${s.alert_min_v} V\n`;
                if (s.tariff_peak) {
                    contextString += `  - Tariffs: Peak R${Number(s.tariff_peak).toFixed(2)} (${s.peak_times || 'times not set'}), ` +
                        `Std R${Number(s.tariff_standard).toFixed(2)} (${s.standard_times || 'times not set'}), ` +
                        `Off-Peak R${Number(s.tariff_offpeak).toFixed(2)} (${s.offpeak_times || 'times not set'})\n`;
                }
            });
        } else {
            contextString += `\nSITE SETTINGS: No per-site thresholds or tariffs configured.\n`;
        }

        // Active alerts
        contextString += `\nACTIVE ALERTS (last 48h, unread):\n`;
        if (alertResult.rows.length === 0) {
            contextString += `• No active alerts. All systems nominal.\n`;
        } else {
            alertResult.rows.forEach(a => {
                const age = Math.round((Date.now() - new Date(a.created_at).getTime()) / 60000);
                contextString += `• [${a.severity}] ${a.type}: ${a.message} (${age} mins ago)\n`;
            });
        }

        // 7-day historical summary per meter (wrapped in try/catch so it doesn't kill the whole context)
        let historyResult: any = { rows: [] };
        try {
            let historyQuery = `
                SELECT
                    m.name as meter_name,
                    COUNT(mr.time) as reading_count,
                    ROUND(MIN(mr.power_active_total)::numeric, 1) as min_kw,
                    ROUND(MAX(mr.power_active_total)::numeric, 1) as max_kw,
                    ROUND(AVG(mr.power_active_total)::numeric, 1) as avg_kw,
                    ROUND(MIN(mr.power_factor_total)::numeric, 3) as min_pf,
                    ROUND(AVG(mr.power_factor_total)::numeric, 3) as avg_pf,
                    ROUND(MIN(mr.voltage_a)::numeric, 1) as min_v,
                    ROUND(MAX(mr.voltage_a)::numeric, 1) as max_v,
                    ROUND(AVG(mr.voltage_a)::numeric, 1) as avg_v,
                    ROUND(AVG(mr.thd_voltage_a)::numeric, 2) as avg_thd,
                    ROUND(MAX(mr.thd_voltage_a)::numeric, 2) as max_thd_reading,
                    ROUND((SUM(mr.power_active_total) * 5.0 / 3600.0)::numeric, 1) as est_kwh_7d
                FROM meter_readings mr
                JOIN meters m ON mr.meter_id = m.id
                JOIN sites s ON m.site_id = s.id
                WHERE mr.time >= NOW() - INTERVAL '7 days'
            `;
            const historyParams: any[] = [];
            if (effectiveTenantId) {
                historyQuery += ` AND s.tenant_id = $1`;
                historyParams.push(effectiveTenantId);
            }
            historyQuery += ` GROUP BY m.id, m.name ORDER BY max_kw DESC NULLS LAST LIMIT 10`;
            historyResult = await client.query(historyQuery, historyParams);
        } catch (histErr) {
            console.error('History query error (non-fatal):', histErr);
        }

        if (historyResult.rows.length > 0) {
            contextString += `\n7-DAY HISTORICAL SUMMARY (last 7 days):\n`;
            historyResult.rows.forEach((h: any) => {
                contextString += `• ${h.meter_name}: ${h.reading_count} readings | P: min ${h.min_kw} / avg ${h.avg_kw} / max ${h.max_kw} kW | Est. Energy: ${h.est_kwh_7d || 'N/A'} kWh`;
                if (h.avg_pf) contextString += ` | PF avg: ${h.avg_pf} (min: ${h.min_pf})`;
                if (h.avg_v) contextString += ` | V avg: ${h.avg_v} (range: ${h.min_v}-${h.max_v} V)`;
                if (h.avg_thd) contextString += ` | THD avg: ${h.avg_thd}% (max: ${h.max_thd_reading}%)`;
                contextString += `\n`;
            });
        } else {
            contextString += `\n7-DAY HISTORY: No historical data recorded yet.\n`;
        }

        // Smart suggestions based on data
        const suggestions: string[] = [];
        if (alertResult.rows.length > 0) suggestions.push('What are my active alerts?');
        suggestions.push('What is my current power demand?');
        if (historyResult.rows.length > 0) suggestions.push('Summarise my energy usage for the last 7 days');
        else suggestions.push('How can I reduce my energy costs?');
        if (!suggestions.find(s => s.includes('power factor'))) {
            suggestions.push('How can I improve my power factor?');
        }

        res.json({ context: contextString, suggestions: suggestions.slice(0, 3) });

    } catch (err) {
        console.error("AI Context creation error:", err);
        res.status(500).json({ error: 'Database error generating AI context' });
    } finally {
        client.release();
    }
});

// Delete a meter (with tenant auth)
app.delete('/meters/:id', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id WHERE m.id = $1 AND s.tenant_id = $2`,
                [id, tenantId]
            );
            if (check.rows.length === 0) {
                client.release();
                return res.status(403).json({ error: 'Forbidden' });
            }
        }
        // Delete readings first (cascade would also work if FK set)
        await client.query('DELETE FROM meter_readings WHERE meter_id = $1', [id]);
        await client.query('DELETE FROM alerts WHERE meter_id = $1', [id]);
        await client.query('DELETE FROM meters WHERE id = $1', [id]);
        res.json({ success: true, message: 'Meter and all its readings deleted.' });
    } catch (err) {
        console.error('Delete meter error:', err);
        res.status(500).json({ error: 'Failed to delete meter' });
    } finally {
        client.release();
    }
});


import multer from 'multer';
import csv from 'csv-parser';
import fs from 'fs';

const upload = multer({ dest: 'uploads/' });

// Secure endpoint: Get Readings for a specific Meter (verified access)
app.get('/meters/:id/readings', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const limit = parseInt(String(req.query.limit || '500'));
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const { tenantId, role } = req.user;

    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(`
                SELECT m.id FROM meters m
                JOIN sites s ON m.site_id = s.id
                WHERE m.id = $1 AND s.tenant_id = $2
            `, [id, tenantId]);
            if (authCheck.rows.length === 0) {
                client.release();
                return res.status(403).json({ error: 'Forbidden' });
            }
        }

        const params: any[] = [id];
        let query = 'SELECT * FROM meter_readings WHERE meter_id = $1';
        if (from) { params.push(new Date(from)); query += ` AND time >= $${params.length}`; }
        if (to) { params.push(new Date(to)); query += ` AND time <= $${params.length}`; }
        query += ' ORDER BY time ASC';
        if (!from && !to) query += ` LIMIT ${limit}`;

        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Monthly consumption aggregation endpoint
app.get('/meters/:id/monthly', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const months = Math.min(parseInt(String(req.query.months || '6')), 24);
    const { tenantId, role } = req.user;

    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(`
                SELECT m.id FROM meters m
                JOIN sites s ON m.site_id = s.id
                WHERE m.id = $1 AND s.tenant_id = $2
            `, [id, tenantId]);
            if (authCheck.rows.length === 0) {
                client.release();
                return res.status(403).json({ error: 'Forbidden' });
            }
        }

        const result = await client.query(`
            SELECT
                TO_CHAR(DATE_TRUNC('month', time), 'Mon') AS month,
                DATE_TRUNC('month', time) AS month_start,
                CASE
                    WHEN MAX(energy_import_total) IS NOT NULL
                         AND (MAX(energy_import_total) - MIN(energy_import_total)) > 0
                    THEN ROUND((MAX(energy_import_total) - MIN(energy_import_total))::numeric, 0)
                    ELSE ROUND((SUM(power_active_total) * 5.0 / 60.0)::numeric, 0)
                END AS kwh
            FROM meter_readings
            WHERE meter_id = $1
              AND time >= DATE_TRUNC('month', NOW() - ($2 || ' months')::INTERVAL)
              AND power_active_total IS NOT NULL
            GROUP BY DATE_TRUNC('month', time)
            ORDER BY DATE_TRUNC('month', time) ASC
        `, [id, months - 1]);

        res.json(result.rows);
    } catch (err) {
        console.error('Monthly readings error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Flexible column name mapper
const mapRow = (row: any) => {
    const k = (keys: string[]) => {
        for (const key of keys) {
            const found = Object.keys(row).find(r => r.trim().toLowerCase() === key.toLowerCase());
            if (found !== undefined && row[found] !== '' && row[found] !== undefined) return row[found];
        }
        return undefined;
    };
    const parseN = (v: any) => { const n = parseFloat(v); return isNaN(n) ? undefined : n; };
    const parseTime = (v: any) => {
        if (!v) return undefined;
        // Try ISO first, then DD/MM/YYYY HH:MM format (SA Excel)
        const iso = new Date(v);
        if (!isNaN(iso.getTime())) return iso;
        const parts = v.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2}):(\d{2})/);
        if (parts) return new Date(`${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}T${parts[4].padStart(2, '0')}:${parts[5]}:00`);
        return undefined;
    };
    return {
        time: parseTime(k(['time', 'timestamp', 'datetime', 'date'])),
        power_active_total: parseN(k(['p', 'kw', 'active_power', 'power_active_total', 'power', 'p_kw'])),
        power_reactive_total: parseN(k(['q', 'kvar', 'reactive_power', 'power_reactive_total', 'q_kvar'])),
        power_apparent_total: parseN(k(['s', 'kva', 'apparent_power', 'power_apparent_total', 's_kva'])),
        power_factor_total: parseN(k(['pf', 'power_factor', 'power_factor_total'])),
        voltage_a: parseN(k(['v', 'voltage', 'v_a', 'voltage_a', 'volts'])),
        current_a: parseN(k(['i', 'current', 'i_a', 'current_a', 'amps'])),
        thd_voltage_a: parseN(k(['thd', 'harmonics', 'thd_v', 'thd_voltage_a', 'thd%'])),
        energy_import_total: parseN(k(['kwh', 'energy', 'energy_kwh', 'energy_import_total'])),
    };
};

// CSV preview endpoint (first 5 rows + detected columns)
app.post('/upload/preview', authenticateToken, upload.single('file') as any, async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const previewRows: any[] = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (row) => { if (previewRows.length < 5) previewRows.push(row); })
        .on('end', () => {
            fs.unlinkSync(req.file.path);
            const headers = previewRows.length > 0 ? Object.keys(previewRows[0]) : [];
            const mapped = previewRows.length > 0 ? mapRow(previewRows[0]) : {};
            const detectedCols = Object.entries(mapped)
                .filter(([, v]) => v !== undefined)
                .map(([k]) => k);
            res.json({ headers, rows: previewRows, detectedColumns: detectedCols });
        })
        .on('error', () => { fs.unlinkSync(req.file.path); res.status(400).json({ error: 'Invalid CSV' }); });
});

// CSV Upload Endpoint — full import with flexible column mapping
app.post('/upload', authenticateToken, upload.single('file') as any, async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const meterId = req.body.meter_id;
    if (!meterId) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'meter_id is required' }); }

    const { tenantId, role } = req.user;
    const client = await pool.connect();

    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(`
                SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                WHERE m.id = $1 AND s.tenant_id = $2
            `, [meterId, tenantId]);
            if (authCheck.rows.length === 0) {
                fs.unlinkSync(req.file.path); client.release();
                return res.status(403).json({ error: 'Forbidden' });
            }
        }

        const results: any[] = [];
        fs.createReadStream(req.file.path)
            .pipe(csv())
            .on('data', (row) => results.push(row))
            .on('end', async () => {
                fs.unlinkSync(req.file.path);
                let inserted = 0;
                let skipped = 0;
                try {
                    await client.query('BEGIN');
                    for (const raw of results) {
                        const r = mapRow(raw);
                        if (!r.time) { skipped++; continue; }
                        await client.query(`
                            INSERT INTO meter_readings (
                                time, meter_id,
                                power_active_total, power_reactive_total, power_apparent_total,
                                power_factor_total, voltage_a, current_a, thd_voltage_a, energy_import_total
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                            ON CONFLICT DO NOTHING
                        `, [
                            r.time, meterId,
                            r.power_active_total ?? null,
                            r.power_reactive_total ?? null,
                            r.power_apparent_total ?? null,
                            r.power_factor_total ?? null,
                            r.voltage_a ?? null,
                            r.current_a ?? null,
                            r.thd_voltage_a ?? null,
                            r.energy_import_total ?? null,
                        ]);
                        inserted++;
                    }
                    await client.query('COMMIT');
                    res.json({ success: true, count: inserted, skipped, total: results.length, message: `Successfully imported ${inserted} rows.` });
                } catch (dbErr) {
                    await client.query('ROLLBACK');
                    console.error('DB Insert Error:', dbErr);
                    res.status(500).json({ error: 'Failed to insert data into database' });
                } finally {
                    client.release();
                }
            })
            .on('error', () => { fs.unlinkSync(req.file.path); client.release(); res.status(400).json({ error: 'Invalid CSV file' }); });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('Upload Error:', err);
        client.release();
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Energy Score endpoints ────────────────────────────────────────────────────

// GET /sites/:id/score — latest stored energy score for a site
app.get('/sites/:id/score', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(`SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
            if (check.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
        const score = await getLatestSiteScore(pool, id);
        if (!score) return res.json({ score: null, message: 'Insufficient data — need at least 10 readings' });
        res.json(score);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching energy score' });
    } finally {
        client.release();
    }
});

// POST /sites/:id/score/calculate — force recalculate score now
app.post('/sites/:id/score/calculate', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(`SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
            if (check.rows.length === 0) { client.release(); return res.status(403).json({ error: 'Forbidden' }); }
        }
        client.release();
        const result = await computeAndStoreSiteScore(pool, id);
        if (!result) return res.json({ score: null, message: 'Insufficient data' });
        res.json(result);
    } catch (err) {
        client.release();
        res.status(500).json({ error: 'Error calculating score' });
    }
});

// GET /sites/scores — latest score for every site in the tenant
app.get('/sites/scores', authenticateToken, async (req: any, res) => {
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        let query = `
            SELECT s.id as site_id, s.name as site_name,
                   es.score, es.tariff_type, es.calculated_at,
                   es.pf_score, es.thd_score, es.load_factor_score, es.voltage_quality_score
            FROM sites s
            LEFT JOIN LATERAL (
                SELECT * FROM energy_scores
                WHERE site_id = s.id
                ORDER BY calculated_at DESC LIMIT 1
            ) es ON true
        `;
        const params: any[] = [];
        if (role !== 'super_admin') { query += ` WHERE s.tenant_id = $1`; params.push(tenantId); }
        query += ` ORDER BY s.created_at ASC`;
        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching scores' });
    } finally {
        client.release();
    }
});

// ── Recommendation endpoints ──────────────────────────────────────────────────

// GET /sites/:id/recommendations — active recommendations for a site
app.get('/sites/:id/recommendations', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(`SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
            if (check.rows.length === 0) { client.release(); return res.status(403).json({ error: 'Forbidden' }); }
        }
        client.release();
        const recs = await getSiteRecommendations(pool, id);
        res.json(recs);
    } catch (err) {
        client.release();
        res.status(500).json({ error: 'Error fetching recommendations' });
    }
});

// GET /recommendations — all recommendations for the tenant
app.get('/recommendations', authenticateToken, async (req: any, res) => {
    const { tenantId, role } = req.user;
    try {
        const recs = await getTenantRecommendations(pool, role === 'super_admin' ? null : tenantId);
        res.json(recs);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching recommendations' });
    }
});

// POST /sites/:id/recommendations/generate — trigger Claude analysis for a site
app.post('/sites/:id/recommendations/generate', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        const siteCheck = await client.query(
            `SELECT id, name, address, tenant_id FROM sites WHERE id = $1 ${role !== 'super_admin' ? 'AND tenant_id = $2' : ''}`,
            role !== 'super_admin' ? [id, tenantId] : [id]
        );
        if (siteCheck.rows.length === 0) { client.release(); return res.status(403).json({ error: 'Forbidden' }); }
        const site = siteCheck.rows[0];
        client.release();

        // Compute fresh score first
        const score = await computeAndStoreSiteScore(pool, id);
        if (!score) return res.status(400).json({ error: 'Insufficient meter data to generate recommendations (need ≥10 readings in last 30 days)' });

        const recs = await generateAndStoreSiteRecommendations(
            pool, id, site.tenant_id, score, site.name, site.address || ''
        );
        res.json({ generated: recs.length, recommendations: recs });
    } catch (err: any) {
        console.error('[API] Recommendation generation error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate recommendations' });
    }
});

// POST /recommendations/:id/notify — client clicks "Notify Team" → creates a lead
app.post('/recommendations/:id/notify', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        // Verify the recommendation belongs to this tenant
        const recCheck = await client.query(
            `SELECT r.id, r.site_id, r.tenant_id FROM recommendations r
             WHERE r.id = $1 ${role !== 'super_admin' ? 'AND r.tenant_id = $2' : ''}`,
            role !== 'super_admin' ? [id, tenantId] : [id]
        );
        if (recCheck.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        const rec = recCheck.rows[0];

        // Prevent duplicate active leads for the same recommendation
        const existing = await client.query(
            `SELECT id FROM leads WHERE recommendation_id = $1 AND status NOT IN ('WON','LOST')`,
            [id]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'A lead for this recommendation already exists', leadId: existing.rows[0].id });
        }

        const lead = await client.query(`
            INSERT INTO leads (site_id, tenant_id, recommendation_id, status)
            VALUES ($1, $2, $3, 'NEW')
            RETURNING *
        `, [rec.site_id, rec.tenant_id, id]);

        console.log(`[LEAD] New lead created: ${lead.rows[0].id} (rec: ${id})`);
        res.status(201).json(lead.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error creating lead' });
    } finally {
        client.release();
    }
});

// ── Lead management endpoints ─────────────────────────────────────────────────

// GET /leads — all leads (super_admin = all tenants, admin = own tenant)
app.get('/leads', authenticateToken, async (req: any, res) => {
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        let query = `
            SELECT l.*,
                   s.name as site_name, s.address as site_address,
                   r.type as rec_type, r.title as rec_title,
                   r.estimated_monthly_saving_zar, r.priority as rec_priority
            FROM leads l
            JOIN sites s ON l.site_id = s.id
            LEFT JOIN recommendations r ON l.recommendation_id = r.id
        `;
        const params: any[] = [];
        if (role !== 'super_admin') { query += ` WHERE l.tenant_id = $1`; params.push(tenantId); }
        query += ` ORDER BY l.created_at DESC LIMIT 100`;
        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching leads' });
    } finally {
        client.release();
    }
});

// PATCH /leads/:id — update lead status (NEW → IN_REVIEW → QUOTED → WON/LOST)
app.patch('/leads/:id', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    const { tenantId, role } = req.user;
    const validStatuses = ['NEW', 'IN_REVIEW', 'QUOTED', 'WON', 'LOST'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

    const client = await pool.connect();
    try {
        let query = `UPDATE leads SET status = $1, notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3`;
        const params: any[] = [status, notes ?? null, id];
        if (role !== 'super_admin') { query += ` AND tenant_id = $4`; params.push(tenantId); }
        query += ` RETURNING *`;
        const result = await client.query(query, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found or access denied' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error updating lead' });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Ingestion Service API running on port ${port}`);
});

console.log('Ingestion Service (Queue Mode) started.');
