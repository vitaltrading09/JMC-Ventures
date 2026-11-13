// ─────────────────────────────────────────────────────────────────────────────
// Assessments API (GridIQ implementation prompt, sections 4–6 and 13).
//
// Staff (internal roles):
//   GET/POST/PATCH /assessment-packages[/:id]       editable price list (cents)
//   GET  /assessments                               all, with effective state
//   POST /assessments                               draft for a project
//   GET  /assessments/:id                           detail, grants, points, audit
//   PATCH /assessments/:id                          details, payment, notes
//   POST /assessments/:id/schedule|start|extend|close|cancel   (audited)
//   POST /assessments/:id/grants                    invite a named recipient
//   POST /assessments/:id/grants/:grantId/revoke    (audited, with reason)
//   GET/POST /devices/:id/maintenance               service/calibration history
//   GET  /devices/:id/history                       deployments, maintenance, assessments
//
// Clients:
//   GET /portal/assessments                         the caller's own assessments
//
// Every transition writes audit_log (who, when, what, before/after, reason).
// Access itself is enforced elsewhere, in SQL, on every request (src/scope.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { withScope, requireInternal, forClient } from '../scope';
import { enqueueEmail, appUrl } from '../notify/email';
import {
    checkTransition, effectiveStatus, effectiveEnd, endFor, remainingMs, deliveryWindow, retentionUntil,
    formatDuration, formatZar, isLive, LifecycleError, DAY,
} from './lifecycle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InputError extends Error {}

const str = (v: unknown, field: string, { required = false, max = 500 } = {}): string | null => {
    if (v === undefined || v === null || v === '') {
        if (required) throw new InputError(`${field} is required`);
        return null;
    }
    const s = String(v).trim();
    if (s.length > max) throw new InputError(`${field}: at most ${max} characters`);
    return s;
};
const int = (v: unknown, field: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${field}: a whole number from ${min} to ${max}`);
    return n;
};
const date = (v: unknown, field: string): Date | null => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new InputError(`${field}: an ISO 8601 date-time`);
    return d;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | null => {
    if (v === undefined || v === null || v === '') return null;
    if (!(allowed as readonly string[]).includes(String(v))) throw new InputError(`${field}: one of ${allowed.join(', ')}`);
    return String(v) as T;
};

async function audit(db: Pool | PoolClient, scope: any, action: string, entityType: string, entityId: string,
                     before?: unknown, after?: unknown, reason?: string | null) {
    await db.query(`
        INSERT INTO audit_log (actor_user_id, actor_email, action, entity_type, entity_id, before, after, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [scope?.userId ?? null, scope?.email ?? null, action, entityType, entityId,
         before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason ?? null]);
}

/** What a reader needs about an assessment's clocks, computed from the row. */
export function clockView(a: any, now = new Date()) {
    const end = effectiveEnd(a);
    const delivery = deliveryWindow(a);
    return {
        effective_status: effectiveStatus(a, now),
        live: isLive(a, now),
        effective_end_at: end,
        remaining_ms: remainingMs(a, now),
        remaining: formatDuration(remainingMs(a, now)),
        delivery_until: delivery?.to ?? null,
        delivery_open: !!delivery && now >= delivery.from && now < delivery.to,
    };
}

const CLIENT_FIELDS = ['id', 'reference', 'title', 'project_id', 'project_name', 'status', 'duration_days', 'start_at', 'end_at',
    'closed_at', 'timezone', 'report_status', 'retention_months', 'retention_until', 'retention_status', 'delivery_days',
    'package_name', 'points'];

