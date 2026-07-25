import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';
import cron from 'node-cron';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { initMqtt } from './mqtt';
import { computeAndStoreSiteScore, getLatestSiteScore } from './energy-score';
import { assessPowerQuality } from './power-quality';
import { getOrCreateExecutiveSummary, answerReportQuestion } from './pq-narrative';
import { forecastDegradation } from './pq-forecast';
import {
    generateAndStoreSiteRecommendations,
    getSiteRecommendations,
    getMeterRecommendations,
    getTenantRecommendations,
} from './ai-recommendations';

// Load .env from the service directory regardless of CWD
dotenv.config({ path: path.resolve(__dirname, '../.env') });

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
        // Meter active/pause flag + load profile (what the meter actually measures)
        await client.query(`
            ALTER TABLE meters
            ADD COLUMN IF NOT EXISTS is_active        BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS load_types       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            ADD COLUMN IF NOT EXISTS load_description TEXT,
            ADD COLUMN IF NOT EXISTS site_type        VARCHAR(50);
        `);

        // Energy score weight columns (added to existing site_settings)
        await client.query(`
            ALTER TABLE site_settings
            ADD COLUMN IF NOT EXISTS tariff_type VARCHAR(50),
            ADD COLUMN IF NOT EXISTS weight_pf DECIMAL(4,3),
            ADD COLUMN IF NOT EXISTS weight_thd DECIMAL(4,3),
            ADD COLUMN IF NOT EXISTS weight_voltage_unbalance DECIMAL(4,3),
            ADD COLUMN IF NOT EXISTS weight_voltage_quality DECIMAL(4,3);
        `);

        // Drop the legacy load_factor weight column if it still exists.
        // Load factor is no longer a scored component (see energy-score.ts);
        // values stored there are not transferable to voltage unbalance.
        await client.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='site_settings' AND column_name='weight_load_factor') THEN
                    ALTER TABLE site_settings DROP COLUMN weight_load_factor;
                END IF;
            END $$;
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
                voltage_unbalance_score DECIMAL(5,2), voltage_quality_score DECIMAL(5,2),
                weight_pf DECIMAL(4,3), weight_thd DECIMAL(4,3),
                weight_voltage_unbalance DECIMAL(4,3), weight_voltage_quality DECIMAL(4,3),
                tariff_type VARCHAR(50), calculated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_energy_scores_site ON energy_scores (site_id, calculated_at DESC);
        `);

        // For existing databases: add the new unbalance columns and drop the
        // legacy load_factor ones. Old historical rows lose those columns —
        // acceptable because score data is recomputed every 5 min anyway.
        await client.query(`
            ALTER TABLE energy_scores
                ADD COLUMN IF NOT EXISTS voltage_unbalance_score DECIMAL(5,2),
                ADD COLUMN IF NOT EXISTS weight_voltage_unbalance DECIMAL(4,3);
        `);
        await client.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='energy_scores' AND column_name='load_factor_score') THEN
                    ALTER TABLE energy_scores DROP COLUMN load_factor_score;
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='energy_scores' AND column_name='weight_load_factor') THEN
                    ALTER TABLE energy_scores DROP COLUMN weight_load_factor;
                END IF;
            END $$;
        `);

        // Recommendations table — meter_id is nullable so legacy site-wide
        // recommendations still work; per-meter recs set meter_id.
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
            ALTER TABLE recommendations
            ADD COLUMN IF NOT EXISTS meter_id UUID REFERENCES meters(id) ON DELETE CASCADE;
            CREATE INDEX IF NOT EXISTS idx_recommendations_meter ON recommendations (meter_id, status, created_at DESC) WHERE meter_id IS NOT NULL;
        `);

        // Single-line diagrams — one per site. Layout is a free-form JSONB
        // shape: { nodes: [{id, type, position:{x,y}, data:{...}}], edges: [...] }.
        // background_pdf_path points at a file on the ingestion-service uploads dir.
        await client.query(`
            CREATE TABLE IF NOT EXISTS site_diagrams (
                site_id             UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
                layout              JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
                background_pdf_path TEXT,
                background_width    INTEGER,
                background_height   INTEGER,
                updated_at          TIMESTAMPTZ DEFAULT NOW()
            );
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

        // Power quality assessment snapshots — the long-term record behind trend
        // lines and the value ledger. One row per meter per assessment run.
        await client.query(`
            CREATE TABLE IF NOT EXISTS pq_assessments (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                meter_id      UUID REFERENCES meters(id) ON DELETE CASCADE,
                site_id       UUID REFERENCES sites(id) ON DELETE CASCADE,
                tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
                assessed_at   TIMESTAMPTZ DEFAULT NOW(),
                period_days   INTEGER,
                readings      INTEGER,
                verdict       VARCHAR(32),
                supply_score  INTEGER,
                install_score INTEGER,
                parameters    JSONB,
                risks         JSONB,
                degrading     JSONB
            );
            CREATE INDEX IF NOT EXISTS idx_pq_meter_time ON pq_assessments (meter_id, assessed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_pq_tenant_time ON pq_assessments (tenant_id, assessed_at DESC);
        `);
        // Cached AI narrative, stored against the snapshot so the wording stays
        // stable for a given assessment and isn't re-billed on every page view.
        await client.query(`
            ALTER TABLE pq_assessments ADD COLUMN IF NOT EXISTS ai_summary TEXT;
        `);
        console.log("DB Schema initialized: pq_assessments verified");

        // White-label branding — lets an installer or reseller put their own
        // identity on the report they hand to their client.
        await client.query(`
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_name TEXT;
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
            ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_footer TEXT;
        `);
        console.log("DB Schema initialized: tenant branding verified");
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
// Runs every 30 minutes — looks for SUSTAINED patterns over 24h that the
// real-time NRS 048 alerts (single-reading) won't catch:
//
//   1. Phase current imbalance > 20% (24h average across all three phases)
//      → unbalanced loads, failing motor windings, neutral fault, blown fuse
//
//   2. Sustained low power factor (24h average PF < 0.80)
//      → capacitor bank degradation, inductive load increase, disconnected PFC
//
// Voltage limit breaches (NRS 048) are handled by the real-time mqtt.ts
// evaluateAlerts function — no need to duplicate them here.
// One alert per meter per 24 hours to prevent notification spam.
// -----------------------------------------------------------------------------
cron.schedule('*/30 * * * *', async () => {
    const client = await pool.connect();
    try {
        const anomalies = await client.query(`
            WITH stats AS (
                SELECT
                    m.id            AS meter_id,
                    s.tenant_id,
                    m.name          AS meter_name,
                    -- Power factor (24h average, exclude invalid readings)
                    ROUND(AVG(r.power_factor_total)
                        FILTER (WHERE r.power_factor_total > 0 AND r.power_factor_total <= 1.05)
                        ::numeric, 3)  AS avg_pf,
                    -- Phase currents (24h average)
                    ROUND(AVG(r.current_a) FILTER (WHERE r.current_a IS NOT NULL)::numeric, 1) AS avg_i1,
                    ROUND(AVG(r.current_b) FILTER (WHERE r.current_b IS NOT NULL)::numeric, 1) AS avg_i2,
                    ROUND(AVG(r.current_c) FILTER (WHERE r.current_c IS NOT NULL)::numeric, 1) AS avg_i3,
                    COUNT(*) AS reading_count
                FROM meters m
                JOIN sites s ON m.site_id = s.id
                JOIN meter_readings r ON m.id = r.meter_id
                WHERE r.time >= NOW() - INTERVAL '24 hours'
                GROUP BY m.id, s.tenant_id, m.name
                HAVING COUNT(*) >= 10
            )
            SELECT *,
                -- Phase imbalance = largest current deviation from 3-phase average
                CASE
                    WHEN avg_i1 IS NOT NULL AND avg_i2 IS NOT NULL AND avg_i3 IS NOT NULL
                         AND (avg_i1 + avg_i2 + avg_i3) > 0
                    THEN ROUND((
                            GREATEST(
                                ABS(avg_i1 - (avg_i1 + avg_i2 + avg_i3) / 3.0),
                                ABS(avg_i2 - (avg_i1 + avg_i2 + avg_i3) / 3.0),
                                ABS(avg_i3 - (avg_i1 + avg_i2 + avg_i3) / 3.0)
                            ) / NULLIF((avg_i1 + avg_i2 + avg_i3) / 3.0, 0) * 100
                         )::numeric, 1)
                    ELSE NULL
                END AS imbalance_pct
            FROM stats
            WHERE (
                -- Sustained low PF over 24h
                avg_pf IS NOT NULL AND avg_pf < 0.80
            ) OR (
                -- Phase current imbalance > 20%
                avg_i1 IS NOT NULL AND avg_i2 IS NOT NULL AND avg_i3 IS NOT NULL
                AND (avg_i1 + avg_i2 + avg_i3) > 0
                AND GREATEST(
                        ABS(avg_i1 - (avg_i1 + avg_i2 + avg_i3) / 3.0),
                        ABS(avg_i2 - (avg_i1 + avg_i2 + avg_i3) / 3.0),
                        ABS(avg_i3 - (avg_i1 + avg_i2 + avg_i3) / 3.0)
                    ) / NULLIF((avg_i1 + avg_i2 + avg_i3) / 3.0, 0) * 100 > 20
            )
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

            const parts: string[] = [];

            if (m.avg_pf !== null && Number(m.avg_pf) < 0.80) {
                parts.push(
                    `Sustained low power factor: 24h average PF = ${Number(m.avg_pf).toFixed(3)} ` +
                    `(target ≥0.85 to avoid Eskom reactive penalty). ` +
                    `Likely cause: capacitor bank degradation or increased inductive load. ` +
                    `Inspect PFC capacitor bank and check for new uncompensated motor loads.`
                );
            }

            if (m.imbalance_pct !== null && Number(m.imbalance_pct) > 20) {
                parts.push(
                    `Phase current imbalance: ${Number(m.imbalance_pct).toFixed(1)}% ` +
                    `(L1 ${m.avg_i1} A / L2 ${m.avg_i2} A / L3 ${m.avg_i3} A, 24h avg). ` +
                    `Imbalance above 20% causes excess motor winding heating and reduces equipment life. ` +
                    `Check load distribution across phases, neutral continuity, and for blown fuses on one phase.`
                );
            }

            if (parts.length === 0) continue;

            const message = parts.join(' | ');

            await client.query(`
                INSERT INTO alerts (tenant_id, meter_id, type, severity, message)
                VALUES ($1, $2, 'PREDICTIVE_WARNING', 'WARNING', $3)
            `, [m.tenant_id, m.meter_id, message]);

            console.log(`[PREDICTIVE] ${m.meter_name} — ${parts.length} condition(s): imbalance=${m.imbalance_pct}% PF=${m.avg_pf}`);
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
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'gridiq-super-secret-key-change-in-prod' || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET is missing, too short, or still set to the default placeholder.');
    console.error('       Set a strong secret (≥32 chars) in services/ingestion-service/.env');
    process.exit(1);
}

app.use(cors());
app.use(express.json());

// JWT Middleware — accepts HTTPOnly cookie (preferred) or Authorization: Bearer header
const authenticateToken = (req: any, res: any, next: any) => {
    // 1. Try cookie first (set by auth-service on login, not readable by JS)
    const cookieHeader = req.headers['cookie'] || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
    const cookieToken = cookieMatch ? cookieMatch[1] : null;

    // 2. Fall back to Authorization header
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader ? authHeader.split(' ')[1] : null;

    const token = cookieToken || bearerToken;
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET as string, (err: any, user: any) => {
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


        // 4. Monthly usage aggregate — energy integrated time-weighted (power x the
        //    actual seconds to the next reading per meter, capped at 900s for gaps),
        //    so it matches the /monthly endpoint instead of assuming a fixed interval.
        const monthlyParams: any[] = [];
        let monthlyWhere = `WHERE mr.time >= date_trunc('month', NOW()) AND mr.power_active_total IS NOT NULL`;
        if (effectiveTenantId) {
            monthlyWhere += ` AND s.tenant_id = $1`;
            monthlyParams.push(effectiveTenantId);
        }
        const monthlyQuery = `
            SELECT
                ROUND(SUM(power_active_total * dt_s / 3600.0)::numeric, 1) as kwh_this_month,
                ROUND(MAX(power_active_total)::numeric, 1) as peak_kw_this_month
            FROM (
                SELECT mr.power_active_total,
                    LEAST(EXTRACT(EPOCH FROM (
                        LEAD(mr.time) OVER (PARTITION BY mr.meter_id ORDER BY mr.time) - mr.time
                    )), 900) AS dt_s
                FROM meter_readings mr
                JOIN meters m ON mr.meter_id = m.id
                JOIN sites s ON m.site_id = s.id
                ${monthlyWhere}
            ) t
        `;
        const monthlyResult = await client.query(monthlyQuery, monthlyParams);
        const monthly = monthlyResult.rows[0];

        // --- Build rich context string ---
        let contextString = `=== GRID-IQ LIVE DATA SNAPSHOT ===\n`;
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
            // est_kwh_7d integrated time-weighted (see monthly aggregate above) so the
            // AI context's energy figures match the report/analytics numbers.
            const historyParams: any[] = [];
            let historyWhere = `WHERE mr.time >= NOW() - INTERVAL '7 days'`;
            if (effectiveTenantId) {
                historyWhere += ` AND s.tenant_id = $1`;
                historyParams.push(effectiveTenantId);
            }
            const historyQuery = `
                SELECT
                    meter_name,
                    COUNT(time) as reading_count,
                    ROUND(MIN(power_active_total)::numeric, 1) as min_kw,
                    ROUND(MAX(power_active_total)::numeric, 1) as max_kw,
                    ROUND(AVG(power_active_total)::numeric, 1) as avg_kw,
                    ROUND(MIN(power_factor_total)::numeric, 3) as min_pf,
                    ROUND(AVG(power_factor_total)::numeric, 3) as avg_pf,
                    ROUND(MIN(voltage_a)::numeric, 1) as min_v,
                    ROUND(MAX(voltage_a)::numeric, 1) as max_v,
                    ROUND(AVG(voltage_a)::numeric, 1) as avg_v,
                    ROUND(AVG(thd_voltage_a)::numeric, 2) as avg_thd,
                    ROUND(MAX(thd_voltage_a)::numeric, 2) as max_thd_reading,
                    ROUND(SUM(power_active_total * dt_s / 3600.0)::numeric, 1) as est_kwh_7d
                FROM (
                    SELECT m.name as meter_name, mr.meter_id, mr.time,
                           mr.power_active_total, mr.power_factor_total,
                           mr.voltage_a, mr.thd_voltage_a,
                           LEAST(EXTRACT(EPOCH FROM (
                               LEAD(mr.time) OVER (PARTITION BY mr.meter_id ORDER BY mr.time) - mr.time
                           )), 900) AS dt_s
                    FROM meter_readings mr
                    JOIN meters m ON mr.meter_id = m.id
                    JOIN sites s ON m.site_id = s.id
                    ${historyWhere}
                ) t
                GROUP BY meter_id, meter_name
                ORDER BY max_kw DESC NULLS LAST LIMIT 10
            `;
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

// Update meter load profile (what the meter actually measures —
// powers the AI recommendations so it stops guessing what loads exist)
app.patch('/meters/:id/profile', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const { load_types, load_description, site_type, name } = req.body;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                 WHERE m.id = $1 AND s.tenant_id = $2`,
                [id, tenantId]
            );
            if (check.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
        // Validate load_types: must be an array of strings if provided
        if (load_types !== undefined && load_types !== null) {
            if (!Array.isArray(load_types) || load_types.some(t => typeof t !== 'string')) {
                return res.status(400).json({ error: 'load_types must be an array of strings' });
            }
        }
        const result = await client.query(`
            UPDATE meters SET
                load_types       = COALESCE($1, load_types),
                load_description = COALESCE($2, load_description),
                site_type        = COALESCE($3, site_type),
                name             = COALESCE($4, name)
            WHERE id = $5
            RETURNING id, name, load_types, load_description, site_type
        `, [
            load_types ?? null,
            load_description ?? null,
            site_type ?? null,
            name ?? null,
            id,
        ]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Meter not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update meter profile error:', err);
        res.status(500).json({ error: 'Failed to update meter profile' });
    } finally {
        client.release();
    }
});

// Toggle meter active/paused state
app.patch('/meters/:id/active', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id WHERE m.id = $1 AND s.tenant_id = $2`,
                [id, tenantId]
            );
            if (check.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
        const result = await client.query(
            `UPDATE meters SET is_active = NOT is_active WHERE id = $1 RETURNING id, name, is_active`,
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Meter not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Toggle meter error:', err);
        res.status(500).json({ error: 'Failed to toggle meter state' });
    } finally {
        client.release();
    }
});


import multer from 'multer';
import csv from 'csv-parser';
import fs from 'fs';

const upload = multer({ dest: 'uploads/' });

// Secure endpoint: Get Readings for a specific Meter (verified access).
// When a date range is provided, server-side time_bucket aggregation keeps
// chart payloads to ~300-700 points regardless of how long the window is.
app.get('/meters/:id/readings', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const limit = parseInt(String(req.query.limit || '500'));
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const raw = req.query.raw === '1' || req.query.raw === 'true';
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

        // Bucketed path: only when both from & to provided (typical chart use)
        // and the caller hasn't explicitly asked for raw rows.
        if (from && !raw) {
            const fromDate = new Date(from);
            const toDate   = to ? new Date(to) : new Date();
            const bucket   = pickBucketInterval(fromDate, toDate);
            const params: any[] = [bucket, id, fromDate, toDate];
            const result = await client.query(`
                SELECT
                    time_bucket($1::interval, time)        AS time,
                    AVG(power_active_total)                AS power_active_total,
                    AVG(power_reactive_total)              AS power_reactive_total,
                    AVG(power_apparent_total)              AS power_apparent_total,
                    AVG(power_factor_total)                AS power_factor_total,
                    AVG(voltage_a) AS voltage_a, AVG(voltage_b) AS voltage_b, AVG(voltage_c) AS voltage_c,
                    AVG(current_a) AS current_a, AVG(current_b) AS current_b, AVG(current_c) AS current_c,
                    AVG(thd_voltage_a) AS thd_voltage_a, AVG(thd_current_a) AS thd_current_a,
                    AVG(frequency) AS frequency,
                    MAX(energy_import_total) AS energy_import_total
                FROM meter_readings
                WHERE meter_id = $2
                  AND time >= $3
                  AND time <= $4
                GROUP BY 1
                ORDER BY 1 ASC
            `, params);
            return res.json(result.rows);
        }

        // Raw rows path — preserved for backwards compat and explicit ?raw=1
        const params: any[] = [id];
        let query = 'SELECT * FROM meter_readings WHERE meter_id = $1';
        if (from) { params.push(new Date(from)); query += ` AND time >= $${params.length}`; }
        if (to)   { params.push(new Date(to));   query += ` AND time <= $${params.length}`; }
        query += ` ORDER BY time ASC LIMIT ${limit}`;

        const result = await client.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Pick a sensible time_bucket interval so chart payloads stay ~300-700 points.
// Recharts gets sluggish above ~1500 points and a 30-day raw query can return
// 40k+ rows — bucketing on the server keeps both DB and browser snappy.
function pickBucketInterval(fromDate: Date, toDate: Date): string {
    const hours = Math.max(0.1, (toDate.getTime() - fromDate.getTime()) / 3_600_000);
    if (hours <= 6)        return '1 minute';   // ≤360 pts
    if (hours <= 48)       return '5 minutes';  // ≤576 pts
    if (hours <= 14 * 24)  return '30 minutes'; // ≤672 pts
    if (hours <= 60 * 24)  return '2 hours';    // ≤720 pts
    return '6 hours';                            // long-range / yearly views
}

// ── Aggregate readings across ALL active meters for the tenant (overview chart) ─
// GET /readings/aggregate?from=ISO  → returns per-bucket SITE TOTAL power
app.get('/readings/aggregate', authenticateToken, async (req: any, res) => {
    const { tenantId, role } = req.user;
    const from = req.query.from as string | undefined;
    const client = await pool.connect();
    try {
        const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const toDate   = new Date();
        const bucket   = pickBucketInterval(fromDate, toDate);

        const params: any[] = [bucket, fromDate];
        let tenantFilter = '';
        if (role !== 'super_admin') {
            params.push(tenantId);
            tenantFilter = `AND s.tenant_id = $${params.length}`;
        }
        // Per-meter average within each bucket, then SUM across meters →
        // gives true site-total power even if meters report at different rates.
        const result = await client.query(`
            WITH per_meter AS (
                SELECT
                    time_bucket($1::interval, mr.time) AS bucket,
                    mr.meter_id,
                    AVG(mr.power_active_total)         AS avg_kw
                FROM meter_readings mr
                JOIN meters m ON mr.meter_id = m.id
                JOIN sites  s ON m.site_id  = s.id
                WHERE mr.time >= $2
                  AND m.is_active = true
                  AND mr.power_active_total IS NOT NULL
                  ${tenantFilter}
                GROUP BY bucket, mr.meter_id
            )
            SELECT
                bucket                                AS time,
                ROUND(SUM(avg_kw)::numeric, 2)        AS power_active_total
            FROM per_meter
            GROUP BY bucket
            ORDER BY bucket ASC
        `, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Aggregate readings error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Power Quality Health Check — NRS 048-2 compliance + equipment risk assessment.
// Deterministic: every figure is measured or derived from a published standard.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/meters/:id/compliance', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.query.days || '7')), 1), 90);
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
                return res.status(403).json({ error: 'Forbidden' });
            }
        }
    } finally {
        client.release();
    }

    try {
        const report = await assessPowerQuality(pool, id, days);
        if (!report) return res.status(404).json({ error: 'Meter not found' });

        // Snapshot the assessment for long-term trend and the value ledger.
        // Rate-limited to one row per meter per ~day so that simply opening the
        // report repeatedly doesn't inflate the history.
        if (report.verdict !== 'INSUFFICIENT_DATA') {
            const snap = await pool.connect();
            try {
                const recent = await snap.query(
                    `SELECT 1 FROM pq_assessments
                     WHERE meter_id = $1 AND assessed_at > NOW() - INTERVAL '20 hours' LIMIT 1`,
                    [id]
                );
                if (recent.rows.length === 0) {
                    await snap.query(`
                        INSERT INTO pq_assessments
                            (meter_id, site_id, tenant_id, period_days, readings, verdict,
                             supply_score, install_score, parameters, risks, degrading)
                        SELECT $1, m.site_id, s.tenant_id, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb
                        FROM meters m JOIN sites s ON m.site_id = s.id WHERE m.id = $1
                    `, [
                        id, days, report.readings, report.verdict,
                        report.supply_score, report.install_score,
                        JSON.stringify(report.parameters),
                        JSON.stringify(report.risks),
                        JSON.stringify(report.degrading),
                    ]);
                }
            } catch (e: any) {
                // Snapshotting must never break the report itself.
                console.error('PQ snapshot failed:', e.message || e);
            } finally {
                snap.release();
            }
        }

        res.json(report);
    } catch (err) {
        console.error('Compliance assessment error:', err);
        res.status(500).json({ error: 'Assessment failed' });
    }
});

// AI executive summary for an assessment — plain-language interpretation of the
// measured findings. Cached against the latest snapshot.
app.get('/meters/:id/compliance/summary', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.query.days || '7')), 1), 90);
    const { tenantId, role } = req.user;

    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                 WHERE m.id = $1 AND s.tenant_id = $2`, [id, tenantId]);
            if (authCheck.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
    } finally {
        client.release();
    }

    try {
        const report = await assessPowerQuality(pool, id, days);
        if (!report) return res.status(404).json({ error: 'Meter not found' });
        if (report.verdict === 'INSUFFICIENT_DATA') {
            return res.json({ summary: null, reason: 'insufficient_data' });
        }
        const summary = await getOrCreateExecutiveSummary(pool, id, report);
        res.json({ summary, reason: summary ? null : 'ai_unavailable' });
    } catch (err) {
        console.error('Executive summary error:', err);
        res.status(500).json({ error: 'Summary failed' });
    }
});

