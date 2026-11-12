import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';
import cron from 'node-cron';
import { initMqtt, IngestRuntime } from './mqtt';
import { assertSchemaCurrent, SchemaBehindError, assertRetentionConsistent, RetentionMismatchError, refreshAggregates, appliedMigrations, compareMigrations, listMigrations } from '@gridiq/db';
import { evaluateDeepHealth, deepHealthConfig, healthTokenValid, DeepHealthFacts } from './health';
import {
    parseRoles, uploadDir, toStoredUploadPath, resolveStoredUploadPath,
    waitUntil, databaseReachable, startHealthServer,
} from './roles';
import { computeAndStoreSiteScore, getLatestSiteScore } from './energy-score';
import { assessPowerQuality } from './power-quality';
import { getOrCreateExecutiveSummary, getCachedExecutiveSummary, answerReportQuestion } from './pq-narrative';
import { forecastDegradation } from './pq-forecast';
import { buildRiskProfile } from './risk-profile';
import { maxDemand, DEFAULT_DEMAND_INTERVAL_MIN } from './demand';
import { planRead, meterSeriesSql, tenantPowerSql } from './aggregates';
import { checkTenMinute, checkDemand, checkEvents, checkDataHealth, checkThdITrend } from './alerting';
import { periodEnergy, monthKey, loadEnergyHours, touBand, localDateHour, combinedMethod } from './energy';
import { buildRenewalReview, runRenewalSweep } from './renewal';
import { fleetRouter, extendFirstDeployment } from './fleet/routes';
import { runCommissioning } from './fleet/commissioning';
import {
    buildScope, normaliseRole, viewerMayCall, tenantSql, telemetrySql, deliverySql, exclusiveDeviceSql, forClient, canWrite,
    findSite, findMeter, findOwned, meterParam, siteParam, requireWrite, seesUnpublishedFindings,
} from './scope';
import { reviewRouter } from './review';
import { opsRouter } from './ops';
import { portalRouter } from './portal';
import { assessmentsRouter, expireAssessments } from './assessments/routes';
import { deliverablesRouter, runCloseouts, notifyNearingEnd } from './reports/closeout';
import { sendDueEmails } from './notify/email';
import { consultantRouter } from './consultant';
import { investigateRouter } from './investigate';
import { runRetention } from './assessments/retention';
import { v1Router } from './v1/routes';
import { runExports, expireExports } from './v1/exports-job';
import { runRuleFindings } from './findings-rules';
import { randomBytes, createHash } from 'crypto';
import {
    generateAndStoreSiteRecommendations,
    getSiteRecommendations,
    getMeterRecommendations,
    getTenantRecommendations,
} from './ai-recommendations';

// Load .env from the service directory regardless of CWD
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Crash early rather than run against a guessed database or an insecure secret
if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set.');
    console.error('       Set it in services/ingestion-service/.env (see .env.example at the repo root).');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'gridiq-super-secret-key-change-in-prod' || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET is missing, too short, or still set to the default placeholder.');
    console.error('       Set a strong secret (≥32 chars) in services/ingestion-service/.env');
    process.exit(1);
}

// Which parts of the service this process runs (see roles.ts).
let ROLES: ReturnType<typeof parseRoles>;
try {
    ROLES = parseRoles(process.env.ROLES);
} catch (e: any) {
    console.error('FATAL:', e.message);
    process.exit(1);
}
console.log(`Ingestion Service roles: ${[...ROLES].join(',')}`);

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20, // Connection pool size from env
    idleTimeoutMillis: 30000,
});
// When the database restarts, idle pooled connections are terminated and the
// pool emits 'error'. Unhandled, that kills the process (and with it ingest's
// in-memory queue). Logged instead: queries fail and are retried by callers,
// and the pool reconnects on the next checkout.
pool.on('error', (err) => {
    console.error('[db] idle connection lost:', err.message);
});

// Startup. Every role refuses to run against a database that is behind the
// latest migration (packages/db/migrations; the compose `migrate` service
// applies them). No role changes the schema.
let ingest: IngestRuntime | null = null;
let jobsRegistered = false;
const startup = (async () => {
    await waitUntil('database', () => databaseReachable(pool));
    try {
        await assertSchemaCurrent(pool);
        // Compression and aggregate-refresh windows must cover MAX_BACKFILL_DAYS
        // as configured here; the migrate step applies them.
        await assertRetentionConsistent(pool);
    } catch (e) {
        if (e instanceof SchemaBehindError || e instanceof RetentionMismatchError) {
            console.error(`FATAL: ${e.message}`);
            process.exit(1);
        }
        throw e;
    }
    startHttp();
    if (ROLES.has('ingest')) {
        // Start MQTT Listener bridging Mosquitto to TimescaleDB
        ingest = await initMqtt(pool);
    }
    if (ROLES.has('jobs')) {
        registerJobs(pool);
        jobsRegistered = true;
    }
})();
startup.catch((e) => {
    console.error('FATAL: startup failed', e);
    process.exit(1);
});

// Graceful stop (docker compose stop/restart sends SIGTERM): ingest stops
// taking messages, flushes and acks what is queued, then disconnects. Anything
// not flushed stays unacked and the broker redelivers it.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        console.log(`[shutdown] ${signal} received`);
        try {
            if (ingest) await ingest.shutdown();
            await pool.end();
        } catch (e) {
            console.error('[shutdown] error:', e);
        }
        process.exit(0);
    });
}

// -----------------------------------------------------------------------------
// Scheduled jobs (jobs role only)
// -----------------------------------------------------------------------------
function registerJobs(pool: Pool) {
    // -----------------------------------------------------------------------------
    // ENERGY SCORE ENGINE — recalculates every 5 minutes for all sites
    // -----------------------------------------------------------------------------
    cron.schedule('*/5 * * * *', async () => {
        const client = await pool.connect();
        try {
            const sites = await client.query(`SELECT id FROM sites WHERE archived_at IS NULL`);
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
    // Pre-renewal review sweep. Daily at 06:00 — renewals move on a calendar, not
    // a clock, so anything more frequent is wasted work. The sweep is idempotent
    // and catches up on missed milestones, so a restart or an outage cannot cause a
    // client's renewal to be skipped silently.
    if (process.env.FEATURE_BROKER === 'true') {
        cron.schedule('0 6 * * *', async () => {
            const n = await runRenewalSweep(pool);
            if (n > 0) console.log(`[renewal] sweep produced ${n} review(s)`);
        });
    }

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

    // ── Alerting on aggregates and events (src/alerting.ts) ─────────────────
    const envPos = (name: string, def: number) => {
        const n = Number(process.env[name]);
        return Number.isFinite(n) && n > 0 ? n : def;
    };
    const silentMinutes = envPos('METER_SILENT_MINUTES', 5);
    const eventMinS = envPos('EVENT_ALERT_MIN_SECONDS', 10);
    const guarded = (name: string, fn: () => Promise<number>) => async () => {
        try {
            const n = await fn();
            if (n > 0) console.log(`[alerts] ${name}: ${n} new alert(s)`);
        } catch (e: any) {
            console.error(`[alerts] ${name} check failed:`, e?.message || e);
        }
    };
    cron.schedule('* * * * *', guarded('events', () => checkEvents(pool, eventMinS)));
    cron.schedule('*/5 * * * *', guarded('demand', () => checkDemand(pool)));
    cron.schedule('*/5 * * * *', guarded('data health', () => checkDataHealth(pool, silentMinutes)));
    // One minute past each 10-minute boundary, once that interval has closed.
    cron.schedule('1-59/10 * * * *', guarded('10-minute quality', () => checkTenMinute(pool)));
    cron.schedule('0 7 * * *', guarded('THD-I trend', () => checkThdITrend(pool)));

    // Commissioning checklist for new deployments (src/fleet/commissioning.ts).
    cron.schedule('* * * * *', async () => {
        try {
            await runCommissioning(pool);
        } catch (e: any) {
            console.error('[fleet] commissioning check failed:', e?.message || e);
        }
    });

    // Public API exports (src/v1/exports-job.ts): queued → CSV.gz in EXPORT_DIR; expired files deleted.
    let exporting = false;
    cron.schedule('* * * * *', async () => {
        if (exporting) return;
        exporting = true;
        try {
            await runExports(pool);
            await expireExports(pool);
        } catch (e: any) {
            console.error('[EXPORT] run failed:', e?.message || e);
        } finally {
            exporting = false;
        }
    });

    // Rule-based findings (src/findings-rules.ts): drafts from 7 days of measured data,
    // hourly and once two minutes after start. No AI provider needed.
    let findingRules = false;
    const runRules = async () => {
        if (findingRules) return;
        findingRules = true;
        try {
            const c = await runRuleFindings(pool);
            if (c.inserted || c.cleared) console.log(`[FINDINGS] rules: ${c.points} points, ${c.inserted} new, ${c.refreshed} refreshed, ${c.cleared} cleared`);
        } catch (e: any) {
            console.error('[FINDINGS] rules run failed:', e?.message || e);
        } finally {
            findingRules = false;
        }
    };
    cron.schedule('7 * * * *', runRules);
    // Assessments past end_at → ended (follow-up only; access already stops in SQL).
    cron.schedule('* * * * *', async () => {
        try {
            const n = await expireAssessments(pool);
            if (n) console.log(`[assessments] ${n} ended`);
        } catch (e: any) { console.error('[assessments] expiry failed:', e?.message || e); }
    });
    // Close-out after the end + late-data window; nearing-end notices; the email
    // outbox; retention purges. Each is idempotent and safe to run on restart.
    const job = (name: string, fn: () => Promise<number>) => async () => {
        try { const n = await fn(); if (n) console.log(`[jobs] ${name}: ${n}`); }
        catch (e: any) { console.error(`[jobs] ${name} failed:`, e?.message || e); }
    };
    cron.schedule('*/5 * * * *', job('assessment close-out', () => runCloseouts(pool)));
    cron.schedule('*/15 * * * *', job('nearing-end notices', () => notifyNearingEnd(pool)));
    cron.schedule('* * * * *', job('email outbox', () => sendDueEmails(pool)));
    cron.schedule('17 * * * *', job('retention purge', () => runRetention(pool)));
    setTimeout(runRules, 120_000).unref();

    console.log('[jobs] Cron schedules registered (score 5m, renewal 06:00, predictive 30m, alerts: events 1m, demand/data health 5m, 10-minute quality 10m, THD-I trend 07:00, exports 1m, rule findings 1h, assessment expiry 1m, close-out 5m, notices 15m, email 1m, retention 1h)');
}

// Health of the roles this process runs. Shared by the api /health route and
// the internal health server used by ingest-only / jobs-only containers.
async function roleHealth() {
    const detail: Record<string, unknown> = { roles: [...ROLES] };
    let ok = true;
    try {
        await pool.query('SELECT 1');
        detail.db = 'ok';
    } catch (e: any) {
        ok = false;
        detail.db = e?.message || 'unreachable';
    }
    if (ROLES.has('ingest')) {
        const h = ingest ? ingest.health() : { ok: false, mqtt: 'starting' };
        const { ok: ingestOk, ...rest } = h;
        Object.assign(detail, rest);
        ok = ok && ingestOk;
    }
    if (ROLES.has('jobs')) {
        detail.jobs = jobsRegistered ? 'registered' : 'pending';
        ok = ok && jobsRegistered;
    }
    return { ok, ...detail };
}

// Express API for Data Access
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';

// Exported for the cross-tenant route tests (test/db/scoping.test.js).
export const app = express();
const port = process.env.PORT || 3002;

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
        // Roles renamed in Phase 7; older tokens carry the old names.
        req.user = { ...user, role: normaliseRole(user?.role) };
        // Central tenant scope (src/scope.ts): every route filters through it.
        req.scope = buildScope(req.user, req);
        // An API key's token is for the public API only (the gateway accepts keys on /v1 only).
        if (req.scope.apiKey && !req.path.startsWith('/v1/')) {
            return res.status(403).json({ error: 'API keys are accepted on /api/v1 only' });
        }
        if (req.scope.role === 'client_viewer' && !viewerMayCall(req.method, req.path)) {
            return res.status(403).json({ error: 'Read-only role' });
        }
        next();
    });
};