export function assessmentsRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const auth = withScope(authenticateJwt);
    const staff = [auth, requireInternal];
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try { await fn(req, res); } catch (e: any) {
            if (e instanceof InputError) return res.status(400).json({ error: e.message });
            if (e instanceof LifecycleError) return res.status(e.status).json({ error: e.message });
            if (e?.code === '23505') return res.status(409).json({ error: 'Already exists' });
            if (e?.code === '23514') return res.status(400).json({ error: `Not allowed by a database rule (${e.constraint ?? 'check'})` });
            console.error(`[assessments] ${req.method} ${req.path}:`, e);
            res.status(500).json({ error: 'Database error' });
        }
    };
    const tx = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            const out = await fn(c);
            await c.query('COMMIT');
            return out;
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };

    const selectAssessment = `
        SELECT a.*, p.name AS project_name, t.name AS tenant_name, pk.name AS package_name, pk.code AS package_code,
               COALESCE((SELECT json_agg(json_build_object('id', mp.id, 'name', mp.name, 'role', mp.role) ORDER BY mp.sort_order, mp.name)
                         FROM assessment_points ap JOIN measurement_points mp ON mp.id = ap.measurement_point_id
                         WHERE ap.assessment_id = a.id), '[]') AS points
        FROM assessments a
        JOIN projects p ON p.id = a.project_id
        JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN assessment_packages pk ON pk.id = a.package_id`;

    const load = async (db: Pool | PoolClient, id: string, lock = false) => {
        if (!UUID.test(id)) return null;
        const row = (await db.query(`${selectAssessment} WHERE a.id = $1`, [id])).rows[0];
        if (row && lock) await db.query(`SELECT 1 FROM assessments WHERE id = $1 FOR UPDATE`, [id]);
        return row ?? null;
    };
    const view = (a: any) => ({ ...a, ...clockView(a), price: formatZar(a.price_cents === null ? null : Number(a.price_cents)) });

    // ── Packages ────────────────────────────────────────────────────────────
    r.get('/assessment-packages', ...staff, handle(async (_req, res) => {
        const q = await pool.query(`SELECT * FROM assessment_packages WHERE status <> 'archived' ORDER BY duration_days`);
        res.json(q.rows.map((p) => ({ ...p, price: formatZar(Number(p.price_cents)) })));
    }));

    const packageFields = (b: any) => ({
        name: str(b.name, 'name', { max: 120 }),
        duration_days: int(b.duration_days, 'duration_days', { min: 1, max: 366 }),
        price_cents: int(b.price_cents, 'price_cents', { min: 0 }),
        tax_basis: oneOf(b.tax_basis, ['incl_vat', 'excl_vat', 'not_vat_registered'] as const, 'tax_basis'),
        included_meters: int(b.included_meters, 'included_meters', { min: 1, max: 50 }),
        extra_meter_price_cents: int(b.extra_meter_price_cents, 'extra_meter_price_cents', { min: 0 }),
        day_rate_cents: int(b.day_rate_cents, 'day_rate_cents', { min: 0 }),
        retention_months: int(b.retention_months, 'retention_months', { min: 3, max: 6 }),
        status: oneOf(b.status, ['draft', 'published', 'archived'] as const, 'status'),
        inclusions: b.inclusions === undefined ? null : (typeof b.inclusions === 'object' ? JSON.stringify(b.inclusions) : (() => { throw new InputError('inclusions: an object'); })()),
    });

    r.post('/assessment-packages', ...staff, handle(async (req, res) => {
        const b = req.body ?? {};
        const code = str(b.code, 'code', { required: true, max: 40 })!.toLowerCase();
        if (!/^[a-z0-9-]+$/.test(code)) throw new InputError('code: lower-case letters, digits and hyphens');
        const f = packageFields(b);
        if (!f.name || !f.duration_days || f.price_cents === null) throw new InputError('name, duration_days and price_cents are required');
        const row = (await pool.query(`
            INSERT INTO assessment_packages (code, name, duration_days, price_cents, tax_basis, included_meters, extra_meter_price_cents,
                                             day_rate_cents, retention_months, inclusions)
            VALUES ($1, $2, $3, $4, $5, COALESCE($6, 1), $7, $8, COALESCE($9, 3), COALESCE($10::jsonb, '{}'::jsonb)) RETURNING *`,
            [code, f.name, f.duration_days, f.price_cents, f.tax_basis, f.included_meters, f.extra_meter_price_cents,
             f.day_rate_cents, f.retention_months, f.inclusions])).rows[0];
        await audit(pool, req.scope, 'package.create', 'assessment_package', row.id, undefined, row);
        res.status(201).json(row);
    }));

    r.patch('/assessment-packages/:id', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const f = packageFields(req.body ?? {});
        const sets: string[] = [], vals: unknown[] = [req.params.id];
        for (const [k, v] of Object.entries(f)) {
            if (v === null || v === undefined) continue;
            vals.push(v);
            sets.push(`${k} = $${vals.length}${k === 'inclusions' ? '::jsonb' : ''}`);
        }
        if (!sets.length) throw new InputError('Nothing to change');
        const out = await tx(async (c) => {
            const before = (await c.query(`SELECT * FROM assessment_packages WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
            if (!before) return null;
            const after = (await c.query(`UPDATE assessment_packages SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`, vals)).rows[0];
            await audit(c, req.scope, 'package.update', 'assessment_package', req.params.id, before, after);
            return after;
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.json(out);
    }));

    // ── Assessments ─────────────────────────────────────────────────────────
    r.get('/assessments', ...staff, handle(async (req, res) => {
        const vals: unknown[] = [];
        const where: string[] = ['TRUE'];
        if (req.scope.filterTenantId) { vals.push(req.scope.filterTenantId); where.push(`a.tenant_id = $${vals.length}`); }
        if (req.query.project_id && UUID.test(String(req.query.project_id))) { vals.push(req.query.project_id); where.push(`a.project_id = $${vals.length}`); }
        const q = await pool.query(`${selectAssessment} WHERE ${where.join(' AND ')}
            ORDER BY CASE a.status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, a.end_at NULLS LAST, a.created_at DESC
            LIMIT 500`, vals);
        res.json(q.rows.map(view));
    }));

    r.post('/assessments', ...staff, handle(async (req, res) => {
        const b = req.body ?? {};
        if (!UUID.test(String(b.project_id ?? ''))) throw new InputError('project_id is required');
        const out = await tx(async (c) => {
            const p = (await c.query(`SELECT p.id, p.tenant_id, p.name, p.timezone, t.kind FROM projects p JOIN tenants t ON t.id = p.tenant_id
                                      WHERE p.id = $1 AND p.archived_at IS NULL`, [b.project_id])).rows[0];
            if (!p) throw new InputError('project_id: no such active project');
            if (p.kind !== 'client') throw new InputError('Assessments are for client projects');
            let pkg: any = null;
            if (b.package_id !== undefined && b.package_id !== null && b.package_id !== '') {
                if (!UUID.test(String(b.package_id))) throw new InputError('package_id: a package id');
                pkg = (await c.query(`SELECT * FROM assessment_packages WHERE id = $1 AND status <> 'archived'`, [b.package_id])).rows[0];
                if (!pkg) throw new InputError('package_id: no such package');
            }
            const duration = int(b.duration_days, 'duration_days', { min: 1, max: 366 }) ?? pkg?.duration_days;
            if (!duration) throw new InputError('duration_days is required (or choose a package)');
            const retention = int(b.retention_months, 'retention_months', { min: 3, max: 6 }) ?? pkg?.retention_months ?? 3;
            if (retention !== 3 && retention !== 6) throw new InputError('retention_months: 3 or 6');
            const price = int(b.price_cents, 'price_cents', { min: 0 }) ?? (pkg ? Number(pkg.price_cents) : null);
            const quote = {
                package: pkg ? { id: pkg.id, code: pkg.code, name: pkg.name, duration_days: pkg.duration_days, price_cents: Number(pkg.price_cents),
                                 tax_basis: pkg.tax_basis, included_meters: pkg.included_meters, inclusions: pkg.inclusions } : null,
                duration_days: duration,
                agreed_price_cents: price,
                tax_basis: pkg?.tax_basis ?? (b.quote?.tax_basis ?? null),
                lines: Array.isArray(b.quote?.lines) ? b.quote.lines : [],
                snapshot_at: new Date().toISOString(),
            };
            const row = (await c.query(`
                INSERT INTO assessments (tenant_id, project_id, package_id, title, duration_days, planned_start_at, timezone,
                                         quote, price_cents, retention_months, delivery_days, internal_notes, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 7), $12, $13) RETURNING id`,
                [p.tenant_id, p.id, pkg?.id ?? null, str(b.title, 'title', { max: 200 }) ?? `${p.name}: ${duration}-day assessment`,
                 duration, date(b.planned_start_at, 'planned_start_at'), p.timezone ?? 'Africa/Johannesburg', JSON.stringify(quote), price,
                 retention, int(b.delivery_days, 'delivery_days', { min: 0, max: 31 }), str(b.internal_notes, 'internal_notes', { max: 4000 }),
                 req.scope.userId])).rows[0];
            // Points: those named, else every metered point of the project.
            const points: string[] = Array.isArray(b.point_ids) ? b.point_ids.map(String) : [];
            if (points.some((x) => !UUID.test(x))) throw new InputError('point_ids: point ids');
            const ins = await c.query(`
                INSERT INTO assessment_points (assessment_id, measurement_point_id)
                SELECT $1, mp.id FROM measurement_points mp
                WHERE mp.project_id = $2 AND mp.archived_at IS NULL
                  AND (cardinality($3::uuid[]) = 0 AND EXISTS (SELECT 1 FROM deployments d WHERE d.measurement_point_id = mp.id)
                       OR mp.id = ANY($3::uuid[]))
                RETURNING measurement_point_id`, [row.id, p.id, points]);
            if (points.length && ins.rows.length !== points.length) throw new InputError('point_ids: every point must belong to this project');
            const full = await load(c, row.id);
            await audit(c, req.scope, 'assessment.create', 'assessment', row.id, undefined, full);
            return full;
        });
        res.status(201).json(view(out));
    }));

    r.get('/assessments/:id', ...staff, handle(async (req, res) => {
        const a = await load(pool, req.params.id);
        if (!a || (req.scope.filterTenantId && a.tenant_id !== req.scope.filterTenantId)) return res.status(404).json({ error: 'Not found' });
        const grants = await pool.query(`
            SELECT g.*, u.role AS user_role FROM assessment_grants g LEFT JOIN users u ON u.id = g.user_id
            WHERE g.assessment_id = $1 ORDER BY g.revoked_at NULLS FIRST, g.created_at`, [a.id]);
        const log = await pool.query(`
            SELECT at, actor_email, action, reason, before, after FROM audit_log
            WHERE entity_type = 'assessment' AND entity_id = $1 ORDER BY at DESC LIMIT 100`, [a.id]);
        const deployments = await pool.query(`
            SELECT d.id, d.installed_at, d.removed_at, mp.name AS point_name, dv.code AS device_code, dv.id AS device_id
            FROM assessment_points ap JOIN deployments d ON d.measurement_point_id = ap.measurement_point_id
            JOIN measurement_points mp ON mp.id = d.measurement_point_id JOIN devices dv ON dv.id = d.device_id
            WHERE ap.assessment_id = $1 ORDER BY d.installed_at`, [a.id]);
        res.json({ ...view(a), grants: grants.rows, deployments: deployments.rows, audit: log.rows });
    }));

    r.patch('/assessments/:id', ...staff, handle(async (req, res) => {
        const b = req.body ?? {};
        const out = await tx(async (c) => {
            const before = await load(c, req.params.id, true);
            if (!before) return null;
            const sets: string[] = [], vals: unknown[] = [before.id];
            const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
            if (b.title !== undefined) set('title', str(b.title, 'title', { required: true, max: 200 }));
            if (b.internal_notes !== undefined) set('internal_notes', str(b.internal_notes, 'internal_notes', { max: 4000 }));
            if (b.payment_state !== undefined) {
                const ps = oneOf(b.payment_state, ['unpaid', 'invoiced', 'paid', 'exception'] as const, 'payment_state');
                if (ps === 'exception' && !str(b.payment_exception_reason, 'payment_exception_reason')) {
                    throw new InputError('payment_exception_reason is required for a payment exception');
                }
                set('payment_state', ps);
                set('payment_exception_reason', ps === 'exception' ? str(b.payment_exception_reason, 'payment_exception_reason', { max: 1000 }) : null);
            }
            if (b.payment_reference !== undefined) set('payment_reference', str(b.payment_reference, 'payment_reference', { max: 200 }));
            // The commercial terms and duration are fixed once the clock runs.
            const notStarted = before.status === 'draft' || before.status === 'scheduled';
            for (const k of ['duration_days', 'price_cents', 'retention_months', 'planned_start_at', 'delivery_days']) {
                if (b[k] === undefined) continue;
                if (!notStarted && k !== 'retention_months') throw new LifecycleError(`${k} cannot change after the assessment has started; extend it instead`);
                if (k === 'planned_start_at') set(k, date(b[k], k));
                else if (k === 'retention_months') {
                    const m = int(b[k], k, { min: 3, max: 6 });
                    if (m !== 3 && m !== 6) throw new InputError('retention_months: 3 or 6');
                    set(k, m);
                    if (!notStarted) set('retention_until', retentionUntil({ ...before, retention_months: m }));
                } else set(k, int(b[k], k, { min: k === 'duration_days' ? 1 : 0, max: k === 'delivery_days' ? 31 : Number.MAX_SAFE_INTEGER }));
            }
            if (b.retention_exception_until !== undefined) {
                const until = date(b.retention_exception_until, 'retention_exception_until');
                const reason = str(b.retention_exception_reason, 'retention_exception_reason', { max: 1000 });
                if (until && !reason) throw new InputError('retention_exception_reason is required with a retention exception');
                set('retention_exception_until', until);
                set('retention_exception_reason', until ? reason : null);
                if (!notStarted) set('retention_until', retentionUntil({ ...before, retention_exception_until: until }));
            }
            if (Array.isArray(b.point_ids)) {
                if (!notStarted) throw new LifecycleError('Points are fixed once the assessment has started');
                const ids = b.point_ids.map(String);
                if (ids.some((x: string) => !UUID.test(x))) throw new InputError('point_ids: point ids');
                await c.query(`DELETE FROM assessment_points WHERE assessment_id = $1`, [before.id]);
                const ins = await c.query(`
                    INSERT INTO assessment_points (assessment_id, measurement_point_id)
                    SELECT $1, id FROM measurement_points WHERE project_id = $2 AND id = ANY($3::uuid[]) RETURNING 1`,
                    [before.id, before.project_id, ids]);
                if (ins.rows.length !== ids.length) throw new InputError('point_ids: every point must belong to this project');
            }
            if (sets.length) await c.query(`UPDATE assessments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
            const after = await load(c, before.id);
            await audit(c, req.scope, 'assessment.update', 'assessment', before.id, before, after, str(b.reason, 'reason', { max: 1000 }));
            return after;
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.json(view(out));
    }));

    // Lifecycle transitions.
    const transition = (action: 'schedule' | 'start' | 'extend' | 'close' | 'cancel') =>
        handle(async (req, res) => {
            const b = req.body ?? {};
            const reason = str(b.reason, 'reason', { max: 1000 });
            const out = await tx(async (c) => {
                const before = await load(c, req.params.id, true);
                if (!before) return null;
                const now = new Date();
                checkTransition(before, action, now);
                switch (action) {
                    case 'schedule': {
                        const at = date(b.planned_start_at, 'planned_start_at') ?? before.planned_start_at;
                        if (!at) throw new InputError('planned_start_at is required');
                        await c.query(`UPDATE assessments SET status = 'scheduled', planned_start_at = $2, updated_at = NOW() WHERE id = $1`, [before.id, at]);
                        break;
                    }
                    case 'start': {
                        // The clock starts at an explicitly confirmed time: now, or a
                        // commissioning time staff state (not in the future, at most 24 h back).
                        if (b.confirm !== true) throw new InputError('confirm: true is required: the purchased clock starts now and cannot be paused');
                        const start = date(b.start_at, 'start_at') ?? now;
                        if (start.getTime() > now.getTime() + 60_000) throw new InputError('start_at cannot be in the future; schedule instead');
                        if (start.getTime() < now.getTime() - DAY) throw new InputError('start_at may be at most 24 hours back (the confirmed commissioning time)');
                        const pts = (await c.query(`SELECT count(*)::int AS n FROM assessment_points WHERE assessment_id = $1`, [before.id])).rows[0].n;
                        if (!pts) throw new LifecycleError('Assign at least one measurement point before starting');
                        const end = endFor(start, before.duration_days);
                        const ret = retentionUntil({ ...before, start_at: start, end_at: end, closed_at: null });
                        await c.query(`UPDATE assessments SET status = 'active', start_at = $2, end_at = $3, retention_until = $4, updated_at = NOW() WHERE id = $1`,
                            [before.id, start, end, ret]);
                        const gs = (await c.query(`SELECT id, email FROM assessment_grants WHERE assessment_id = $1 AND revoked_at IS NULL`, [before.id])).rows;
                        for (const g of gs) {
                            await enqueueEmail(c, { dedupeKey: `start:${before.id}:${g.id}`, to: g.email, assessmentId: before.id, purpose: 'activation',
                                subject: `GridIQ ${before.reference}: your assessment has started`,
                                text: `Your GridIQ assessment ${before.reference} of ${before.project_name} started at ${start.toISOString().slice(0, 16).replace('T', ' ')} UTC and ends at ${end.toISOString().slice(0, 16).replace('T', ' ')} UTC (${before.duration_days} × 24 hours).\nLive data, history and the consultant are available until then: ${appUrl()}/portal` });
                        }
                        break;
                    }
                    case 'extend': {
                        const days = int(b.days, 'days', { min: 1, max: 90 });
                        if (!days) throw new InputError('days is required');
                        if (!reason) throw new InputError('reason is required: every extension is audited');
                        const end = new Date(new Date(before.end_at).getTime() + days * DAY);
                        // An ended assessment reopens only if the new end is still ahead.
                        const status = end.getTime() > now.getTime() ? 'active' : before.status;
                        const ret = retentionUntil({ ...before, end_at: end });
                        await c.query(`UPDATE assessments SET end_at = $2, duration_days = duration_days + $3, status = $4, retention_until = $5, updated_at = NOW() WHERE id = $1`,
                            [before.id, end, days, status, ret]);
                        break;
                    }
                    case 'close': {
                        if (!reason) throw new InputError('reason is required to close an assessment early');
                        const ret = retentionUntil({ ...before, closed_at: now });
                        await c.query(`UPDATE assessments SET status = 'ended', closed_at = $2, close_reason = $3, retention_until = $4, updated_at = NOW() WHERE id = $1`,
                            [before.id, now, reason, ret]);
                        break;
                    }
                    case 'cancel': {
                        if (!reason) throw new InputError('reason is required to cancel');
                        await c.query(`UPDATE assessments SET status = 'cancelled', close_reason = $2, updated_at = NOW() WHERE id = $1`, [before.id, reason]);
                        break;
                    }
                }
                const after = await load(c, before.id);
                await audit(c, req.scope, `assessment.${action}`, 'assessment', before.id, before, after, reason);
                return after;
            });
            if (!out) return res.status(404).json({ error: 'Not found' });
            res.json(view(out));
        });
    // Spelled out (not a loop) so the scoping test's route scan sees each one.
    r.post('/assessments/:id/schedule', ...staff, transition('schedule'));
    r.post('/assessments/:id/start', ...staff, transition('start'));
    r.post('/assessments/:id/extend', ...staff, transition('extend'));
    r.post('/assessments/:id/close', ...staff, transition('close'));
    r.post('/assessments/:id/cancel', ...staff, transition('cancel'));

    // ── Access grants ───────────────────────────────────────────────────────
    r.post('/assessments/:id/grants', ...staff, handle(async (req, res) => {
        const b = req.body ?? {};
        const email = str(b.email, 'email', { required: true, max: 254 })!.toLowerCase();
        if (!EMAIL.test(email)) throw new InputError('email: an email address');
        const out = await tx(async (c) => {
            const a = await load(c, req.params.id, true);
            if (!a) return null;
            if (a.status === 'cancelled') throw new LifecycleError('This assessment was cancelled');
            const users = (await c.query(`SELECT id, tenant_id, role FROM users WHERE lower(email) = $1`, [email])).rows;
            const other = users.find((u) => u.tenant_id !== a.tenant_id);
            if (other) throw new LifecycleError('This email belongs to a user of another organisation; use an address of the client');
            const user = users[0] ?? null;
            const row = (await c.query(`
                INSERT INTO assessment_grants (assessment_id, user_id, email, receives_reports, created_by)
                VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [a.id, user?.id ?? null, email, b.receives_reports !== false, req.scope.userId])).rows[0];
            await audit(c, req.scope, 'assessment.grant', 'assessment', a.id, undefined, row);
            // Invitation: sign in with an email code; nothing reusable is sent.
            await enqueueEmail(c, { dedupeKey: `invite:${row.id}`, to: email, assessmentId: a.id, purpose: 'invite',
                subject: `GridIQ: you have access to ${a.reference} (${a.project_name})`,
                text: [`You have been given access to the GridIQ assessment ${a.reference} of ${a.project_name}.`, '',
                    a.start_at ? `It runs from ${new Date(a.start_at).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(a.end_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
                        : 'You will receive another message when the measurement period starts.',
                    '', `Sign in with this email address at ${appUrl()}/login (a one-time code is emailed to you each time).`].join('\n') });
            return { ...row, user_exists: !!user };
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.status(201).json(out);
    }));

    r.post('/assessments/:id/grants/:grantId/revoke', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id) || !UUID.test(req.params.grantId)) return res.status(404).json({ error: 'Not found' });
        const reason = str(req.body?.reason, 'reason', { required: true, max: 1000 });
        const out = await tx(async (c) => {
            const before = (await c.query(`SELECT * FROM assessment_grants WHERE id = $1 AND assessment_id = $2 FOR UPDATE`, [req.params.grantId, req.params.id])).rows[0];
            if (!before) return null;
            if (before.revoked_at) throw new LifecycleError('Already revoked');
            const after = (await c.query(`UPDATE assessment_grants SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 RETURNING *`,
                [before.id, req.scope.userId, reason])).rows[0];
            await audit(c, req.scope, 'assessment.revoke', 'assessment', req.params.id, before, after, reason);
            return after;
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.json(out);
    }));

    // ── Client view ─────────────────────────────────────────────────────────
    // The caller's own assessments (through a grant, live or not): dates, time
    // remaining, delivery window and deletion date. Never other users' grants,
    // prices or internal notes.
    r.get('/portal/assessments', auth, handle(async (req, res) => {
        if (req.scope.isInternal) {
            const q = await pool.query(`${selectAssessment} WHERE a.status IN ('active', 'scheduled') ORDER BY a.end_at NULLS LAST LIMIT 200`);
            return res.json(q.rows.map(view));
        }
        if (!req.scope.userId || !UUID.test(String(req.scope.userId)) || !req.scope.tenantId) return res.json([]);
        const q = await pool.query(`${selectAssessment}
            WHERE a.tenant_id = $2 AND a.status <> 'draft' AND a.status <> 'cancelled'
              AND EXISTS (SELECT 1 FROM assessment_grants g WHERE g.assessment_id = a.id AND g.revoked_at IS NULL
                          AND (g.user_id = $1 OR (g.user_id IS NULL AND g.email = (SELECT lower(email) FROM users WHERE id = $1))))
            ORDER BY a.start_at DESC NULLS LAST`, [req.scope.userId, req.scope.tenantId]);
        res.json(q.rows.map((a) => {
            const out: any = {};
            for (const k of CLIENT_FIELDS) out[k] = a[k];
            return forClient(req.scope, { ...out, ...clockView(a) });
        }));
    }));

    // ── Fleet asset history ─────────────────────────────────────────────────
    r.get('/devices/:id/maintenance', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const q = await pool.query(`SELECT * FROM maintenance_events WHERE device_id = $1 ORDER BY occurred_at DESC`, [req.params.id]);
        res.json(q.rows);
    }));

    r.post('/devices/:id/maintenance', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const b = req.body ?? {};
        const kind = oneOf(b.kind, ['maintenance', 'calibration', 'inspection', 'fault', 'repair', 'firmware'] as const, 'kind');
        if (!kind) throw new InputError('kind is required');
        const at = date(b.occurred_at, 'occurred_at') ?? new Date();
        const description = str(b.description, 'description', { required: true, max: 4000 });
        const nextDue = b.next_due_on ? String(b.next_due_on) : null;
        if (nextDue && !/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) throw new InputError('next_due_on: YYYY-MM-DD');
        const out = await tx(async (c) => {
            const dev = (await c.query(`SELECT id, calibration_due_on FROM devices WHERE id = $1`, [req.params.id])).rows[0];
            if (!dev) return null;
            const row = (await c.query(`
                INSERT INTO maintenance_events (device_id, occurred_at, kind, description, technician, outcome, cost_cents, next_due_on, evidence, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::jsonb, '{}'::jsonb), $10) RETURNING *`,
                [dev.id, at, kind, description, str(b.technician, 'technician', { max: 200 }), str(b.outcome, 'outcome', { max: 2000 }),
                 int(b.cost_cents, 'cost_cents', { min: 0 }), nextDue, b.evidence ? JSON.stringify(b.evidence) : null, req.scope.userId])).rows[0];
            // A calibration sets the device's next calibration date.
            if (kind === 'calibration' && nextDue) await c.query(`UPDATE devices SET calibration_due_on = $2 WHERE id = $1`, [dev.id, nextDue]);
            await audit(c, req.scope, `device.${kind}`, 'device', dev.id, undefined, row);
            return row;
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.status(201).json(out);
    }));

    r.get('/devices/:id/history', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const dev = (await pool.query(`SELECT * FROM devices WHERE id = $1`, [req.params.id])).rows[0];
        if (!dev) return res.status(404).json({ error: 'Not found' });
        const deployments = await pool.query(`
            SELECT d.id, d.installed_at, d.removed_at, d.planned_install_at, d.planned_removal_at,
                   mp.id AS point_id, mp.name AS point_name, p.id AS project_id, p.name AS project_name, t.name AS client_name
            FROM deployments d JOIN measurement_points mp ON mp.id = d.measurement_point_id
            JOIN projects p ON p.id = mp.project_id JOIN tenants t ON t.id = p.tenant_id
            WHERE d.device_id = $1 ORDER BY d.installed_at DESC`, [dev.id]);
        const maintenance = await pool.query(`SELECT * FROM maintenance_events WHERE device_id = $1 ORDER BY occurred_at DESC`, [dev.id]);
        const assessments = await pool.query(`
            SELECT DISTINCT a.id, a.reference, a.title, a.status, a.start_at, a.end_at, a.closed_at, t.name AS client_name
            FROM deployments d JOIN assessment_points ap ON ap.measurement_point_id = d.measurement_point_id
            JOIN assessments a ON a.id = ap.assessment_id JOIN tenants t ON t.id = a.tenant_id
            WHERE d.device_id = $1
              -- the assessment overlapped this device's time at the point
              AND (a.start_at IS NULL OR ((d.removed_at IS NULL OR a.start_at < d.removed_at) AND (a.end_at IS NULL OR d.installed_at < a.end_at)))
            ORDER BY a.start_at DESC NULLS LAST`, [dev.id]);
        const timeline = [
            ...deployments.rows.flatMap((d) => [
                { at: d.installed_at, kind: 'install', text: `Installed at ${d.client_name} · ${d.project_name} · ${d.point_name}`, ref: d.id },
                ...(d.removed_at ? [{ at: d.removed_at, kind: 'removal', text: `Removed from ${d.client_name} · ${d.project_name}`, ref: d.id }] : []),
            ]),
            ...maintenance.rows.map((m) => ({ at: m.occurred_at, kind: m.kind, text: m.description, ref: m.id })),
        ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        res.json({ device: dev, deployments: deployments.rows, maintenance: maintenance.rows, assessments: assessments.rows, timeline,
                   health: await deviceHealth(pool, dev.id) });
    }));

    return r;
}