// Ask a question about one specific assessment — scoped to its measured findings.
app.post('/meters/:id/compliance/ask', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.body?.days || '7')), 1), 90);
    const question = String(req.body?.question || '').slice(0, 1000).trim();
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
    const { tenantId, role } = req.user;

    if (!question) return res.status(400).json({ error: 'Question required' });

    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                 WHERE m.id = $1 AND s.tenant_id = $2`, [id, tenantId]);
            if (authCheck.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
    } finally {
        client.release();
    }

    try {
        const report = await assessPowerQuality(pool, id, days);
        if (!report) return res.status(404).json({ error: 'Meter not found' });
        const answer = await answerReportQuestion(report, question, history);
        res.json({ answer, reason: answer ? null : 'ai_unavailable' });
    } catch (err) {
        console.error('Report Q&A error:', err);
        res.status(500).json({ error: 'Question failed' });
    }
});

// Degradation forecast — weekly trend regression and projected threshold crossing.
app.get('/meters/:id/forecast', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const weeks = Math.min(Math.max(parseInt(String(req.query.weeks || '12')), 4), 52);
    const { tenantId, role } = req.user;

    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                 WHERE m.id = $1 AND s.tenant_id = $2`, [id, tenantId]);
            if (authCheck.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
    } finally {
        client.release();
    }

    try {
        const forecast = await forecastDegradation(pool, id, weeks);
        if (!forecast) return res.status(404).json({ error: 'Meter not found' });
        res.json(forecast);
    } catch (err) {
        console.error('Forecast error:', err);
        res.status(500).json({ error: 'Forecast failed' });
    }
});