// The broker portfolio is kept but off unless FEATURE_BROKER=true.
const BROKER_ENABLED = process.env.FEATURE_BROKER === 'true';

// Fleet model API: projects, points, devices, deployments, /fleet (src/fleet/routes.ts).
app.use(fleetRouter(pool, authenticateToken));
// Review workflow and reports (src/review.ts).
app.use(reviewRouter(pool, authenticateToken));
// Ops console extras: tenant list, data health (src/ops.ts).
app.use(opsRouter(pool, authenticateToken));
// Client portal reads: projects, points, demand, load profile (src/portal.ts).
app.use(portalRouter(pool, authenticateToken));
// Public API v1 (src/v1/routes.ts): API keys or sessions, OpenAPI at /v1/openapi.json, docs at /v1/docs.
app.use(v1Router(pool, authenticateToken));
// GridIQ assessments: packages, lifecycle, access grants, asset history (src/assessments/routes.ts).
app.use(assessmentsRouter(pool, authenticateToken));
// Report revisions, previews, deliverables and final-delivery links (src/reports/closeout.ts).
app.use(deliverablesRouter(pool, authenticateToken));
// The assessment consultant (src/consultant.ts): scoped retrieval, budgets, provider adapters.
app.use(consultantRouter(pool, authenticateToken));
app.use(investigateRouter(pool, authenticateToken));

