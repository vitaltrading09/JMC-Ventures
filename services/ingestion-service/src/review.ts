// ─────────────────────────────────────────────────────────────────────────────
// Review workflow (plan Phase 7, items 3 and 4).
//
// Recommendations: the engines write drafts. An internal user moves them
// through in_review to published or dismissed. Client roles only ever see
// published ones, and never internal_notes (src/scope.ts forClient).
//
// Reports: a report covers one project for a fixed period. draft → approved
// → published, by internal users. A share link serves a report only while it
// is published. Every transition is written to audit_log.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { requireInternal, tenantSql, forClient, withScope, deliverySql } from './scope';
import { uploadDir, resolveStoredUploadPath } from './roles';

export type ReviewStatus = 'draft' | 'in_review' | 'published' | 'dismissed';
const REVIEW_STATUSES: ReviewStatus[] = ['draft', 'in_review', 'published', 'dismissed'];

const REVIEW_MOVES: Record<ReviewStatus, ReviewStatus[]> = {
    draft:     ['in_review', 'published', 'dismissed'],
    in_review: ['draft', 'published', 'dismissed'],
    published: ['in_review', 'dismissed'],   // withdraw for rework, or retire
    dismissed: ['draft'],
};
export const canReview = (from: ReviewStatus, to: ReviewStatus) => REVIEW_MOVES[from]?.includes(to) ?? false;