// Assessment history for a meter — powers long-term trend lines.
app.get('/meters/:id/compliance/history', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(String(req.query.limit || '52')), 200);
    const { tenantId, role } = req.user;

    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const authCheck = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                 WHERE m.id = $1 AND s.tenant_id = $2`, [id, tenantId]);
            if (authCheck.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        }
        const result = await client.query(`
            SELECT assessed_at, verdict, supply_score, install_score, readings,
                   jsonb_array_length(COALESCE(risks,'[]'::jsonb)) AS risk_count
            FROM pq_assessments
            WHERE meter_id = $1
            ORDER BY assessed_at DESC
            LIMIT $2
        `, [id, limit]);
        res.json(result.rows.reverse());
    } catch (err) {
        console.error('Compliance history error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Value ledger — what Grid-IQ has caught for this client. Shown when the
// invoice lands: the running record of monitoring actually earning its keep.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/value-ledger', authenticateToken, async (req: any, res) => {
    const { tenantId, role } = req.user;
    const effectiveTenantId = role === 'super_admin' ? (req.query.tenant_id || null) : tenantId;

    const client = await pool.connect();
    try {
        const params: any[] = [];
        let where = '';
        if (effectiveTenantId) { where = 'WHERE s.tenant_id = $1'; params.push(effectiveTenantId); }

        // Monitoring effort: how much data has actually been examined.
        const coverage = await client.query(`
            SELECT COUNT(*)::bigint AS readings,
                   MIN(mr.time) AS since,
                   COUNT(DISTINCT mr.meter_id) AS meters
            FROM meter_readings mr
            JOIN meters m ON mr.meter_id = m.id
            JOIN sites s ON m.site_id = s.id
            ${where}
        `, params);

        // Findings raised by the assessment engine, grouped per meter. Grouping by
        // severity alone made the same issue on two meters look like a duplicate
        // row; the meter name is what distinguishes them. Severity is taken as the
        // worst observed for that finding on that meter.
        const findings = await client.query(`
            SELECT risk->>'key' AS key,
                   risk->>'title' AS title,
                   m.name AS meter_name,
                   (ARRAY_AGG(risk->>'severity' ORDER BY
                        CASE risk->>'severity'
                            WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                            WHEN 'MEDIUM' THEN 2 ELSE 3 END))[1] AS severity,
                   COUNT(*)::int AS times_seen,
                   MIN(a.assessed_at) AS first_seen,
                   MAX(a.assessed_at) AS last_seen
            FROM pq_assessments a
            JOIN sites s ON a.site_id = s.id
            LEFT JOIN meters m ON a.meter_id = m.id
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.risks,'[]'::jsonb)) AS risk
            ${where}
            GROUP BY 1, 2, 3
            ORDER BY MAX(a.assessed_at) DESC
        `, params);

        // Alerts the platform raised without being asked.
        const alerts = await client.query(`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE severity IN ('CRITICAL','HIGH'))::int AS serious
            FROM alerts a
            ${effectiveTenantId ? 'WHERE a.tenant_id = $1' : ''}
        `, params);

        const assessments = await client.query(`
            SELECT COUNT(*)::int AS total FROM pq_assessments a
            JOIN sites s ON a.site_id = s.id ${where}
        `, params);

        const c = coverage.rows[0] || {};
        res.json({
            readings_analysed: Number(c.readings || 0),
            monitoring_since:  c.since || null,
            meters_monitored:  Number(c.meters || 0),
            assessments_run:   assessments.rows[0]?.total ?? 0,
            alerts_raised:     alerts.rows[0]?.total ?? 0,
            serious_alerts:    alerts.rows[0]?.serious ?? 0,
            findings:          findings.rows,
        });
    } catch (err) {
        console.error('Value ledger error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ── Report branding (white-label) ────────────────────────────────────────────
app.get('/branding', authenticateToken, async (req: any, res) => {
    const { tenantId } = req.user;
    const client = await pool.connect();
    try {
        const r = await client.query(
            `SELECT brand_name, brand_logo_url, brand_footer FROM tenants WHERE id = $1`, [tenantId]);
        res.json(r.rows[0] || { brand_name: null, brand_logo_url: null, brand_footer: null });
    } catch (err) {
        console.error('Branding fetch error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.put('/branding', authenticateToken, async (req: any, res) => {
    const { tenantId } = req.user;
    const { brand_name, brand_logo_url, brand_footer } = req.body ?? {};
    const clean = (v: any) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 512) : null);
    const client = await pool.connect();
    try {
        const r = await client.query(
            `UPDATE tenants SET brand_name = $2, brand_logo_url = $3, brand_footer = $4
             WHERE id = $1 RETURNING brand_name, brand_logo_url, brand_footer`,
            [tenantId, clean(brand_name), clean(brand_logo_url), clean(brand_footer)]
        );
        res.json(r.rows[0]);
    } catch (err) {
        console.error('Branding update error:', err);
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

        // Energy (kWh) is integrated interval-independently: for each reading,
        // power (kW) × the actual time to the NEXT reading. This is immune to
        // sampling-rate changes (readings arrive anywhere from ~3s to ~60s apart)
        // and to reading-density variation between months. The per-reading gap is
        // capped at 900s so an offline period isn't billed as continuous power.
        // If the meter reports a sane cumulative kWh register, that wins (a direct
        // measurement beats an estimate); resets/rollovers are rejected by the bound.
        const result = await client.query(`
            WITH r AS (
                SELECT
                    time,
                    power_active_total,
                    energy_import_total,
                    LEAST(
                        EXTRACT(EPOCH FROM (
                            LEAD(time) OVER (PARTITION BY DATE_TRUNC('month', time) ORDER BY time) - time
                        )),
                        900
                    ) AS dt_s
                FROM meter_readings
                WHERE meter_id = $1
                  AND time >= DATE_TRUNC('month', NOW() - ($2 || ' months')::INTERVAL)
                  AND power_active_total IS NOT NULL
            )
            SELECT
                TO_CHAR(DATE_TRUNC('month', time), 'Mon') AS month,
                DATE_TRUNC('month', time) AS month_start,
                CASE
                    WHEN MAX(energy_import_total) IS NOT NULL
                         AND (MAX(energy_import_total) - MIN(energy_import_total)) BETWEEN 0 AND 10000000
                    THEN ROUND((MAX(energy_import_total) - MIN(energy_import_total))::numeric, 0)
                    ELSE ROUND(SUM(power_active_total * COALESCE(dt_s, 0) / 3600.0)::numeric, 0)
                END AS kwh
            FROM r
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
                   es.pf_score, es.thd_score, es.voltage_unbalance_score, es.voltage_quality_score
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