// Deep health for an external uptime monitor (src/health.ts). Token header,
// no JWT: the monitor is not a user. Disabled unless HEALTH_TOKEN is set.
app.get('/health/deep', async (req: any, res) => {
    if (!process.env.HEALTH_TOKEN) return res.sendStatus(404);
    if (!healthTokenValid(process.env.HEALTH_TOKEN, req.headers['x-health-token'])) return res.sendStatus(401);
    const cfg = deepHealthConfig();
    const facts: DeepHealthFacts = {
        dbOk: false, pendingMigrations: null, ingestAliveAgeS: null, ingestFlushAgeS: null,
        metersReportingRecently: 0, metersSilent: 0, backupAgeS: null,
    };
    try {
        const applied = await appliedMigrations(pool);
        facts.dbOk = true;
        facts.pendingMigrations = compareMigrations(listMigrations(), applied).pending.length;
        const r = await pool.query(`
            SELECT
                (SELECT extract(epoch FROM NOW() - alive_at)      FROM service_heartbeats WHERE service = 'ingest') AS alive_age,
                (SELECT extract(epoch FROM NOW() - last_flush_at) FROM service_heartbeats WHERE service = 'ingest') AS flush_age,
                (SELECT extract(epoch FROM NOW() - max(finished_at)) FROM backup_runs WHERE ok) AS backup_age,
                (SELECT count(*) FROM (
                    SELECT m.id, (SELECT max(time) FROM meter_readings r WHERE r.meter_id = m.id AND r.time >= NOW() - INTERVAL '1 day') AS last
                    FROM meters m WHERE m.is_active) x WHERE last IS NOT NULL) AS reporting,
                (SELECT count(*) FROM (
                    SELECT m.id, (SELECT max(time) FROM meter_readings r WHERE r.meter_id = m.id AND r.time >= NOW() - INTERVAL '1 day') AS last
                    FROM meters m WHERE m.is_active) x WHERE last < NOW() - make_interval(mins => $1)
                ) + (SELECT count(*) FROM meters m WHERE m.is_active
                       AND NOT EXISTS (SELECT 1 FROM meter_readings r WHERE r.meter_id = m.id AND r.time >= NOW() - INTERVAL '1 day')
                       AND EXISTS (SELECT 1 FROM meter_readings r WHERE r.meter_id = m.id AND r.time >= NOW() - INTERVAL '7 days')) AS silent
        `, [cfg.silentMinutes]);
        const row = r.rows[0];
        const n = (v: any) => (v === null || v === undefined ? null : Number(v));
        facts.ingestAliveAgeS = n(row.alive_age);
        facts.ingestFlushAgeS = n(row.flush_age);
        facts.backupAgeS = n(row.backup_age);
        facts.metersReportingRecently = Number(row.reporting) || 0;
        facts.metersSilent = Number(row.silent) || 0;
    } catch (e: any) {
        if (!facts.dbOk) facts.dbError = e?.message || 'unreachable';
        else console.error('Deep health query failed:', e?.message || e);
    }
    const result = evaluateDeepHealth(facts, cfg);
    res.status(result.ok ? 200 : 503).json({ ...result, checked_at: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ingestion-service', mode: [...ROLES].join(',') });
});

// Secure endpoint: Get Sites (filtered by Tenant)
app.get('/sites', authenticateToken, async (req: any, res) => {
    const client = await pool.connect();

    try {
        // Archived sites are hidden unless ?archived=1 (admin restore view).
        const showArchived = req.query.archived === '1' || req.query.archived === 'true';
        const params: any[] = [];
        let query = `SELECT * FROM sites WHERE ${showArchived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'}
                     AND ${tenantSql(req.scope, 'tenant_id', params)}`;

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
app.post('/sites', authenticateToken, requireWrite, async (req: any, res) => {
    const { name, address, timezone } = req.body;

    if (!name) return res.status(400).json({ error: 'Site name is required' });

    // Clients always create in their own tenant; internal users may name one.
    const targetTenantId = req.scope.filterTenantId ?? req.scope.tenantId;
    const client = await pool.connect();

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
app.delete('/sites/:id', authenticateToken, siteParam(pool, { write: true }), async (req: any, res) => {
    const client = await pool.connect();
    const siteId = req.params.id;

    try {
        await client.query('BEGIN'); // Start transaction

        // Archive, never delete: readings, reports and alerts are evidence.
        // The site and its meters leave the lists and stop ingesting; an admin
        // can restore them (POST /sites/:id/restore).
        const result = await client.query(
            `UPDATE sites SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING archived_at`, [siteId]);
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Site not found or already archived' });
        }
        // Same timestamp on its meters, so a restore brings back exactly these.
        await client.query(
            `UPDATE meters SET archived_at = $2, is_active = false WHERE site_id = $1 AND archived_at IS NULL`,
            [siteId, result.rows[0].archived_at]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Site archived. Its meters stopped receiving readings; all data is kept and an admin can restore it.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Database error archiving site' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Create Meter
app.post('/meters', authenticateToken, requireWrite, async (req: any, res) => {
    const client = await pool.connect();
    const { site_id, name, serial_number, model } = req.body;

    if (!site_id || !name) { client.release(); return res.status(400).json({ error: 'site_id and name are required' }); }

    try {
        if (!await findSite(client, req.scope, site_id)) {
            return res.status(403).json({ error: 'Forbidden: Site does not belong to your tenant or does not exist.' });
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

    try {
        // Telemetry (the latest reading) only where the project shares live data.
        let query = `
            SELECT m.*,
            CASE WHEN ${telemetrySql(req.scope, 's')} THEN (
                SELECT row_to_json(r)
                FROM (
                    SELECT * FROM meter_readings
                    WHERE meter_id = m.id
                    ORDER BY time DESC
                    LIMIT 1
                ) r
            ) END as latest_reading
            FROM meters m
            JOIN sites s ON m.site_id = s.id
        `;
        const params: any[] = [];

        // Tenant Isolation
        // Archived meters (or meters of an archived site) are hidden unless ?archived=1.
        const showArchived = req.query.archived === '1' || req.query.archived === 'true';
        query += showArchived
            ? ` WHERE (m.archived_at IS NOT NULL OR s.archived_at IS NOT NULL)`
            : ` WHERE m.archived_at IS NULL AND s.archived_at IS NULL`;
        query += ` AND ${tenantSql(req.scope, 's.tenant_id', params)} AND ${exclusiveDeviceSql(req.scope, 'm', params)}`;

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
app.get('/sites/:id/settings', authenticateToken, siteParam(pool), async (req: any, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
        const result = await client.query(`SELECT * FROM site_settings WHERE site_id = $1`, [id]);
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching site settings' });
    } finally {
        client.release();
    }
});

// Secure endpoint: Update Site Settings (Upsert)
app.post('/sites/:id/settings', authenticateToken, siteParam(pool, { write: true }), async (req: any, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const {
        tariff_peak, tariff_standard, tariff_offpeak,
        peak_times, standard_times, offpeak_times,
        alert_max_kw, alert_min_v, alert_max_thd,
        alert_max_v, alert_min_freq, alert_max_freq,
        contracted_mdi_kva, tariff_demand,
    } = req.body;

    try {
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

    try {
        // Alerts are derived from telemetry: hidden with the project's live data.
        const params: any[] = [];
        let query = `
            SELECT a.*, m.name as meter_name
            FROM alerts a
            JOIN meters m ON a.meter_id = m.id
            LEFT JOIN sites s ON m.site_id = s.id
            WHERE ${tenantSql(req.scope, 'a.tenant_id', params)}
              AND ${req.scope.isInternal ? 'TRUE' : telemetrySql(req.scope, 's')}
        `;

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
    const { id } = req.params;

    try {
        if (!await findOwned(client, req.scope, 'alerts', id)) return res.status(403).json({ error: 'Forbidden' });
        await client.query(`UPDATE alerts SET is_read = true WHERE id = $1`, [id]);
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
    const sc = req.scope;

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
        meterQuery += ` WHERE ${tenantSql(sc, 's.tenant_id', meterParams)} AND ${telemetrySql(sc, 's')}
                          AND ${exclusiveDeviceSql(sc, 'm', meterParams)}`;
        const meterResult = await client.query(meterQuery, meterParams);

        // 2. Active alerts (last 48h, unread)
        let alertQuery = `
            SELECT type, severity, message, created_at
            FROM alerts
            WHERE is_read = false
            AND created_at > NOW() - INTERVAL '48 hours'
        `;
        const alertParams: any[] = [];
        alertQuery += ` AND ${tenantSql(sc, 'tenant_id', alertParams)}`;
        if (!sc.isInternal) {
            alertQuery += ` AND meter_id IN (SELECT m.id FROM meters m JOIN sites s ON s.id = m.site_id WHERE ${telemetrySql(sc, 's')})`;
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
        settingsQuery += ` WHERE ${tenantSql(sc, 's.tenant_id', settingsParams)}`;
        const settingsResult = await client.query(settingsQuery, settingsParams);
        const settingsList = settingsResult.rows;


        // 4. Monthly usage aggregate — energy integrated time-weighted (power x the
        //    actual seconds to the next reading per meter, capped at 900s for gaps),
        //    so it matches the /monthly endpoint instead of assuming a fixed interval.
        const monthlyParams: any[] = [];
        const tenantClause = ` AND ${tenantSql(sc, 's.tenant_id', monthlyParams)} AND ${telemetrySql(sc, 's')}
                               AND ${exclusiveDeviceSql(sc, 'm', monthlyParams)}`;
        // From the continuous aggregates. Billed demand: the 30-minute interval
        // averages in readings_30m (minute-weighted, ≥ 80 % of minutes covered),
        // averaged across meters per interval as before. Energy: 1-minute
        // averages × the time to the next minute with data, capped at 900 s.
        const monthlyQuery = `
            WITH iv AS (
                -- Per meter: each meter's own billed-demand figure. Meters are
                -- neither averaged (understates) nor summed (a main incomer
                -- plus its sub-meters would be counted twice).
                SELECT m.name AS meter_name, MAX(v.kw_demand) AS iv_kw, MAX(v.kva_demand) AS iv_kva
                FROM readings_30m v
                JOIN meters m ON v.meter_id = m.id
                JOIN sites s ON m.site_id = s.id
                WHERE v.bucket >= date_trunc('month', NOW()) AND v.minutes >= 0.8 * 30 ${tenantClause}
                GROUP BY v.meter_id, m.name
            ), mins AS (
                SELECT v.power_active_total_avg AS p, v.power_active_total_max AS p_max,
                       LEAST(EXTRACT(EPOCH FROM (LEAD(v.bucket) OVER (PARTITION BY v.meter_id ORDER BY v.bucket) - v.bucket)), 900) AS dt_s
                FROM readings_1m v
                JOIN meters m ON v.meter_id = m.id
                JOIN sites s ON m.site_id = s.id
                WHERE v.bucket >= date_trunc('month', NOW()) AND v.power_active_total_avg IS NOT NULL ${tenantClause}
            )
            SELECT
                (SELECT ROUND((SUM(p * COALESCE(dt_s, 60)) / 3600.0)::numeric, 1) FROM mins) AS kwh_this_month,
                (SELECT ROUND(MAX(p_max)::numeric, 1) FROM mins)                            AS peak_instant_kw,
                (SELECT string_agg(format('%s %s kVA / %s kW', meter_name, ROUND(iv_kva::numeric, 1), ROUND(iv_kw::numeric, 1)), '; '
                                   ORDER BY iv_kva DESC NULLS LAST)
                 FROM (SELECT * FROM iv ORDER BY iv_kva DESC NULLS LAST LIMIT 5) top) AS demand_by_meter
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
        contextString += `• Maximum demand per meter this month (BILLED BASIS — highest 30-min time-weighted average, matches the utility's method): `
            + `${monthly?.demand_by_meter ?? 'N/A'}\n`
            + `  (Each meter's own figure. A site's billed demand is the figure of its main incomer / utility metering point; `
            + `sub-meters are part of it and are not added on top.)\n`;
        contextString += `• Highest instantaneous reading (NOT what is billed — a brief spike does not move a 30-min average): `
            + `${monthly?.peak_instant_kw ?? 'N/A'} kW\n`;
        contextString += `  When asked about peak or maximum demand, quote the BILLED BASIS figure. Only mention the `
            + `instantaneous value to explain why it differs from the billed one.\n`;

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
            const historyTenant = ` AND ${tenantSql(sc, 's.tenant_id', historyParams)} AND ${telemetrySql(sc, 's')}
                                    AND ${exclusiveDeviceSql(sc, 'm', historyParams)}`;
            // From readings_1h: min/max are of the raw samples, averages are
            // sample-weighted; energy integrates the hourly average over the
            // minutes that carried data.
            const historyQuery = `
                SELECT
                    m.name AS meter_name,
                    SUM(v.n) AS reading_count,
                    ROUND(MIN(v.power_active_total_min)::numeric, 1) AS min_kw,
                    ROUND(MAX(v.power_active_total_max)::numeric, 1) AS max_kw,
                    ROUND((SUM(v.power_active_total_avg * v.n) / NULLIF(SUM(v.n) FILTER (WHERE v.power_active_total_avg IS NOT NULL), 0))::numeric, 1) AS avg_kw,
                    ROUND(MIN(v.power_factor_total_min)::numeric, 3) AS min_pf,
                    ROUND((SUM(v.power_factor_total_avg * v.n) / NULLIF(SUM(v.n) FILTER (WHERE v.power_factor_total_avg IS NOT NULL), 0))::numeric, 3) AS avg_pf,
                    ROUND(MIN(v.voltage_a_min)::numeric, 1) AS min_v,
                    ROUND(MAX(v.voltage_a_max)::numeric, 1) AS max_v,
                    ROUND((SUM(v.voltage_a_avg * v.n) / NULLIF(SUM(v.n) FILTER (WHERE v.voltage_a_avg IS NOT NULL), 0))::numeric, 1) AS avg_v,
                    ROUND((SUM(v.thd_voltage_a_avg * v.n) / NULLIF(SUM(v.n) FILTER (WHERE v.thd_voltage_a_avg IS NOT NULL), 0))::numeric, 2) AS avg_thd,
                    ROUND(MAX(v.thd_voltage_a_max)::numeric, 2) AS max_thd_reading,
                    ROUND(SUM(v.power_active_total_avg * v.minutes / 60.0)::numeric, 1) AS est_kwh_7d
                FROM readings_1h v
                JOIN meters m ON v.meter_id = m.id
                JOIN sites s ON m.site_id = s.id
                WHERE v.bucket >= NOW() - INTERVAL '7 days' ${historyTenant}
                GROUP BY v.meter_id, m.name
                ORDER BY max_kw DESC NULLS LAST LIMIT 10
            `;
            historyResult = await client.query(historyQuery, historyParams);
        } catch (histErr) {
            console.error('History query error (non-fatal):', histErr);
        }

        if (historyResult.rows.length > 0) {
            contextString += `\n7-DAY HISTORICAL SUMMARY (last 7 days):\n`;
            historyResult.rows.forEach((h: any) => {
                contextString += `• ${h.meter_name}: ${h.reading_count} readings | P: min ${h.min_kw} / avg ${h.avg_kw} / max ${h.max_kw} kW (max here is instantaneous, not billed demand) | Est. Energy: ${h.est_kwh_7d || 'N/A'} kWh`;
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
app.delete('/meters/:id', authenticateToken, meterParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        // Archive, never delete: the meter stops ingesting and leaves the lists;
        // its readings, reports and alerts are kept. An admin can restore it.
        const r = await client.query(
            `UPDATE meters SET archived_at = NOW(), is_active = false WHERE id = $1 AND archived_at IS NULL RETURNING id`, [id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Meter not found or already archived' });
        res.json({ success: true, message: 'Meter archived. It no longer receives readings; its data is kept and an admin can restore it.' });
    } catch (err) {
        console.error('Archive meter error:', err);
        res.status(500).json({ error: 'Failed to archive meter' });
    } finally {
        client.release();
    }
});

// Restore an archived meter or site (client_admin of the tenant, or internal users).
app.post('/meters/:id/restore', authenticateToken, async (req: any, res) => {
    if (!canWrite(req.scope)) return res.status(403).json({ error: 'Only an admin can restore a meter' });
    try {
        const params: any[] = [req.params.id];
        const r = await pool.query(`
            UPDATE meters m SET archived_at = NULL, is_active = true
            FROM sites s
            WHERE m.id = $1 AND m.site_id = s.id AND m.archived_at IS NOT NULL
              AND s.archived_at IS NULL AND ${tenantSql(req.scope, 's.tenant_id', params)}
            RETURNING m.id`, params);
        if (r.rows.length === 0) return res.status(404).json({ error: 'No archived meter with that id (restore its site first if the site is archived)' });
        res.json({ success: true, message: 'Meter restored; it receives readings again.' });
    } catch (err) {
        console.error('Restore meter error:', err);
        res.status(500).json({ error: 'Failed to restore meter' });
    }
});

app.post('/sites/:id/restore', authenticateToken, async (req: any, res) => {
    if (!canWrite(req.scope)) return res.status(403).json({ error: 'Only an admin can restore a site' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const params: any[] = [req.params.id];
        const before = await client.query(
            `SELECT archived_at FROM sites WHERE id = $1 AND archived_at IS NOT NULL
               AND ${tenantSql(req.scope, 'tenant_id', params)} FOR UPDATE`, params);
        if (before.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'No archived site with that id' });
        }
        await client.query(`UPDATE sites SET archived_at = NULL WHERE id = $1`, [req.params.id]);
        // Bring back the meters archived together with the site, not ones
        // archived individually before it.
        const m = await client.query(
            `UPDATE meters SET archived_at = NULL, is_active = true WHERE site_id = $1 AND archived_at = $2 RETURNING id`,
            [req.params.id, before.rows[0].archived_at]);
        await client.query('COMMIT');
        res.json({ success: true, message: `Site restored with ${m.rows.length} meter(s).` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Restore site error:', err);
        res.status(500).json({ error: 'Failed to restore site' });
    } finally {
        client.release();
    }
});

// Update meter load profile (what the meter actually measures —
// powers the AI recommendations so it stops guessing what loads exist)
app.patch('/meters/:id/profile', authenticateToken, meterParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    const { load_types, load_description, site_type, name } = req.body;
    const client = await pool.connect();
    try {
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
app.patch('/meters/:id/active', authenticateToken, meterParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
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

// CSV imports are staged in UPLOAD_DIR and deleted once processed.
const UPLOAD_DIR = uploadDir();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR });

// Secure endpoint: Get Readings for a specific Meter (verified access).
// When a date range is provided, server-side time_bucket aggregation keeps
// chart payloads to ~300-700 points regardless of how long the window is.
app.get('/meters/:id/readings', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const limit = parseInt(String(req.query.limit || '500'));
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const raw = req.query.raw === '1' || req.query.raw === 'true';

    const client = await pool.connect();
    try {

        // Bucketed path (typical chart use), unless the caller asked for raw rows.
        // About 300–700 points from the coarsest continuous aggregate that fits
        // the range (raw data only for ranges ≤ 2 h); same columns as before.
        if (from && !raw) {
            const fromDate = new Date(from);
            const toDate   = to ? new Date(to) : new Date();
            const plan     = planRead(fromDate, toDate);
            const result = await client.query(meterSeriesSql(plan.source), [plan.bucket, id, fromDate, toDate]);
            res.setHeader('X-Readings-Source', `${plan.source}; bucket=${plan.bucket}`);
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

// ── Aggregate readings across ALL active meters for the tenant (overview chart) ─
// GET /readings/aggregate?from=ISO  → returns per-bucket SITE TOTAL power
app.get('/readings/aggregate', authenticateToken, async (req: any, res) => {
    const from = req.query.from as string | undefined;
    const client = await pool.connect();
    try {
        const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const toDate   = new Date();
        const plan     = planRead(fromDate, toDate);

        const params: any[] = [plan.bucket, fromDate];
        const tenantFilter = `AND ${tenantSql(req.scope, 's.tenant_id', params)} AND ${telemetrySql(req.scope, 's')}
                              AND ${exclusiveDeviceSql(req.scope, 'm', params)}`;
        // Per-meter average within each bucket, then SUM across meters →
        // gives true site-total power even if meters report at different rates.
        const result = await client.query(tenantPowerSql(plan.source, tenantFilter), params);
        res.setHeader('X-Readings-Source', `${plan.source}; bucket=${plan.bucket}`);
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
app.get('/meters/:id/compliance', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.query.days || '7')), 1), 90);

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

        // Restates the same findings in insurer/broker categories. Additive only —
        // it introduces no new judgement, so a failure here must not lose the report.
        let risk_profile = null;
        try {
            risk_profile = await buildRiskProfile(pool, report);
        } catch (e: any) {
            console.error('Risk profile build failed:', e.message || e);
        }

        res.json({ ...report, risk_profile });
    } catch (err) {
        console.error('Compliance assessment error:', err);
        res.status(500).json({ error: 'Assessment failed' });
    }
});

// AI executive summary for an assessment — plain-language interpretation of the
// measured findings. Cached against the latest snapshot.
app.get('/meters/:id/compliance/summary', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.query.days || '7')), 1), 90);

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
app.post('/meters/:id/compliance/ask', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.body?.days || '7')), 1), 90);
    const question = String(req.body?.question || '').slice(0, 1000).trim();
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];

    if (!question) return res.status(400).json({ error: 'Question required' });

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
app.get('/meters/:id/forecast', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const weeks = Math.min(Math.max(parseInt(String(req.query.weeks || '12')), 4), 52);

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
app.get('/meters/:id/compliance/history', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(String(req.query.limit || '52')), 200);

    const client = await pool.connect();
    try {
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
// ── Maximum demand, on the basis the utility actually bills ──────────────────
// GET /meters/:id/demand?days=30[&interval=30]
app.get('/meters/:id/demand', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.query.days || '30')), 1), 365);

    const client = await pool.connect();
    let intervalMin = DEFAULT_DEMAND_INTERVAL_MIN;
    try {
        const own = await client.query(`
            SELECT m.id, ss.demand_interval_min, ss.contracted_mdi_kva, ss.tariff_demand
            FROM meters m
            JOIN sites s ON m.site_id = s.id
            LEFT JOIN site_settings ss ON s.id = ss.site_id
            WHERE m.id = $1
        `, [id]);

        if (own.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });

        const cfg = own.rows[0];
        // Query override wins, then the site's configured tariff window, then Eskom's 30 min.
        const requested = parseInt(String(req.query.interval || ''), 10);
        intervalMin = [5, 10, 15, 30, 60].includes(requested) ? requested
            : Number(cfg.demand_interval_min) || DEFAULT_DEMAND_INTERVAL_MIN;

        const to = new Date();
        const from = new Date(to.getTime() - days * 86_400_000);
        const result = await maxDemand(pool, id, from, to, intervalMin);

        const contracted = cfg.contracted_mdi_kva === null || cfg.contracted_mdi_kva === undefined
            ? null : Number(cfg.contracted_mdi_kva);
        const tariffDemand = cfg.tariff_demand === null || cfg.tariff_demand === undefined
            ? null : Number(cfg.tariff_demand);

        res.json({
            ...result,
            contracted_mdi_kva: contracted,
            utilisation_pct: contracted && result.max_kva ? (result.max_kva / contracted) * 100 : null,
            // Only stated where a demand rate is actually configured — an
            // invented rate would produce a number the client cannot reconcile.
            estimated_demand_charge_zar:
                tariffDemand !== null && result.max_kva !== null
                    ? Math.round(result.max_kva * tariffDemand)
                    : null,
        });
    } catch (err) {
        console.error('Max demand error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Broker portfolio — read across a granted book of clients.
//
// Every route here resolves the caller's grants first and confines the query to
// that list. Nothing below relaxes a filter on an existing endpoint: a broker
// reaching client data does so exclusively through these routes.
// ─────────────────────────────────────────────────────────────────────────────

/** Tenant ids this caller may read. Empty array = broker with no grants. */
async function grantedTenantIds(client: any, user: any): Promise<string[]> {
    const q = await client.query(
        `SELECT tenant_id FROM broker_client_access
         WHERE broker_user_id = $1 AND revoked_at IS NULL`,
        [user.userId]
    );
    return q.rows.map((r: any) => r.tenant_id);
}

/** Brokers only. super_admin is the platform operator, not a broker. Off unless FEATURE_BROKER. */
function requireBroker(req: any, res: any): boolean {
    if (!BROKER_ENABLED) {
        res.status(404).json({ error: 'Not found' });
        return false;
    }
    if (req.user?.role !== 'broker') {
        res.status(403).json({ error: 'Forbidden' });
        return false;
    }
    return true;
}

// Portfolio overview: one row per client, ordered by what needs attention.
app.get('/broker/clients', authenticateToken, async (req: any, res) => {
    if (!requireBroker(req, res)) return;

    const client = await pool.connect();
    try {
        const tenants = await grantedTenantIds(client, req.user);
        if (tenants.length === 0) return res.json([]);

        const result = await client.query(`
            WITH latest AS (
                -- Most recent assessment per meter; older snapshots are history.
                SELECT DISTINCT ON (a.meter_id)
                       a.meter_id, a.tenant_id, a.assessed_at, a.verdict,
                       a.supply_score, a.install_score,
                       COALESCE(jsonb_array_length(a.risks), 0)     AS risk_count,
                       COALESCE(jsonb_array_length(a.degrading), 0) AS degrading_count
                FROM pq_assessments a
                WHERE a.tenant_id = ANY($1::uuid[])
                ORDER BY a.meter_id, a.assessed_at DESC
            )
            SELECT
                t.id   AS tenant_id,
                t.name AS client_name,
                t.renewal_date,
                (t.renewal_date - CURRENT_DATE) AS renewal_days_out,
                (SELECT COUNT(*) FROM sites s WHERE s.tenant_id = t.id)::int AS site_count,
                (SELECT COUNT(*) FROM meters m JOIN sites s ON m.site_id = s.id
                  WHERE s.tenant_id = t.id AND m.is_active)::int             AS meter_count,
                -- A site that has gone quiet is itself a finding worth surfacing.
                (SELECT MAX(mr.time) FROM meter_readings mr
                   JOIN meters m ON mr.meter_id = m.id
                   JOIN sites  s ON m.site_id = s.id
                  WHERE s.tenant_id = t.id
                    AND mr.time > NOW() - INTERVAL '30 days')                AS last_reading,
                l.assessed_meters, l.min_supply, l.min_install,
                l.open_findings, l.degrading_params, l.last_assessed, l.worst_rank
            FROM tenants t
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int                  AS assessed_meters,
                       MIN(supply_score)::int         AS min_supply,
                       MIN(install_score)::int        AS min_install,
                       SUM(risk_count)::int           AS open_findings,
                       SUM(degrading_count)::int      AS degrading_params,
                       MAX(assessed_at)               AS last_assessed,
                       MIN(CASE verdict
                             WHEN 'NON_COMPLIANT'       THEN 1
                             WHEN 'COMPLIANT_WITH_RISK' THEN 2
                             WHEN 'COMPLIANT'           THEN 3
                             ELSE 4 END)::int         AS worst_rank
                FROM latest WHERE latest.tenant_id = t.id
            ) l ON true
            WHERE t.id = ANY($1::uuid[])
            -- Worst verdict first, then most deterioration, then weakest
            -- installation: a portfolio screen is a triage queue, not a directory.
            ORDER BY COALESCE(l.worst_rank, 4) ASC,
                     COALESCE(l.degrading_params, 0) DESC,
                     COALESCE(l.min_install, 100) ASC,
                     t.name ASC
        `, [tenants]);

        res.json(result.rows);
    } catch (err) {
        console.error('Broker portfolio error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Drill-down into one client. The grant check is repeated here deliberately —
// an authorisation that lives in only one place is one refactor from being lost.
app.get('/broker/clients/:tenantId/meters', authenticateToken, async (req: any, res) => {
    if (!requireBroker(req, res)) return;

    const client = await pool.connect();
    try {
        const tenants = await grantedTenantIds(client, req.user);
        if (!tenants.includes(req.params.tenantId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const result = await client.query(`
            SELECT DISTINCT ON (m.id)
                   m.id AS meter_id, m.name AS meter_name,
                   s.id AS site_id,  s.name AS site_name,
                   a.assessed_at, a.verdict, a.supply_score, a.install_score,
                   COALESCE(jsonb_array_length(a.risks), 0) AS open_findings
            FROM meters m
            JOIN sites s ON m.site_id = s.id
            LEFT JOIN pq_assessments a ON a.meter_id = m.id
            WHERE s.tenant_id = $1 AND m.is_active
            ORDER BY m.id, a.assessed_at DESC NULLS LAST
        `, [req.params.tenantId]);

        res.json(result.rows);
    } catch (err) {
        console.error('Broker client drill-down error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Set or clear a client's insurance renewal date. The broker knows this date —
// it comes off the policy schedule, not from anything the platform can measure.
app.put('/broker/clients/:tenantId/renewal', authenticateToken, async (req: any, res) => {
    if (!requireBroker(req, res)) return;

    const raw = req.body?.renewal_date;
    // Explicit null clears the date; anything else must be a real calendar date.
    if (raw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw ?? ''))) {
        return res.status(400).json({ error: 'renewal_date must be YYYY-MM-DD, or null to clear' });
    }
    if (raw !== null && isNaN(new Date(raw).getTime())) {
        return res.status(400).json({ error: 'renewal_date is not a valid date' });
    }

    const client = await pool.connect();
    try {
        const tenants = await grantedTenantIds(client, req.user);
        if (!tenants.includes(req.params.tenantId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const result = await client.query(
            `UPDATE tenants SET renewal_date = $2 WHERE id = $1 RETURNING id, name, renewal_date`,
            [req.params.tenantId, raw ?? null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Set renewal date error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Upcoming renewals across the book, soonest first, with the latest review.
app.get('/broker/renewals', authenticateToken, async (req: any, res) => {
    if (!requireBroker(req, res)) return;

    const client = await pool.connect();
    try {
        const tenants = await grantedTenantIds(client, req.user);
        if (tenants.length === 0) return res.json([]);

        const result = await client.query(`
            SELECT t.id AS tenant_id, t.name AS client_name, t.renewal_date,
                   (t.renewal_date - CURRENT_DATE) AS days_out,
                   r.days_before, r.generated_at, r.summary
            FROM tenants t
            LEFT JOIN LATERAL (
                SELECT days_before, generated_at, summary
                FROM renewal_reviews rr
                WHERE rr.tenant_id = t.id AND rr.renewal_date = t.renewal_date
                ORDER BY days_before ASC     -- the most recent milestone reached
                LIMIT 1
            ) r ON true
            WHERE t.id = ANY($1::uuid[]) AND t.renewal_date IS NOT NULL
            ORDER BY t.renewal_date ASC
        `, [tenants]);

        res.json(result.rows);
    } catch (err) {
        console.error('Broker renewals error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Generate a review on demand, for a broker who wants the comparison now rather
// than waiting for the next milestone. Not persisted — the sweep owns the record.
app.get('/broker/clients/:tenantId/renewal-review', authenticateToken, async (req: any, res) => {
    if (!requireBroker(req, res)) return;

    const client = await pool.connect();
    try {
        const tenants = await grantedTenantIds(client, req.user);
        if (!tenants.includes(req.params.tenantId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const t = await client.query(`SELECT renewal_date FROM tenants WHERE id = $1`, [req.params.tenantId]);
        const date = t.rows[0]?.renewal_date
            ? new Date(t.rows[0].renewal_date).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10);   // no date set: compare to today

        const review = await buildRenewalReview(pool, req.params.tenantId, date);
        if (!review) return res.status(404).json({ error: 'Not found' });
        res.json(review);
    } catch (err) {
        console.error('Renewal review error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ── Grant administration (platform operator only) ────────────────────────────
app.get('/admin/broker-access', authenticateToken, async (req: any, res) => {
    if (!BROKER_ENABLED) return res.status(404).json({ error: 'Not found' });
    if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT b.id, b.broker_user_id, u.email AS broker_email,
                   b.tenant_id, t.name AS client_name,
                   b.label, b.granted_at, b.revoked_at
            FROM broker_client_access b
            JOIN users   u ON b.broker_user_id = u.id
            JOIN tenants t ON b.tenant_id = t.id
            ORDER BY b.revoked_at NULLS FIRST, b.granted_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Broker access list error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.post('/admin/broker-access', authenticateToken, async (req: any, res) => {
    if (!BROKER_ENABLED) return res.status(404).json({ error: 'Not found' });
    if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    const { broker_user_id, tenant_id, label } = req.body || {};
    if (!broker_user_id || !tenant_id) {
        return res.status(400).json({ error: 'broker_user_id and tenant_id are required' });
    }

    const client = await pool.connect();
    try {
        // Only a user actually marked as a broker can hold client grants.
        const u = await client.query(`SELECT role FROM users WHERE id = $1`, [broker_user_id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        if (u.rows[0].role !== 'broker') {
            return res.status(400).json({ error: "User's role must be 'broker' before granting client access" });
        }

        const result = await client.query(`
            INSERT INTO broker_client_access (broker_user_id, tenant_id, label, granted_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (broker_user_id, tenant_id)
            DO UPDATE SET revoked_at = NULL,
                          label      = COALESCE(EXCLUDED.label, broker_client_access.label),
                          granted_at = NOW(),
                          granted_by = EXCLUDED.granted_by
            RETURNING id, broker_user_id, tenant_id, label, granted_at
        `, [broker_user_id, tenant_id, label ?? null, req.user.userId ?? null]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Broker access grant error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.delete('/admin/broker-access/:id', authenticateToken, async (req: any, res) => {
    if (!BROKER_ENABLED) return res.status(404).json({ error: 'Not found' });
    if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE broker_client_access SET revoked_at = NOW()
             WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ revoked: true });
    } catch (err) {
        console.error('Broker access revoke error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-only report sharing.
//
// The owner issues a time-limited link; anyone holding it can read that one
// report and nothing else. This exists because the report is most valuable when
// it leaves the building — to a broker, an underwriter, a landlord, a head
// office — and asking those people to create an account kills that entirely.
//
// Security posture:
//   · 256-bit token, generated server-side, shown to the issuer exactly once
//   · only the SHA-256 of the token is persisted
//   · expiry and revocation enforced on every read
//   · scope is one meter, read-only; no tenant, site list or account data leaks
//   · every view is logged with IP and user agent
// ─────────────────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Issue a share link for a PUBLISHED report of this meter's project (Phase 7:
// unreviewed content never leaves through a link). The raw token is returned
// once and never stored.
app.post('/meters/:id/shares', authenticateToken, meterParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    // JWT signs this as `userId`, not `id` — reading `id` left created_by null.
    const { userId } = req.user;

    const daysValid  = Math.min(Math.max(parseInt(String(req.body?.days_valid  ?? 30)), 1), 365);
    const label      = String(req.body?.label ?? '').slice(0, 200).trim() || null;
    const owned = req.meter;

    const reportId = String(req.body?.report_id ?? '');
    const published = /^[0-9a-f-]{36}$/i.test(reportId)
        ? (await pool.query(
            `SELECT id, period_start, period_end FROM reports WHERE id = $1 AND project_id = $2 AND status = 'published'`,
            [reportId, owned.site_id])).rows[0]
        : null;
    if (!published) {
        return res.status(400).json({ error: 'report_id must be a published report of this meter\'s project. Share links only carry reviewed reports.' });
    }
    const periodDays = Math.max(1, Math.ceil((new Date(published.period_end).getTime() - new Date(published.period_start).getTime()) / 86_400_000));

    const token = randomBytes(32).toString('base64url');

    const client = await pool.connect();
    try {
        const result = await client.query(`
            INSERT INTO report_shares
                (tenant_id, site_id, meter_id, token_hash, label, period_days, expires_at, created_by, report_id)
            VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::INTERVAL, $8, $9)
            RETURNING id, expires_at, created_at
        `, [owned.tenant_id, owned.site_id, id, sha256(token), label, periodDays, daysValid, userId ?? null, published.id]);

        const row = result.rows[0];
        res.status(201).json({
            id: row.id,
            token,                              // shown once — not recoverable later
            path: `/report/${token}`,
            expires_at: row.expires_at,
            created_at: row.created_at,
            label,
            period_days: periodDays,
            report_id: published.id,
        });
    } catch (err) {
        console.error('Share creation error:', err);
        res.status(500).json({ error: 'Could not create share link' });
    } finally {
        client.release();
    }
});

// List share links for a meter. Never returns tokens — they are unrecoverable.
app.get('/meters/:id/shares', authenticateToken, meterParam(pool), async (req: any, res) => {
    const { id } = req.params;

    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT id, label, period_days, expires_at, revoked_at, report_id,
                   view_count, last_viewed_at, created_at,
                   (revoked_at IS NULL AND expires_at > NOW()) AS is_live
            FROM report_shares
            WHERE meter_id = $1
            ORDER BY created_at DESC
            LIMIT 50
        `, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Share list error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Revoke a share link immediately.
app.delete('/shares/:shareId', authenticateToken, requireWrite, async (req: any, res) => {
    const { shareId } = req.params;

    const client = await pool.connect();
    try {
        if (!await findOwned(client, req.scope, 'report_shares', shareId)) return res.status(404).json({ error: 'Not found' });
        const result = await client.query(
            `UPDATE report_shares SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [shareId]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ revoked: true });
    } catch (err) {
        console.error('Share revoke error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ── Public report read — NO AUTHENTICATION ───────────────────────────────────
// The only unauthenticated data route in the service. Treat every change here
// as security-sensitive: it must return one report and expose nothing else.

// Assessments are DB-heavy, so the public path gets its own limiter regardless
// of the gateway's global allowance. In-memory is adequate for a single
// instance; move to Redis if this ever runs multi-node.
const publicHits = new Map<string, { count: number; resetAt: number }>();
function publicRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = publicHits.get(ip);
    if (!entry || now > entry.resetAt) {
        publicHits.set(ip, { count: 1, resetAt: now + 60_000 });
        if (publicHits.size > 5_000) {            // bound memory
            for (const [k, v] of publicHits) if (now > v.resetAt) publicHits.delete(k);
        }
        return false;
    }
    entry.count += 1;
    return entry.count > 30;                       // 30 views/minute/IP
}

/** Share links act like a key on their project: delivery rules, no user grant. */
const LINK_SCOPE = { ...buildScope({ role: 'client_viewer', tenantId: null }), apiKey: { id: 'share-link', scopes: [], projectIds: null } };

app.get('/public/report/:token', async (req: any, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
        .split(',')[0].trim();

    if (publicRateLimited(ip)) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    const token = String(req.params.token || '');
    // Cheap shape check before touching the database.
    if (!token || token.length < 20 || token.length > 200) {
        return res.status(404).json({ error: 'not_found' });
    }

    const client = await pool.connect();
    let share: any;
    try {
        const q = await client.query(`
            SELECT s.id, s.meter_id, s.period_days, s.expires_at, s.revoked_at,
                   r.status AS report_status, r.period_start, r.period_end,
                   ${deliverySql(LINK_SCOPE, 'pj')} AS deliverable,
                   t.brand_name, t.brand_logo_url, t.brand_footer
            FROM report_shares s
            LEFT JOIN reports r ON r.id = s.report_id
            LEFT JOIN tenants t ON s.tenant_id = t.id
            LEFT JOIN projects pj ON pj.id = s.site_id
            WHERE s.token_hash = $1
        `, [sha256(token)]);
        share = q.rows[0];
    } catch (err) {
        console.error('Public report lookup error:', err);
        return res.status(500).json({ error: 'server_error' });
    } finally {
        client.release();
    }

    if (!share)             return res.status(404).json({ error: 'not_found' });
    if (share.revoked_at)   return res.status(410).json({ error: 'revoked' });
    if (new Date(share.expires_at) < new Date()) {
        return res.status(410).json({ error: 'expired', expires_at: share.expires_at });
    }
    // Phase 7: a link serves only a report an internal user has published.
    if (share.report_status !== 'published') return res.status(410).json({ error: 'not_published' });
    // GridIQ assessments: a link works only while the project's assessment is
    // live or within its final-delivery window.
    if (!share.deliverable) return res.status(410).json({ error: 'assessment_ended' });

    try {
        // The published report's own period, not "the last N days".
        const report = await assessPowerQuality(pool, share.meter_id, share.period_days, new Date(share.period_end));
        if (!report) return res.status(404).json({ error: 'not_found' });

        let risk_profile = null;
        try { risk_profile = await buildRiskProfile(pool, report); }
        catch (e: any) { console.error('Public risk profile failed:', e.message || e); }

        // Best-effort extras — a shared report must still render without them.
        // The summary is read from cache only and never generated here: this
        // route is unauthenticated, so it must not be a route to billable
        // model calls. If the owner has not yet viewed the report, the shared
        // copy simply omits the summary; the engineering stands on its own.
        const [summary, forecast] = await Promise.all([
            getCachedExecutiveSummary(pool, share.meter_id).catch(() => null),
            forecastDegradation(pool, share.meter_id, 12).catch(() => null),
        ]);

        // Record the view. Never let logging failure block the reader.
        pool.connect().then(async c => {
            try {
                await c.query(
                    `UPDATE report_shares
                     SET view_count = view_count + 1, last_viewed_at = NOW()
                     WHERE id = $1`, [share.id]);
                await c.query(
                    `INSERT INTO report_share_access (share_id, ip_address, user_agent)
                     VALUES ($1, $2, $3)`,
                    [share.id, ip || null, String(req.headers['user-agent'] || '').slice(0, 500)]);
            } catch (e: any) {
                console.error('Share access log failed:', e.message || e);
            } finally { c.release(); }
        }).catch(() => { /* pool exhausted — reader is unaffected */ });

        res.json({
            report: { ...report, risk_profile },
            summary,
            forecast,
            branding: {
                brand_name:     share.brand_name,
                brand_logo_url: share.brand_logo_url,
                brand_footer:   share.brand_footer,
            },
            share: { expires_at: share.expires_at },
        });
    } catch (err) {
        console.error('Public report error:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

app.get('/value-ledger', authenticateToken, async (req: any, res) => {
    const sc = req.scope;
    const client = await pool.connect();
    try {
        const params: any[] = [];
        const where = `WHERE ${tenantSql(sc, 's.tenant_id', params)} AND ${telemetrySql(sc, 's')}`;

        // Monitoring effort: how much data has actually been examined.
        // From readings_1d (n = raw readings per day): a COUNT(*) over every raw
        // reading would scan the whole hypertable (86,400 rows per meter per day at 1 Hz).
        const coverage = await client.query(`
            SELECT COALESCE(SUM(v.n), 0)::bigint AS readings,
                   MIN(v.t_first) AS since,
                   COUNT(DISTINCT v.meter_id) AS meters
            FROM readings_1d v
            JOIN meters m ON v.meter_id = m.id
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
            WHERE ${tenantSql(sc, 'a.tenant_id', params)}
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

app.put('/branding', authenticateToken, requireWrite, async (req: any, res) => {
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
app.get('/meters/:id/monthly', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const months = Math.min(parseInt(String(req.query.months || '6')), 24);

    const client = await pool.connect();
    try {

        // Energy per month from the import register (deltas per hour, summed;
        // a negative delta is a register reset and is never summed through).
        // Hours without a register fall back to power integration: each
        // 1-minute average × the time to the next minute with data, capped at
        // 900 s so an offline stretch is not billed as continuous power. See
        // src/energy.ts. Each month says which method it used.
        const since = await client.query(
            `SELECT DATE_TRUNC('month', NOW() - ($1 || ' months')::INTERVAL) AS start`, [months - 1]);
        const start: Date = since.rows[0].start;
        const hours = await loadEnergyHours(client, id, start);
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const result = {
            rows: periodEnergy(hours, monthKey).map((p) => {
                const [y, m] = p.period.split('-').map(Number);
                return {
                    month: MONTHS[m - 1],
                    month_start: new Date(Date.UTC(y, m - 1, 1)),
                    kwh: Math.round(p.kwh),
                    method: p.method,
                    data_quality: p.data_quality,
                };
            }),
        };

        res.json(result.rows);
    } catch (err) {
        console.error('Monthly readings error:', err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// ── Energy by time-of-use band, per local day (analytics page) ──────────────
// GET /meters/:id/energy/tou?days=7
// From the import register (power-integration fallback where the meter has no
// register), the same source as /monthly, so every kWh figure agrees.
app.get('/meters/:id/energy/tou', authenticateToken, meterParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(String(req.query.days || '7')), 1), 31);
    const client = await pool.connect();
    try {
        const own = await client.query(`
            SELECT s.timezone FROM meters m JOIN sites s ON m.site_id = s.id WHERE m.id = $1`, [id]);
        if (own.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // sites.timezone defaults to 'UTC' in the schema; the tariff bands are
        // South African local time unless a site says otherwise.
        const tz = own.rows[0].timezone && own.rows[0].timezone !== 'UTC' ? own.rows[0].timezone : 'Africa/Johannesburg';

        const since = new Date(Date.now() - days * 86_400_000);
        const hours = await loadEnergyHours(client, id, since);
        const periods = periodEnergy(hours, (h) => {
            const { date, hour } = localDateHour(h, tz);
            return `${date}|${touBand(hour)}`;
        });
        const byDay = new Map<string, { date: string; peak: number; standard: number; offpeak: number }>();
        const total = { peak: 0, standard: 0, offpeak: 0 };
        const quality = { register_resets: 0, implausible_jumps: 0, register_hours: 0, power_hours: 0 };
        for (const p of periods) {
            const [date, band] = p.period.split('|') as [string, 'peak' | 'standard' | 'offpeak'];
            const d = byDay.get(date) ?? { date, peak: 0, standard: 0, offpeak: 0 };
            d[band] = Math.round((d[band] + p.kwh) * 10) / 10;
            byDay.set(date, d);
            total[band] = Math.round((total[band] + p.kwh) * 10) / 10;
            for (const k of Object.keys(quality) as Array<keyof typeof quality>) quality[k] += p.data_quality[k];
        }
        res.json({
            meter_id: id, days, timezone: tz,
            method: combinedMethod(periods.map((p) => p.method)),
            total_kwh: total,
            by_day: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
            data_quality: quality,
        });
    } catch (err) {
        console.error('TOU energy error:', err);
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
/**
 * TimescaleDB does not enforce unique indexes against COMPRESSED chunks, so an
 * INSERT ... ON CONFLICT DO NOTHING aimed at one silently writes a DUPLICATE
 * rather than skipping it. Duplicated readings would corrupt every average,
 * percentile and energy integration over the affected period — silently, and
 * in a way no error would reveal.
 *
 * Live MQTT ingestion is protected structurally: the compression policy starts
 * beyond the backfill window in mqtt.ts, so it can never target a compressed
 * chunk. CSV import carries data of arbitrary age, so it has to decompress
 * whatever it is about to write into. The background policy re-compresses those
 * chunks on its next run, so this costs nothing lasting.
 */
async function ensureRangeWritable(client: any, from: Date, to: Date): Promise<number> {
    const q = await client.query(`
        SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
        FROM timescaledb_information.chunks
        WHERE hypertable_name = 'meter_readings'
          AND is_compressed
          AND range_start < $2 AND range_end > $1
    `, [from, to]);

    for (const row of q.rows) {
        // Must run outside a transaction block, hence before BEGIN at the call site.
        await client.query(`SELECT decompress_chunk($1::regclass, if_compressed => true)`, [row.chunk]);
    }
    return q.rows.length;
}

app.post('/upload', authenticateToken, upload.single('file') as any, async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const meterId = req.body.meter_id;
    if (!meterId) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'meter_id is required' }); }

    const client = await pool.connect();

    try {
        if (!canWrite(req.scope) || !await findMeter(client, req.scope, meterId)) {
            fs.unlinkSync(req.file.path); client.release();
            return res.status(403).json({ error: 'Forbidden' });
        }

        const results: any[] = [];
        fs.createReadStream(req.file.path)
            .pipe(csv())
            .on('data', (row) => results.push(row))
            .on('end', async () => {
                fs.unlinkSync(req.file.path);
                let inserted = 0;
                let skipped = 0;
                let duplicates = 0;
                try {
                    // Any chunk this import touches must be writable before the
                    // insert loop starts, or ON CONFLICT silently duplicates.
                    const times = results
                        .map(raw => mapRow(raw).time)
                        .filter(Boolean)
                        .map((t: any) => new Date(t))
                        .filter((d: Date) => !isNaN(d.getTime()));
                    if (times.length > 0) {
                        const from = new Date(Math.min(...times.map(d => d.getTime())));
                        const to   = new Date(Math.max(...times.map(d => d.getTime())) + 1);
                        const n = await ensureRangeWritable(client, from, to);
                        if (n > 0) {
                            console.log(`[import] decompressed ${n} chunk(s) spanning ${from.toISOString()}..${to.toISOString()}`);
                        }
                    }

                    await client.query('BEGIN');
                    for (const raw of results) {
                        const r = mapRow(raw);
                        if (!r.time) { skipped++; continue; }
                        // time_source 'IMPORT': the timestamp came from the uploaded
                        // file, not from a meter clock or arrival time.
                        const ins = await client.query(`
                            INSERT INTO meter_readings (
                                time, meter_id,
                                power_active_total, power_reactive_total, power_apparent_total,
                                power_factor_total, voltage_a, current_a, thd_voltage_a, energy_import_total,
                                time_source
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IMPORT')
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
                        // A row whose (meter, time) already exists is skipped by
                        // ON CONFLICT and must not be reported as imported.
                        if (ins.rowCount === 1) inserted++; else duplicates++;
                    }
                    // Attribute imported history older than the device's first deployment to it.
                    if (times.length > 0) await extendFirstDeployment(client, meterId, new Date(Math.min(...times.map(d => d.getTime()))));
                    await client.query('COMMIT');
                    res.json({
                        success: true, count: inserted, skipped, duplicates, total: results.length,
                        message: `Successfully imported ${inserted} rows`
                            + (duplicates ? `; ${duplicates} already existed and were left unchanged` : '')
                            + (skipped ? `; ${skipped} had no readable timestamp` : '') + '.',
                    });
                    // Imported history may be older than the aggregates' refresh
                    // window; materialise the imported range so charts, demand and
                    // energy see it. In the background: the import is already committed.
                    if (times.length > 0) {
                        // Day-aligned: a refresh window covers whole buckets only.
                        const first = new Date(Math.floor(Math.min(...times.map(d => d.getTime())) / 86_400_000) * 86_400_000);
                        // Widened by a day so the 1-day bucket holding the last row is complete.
                        const last  = new Date(Math.max(...times.map(d => d.getTime())) + 86_400_000);
                        refreshAggregates(pool, first, last)
                            .then(() => console.log(`[import] aggregates refreshed for ${first.toISOString()}..${last.toISOString()}`))
                            .catch((e) => console.error('[import] aggregate refresh failed:', e?.message || e));
                    }
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
app.get('/sites/:id/score', authenticateToken, siteParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
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
app.post('/sites/:id/score/calculate', authenticateToken, siteParam(pool, { telemetry: true }), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
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
        // A score is derived from telemetry: not for projects that hide live data.
        query += ` WHERE ${tenantSql(req.scope, 's.tenant_id', params)} AND ${telemetrySql(req.scope, 's')}`;
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
app.get('/sites/:id/recommendations', authenticateToken, siteParam(pool), async (req: any, res) => {
    try {
        const recs = await getSiteRecommendations(pool, req.params.id, seesUnpublishedFindings(req.scope));
        res.json(recs.map((r) => forClient(req.scope, r)));
    } catch (err) {
        res.status(500).json({ error: 'Error fetching recommendations' });
    }
});

// GET /recommendations — all recommendations for the tenant
app.get('/recommendations', authenticateToken, async (req: any, res) => {
    try {
        const recs = await getTenantRecommendations(pool, req.scope.filterTenantId, seesUnpublishedFindings(req.scope));
        res.json(recs.map((r) => forClient(req.scope, r)));
    } catch (err) {
        res.status(500).json({ error: 'Error fetching recommendations' });
    }
});

// POST /sites/:id/recommendations/generate — site-wide AI analysis
app.post('/sites/:id/recommendations/generate', authenticateToken, siteParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    try {
        const site = req.site;

        // Compute fresh score first
        const score = await computeAndStoreSiteScore(pool, id);
        if (!score) return res.status(400).json({ error: 'Insufficient meter data — need at least 3 readings. Check that the meter is connected and sending data.' });

        const recs = await generateAndStoreSiteRecommendations(
            pool, id, site.tenant_id, score, site.name, site.address || ''
        );
        // Drafts: clients see them once an internal user has published them.
        res.json({ generated: recs.length, review_status: 'draft',
                   recommendations: req.scope.isInternal ? recs : [] });
    } catch (err: any) {
        console.error('[API] Recommendation generation error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate recommendations' });
    }
});

// GET /meters/:id/recommendations — active recommendations for a single meter
app.get('/meters/:id/recommendations', authenticateToken, meterParam(pool), async (req: any, res) => {
    try {
        const recs = await getMeterRecommendations(pool, req.params.id, seesUnpublishedFindings(req.scope));
        res.json(recs.map((r) => forClient(req.scope, r)));
    } catch (err) {
        res.status(500).json({ error: 'Error fetching meter recommendations' });
    }
});

// POST /meters/:id/recommendations/generate — AI analysis scoped to one meter
app.post('/meters/:id/recommendations/generate', authenticateToken, meterParam(pool, { write: true }), async (req: any, res) => {
    try {
        const meter = req.meter;

        // Compute fresh score for this meter only (not persisted to energy_scores).
        const score = await computeAndStoreSiteScore(pool, meter.site_id, meter.id);
        if (!score) return res.status(400).json({ error: 'Insufficient meter data — need at least 3 readings for this meter.' });

        const recs = await generateAndStoreSiteRecommendations(
            pool, meter.site_id, meter.tenant_id, score,
            meter.site_name, meter.site_address || '',
            meter.id, meter.name
        );
        res.json({ generated: recs.length, review_status: 'draft',
                   recommendations: req.scope.isInternal ? recs : [], meter: { id: meter.id, name: meter.name } });
    } catch (err: any) {
        console.error('[API] Per-meter recommendation generation error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate per-meter recommendations' });
    }
});

// POST /recommendations/:id/notify — client clicks "Notify Team" → creates a lead
app.post('/recommendations/:id/notify', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        // The recommendation belongs to this tenant and, for a client, is published.
        const rec = await findOwned(client, req.scope, 'recommendations', id,
            seesUnpublishedFindings(req.scope) ? "x.review_status <> 'dismissed'" : "x.review_status = 'published'");
        if (!rec) return res.status(403).json({ error: 'Forbidden' });

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
        query += ` WHERE ${tenantSql(req.scope, 'l.tenant_id', params)}`;
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
app.patch('/leads/:id', authenticateToken, requireWrite, async (req: any, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    const validStatuses = ['NEW', 'IN_REVIEW', 'QUOTED', 'WON', 'LOST'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

    const client = await pool.connect();
    try {
        const params: any[] = [status, notes ?? null, id];
        let query = `UPDATE leads SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
                     WHERE id = $3 AND ${tenantSql(req.scope, 'tenant_id', params)}`;
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
// UPLOAD_DIR/sld-pdfs/<site>.pdf and streamed via auth-protected endpoint.
// TODO: move SLD PDFs to object storage (see the Phase 1 PR).

const SLD_PDF_DIR = path.join(UPLOAD_DIR, 'sld-pdfs');
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


// GET diagram (layout + has-PDF flag)
app.get('/sites/:id/diagram', authenticateToken, siteParam(pool), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
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
app.put('/sites/:id/diagram', authenticateToken, siteParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    const { layout, background_width, background_height } = req.body;
    if (!layout || typeof layout !== 'object' || !Array.isArray(layout.nodes)) {
        return res.status(400).json({ error: 'layout must be { nodes: [], edges: [] }' });
    }
    const client = await pool.connect();
    try {
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
// The site check runs BEFORE multer: the file is written as <site id>.pdf, so
// checking afterwards let any user overwrite (and then delete) another
// tenant's diagram.
app.post('/sites/:id/diagram/pdf', authenticateToken, siteParam(pool, { write: true }), sldUpload.single('pdf') as any, async (req: any, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    const client = await pool.connect();
    try {
        const relPath = toStoredUploadPath(req.file.path, UPLOAD_DIR);
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
app.get('/sites/:id/diagram/pdf', authenticateToken, siteParam(pool), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT background_pdf_path FROM site_diagrams WHERE site_id = $1`,
            [id]
        );
        const relPath = result.rows[0]?.background_pdf_path;
        if (!relPath) return res.status(404).json({ error: 'No PDF uploaded for this site' });
        const absPath = resolveStoredUploadPath(relPath, UPLOAD_DIR);
        if (!absPath || !fs.existsSync(absPath)) return res.status(404).json({ error: 'PDF file missing on disk' });
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
app.delete('/sites/:id/diagram/pdf', authenticateToken, siteParam(pool, { write: true }), async (req: any, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT background_pdf_path FROM site_diagrams WHERE site_id = $1`,
            [id]
        );
        const relPath = result.rows[0]?.background_pdf_path;
        const absPath = relPath ? resolveStoredUploadPath(relPath, UPLOAD_DIR) : null;
        if (absPath) {
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

// Called by startup() once the schema is confirmed current, so nothing is
// served from an outdated database.
function startHttp() {
    if (ROLES.has('api')) {
        app.listen(port, () => {
            console.log(`Ingestion Service API running on port ${port}`);
        });
    } else {
        // ingest/jobs containers: tiny internal /health for the Docker HEALTHCHECK
        startHealthServer(Number(process.env.HEALTH_PORT || 9090), roleHealth);
    }
}

console.log('Ingestion Service started.');
