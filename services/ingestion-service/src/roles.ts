import http from 'http';
import path from 'path';
import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Process roles
//
// One image runs as three containers. ROLES picks which parts start:
//   api    — REST endpoints (app.listen) and the startup schema bootstrap
//   ingest — MQTT → DB only
//   jobs   — every cron.schedule
// Local dev runs all three in one process (the default).
// ─────────────────────────────────────────────────────────────────────────────

export const KNOWN_ROLES = ['api', 'ingest', 'jobs'] as const;
export type Role = typeof KNOWN_ROLES[number];
export const DEFAULT_ROLES = 'api,ingest,jobs';

export function parseRoles(raw: string | undefined): Set<Role> {
    const value = raw === undefined || raw.trim() === '' ? DEFAULT_ROLES : raw;
    const roles = new Set<Role>();
    for (const part of value.split(',')) {
        const r = part.trim().toLowerCase();
        if (r === '') continue;
        if (!(KNOWN_ROLES as readonly string[]).includes(r)) {
            throw new Error(`Unknown role "${part.trim()}" in ROLES. Valid roles: ${KNOWN_ROLES.join(', ')}`);
        }
        roles.add(r as Role);
    }
    if (roles.size === 0) throw new Error('ROLES is empty. Valid roles: ' + KNOWN_ROLES.join(', '));
    return roles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload storage
//
// Uploads live in UPLOAD_DIR (default /data/uploads, a mounted volume). Rows
// written before this change stored paths relative to the service folder
// ("uploads/sld-pdfs/<site>.pdf"); new rows store them relative to UPLOAD_DIR
// ("sld-pdfs/<site>.pdf"). Both resolve to the same file.
// ─────────────────────────────────────────────────────────────────────────────

export function uploadDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(env.UPLOAD_DIR || '/data/uploads');
}

export function toStoredUploadPath(absPath: string, root: string = uploadDir()): string {
    return path.relative(root, absPath).split(path.sep).join('/');
}

/** Absolute path for a stored upload path, or null if it escapes UPLOAD_DIR. */
export function resolveStoredUploadPath(stored: string, root: string = uploadDir()): string | null {
    const rel = stored.replace(/\\/g, '/').replace(/^\.?\/*uploads\//, '');
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup waits
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Polls until `check` returns true. Used by ingest/jobs, which must not touch
 * the database before it is reachable and the api role has bootstrapped it.
 */
export async function waitUntil(
    label: string,
    check: () => Promise<boolean>,
    { intervalMs = 2_000, timeoutMs = 0 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
    const started = Date.now();
    let lastReason = '';
    for (;;) {
        try {
            if (await check()) return;
            lastReason = 'not ready yet';
        } catch (e: any) {
            lastReason = e?.message || String(e);
        }
        if (timeoutMs > 0 && Date.now() - started >= timeoutMs) {
            throw new Error(`Timed out waiting for ${label}: ${lastReason}`);
        }
        console.log(`[startup] Waiting for ${label} (${lastReason})`);
        await sleep(intervalMs);
    }
}

export async function databaseReachable(pool: Pool): Promise<boolean> {
    await pool.query('SELECT 1');
    return true;
}

/**
 * True once the objects ingest depends on exist: the unique index behind the
 * ON CONFLICT guard, the provenance columns and the dead-letter table. Ingest
 * must never start writing without the guard in place.
 */
export async function ingestSchemaReady(pool: Pool): Promise<boolean> {
    const r = await pool.query(`
        SELECT
            to_regclass('public.idx_meter_readings_unique') IS NOT NULL AS has_unique,
            to_regclass('public.dead_letter_payloads')      IS NOT NULL AS has_dead_letter,
            EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'meter_readings' AND column_name = 'time_source') AS has_provenance,
            -- alert thresholds read by mqtt.ts on every message (main bootstrap)
            EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'site_settings' AND column_name = 'contracted_mdi_kva') AS has_alert_cols
    `);
    const row = r.rows[0];
    return !!(row.has_unique && row.has_dead_letter && row.has_provenance && row.has_alert_cols);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal health endpoint for containers that don't run the api role.
// Not published outside the compose network.
// ─────────────────────────────────────────────────────────────────────────────

export type HealthCheck = () => Promise<{ ok: boolean; [k: string]: unknown }>;

export function startHealthServer(port: number, check: HealthCheck): http.Server {
    const server = http.createServer(async (req, res) => {
        if (req.url !== '/health') {
            res.writeHead(404).end();
            return;
        }
        let body: { ok: boolean; [k: string]: unknown };
        try {
            body = await check();
        } catch (e: any) {
            body = { ok: false, error: e?.message || String(e) };
        }
        res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: body.ok ? 'ok' : 'unhealthy', ...body }));
    });
    server.listen(port, () => console.log(`[health] Internal health endpoint on :${port}/health`));
    return server;
}