// POST /sites/:id/recommendations/generate — site-wide AI analysis
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
        if (!score) return res.status(400).json({ error: 'Insufficient meter data — need at least 3 readings. Check that the meter is connected and sending data.' });

        const recs = await generateAndStoreSiteRecommendations(
            pool, id, site.tenant_id, score, site.name, site.address || ''
        );
        res.json({ generated: recs.length, recommendations: recs });
    } catch (err: any) {
        console.error('[API] Recommendation generation error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate recommendations' });
    }
});

// GET /meters/:id/recommendations — active recommendations for a single meter
app.get('/meters/:id/recommendations', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (role !== 'super_admin') {
            const check = await client.query(
                `SELECT m.id FROM meters m JOIN sites s ON m.site_id = s.id
                 WHERE m.id = $1 AND s.tenant_id = $2`,
                [id, tenantId]
            );
            if (check.rows.length === 0) { client.release(); return res.status(403).json({ error: 'Forbidden' }); }
        }
        client.release();
        const recs = await getMeterRecommendations(pool, id);
        res.json(recs);
    } catch (err) {
        client.release();
        res.status(500).json({ error: 'Error fetching meter recommendations' });
    }
});

// POST /meters/:id/recommendations/generate — AI analysis scoped to one meter
app.post('/meters/:id/recommendations/generate', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        const meterCheck = await client.query(
            `SELECT m.id, m.name, m.site_id, s.tenant_id, s.name as site_name, s.address as site_address
             FROM meters m JOIN sites s ON m.site_id = s.id
             WHERE m.id = $1 ${role !== 'super_admin' ? 'AND s.tenant_id = $2' : ''}`,
            role !== 'super_admin' ? [id, tenantId] : [id]
        );
        if (meterCheck.rows.length === 0) { client.release(); return res.status(403).json({ error: 'Forbidden' }); }
        const meter = meterCheck.rows[0];
        client.release();

        // Compute fresh score for this meter only (not persisted to energy_scores).
        const score = await computeAndStoreSiteScore(pool, meter.site_id, meter.id);
        if (!score) return res.status(400).json({ error: 'Insufficient meter data — need at least 3 readings for this meter.' });

        const recs = await generateAndStoreSiteRecommendations(
            pool, meter.site_id, meter.tenant_id, score,
            meter.site_name, meter.site_address || '',
            meter.id, meter.name
        );
        res.json({ generated: recs.length, recommendations: recs, meter: { id: meter.id, name: meter.name } });
    } catch (err: any) {
        console.error('[API] Per-meter recommendation generation error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate per-meter recommendations' });
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

