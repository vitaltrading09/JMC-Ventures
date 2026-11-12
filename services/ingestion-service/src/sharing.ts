// ─────────────────────────────────────────────────────────────────────────────
// Sharing the provisional report and booking follow-up assessments.
//
//   POST /assessments/:id/preview-shares   { kind, label?, days_valid? }  staff / client_admin
//   GET  /assessments/:id/preview-shares                                   the assessment's links
//   POST /preview-shares/:id/revoke
//   GET  /public/preview/:token[?check=1]                                  the provisional PDF (no login); check = validity only
//   POST /booking-requests  { project_id?, assessment_id?, purpose, ... }  any client user (incl. viewer)
//   GET  /booking-requests                                                 staff: all; clients: own tenant
//   PATCH /booking-requests/:id  { status }                                staff
//
// A provisional link needs useful data (24 h of the assessment) and stops at the
// earlier of its expiry and the assessment's end, checked on every open (no job).
// The PDF is rendered from the live dataset each time and marked PROVISIONAL.
// Only the token's SHA-256 is stored. Every create/revoke is in audit_log.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { withScope, findSite, liveAssessmentSql, tenantSql, canWrite, NO_ACCESS } from './scope';
import { buildAssessmentDataset, canonical, sha256 } from './reports/dataset';
import { renderReportPdf } from './reports/pdf';
import { enqueueEmail } from './notify/email';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USEFUL_DATA_MS = 24 * 3_600_000;
const PURPOSES = ['follow_up', 'verify_improvement', 'new_site', 'other'];
const STATUSES = ['new', 'contacted', 'booked', 'declined'];

/** Whether a provisional link may be made now (pure; unit-tested). */
export function previewShareAllowed(a: { start_at: Date | string | null; end_at: Date | string; closed_at?: Date | string | null }, now = Date.now()): { ok: boolean; reason?: string } {
    if (!a.start_at) return { ok: false, reason: 'The assessment has not started' };
    const end = Math.min(new Date(a.end_at).getTime(), a.closed_at ? new Date(a.closed_at).getTime() : Infinity);
    if (now >= end) return { ok: false, reason: 'The assessment has ended; share the final report instead' };
    if (now - new Date(a.start_at).getTime() < USEFUL_DATA_MS) return { ok: false, reason: 'A provisional report can be shared after the first 24 hours of measurements' };
    return { ok: true };
}

const hits = new Map<string, number[]>();
const limited = (ip: string) => {
    const now = Date.now(), list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now); hits.set(ip, list);
    return list.length > 20;
};