/**
 * Jobs role follow-up (not the security boundary: access already stops in SQL
 * at end_at): marks assessments past their end as ended and audits it.
 */
export async function expireAssessments(pool: Pool): Promise<number> {
    const q = await pool.query(`
        UPDATE assessments SET status = 'ended', updated_at = NOW()
        WHERE status = 'active' AND end_at <= NOW()
        RETURNING id, end_at`);
    for (const a of q.rows) {
        await pool.query(`
            INSERT INTO audit_log (actor_email, action, entity_type, entity_id, after, reason)
            VALUES ('system', 'assessment.expire', 'assessment', $1, $2, 'end_at reached')`, [a.id, JSON.stringify({ end_at: a.end_at })]);
    }
    return q.rows.length;
}

/**
 * Health of one device, as separate dimensions (prompt section 7): a box that
 * talks but sends stale values is not measuring; missing messages do not
 * prove an outage; a measured zero is a valid measurement.
 *   communication   last message received (ingested_at), any timestamp
 *   freshness       last measurement timestamp (device time) and its lag
 *   completeness    received vs expected samples over 24 h, at its own cadence
 *   quality         clock drift, duplicate/conflicting timestamps, unmapped channels
 *   electrical      open alerts from measured values (7 days), never inferred from silence
 */
export async function deviceHealth(db: Pool, deviceId: string) {
    const r = (await db.query(`
        WITH recent AS (
            SELECT time, ingested_at, device_time FROM meter_readings
            WHERE meter_id = $1 AND time > NOW() - INTERVAL '2 days'
        )
        SELECT (SELECT max(ingested_at) FROM recent) AS last_contact,
               (SELECT max(time) FROM recent) AS last_measurement,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(extract(epoch FROM ingested_at - device_time)))
                  FROM recent WHERE ingested_at > NOW() - INTERVAL '1 hour' AND device_time IS NOT NULL) AS clock_lag_s,
               (SELECT ROUND(device_coverage($1, NOW() - INTERVAL '24 hours')::numeric, 3)) AS coverage_24h,
               (SELECT COALESCE(sum(conflicts), 0)::int FROM ingest_stats WHERE meter_id = $1 AND hour > NOW() - INTERVAL '24 hours') AS conflicts_24h,
               (SELECT count(*)::int FROM ingest_unknown_params WHERE meter_id = $1) AS unknown_params,
               (SELECT count(*)::int FROM alerts WHERE meter_id = $1 AND NOT is_read AND created_at > NOW() - INTERVAL '7 days'
                  AND type NOT IN ('METER_SILENT', 'LOW_COVERAGE', 'CLOCK_DRIFT', 'CONFLICTS_RISING')) AS electrical_alerts_7d
        `, [deviceId])).rows[0];
    const ago = (d: Date | null) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 1000) : null);
    return {
        communication: { last_contact_at: r.last_contact, seconds_ago: ago(r.last_contact),
            basis: 'when the platform last received a message from this box (any timestamp)' },
        freshness: { last_measurement_at: r.last_measurement, seconds_ago: ago(r.last_measurement),
            basis: 'device timestamp of the newest stored measurement; a backlog replay can be recent contact with old measurements' },
        completeness: { coverage_24h: r.coverage_24h === null ? null : Number(r.coverage_24h),
            basis: 'samples received in the last 24 h ÷ samples expected at the box’s own median reporting interval' },
        quality: { clock_lag_s: r.clock_lag_s === null ? null : Math.round(Number(r.clock_lag_s)), conflicts_24h: r.conflicts_24h,
            unknown_params: r.unknown_params,
            basis: 'median |receive time − device time| over the last hour; duplicate timestamps with different values; channels not mapped' },
        electrical: { open_alerts_7d: r.electrical_alerts_7d,
            basis: 'alerts raised from measured values (voltage, THD, demand, events); silence is never treated as an outage' },
    };
}