// ── Single-Line Diagram (SLD) endpoints ──────────────────────────────────────
// Layout JSONB stores nodes + edges. PDF backdrops are persisted to disk under
// uploads/sld-pdfs/<site>.pdf and streamed via auth-protected endpoint.

const SLD_PDF_DIR = path.join(__dirname, '..', 'uploads', 'sld-pdfs');
fs.mkdirSync(SLD_PDF_DIR, { recursive: true });

const sldUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, SLD_PDF_DIR),
        filename:    (req: any, _file, cb) => cb(null, `${req.params.id}.pdf`),
    }),
    fileFilter: (_req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('Only PDF files accepted'));
        }
        cb(null, true);
    },
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB ceiling — SLDs are usually <5 MB
});

async function assertSiteAccess(client: any, siteId: string, tenantId: string, role: string) {
    if (role === 'super_admin') return true;
    const check = await client.query(
        `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`,
        [siteId, tenantId]
    );
    return check.rows.length > 0;
}

// GET diagram (layout + has-PDF flag)
app.get('/sites/:id/diagram', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (!await assertSiteAccess(client, id, tenantId, role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const result = await client.query(
            `SELECT layout, background_pdf_path, background_width, background_height, updated_at
             FROM site_diagrams WHERE site_id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            // Initialise empty diagram on first read so PUT doesn't need a separate create call
            await client.query(
                `INSERT INTO site_diagrams (site_id) VALUES ($1) ON CONFLICT DO NOTHING`,
                [id]
            );
            return res.json({ layout: { nodes: [], edges: [] }, has_pdf: false, updated_at: null });
        }
        const row = result.rows[0];
        res.json({
            layout: row.layout,
            has_pdf: !!row.background_pdf_path,
            background_width:  row.background_width,
            background_height: row.background_height,
            updated_at: row.updated_at,
        });
    } catch (err) {
        console.error('Get diagram error:', err);
        res.status(500).json({ error: 'Failed to fetch diagram' });
    } finally {
        client.release();
    }
});

// PUT diagram layout
app.put('/sites/:id/diagram', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const { layout, background_width, background_height } = req.body;
    if (!layout || typeof layout !== 'object' || !Array.isArray(layout.nodes)) {
        return res.status(400).json({ error: 'layout must be { nodes: [], edges: [] }' });
    }
    const client = await pool.connect();
    try {
        if (!await assertSiteAccess(client, id, tenantId, role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        await client.query(`
            INSERT INTO site_diagrams (site_id, layout, background_width, background_height, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (site_id) DO UPDATE SET
                layout            = EXCLUDED.layout,
                background_width  = COALESCE(EXCLUDED.background_width,  site_diagrams.background_width),
                background_height = COALESCE(EXCLUDED.background_height, site_diagrams.background_height),
                updated_at        = NOW()
        `, [id, JSON.stringify(layout), background_width ?? null, background_height ?? null]);
        res.json({ ok: true });
    } catch (err) {
        console.error('Save diagram error:', err);
        res.status(500).json({ error: 'Failed to save diagram' });
    } finally {
        client.release();
    }
});

// POST upload PDF backdrop
app.post('/sites/:id/diagram/pdf', authenticateToken, sldUpload.single('pdf') as any, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    const client = await pool.connect();
    try {
        if (!await assertSiteAccess(client, id, tenantId, role)) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(403).json({ error: 'Forbidden' });
        }
        const relPath = path.relative(path.join(__dirname, '..'), req.file.path);
        await client.query(`
            INSERT INTO site_diagrams (site_id, background_pdf_path, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (site_id) DO UPDATE SET
                background_pdf_path = EXCLUDED.background_pdf_path,
                updated_at = NOW()
        `, [id, relPath]);
        res.json({ ok: true, size: req.file.size });
    } catch (err) {
        console.error('Upload SLD PDF error:', err);
        res.status(500).json({ error: 'Failed to save PDF' });
    } finally {
        client.release();
    }
});

// GET PDF stream (auth-checked; PDFs contain client electrical info — never public)
app.get('/sites/:id/diagram/pdf', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (!await assertSiteAccess(client, id, tenantId, role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const result = await client.query(
            `SELECT background_pdf_path FROM site_diagrams WHERE site_id = $1`,
            [id]
        );
        const relPath = result.rows[0]?.background_pdf_path;
        if (!relPath) return res.status(404).json({ error: 'No PDF uploaded for this site' });
        const absPath = path.join(__dirname, '..', relPath);
        if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'PDF file missing on disk' });
        res.setHeader('Content-Type', 'application/pdf');
        fs.createReadStream(absPath).pipe(res);
    } catch (err) {
        console.error('Serve SLD PDF error:', err);
        res.status(500).json({ error: 'Failed to serve PDF' });
    } finally {
        client.release();
    }
});

// DELETE PDF backdrop
app.delete('/sites/:id/diagram/pdf', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { tenantId, role } = req.user;
    const client = await pool.connect();
    try {
        if (!await assertSiteAccess(client, id, tenantId, role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const result = await client.query(
            `SELECT background_pdf_path FROM site_diagrams WHERE site_id = $1`,
            [id]
        );
        const relPath = result.rows[0]?.background_pdf_path;
        if (relPath) {
            const absPath = path.join(__dirname, '..', relPath);
            try { fs.unlinkSync(absPath); } catch {}
        }
        await client.query(
            `UPDATE site_diagrams SET background_pdf_path = NULL, background_width = NULL, background_height = NULL, updated_at = NOW() WHERE site_id = $1`,
            [id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('Delete SLD PDF error:', err);
        res.status(500).json({ error: 'Failed to delete PDF' });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Ingestion Service API running on port ${port}`);
});

console.log('Ingestion Service (Queue Mode) started.');