export function sharingRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const auth = withScope(authenticateJwt);
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try { await fn(req, res); } catch (e) { console.error('[sharing]', e); res.status(500).json({ error: 'Server error' }); }
    };
    const liveFor = async (req: any, id: string) => {
        if (!UUID.test(id) || req.scope.apiKey) return null;
        if (req.scope.isInternal) return (await pool.query(`SELECT * FROM assessments WHERE id = $1`, [id])).rows[0] ?? null;
        return (await pool.query(`SELECT a.* FROM assessments a WHERE a.id = $1 AND a.tenant_id = $2 AND ${liveAssessmentSql(req.scope, 'a')}`, [id, req.scope.tenantId])).rows[0] ?? null;
    };

    r.post('/assessments/:id/preview-shares', auth, handle(async (req, res) => {
        if (!canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
        const a = await liveFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
        const allowed = previewShareAllowed(a);
        if (!allowed.ok) return res.status(409).json({ error: allowed.reason, code: 'not_yet_useful' });
        const kind = req.body?.kind === 'power_quality' ? 'power_quality' : 'overview';
        const days = Math.min(Math.max(parseInt(String(req.body?.days_valid ?? '14')) || 14, 1), 90);
        const end = Math.min(new Date(a.end_at).getTime(), a.closed_at ? new Date(a.closed_at).getTime() : Infinity);
        const expires = new Date(Math.min(end, Date.now() + days * 86_400_000));
        const token = crypto.randomBytes(32).toString('base64url');
        const row = (await pool.query(`
            INSERT INTO preview_shares (assessment_id, kind, token_hash, label, created_by, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, label, created_at, expires_at`,
            [a.id, kind, sha256(token), req.body?.label ? String(req.body.label).slice(0, 120) : null, req.scope.userId, expires])).rows[0];
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'preview_share.create', 'assessment', $2, $3)`,
            [req.scope.userId, a.id, JSON.stringify({ share: row.id, kind, expires_at: expires })]);
        res.status(201).json({ ...row, path: `/shared/${token}` });
    }));

    r.get('/assessments/:id/preview-shares', auth, handle(async (req, res) => {
        const a = await liveFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
        res.json((await pool.query(`
            SELECT id, kind, label, created_at, expires_at, revoked_at, opened_count, last_opened_at
            FROM preview_shares WHERE assessment_id = $1 ORDER BY created_at DESC`, [a.id])).rows);
    }));

    r.post('/preview-shares/:id/revoke', auth, handle(async (req, res) => {
        if (!canWrite(req.scope) || !UUID.test(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
        const s = (await pool.query(`SELECT assessment_id FROM preview_shares WHERE id = $1`, [req.params.id])).rows[0];
        const a = s && await liveFor(req, s.assessment_id);
        if (!a) return res.status(403).json({ error: 'Forbidden' });
        await pool.query(`UPDATE preview_shares SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1`, [req.params.id]);
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'preview_share.revoke', 'assessment', $2, $3)`,
            [req.scope.userId, a.id, JSON.stringify({ share: req.params.id })]);
        res.json({ ok: true });
    }));

    // Public: no login. Valid only while the link and the assessment both are.
    r.get('/public/preview/:token', handle(async (req, res) => {
        const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
        if (limited(ip)) return res.status(429).json({ error: 'Too many requests' });
        const token = String(req.params.token ?? '');
        if (token.length < 20 || token.length > 200) return res.status(404).json({ error: 'not_found' });
        const s = (await pool.query(`
            SELECT s.id, s.kind, s.expires_at, s.revoked_at, a.id AS assessment_id, a.reference, a.end_at, a.closed_at, a.start_at
            FROM preview_shares s JOIN assessments a ON a.id = s.assessment_id WHERE s.token_hash = $1`, [sha256(token)])).rows[0];
        if (!s) return res.status(404).json({ error: 'not_found' });
        const end = Math.min(new Date(s.end_at).getTime(), s.closed_at ? new Date(s.closed_at).getTime() : Infinity);
        if (s.revoked_at || new Date(s.expires_at).getTime() <= Date.now() || Date.now() >= end) return res.status(410).json({ error: 'expired' });
        // ?check=1: validity only (the share page asks before showing the PDF); not counted as an open.
        if (req.query.check) return res.json({ ok: true, kind: s.kind, reference: s.reference, expires_at: s.expires_at });
        await pool.query(`UPDATE preview_shares SET opened_count = opened_count + 1, last_opened_at = NOW() WHERE id = $1`, [s.id]);
        const ds = await buildAssessmentDataset(pool, s.assessment_id, new Date(), { provisional: true });
        const pdf = await renderReportPdf(s.kind, ds, { revision: 0, sha256: sha256(canonical(ds)), status: 'provisional preview', generatedAt: new Date() });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `inline; filename="${s.reference}-${s.kind}-provisional.pdf"`);
        res.send(pdf);
    }));

    r.post('/booking-requests', auth, handle(async (req, res) => {
        if (req.scope.apiKey) return res.status(403).json({ error: 'Forbidden' });
        const b = req.body ?? {};
        if (!PURPOSES.includes(b.purpose)) return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
        let projectId: string | null = null, tenantId: string | null = req.scope.isInternal ? null : req.scope.tenantId;
        if (b.project_id) {
            const site = await findSite(pool, req.scope, String(b.project_id));
            if (!site) return res.status(403).json({ error: 'Forbidden' });
            projectId = site.id; tenantId = site.tenant_id;
        }
        if (!tenantId) return res.status(400).json({ error: 'project_id is required' });
        let fromAssessment: string | null = null;
        if (b.assessment_id && UUID.test(String(b.assessment_id))) {
            const a = (await pool.query(`SELECT id FROM assessments WHERE id = $1 AND tenant_id = $2`, [b.assessment_id, tenantId])).rows[0];
            fromAssessment = a?.id ?? null;
        }
        const days = b.duration_days ? parseInt(String(b.duration_days)) : null;
        if (days !== null && !(days >= 1 && days <= 365)) return res.status(400).json({ error: 'duration_days must be 1–365' });
        if (b.preferred_start && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.preferred_start))) return res.status(400).json({ error: 'preferred_start must be YYYY-MM-DD' });
        const row = (await pool.query(`
            INSERT INTO booking_requests (tenant_id, project_id, from_assessment_id, requested_by, purpose, duration_days, preferred_start, contact_name, contact_phone, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [tenantId, projectId, fromAssessment, req.scope.userId, b.purpose, days, b.preferred_start || null,
             b.contact_name ? String(b.contact_name).slice(0, 120) : null, b.contact_phone ? String(b.contact_phone).slice(0, 40) : null,
             b.notes ? String(b.notes).slice(0, 2000) : null])).rows[0];
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'booking_request.create', 'booking_request', $2, $3)`,
            [req.scope.userId, row.id, JSON.stringify({ purpose: row.purpose, project: projectId })]);
        const to = process.env.OPS_NOTIFY_EMAIL;
        if (to) {
            const who = (await pool.query(`SELECT u.email, t.name AS tenant, p.name AS project FROM tenants t LEFT JOIN users u ON u.id = $2 LEFT JOIN projects p ON p.id = $3 WHERE t.id = $1`,
                [tenantId, req.scope.userId, projectId])).rows[0] ?? {};
            await enqueueEmail(pool, { dedupeKey: `booking:${row.id}`, to, purpose: 'booking_request',
                subject: `Booking request: ${who.tenant ?? 'client'}${who.project ? ` · ${who.project}` : ''}`,
                text: `${who.email ?? 'A client'} asked for a ${row.purpose.replace(/_/g, ' ')} assessment${who.project ? ` at ${who.project}` : ''}.\n`
                    + `Duration: ${row.duration_days ?? 'not given'} days · preferred start: ${row.preferred_start ?? 'not given'}\n`
                    + `Contact: ${row.contact_name ?? '–'} ${row.contact_phone ?? ''}\n\n${row.notes ?? ''}\n\nOps console → Home → Booking requests.` } as any);
        }
        res.status(201).json(row);
    }));

    r.get('/booking-requests', auth, handle(async (req, res) => {
        const params: unknown[] = [];
        const t = tenantSql(req.scope, 'b.tenant_id', params);
        res.json((await pool.query(`
            SELECT b.*, t.name AS tenant_name, p.name AS project_name, u.email AS requested_by_email
            FROM booking_requests b JOIN tenants t ON t.id = b.tenant_id
            LEFT JOIN projects p ON p.id = b.project_id LEFT JOIN users u ON u.id = b.requested_by
            WHERE ${t} ORDER BY b.created_at DESC LIMIT 200`, params)).rows);
    }));

    r.patch('/booking-requests/:id', auth, handle(async (req, res) => {
        if (!req.scope.isInternal) return res.status(403).json({ error: 'Forbidden' });
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        if (!STATUSES.includes(req.body?.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
        const row = (await pool.query(`UPDATE booking_requests SET status = $2, handled_by = $3, handled_at = NOW() WHERE id = $1 RETURNING *`,
            [req.params.id, req.body.status, req.scope.userId])).rows[0];
        if (!row) return res.status(404).json({ error: 'Not found' });
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'booking_request.update', 'booking_request', $2, $3)`,
            [req.scope.userId, row.id, JSON.stringify({ status: row.status })]);
        res.json(row);
    }));

    return r;
}
