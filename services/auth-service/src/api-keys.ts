// ─────────────────────────────────────────────────────────────────────────────
// API keys (plan Phase 9). A client_admin creates keys for its tenant in the
// portal (Settings → API keys); super_admin for any tenant. The key
//
//     gq_live_<prefix>_<secret>
//
// is shown once. Only its SHA-256 is stored; the prefix identifies it in
// lists and logs. The gateway verifies a key through POST /internal/keys/verify
// (blocked from outside by the gateway) and passes its scope downstream.
// Creating and revoking a key is written to audit_log.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool } from 'pg';
import { createHash, randomBytes } from 'crypto';

export const SCOPES = ['projects:read', 'readings:read', 'readings:raw', 'energy:read', 'findings:read', 'reports:read', 'exports:write'] as const;
/** What a key gets when none are named: everything but raw 1-second readings. */
export const DEFAULT_SCOPES = SCOPES.filter((s) => s !== 'readings:raw');

const KEY_RE = /^gq_live_([a-z0-9]{10})_([A-Za-z0-9_-]{40,})$/;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newKey(): { key: string; prefix: string } {
    const prefix = randomBytes(8).toString('hex').slice(0, 10);
    const secret = randomBytes(32).toString('base64url');
    return { key: `gq_live_${prefix}_${secret}`, prefix };
}

export const looksLikeKey = (s: unknown): s is string => typeof s === 'string' && KEY_RE.test(s);

/** Validated scopes, or null if one is unknown. */
export function parseScopes(v: unknown): string[] | null {
    if (v === undefined || v === null) return [...DEFAULT_SCOPES];
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = [...new Set(v.map(String))];
    return out.every((s) => (SCOPES as readonly string[]).includes(s)) ? out : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function apiKeyRouter(pool: Pool, requireUserAdmin: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const audit = (a: any, action: string, id: string, after: unknown) => pool.query(
        `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, $2, 'api_key', $3, $4)`,
        [a.userId, action, id, JSON.stringify(after)]);

    r.get('/keys', requireUserAdmin, async (req: any, res) => {
        const a = req.userAdmin;
        const tenantId = a.isSuper ? (UUID.test(String(req.query.tenant_id ?? '')) ? req.query.tenant_id : null) : a.tenantId;
        try {
            const q = await pool.query(`
                SELECT id, tenant_id, name, prefix, scopes, project_ids, created_at, last_used_at, revoked_at
                FROM api_keys WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY revoked_at NULLS FIRST, created_at DESC`, [tenantId]);
            res.json(q.rows);
        } catch (e) {
            console.error('List keys error:', e);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    r.post('/keys', requireUserAdmin, async (req: any, res) => {
        const a = req.userAdmin;
        const tenantId = a.isSuper ? req.body?.tenant_id : a.tenantId;
        const name = String(req.body?.name ?? '').trim().slice(0, 100);
        const scopes = parseScopes(req.body?.scopes);
        const projects = req.body?.project_ids ?? null;
        if (!UUID.test(String(tenantId ?? ''))) return res.status(400).json({ error: 'tenant_id is required' });
        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!scopes) return res.status(400).json({ error: `scopes: any of ${SCOPES.join(', ')}` });
        if (projects !== null && (!Array.isArray(projects) || !projects.every((p) => UUID.test(String(p))))) {
            return res.status(400).json({ error: 'project_ids: a list of project ids, or null for all' });
        }
        try {
            const t = await pool.query(`SELECT kind FROM tenants WHERE id = $1`, [tenantId]);
            if (t.rows[0]?.kind !== 'client') return res.status(400).json({ error: 'API keys belong to a client tenant' });
            if (projects && projects.length) {
                const own = await pool.query(`SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1 AND id = ANY($2)`, [tenantId, projects]);
                if (own.rows[0].n !== new Set(projects).size) return res.status(400).json({ error: 'project_ids must be projects of this tenant' });
            }
            const { key, prefix } = newKey();
            const row = (await pool.query(`
                INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes, project_ids, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, tenant_id, name, prefix, scopes, project_ids, created_at`,
                [tenantId, name, prefix, sha256(key), scopes, projects && projects.length ? projects : null, a.userId])).rows[0];
            await audit(a, 'api_key.create', row.id, { name, prefix, scopes, project_ids: row.project_ids });
            res.status(201).json({ ...row, key, note: 'Shown once. Store it now; Grid-IQ keeps only a hash.' });
        } catch (e) {
            console.error('Create key error:', e);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    r.delete('/keys/:id', requireUserAdmin, async (req: any, res) => {
        const a = req.userAdmin;
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        try {
            const q = await pool.query(`
                UPDATE api_keys SET revoked_at = NOW()
                WHERE id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR tenant_id = $2)
                RETURNING id, prefix, revoked_at`, [req.params.id, a.isSuper ? null : a.tenantId]);
            if (!q.rows.length) return res.status(404).json({ error: 'Not found or already revoked' });
            await audit(a, 'api_key.revoke', q.rows[0].id, { prefix: q.rows[0].prefix });
            res.json({ revoked: true, ...q.rows[0] });
        } catch (e) {
            console.error('Revoke key error:', e);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // For the gateway only (it refuses /auth/internal from outside).
    r.post('/internal/keys/verify', async (req, res) => {
        const key = req.body?.key;
        if (!looksLikeKey(key)) return res.status(401).json({ error: 'invalid key' });
        try {
            const q = await pool.query(`
                SELECT k.id, k.tenant_id, k.scopes, k.project_ids, k.prefix
                FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
                WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND t.kind = 'client'`, [sha256(key)]);
            const k = q.rows[0];
            if (!k) return res.status(401).json({ error: 'invalid key' });
            // At most once a minute, so a busy key does not write on every call.
            pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`, [k.id])
                .catch(() => { /* informational */ });
            res.json({ key_id: k.id, prefix: k.prefix, tenant_id: k.tenant_id, scopes: k.scopes, project_ids: k.project_ids });
        } catch (e) {
            console.error('Verify key error:', e);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return r;
}