export type ReportStatus = 'draft' | 'approved' | 'published';
export type ReportAction = 'approve' | 'publish' | 'withdraw';
/** The status a report moves to, or null if the action is not allowed from here. */
export function reportTransition(from: ReportStatus, action: ReportAction): ReportStatus | null {
    if (action === 'approve') return from === 'draft' ? 'approved' : null;
    if (action === 'publish') return from === 'approved' ? 'published' : null;
    if (action === 'withdraw') return from === 'approved' || from === 'published' ? 'draft' : null;
    return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function audit(db: Pool | PoolClient, scope: any, action: string, entityType: string, entityId: string,
                     before: unknown, after: unknown, reason: string | null = null) {
    await db.query(`
        INSERT INTO audit_log (actor_user_id, actor_email, action, entity_type, entity_id, before, after, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [scope?.userId ?? null, scope?.email ?? null, action, entityType, entityId,
         before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason]);
}

export function reviewRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const authenticate = withScope(authenticateJwt);
    const guard = [authenticate, requireInternal];
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try {
            await fn(req, res);
        } catch (e: any) {
            if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') return res.status(400).json({ error: 'Malformed value' });
            if (e?.code === '23514') return res.status(400).json({ error: 'period_end must be after period_start' });
            if (e?.code === '23503') return res.status(400).json({ error: 'Refers to a record that does not exist' });
            console.error(`[review] ${req.method} ${req.path}:`, e);
            res.status(500).json({ error: 'Database error' });
        }
    };

    // ── Recommendations ─────────────────────────────────────────────────────
    r.get('/review/recommendations', ...guard, handle(async (req, res) => {
        const params: unknown[] = [];
        const where = [`r.status = 'ACTIVE'`, tenantSql(req.scope, 'r.tenant_id', params)];
        const status = String(req.query.review_status ?? 'draft');
        if (status !== 'all') {
            if (!REVIEW_STATUSES.includes(status as ReviewStatus)) return res.status(400).json({ error: `review_status: one of ${REVIEW_STATUSES.join(', ')}, all` });
            params.push(status);
            where.push(`r.review_status = $${params.length}`);
        }
        const q = await pool.query(`
            SELECT r.*, s.name AS site_name, m.name AS meter_name, t.name AS tenant_name
            FROM recommendations r
            JOIN sites s ON s.id = r.site_id
            JOIN tenants t ON t.id = r.tenant_id
            LEFT JOIN meters m ON m.id = r.meter_id
            WHERE ${where.join(' AND ')}
            ORDER BY r.created_at DESC LIMIT 200`, params);
        res.json(q.rows);
    }));

    r.patch('/recommendations/:id/review', ...guard, handle(async (req, res) => {
        const to = String(req.body?.review_status ?? '') as ReviewStatus;
        if (!REVIEW_STATUSES.includes(to)) return res.status(400).json({ error: `review_status: one of ${REVIEW_STATUSES.join(', ')}` });
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            const params: unknown[] = [req.params.id];
            const before = (await c.query(
                `SELECT * FROM recommendations WHERE id = $1 AND ${tenantSql(req.scope, 'tenant_id', params)} FOR UPDATE`, params)).rows[0];
            if (!before) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
            if (before.review_status !== to && !canReview(before.review_status, to)) {
                await c.query('ROLLBACK');
                return res.status(409).json({ error: `Cannot move from ${before.review_status} to ${to}` });
            }
            const notes = req.body && 'internal_notes' in req.body ? (req.body.internal_notes ?? null) : before.internal_notes;
            const after = (await c.query(`
                UPDATE recommendations SET review_status = $2, internal_notes = $3, reviewed_by = $4, reviewed_at = NOW()
                WHERE id = $1 RETURNING *`, [req.params.id, to, notes, req.scope.userId])).rows[0];
            let superseded = 0;
            if (to === 'published' && req.body?.supersede_previous === true) {
                // The client's earlier published set for the same scope (site-wide or this meter) is replaced.
                const s = await c.query(`
                    UPDATE recommendations SET status = 'SUPERSEDED'
                    WHERE id <> $1 AND site_id = $2 AND meter_id IS NOT DISTINCT FROM $3
                      AND status = 'ACTIVE' AND review_status = 'published' AND created_at < $4`,
                    [after.id, after.site_id, after.meter_id, after.created_at]);
                superseded = s.rowCount ?? 0;
            }
            await audit(c, req.scope, `finding.${to}`, 'recommendation', after.id,
                { review_status: before.review_status }, { review_status: to, superseded }, req.body?.reason ?? null);
            await c.query('COMMIT');
            res.json({ ...after, superseded });
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            c.release();
        }
    }));

    // ── Reports ─────────────────────────────────────────────────────────────
    const reportSelect = `
        SELECT rp.*, p.name AS project_name, p.tenant_id
        FROM reports rp JOIN projects p ON p.id = rp.project_id`;

    r.get('/reports', authenticate, handle(async (req, res) => {
        const params: unknown[] = [];
        const where = [tenantSql(req.scope, 'p.tenant_id', params)];
        if (!req.scope.isInternal) where.push(`rp.status = 'published'`, deliverySql(req.scope, 'p'));
        if (req.query.project_id) {
            if (!UUID.test(String(req.query.project_id))) return res.json([]);
            params.push(req.query.project_id);
            where.push(`rp.project_id = $${params.length}`);
        }
        const q = await pool.query(`${reportSelect} WHERE ${where.join(' AND ')} ORDER BY rp.period_end DESC LIMIT 200`, params);
        res.json(q.rows.map((x) => forClient(req.scope, x)));
    }));

    r.get('/reports/:id', authenticate, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const params: unknown[] = [req.params.id];
        const where = [`rp.id = $1`, tenantSql(req.scope, 'p.tenant_id', params)];
        if (!req.scope.isInternal) where.push(`rp.status = 'published'`, deliverySql(req.scope, 'p'));
        const row = (await pool.query(`${reportSelect} WHERE ${where.join(' AND ')}`, params)).rows[0];
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(forClient(req.scope, row));
    }));

    r.post('/reports', ...guard, handle(async (req, res) => {
        const b = req.body ?? {};
        if (!UUID.test(String(b.project_id ?? ''))) return res.status(400).json({ error: 'project_id is required' });
        if (!b.period_start || !b.period_end) return res.status(400).json({ error: 'period_start and period_end are required' });
        const params: unknown[] = [b.project_id];
        const project = (await pool.query(`SELECT id FROM projects WHERE id = $1 AND ${tenantSql(req.scope, 'tenant_id', params)}`, params)).rows[0];
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const row = (await pool.query(`
            INSERT INTO reports (project_id, title, period_start, period_end, pdf_path, dataset_id, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [b.project_id, b.title ?? null, b.period_start, b.period_end, b.pdf_path ?? null, b.dataset_id ?? null, req.scope.userId])).rows[0];
        await audit(pool, req.scope, 'report.create', 'report', row.id, undefined, row);
        res.status(201).json(row);
    }));

    r.patch('/reports/:id', ...guard, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const allowed = ['title', 'period_start', 'period_end', 'pdf_path', 'dataset_id'];
        const fields = allowed.filter((k) => req.body && k in req.body);
        if (!fields.length) return res.status(400).json({ error: `Nothing to update (${allowed.join(', ')})` });
        const cur = (await pool.query(`SELECT status FROM reports WHERE id = $1`, [req.params.id])).rows[0];
        if (!cur) return res.status(404).json({ error: 'Not found' });
        if (cur.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be edited: withdraw it first' });
        const row = (await pool.query(
            `UPDATE reports SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
            [req.params.id, ...fields.map((k) => req.body[k])])).rows[0];
        res.json(row);
    }));

    // ── Report PDF ──────────────────────────────────────────────────────────
    const pdfDir = path.join(uploadDir(), 'report-pdfs');
    const PDF_MAX_BYTES = 50 * 1024 * 1024;
    const pdfUpload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => { fs.mkdirSync(pdfDir, { recursive: true }); cb(null, pdfDir); },
            filename: (req: any, _file, cb) => cb(null, `${req.params.id}.${randomBytes(6).toString('hex')}.part`),
        }),
        fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
        limits: { fileSize: PDF_MAX_BYTES, files: 1 },
    }).single('file');

    // A refusal is sent after the upload body has been read (and discarded):
    // answering mid-upload resets the connection behind a proxy, and the
    // caller would see a network error instead of the status.
    const refuse = (req: any, res: any, status: number, error: string) => {
        const send = () => { if (!res.headersSent) res.status(status).json({ error }); };
        if (Number(req.headers['content-length'] ?? 0) > PDF_MAX_BYTES + 1_000_000 || req.readableEnded) {
            res.setHeader('Connection', 'close');
            return send();
        }
        req.on('end', send).on('error', send).on('close', send);
        req.resume();
    };

    r.post('/reports/:id/pdf', authenticate, handle(async (req, res) => {
        if (!req.scope?.isInternal) return refuse(req, res, 403, 'Forbidden: internal users only');
        if (!UUID.test(req.params.id)) return refuse(req, res, 404, 'Not found');
        const params: unknown[] = [req.params.id];
        const cur = (await pool.query(`
            SELECT rp.id, rp.status, rp.pdf_path FROM reports rp JOIN projects p ON p.id = rp.project_id
            WHERE rp.id = $1 AND ${tenantSql(req.scope, 'p.tenant_id', params)}`, params)).rows[0];
        if (!cur) return refuse(req, res, 404, 'Not found');
        if (cur.status !== 'draft') return refuse(req, res, 409, 'Only a draft can be edited: withdraw it first');
        const err = await new Promise<any>((resolve) => pdfUpload(req, res, resolve));
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'PDF larger than 50 MB' : 'Upload failed' });
        if (!req.file) return res.status(400).json({ error: 'Send one PDF as multipart field "file"' });
        const head = Buffer.alloc(5);
        const fd = fs.openSync(req.file.path, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
        if (head.toString('latin1') !== '%PDF-') { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Not a PDF file' }); }
        const stored = `report-pdfs/${req.params.id}.pdf`;
        fs.renameSync(req.file.path, path.join(pdfDir, `${req.params.id}.pdf`));
        const row = (await pool.query(`UPDATE reports SET pdf_path = $2 WHERE id = $1 RETURNING *`, [req.params.id, stored])).rows[0];
        await audit(pool, req.scope, 'report.attach_pdf', 'report', row.id, { pdf_path: cur.pdf_path }, { pdf_path: stored, bytes: req.file.size });
        res.json(row);
    }));

    r.get('/reports/:id/pdf', authenticate, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const params: unknown[] = [req.params.id];
        const where = [`rp.id = $1`, tenantSql(req.scope, 'p.tenant_id', params)];
        if (!req.scope.isInternal) where.push(`rp.status = 'published'`, deliverySql(req.scope, 'p'));
        const row = (await pool.query(`${reportSelect} WHERE ${where.join(' AND ')}`, params)).rows[0];
        const file = row?.pdf_path ? resolveStoredUploadPath(row.pdf_path) : null;
        if (!row || !file || !fs.existsSync(file)) return res.status(404).json({ error: 'No PDF attached to this report' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="report-${row.id}.pdf"`);
        fs.createReadStream(file).pipe(res);
    }));

    for (const action of ['approve', 'publish', 'withdraw'] as ReportAction[]) {
        r.post(`/reports/:id/${action}`, ...guard, handle(async (req, res) => {
            if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
            const c = await pool.connect();
            try {
                await c.query('BEGIN');
                const params: unknown[] = [req.params.id];
                const before = (await c.query(`
                    SELECT rp.* FROM reports rp JOIN projects p ON p.id = rp.project_id
                    WHERE rp.id = $1 AND ${tenantSql(req.scope, 'p.tenant_id', params)} FOR UPDATE OF rp`, params)).rows[0];
                if (!before) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
                const to = reportTransition(before.status, action);
                if (!to) { await c.query('ROLLBACK'); return res.status(409).json({ error: `Cannot ${action} a ${before.status} report` }); }
                const set = action === 'approve' ? `, approved_by = $3, approved_at = NOW()`
                    : action === 'publish' ? `, published_by = $3, published_at = NOW()`
                        : `, approved_by = NULL, approved_at = NULL, published_by = NULL, published_at = NULL`;
                const after = (await c.query(
                    `UPDATE reports SET status = $2 ${set} WHERE id = $1 RETURNING *`,
                    action === 'withdraw' ? [req.params.id, to] : [req.params.id, to, req.scope.userId])).rows[0];
                await audit(c, req.scope, `report.${action}`, 'report', after.id,
                    { status: before.status }, { status: to }, req.body?.reason ?? null);
                await c.query('COMMIT');
                res.json(after);
            } catch (e) {
                await c.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                c.release();
            }
        }));
    }

    return r;
}
