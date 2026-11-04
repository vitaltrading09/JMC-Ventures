// ─────────────────────────────────────────────────────────────────────────────
// Fleet API (plan Phase 6, item 8): projects, measurement points, devices,
// deployments, /fleet. Internal roles only, except the energy balance, which
// a client can read for its own projects.
//
// Delete = archive, as everywhere else: projects and points get archived_at,
// a device is retired. Corrections to a deployment need a reason and are
// written to audit_log (who, when, why, before and after).
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { projectEnergyBalance } from './balance';
import { findSite, withScope } from '../scope';

/** Roles that work across tenants. Phase 7 adds 'engineer'. */
export const INTERNAL_ROLES = new Set(['super_admin', 'engineer']);

export const isInternal = (user: any) => !!user && INTERNAL_ROLES.has(user.role);

const PROJECT_STATUSES = ['planned', 'active', 'completed', 'archived'];
const POINT_ROLES = ['incomer', 'sub_load', 'pv', 'bess', 'generator', 'other'];
const DEVICE_STATUSES = ['in_stock', 'deployed', 'maintenance', 'retired'];

export class InputError extends Error {}

// ── Input helpers (exported for tests) ──────────────────────────────────────

/** Fleet code: upper-case letters, digits and hyphens, e.g. GQ-M01. */
export function normaliseCode(v: unknown): string {
    const code = String(v ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code)) throw new InputError('code: 2–32 letters, digits or hyphens, e.g. GQ-M01');
    return code;
}

/** Broker username (and topic segment) for a fleet device. */
export const mqttUsernameFor = (code: string) => code.toLowerCase();

export function optDate(v: unknown, field: string): Date | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new InputError(`${field}: not a valid date-time`);
    return d;
}

function optNum(v: unknown, field: string, { positive = false } = {}): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || (positive && n <= 0)) throw new InputError(`${field}: ${positive ? 'a positive number' : 'a number'}`);
    return n;
}

function oneOf(v: unknown, allowed: string[], field: string): string | undefined {
    if (v === undefined) return undefined;
    if (!allowed.includes(String(v))) throw new InputError(`${field}: one of ${allowed.join(', ')}`);
    return String(v);
}

/**
 * Picks the allowed fields present in a body into a column → value map,
 * validated. Unknown fields are ignored.
 */
type FieldSpec = Record<string, (v: unknown) => unknown>;
export function pickFields(body: any, spec: FieldSpec): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, parse] of Object.entries(spec)) {
        if (body && Object.prototype.hasOwnProperty.call(body, k)) out[k] = parse(body[k]);
    }
    return out;
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const bool = (field: string) => (v: unknown) => {
    if (typeof v !== 'boolean') throw new InputError(`${field}: true or false`);
    return v;
};
const date = (field: string) => (v: unknown) => {
    if (v === null || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new InputError(`${field}: YYYY-MM-DD`);
    return String(v);
};

const PROJECT_FIELDS: FieldSpec = {
    name: text, address: text, end_client_name: text, timezone: text, notes: text,
    gps_lat: (v) => optNum(v, 'gps_lat'), gps_lon: (v) => optNum(v, 'gps_lon'),
    status: (v) => oneOf(v, PROJECT_STATUSES, 'status'),
    starts_on: date('starts_on'), ends_on: date('ends_on'),
    live_data_visible: bool('live_data_visible'),
};
const POINT_FIELDS: FieldSpec = {
    name: text,
    role: (v) => oneOf(v, POINT_ROLES, 'role'),
    parent_point_id: text,
    nominal_voltage_v: (v) => optNum(v, 'nominal_voltage_v', { positive: true }),
    ct_primary_a: (v) => optNum(v, 'ct_primary_a', { positive: true }),
    breaker_rating_a: (v) => optNum(v, 'breaker_rating_a', { positive: true }),
    declared_capacity_kva: (v) => optNum(v, 'declared_capacity_kva', { positive: true }),
    contracted_mdi_kva: (v) => optNum(v, 'contracted_mdi_kva', { positive: true }),
    sort_order: (v) => optNum(v, 'sort_order'),
};
const DEVICE_FIELDS: FieldSpec = {
    name: text, serial_number: text, model: text, comms_module: text, firmware: text,
    router_model: text, sim_iccid: text, notes: text,
    calibration_due_on: date('calibration_due_on'),
    status: (v) => oneOf(v, DEVICE_STATUSES.filter((s) => s !== 'deployed'), 'status'),
};
export const CORRECTION_FIELDS: FieldSpec = {
    power_sign: (v) => {
        if (Number(v) !== 1 && Number(v) !== -1) throw new InputError('power_sign: 1 or -1');
        return Number(v);
    },
    scale_correction: (v) => optNum(v, 'scale_correction', { positive: true }) ?? 1,
    ct_ratio_configured: (v) => optNum(v, 'ct_ratio_configured', { positive: true }),
    pt_ratio_configured: (v) => optNum(v, 'pt_ratio_configured', { positive: true }),
};

/** "col1 = $2, col2 = $3" for an UPDATE, values after the id. */
function setClause(fields: Record<string, unknown>, offset = 2) {
    const cols = Object.keys(fields);
    return { sql: cols.map((c, i) => `${c} = $${i + offset}`).join(', '), values: cols.map((c) => fields[c]) };
}

/** Postgres constraint errors → HTTP. */
export function dbErrorResponse(e: any): { status: number; error: string } | null {
    switch (e?.code) {
        case '23P01': return {
            status: 409,
            error: e.constraint === 'deployments_point_no_overlap'
                ? 'The point already has a device installed in that time window'
                : 'The device is already deployed in that time window',
        };
        case '23505': return { status: 409, error: `Already exists (${e.constraint ?? 'unique'})` };
        case '23514': return { status: 400, error: `Value not allowed (${e.constraint ?? 'check'})` };
        case '23503': return { status: 400, error: 'Refers to a record that does not exist' };
        case '22P02': return { status: 400, error: 'Malformed id' };
        default: return null;
    }
}

async function audit(db: Pool | PoolClient, user: any, action: string, entityType: string, entityId: string,
                     before: unknown, after: unknown, reason: string | null = null) {
    await db.query(`
        INSERT INTO audit_log (actor_user_id, actor_email, action, entity_type, entity_id, before, after, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [user?.userId ?? null, user?.email ?? null, action, entityType, entityId,
         before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason]);
}

// ── Router ──────────────────────────────────────────────────────────────────

export function fleetRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const authenticate = withScope(authenticateJwt);
    const internal = (req: any, res: any, next: any) => (isInternal(req.user) ? next() : res.status(403).json({ error: 'Internal users only' }));
    const guard = [authenticate, internal];

    // Wraps a handler: input and constraint errors become 4xx.
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try {
            await fn(req, res);
        } catch (e: any) {
            if (e instanceof InputError) return res.status(400).json({ error: e.message });
            const mapped = dbErrorResponse(e);
            if (mapped) return res.status(mapped.status).json({ error: mapped.error });
            console.error(`[fleet] ${req.method} ${req.path}:`, e);
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
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            c.release();
        }
    };

    // ── Projects ────────────────────────────────────────────────────────────
    r.get('/projects', ...guard, handle(async (req, res) => {
        const where: string[] = [], vals: unknown[] = [];
        if (req.query.tenant_id) { vals.push(req.query.tenant_id); where.push(`p.tenant_id = $${vals.length}`); }
        if (req.query.status) { vals.push(oneOf(req.query.status, PROJECT_STATUSES, 'status')); where.push(`p.status = $${vals.length}`); }
        const q = await pool.query(`
            SELECT p.*, t.name AS tenant_name,
                   (SELECT count(*) FROM measurement_points mp WHERE mp.project_id = p.id AND mp.archived_at IS NULL)::int AS points,
                   (SELECT count(*) FROM deployments d JOIN measurement_points mp ON mp.id = d.measurement_point_id
                    WHERE mp.project_id = p.id AND d.removed_at IS NULL)::int AS active_deployments
            FROM projects p JOIN tenants t ON t.id = p.tenant_id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY t.name, p.name`, vals);
        res.json(q.rows);
    }));

    r.post('/projects', ...guard, handle(async (req, res) => {
        const f = pickFields(req.body, PROJECT_FIELDS);
        if (!req.body?.tenant_id) throw new InputError('tenant_id is required');
        if (!f.name) throw new InputError('name is required');
        const cols = ['tenant_id', ...Object.keys(f)];
        const vals = [req.body.tenant_id, ...Object.values(f)];
        const q = await pool.query(
            `INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
        res.status(201).json(q.rows[0]);
    }));

    r.get('/projects/:id', ...guard, handle(async (req, res) => {
        const p = await pool.query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
        if (!p.rows.length) return res.status(404).json({ error: 'Not found' });
        const points = await pool.query(`
            SELECT mp.*, d.id AS deployment_id, d.device_id, dv.code AS device_code, dv.name AS device_name, d.installed_at
            FROM measurement_points mp
            LEFT JOIN deployments d ON d.measurement_point_id = mp.id AND d.removed_at IS NULL
            LEFT JOIN devices dv ON dv.id = d.device_id
            WHERE mp.project_id = $1
            ORDER BY mp.sort_order, mp.name`, [req.params.id]);
        res.json({ ...p.rows[0], points: points.rows });
    }));

    r.patch('/projects/:id', ...guard, handle(async (req, res) => {
        const f = pickFields(req.body, PROJECT_FIELDS);
        if (!Object.keys(f).length) throw new InputError('Nothing to update');
        const s = setClause(f);
        const q = await pool.query(`UPDATE projects SET ${s.sql} WHERE id = $1 RETURNING *`, [req.params.id, ...s.values]);
        if (!q.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(q.rows[0]);
    }));

    r.delete('/projects/:id', ...guard, handle(async (req, res) => {
        const q = await pool.query(
            `UPDATE projects SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id, archived_at, status`, [req.params.id]);
        if (!q.rows.length) return res.status(404).json({ error: 'Not found or already archived' });
        res.json({ archived: true, ...q.rows[0] });
    }));

    // Energy balance: internal users for any project, client users for their
    // own, through the central scope (and only where live data is shared).
    r.get('/projects/:id/energy-balance', authenticate, handle(async (req, res) => {
        const p = await findSite(pool, req.scope, req.params.id);
        if (!p || !p.telemetry_visible) return res.status(404).json({ error: 'Not found' });
        const to = optDate(req.query.to, 'to') ?? new Date();
        const from = optDate(req.query.from, 'from') ?? new Date(to.getTime() - 30 * 86_400_000);
        if (from >= to) throw new InputError('from must be before to');
        if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new InputError('At most 400 days per request');
        res.json(await projectEnergyBalance(pool, req.params.id, from, to));
    }));

    // ── Measurement points ──────────────────────────────────────────────────
    r.post('/projects/:id/points', ...guard, handle(async (req, res) => {
        const f = pickFields(req.body, POINT_FIELDS);
        if (!f.name) throw new InputError('name is required');
        if (f.parent_point_id) await assertSameProject(pool, String(f.parent_point_id), req.params.id);
        const cols = ['project_id', ...Object.keys(f)];
        const q = await pool.query(
            `INSERT INTO measurement_points (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
            [req.params.id, ...Object.values(f)]);
        res.status(201).json(q.rows[0]);
    }));

    r.patch('/points/:id', ...guard, handle(async (req, res) => {
        const f = pickFields(req.body, POINT_FIELDS);
        if (!Object.keys(f).length) throw new InputError('Nothing to update');
        if (f.parent_point_id) {
            const own = await pool.query(`SELECT project_id FROM measurement_points WHERE id = $1`, [req.params.id]);
            if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
            await assertSameProject(pool, String(f.parent_point_id), own.rows[0].project_id);
        }
        const s = setClause(f);
        const q = await pool.query(`UPDATE measurement_points SET ${s.sql} WHERE id = $1 RETURNING *`, [req.params.id, ...s.values]);
        if (!q.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(q.rows[0]);
    }));

    r.delete('/points/:id', ...guard, handle(async (req, res) => {
        const active = await pool.query(`SELECT 1 FROM deployments WHERE measurement_point_id = $1 AND removed_at IS NULL`, [req.params.id]);
        if (active.rows.length) return res.status(409).json({ error: 'Remove the device installed at this point first' });
        const q = await pool.query(
            `UPDATE measurement_points SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id, archived_at`, [req.params.id]);
        if (!q.rows.length) return res.status(404).json({ error: 'Not found or already archived' });
        res.json({ archived: true, ...q.rows[0] });
    }));

    // ── Devices ─────────────────────────────────────────────────────────────
    r.get('/devices', ...guard, handle(async (req, res) => {
        const vals: unknown[] = [];
        let where = '';
        if (req.query.status) { vals.push(oneOf(req.query.status, DEVICE_STATUSES, 'status')); where = 'WHERE status = $1'; }
        res.json((await pool.query(`SELECT * FROM devices ${where} ORDER BY code NULLS LAST, name`, vals)).rows);
    }));

    r.post('/devices', ...guard, handle(async (req, res) => {
        const code = normaliseCode(req.body?.code);
        const f = pickFields(req.body, DEVICE_FIELDS);
        const row: Record<string, unknown> = { name: code, ...f, code, mqtt_username: mqttUsernameFor(code) };
        const q = await tx(async (c) => {
            const ins = await c.query(
                `INSERT INTO devices (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
                Object.values(row));
            await audit(c, req.user, 'device.create', 'device', ins.rows[0].id, undefined, ins.rows[0]);
            return ins;
        });
        res.status(201).json({
            ...q.rows[0],
            mqtt: {
                username: q.rows[0].mqtt_username,
                topic: `acuvim/${q.rows[0].mqtt_username}/telemetry`,
                note: 'Create the broker user with this username (docs/RUNBOOK.md → MQTT credentials)',
            },
        });
    }));

    r.get('/devices/:id', ...guard, handle(async (req, res) => {
        const d = await pool.query(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
        if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
        const history = await pool.query(`
            SELECT dep.*, mp.name AS point_name, mp.role, pr.id AS project_id, pr.name AS project_name, t.name AS tenant_name
            FROM deployments dep
            JOIN measurement_points mp ON mp.id = dep.measurement_point_id
            JOIN projects pr ON pr.id = mp.project_id
            JOIN tenants t ON t.id = pr.tenant_id
            WHERE dep.device_id = $1 ORDER BY dep.installed_at DESC`, [req.params.id]);
        res.json({ ...d.rows[0], deployments: history.rows });
    }));

    r.patch('/devices/:id', ...guard, handle(async (req, res) => {
        if (req.body && 'code' in req.body) throw new InputError('code cannot change: it is the broker username');
        const f = pickFields(req.body, DEVICE_FIELDS);
        if (!Object.keys(f).length) throw new InputError('Nothing to update');
        const out = await tx(async (c) => {
            const before = await c.query(`SELECT * FROM devices WHERE id = $1 FOR UPDATE`, [req.params.id]);
            if (!before.rows.length) return null;
            if (f.status && before.rows[0].status === 'deployed') {
                throw new InputError('The device is deployed: remove the deployment to change its status');
            }
            const s = setClause(f);
            const after = await c.query(`UPDATE devices SET ${s.sql} WHERE id = $1 RETURNING *`, [req.params.id, ...s.values]);
            await audit(c, req.user, 'device.update', 'device', req.params.id, before.rows[0], after.rows[0]);
            return after.rows[0];
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.json(out);
    }));

    r.delete('/devices/:id', ...guard, handle(async (req, res) => {
        const out = await tx(async (c) => {
            const before = await c.query(`SELECT * FROM devices WHERE id = $1 FOR UPDATE`, [req.params.id]);
            if (!before.rows.length) return { status: 404, body: { error: 'Not found' } };
            const active = await c.query(`SELECT 1 FROM deployments WHERE device_id = $1 AND removed_at IS NULL`, [req.params.id]);
            if (active.rows.length) return { status: 409, body: { error: 'Remove the deployment first' } };
            const after = await c.query(
                `UPDATE devices SET status = 'retired', is_active = false, archived_at = COALESCE(archived_at, NOW()) WHERE id = $1 RETURNING *`,
                [req.params.id]);
            await audit(c, req.user, 'device.retire', 'device', req.params.id, before.rows[0], after.rows[0], text(req.body?.reason));
            return { status: 200, body: { retired: true, ...after.rows[0] } };
        });
        res.status(out.status).json(out.body);
    }));

    // ── Deployments ─────────────────────────────────────────────────────────
    r.post('/deployments', ...guard, handle(async (req, res) => {
        const b = req.body ?? {};
        if (!b.device_id || !b.measurement_point_id) throw new InputError('device_id and measurement_point_id are required');
        const installedAt = optDate(b.installed_at, 'installed_at') ?? new Date();
        if (installedAt.getTime() > Date.now() + 5 * 60_000) throw new InputError('installed_at is in the future');
        const corr = pickFields(b, CORRECTION_FIELDS);
        const out = await tx(async (c) => {
            const dev = await c.query(`SELECT * FROM devices WHERE id = $1 FOR UPDATE`, [b.device_id]);
            if (!dev.rows.length) return { status: 404, body: { error: 'Device not found' } };
            if (dev.rows[0].status === 'retired') return { status: 409, body: { error: 'The device is retired' } };
            const pt = await c.query(`
                SELECT mp.project_id, mp.archived_at, pr.archived_at AS project_archived_at
                FROM measurement_points mp JOIN projects pr ON pr.id = mp.project_id WHERE mp.id = $1`, [b.measurement_point_id]);
            if (!pt.rows.length) return { status: 404, body: { error: 'Measurement point not found' } };
            if (pt.rows[0].archived_at || pt.rows[0].project_archived_at) return { status: 409, body: { error: 'The point or its project is archived' } };
            const row: Record<string, unknown> = {
                device_id: b.device_id, measurement_point_id: b.measurement_point_id, installed_at: installedAt,
                installed_by: text(b.installed_by) ?? req.user?.email ?? req.user?.userId ?? null,
                ct_ratio_configured: dev.rows[0].ct_ratio ?? null, pt_ratio_configured: dev.rows[0].pt_ratio ?? null,
                ...corr,
            };
            const ins = await c.query(
                `INSERT INTO deployments (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
                Object.values(row));
            // The legacy pages find a device by site_id: point it at the new project.
            await c.query(`UPDATE devices SET status = 'deployed', site_id = $2, is_active = true WHERE id = $1`,
                [b.device_id, pt.rows[0].project_id]);
            await audit(c, req.user, 'deployment.install', 'deployment', ins.rows[0].id, undefined, ins.rows[0]);
            return { status: 201, body: ins.rows[0] };
        });
        res.status(out.status).json(out.body);
    }));

    r.get('/deployments/:id', ...guard, handle(async (req, res) => {
        const d = await pool.query(`
            SELECT dep.*, dv.code AS device_code, dv.name AS device_name, mp.name AS point_name, mp.role,
                   pr.id AS project_id, pr.name AS project_name
            FROM deployments dep JOIN devices dv ON dv.id = dep.device_id
            JOIN measurement_points mp ON mp.id = dep.measurement_point_id
            JOIN projects pr ON pr.id = mp.project_id
            WHERE dep.id = $1`, [req.params.id]);
        if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
        const log = await pool.query(
            `SELECT at, actor_email, action, before, after, reason FROM audit_log
             WHERE entity_type = 'deployment' AND entity_id = $1 ORDER BY at`, [req.params.id]);
        res.json({ ...d.rows[0], audit: log.rows });
    }));

    r.post('/deployments/:id/remove', ...guard, handle(async (req, res) => {
        const removedAt = optDate(req.body?.removed_at, 'removed_at') ?? new Date();
        const nextStatus = oneOf(req.body?.device_status ?? 'in_stock', ['in_stock', 'maintenance'], 'device_status');
        const out = await tx(async (c) => {
            const before = await c.query(`SELECT * FROM deployments WHERE id = $1 FOR UPDATE`, [req.params.id]);
            if (!before.rows.length) return { status: 404, body: { error: 'Not found' } };
            if (before.rows[0].removed_at) return { status: 409, body: { error: 'Already removed' } };
            if (removedAt <= new Date(before.rows[0].installed_at)) throw new InputError('removed_at must be after installed_at');
            const after = await c.query(`UPDATE deployments SET removed_at = $2 WHERE id = $1 RETURNING *`, [req.params.id, removedAt]);
            await c.query(`UPDATE devices SET status = $2 WHERE id = $1`, [before.rows[0].device_id, nextStatus]);
            await audit(c, req.user, 'deployment.remove', 'deployment', req.params.id, before.rows[0], after.rows[0], text(req.body?.reason));
            return { status: 200, body: after.rows[0] };
        });
        res.status(out.status).json(out.body);
    }));

    // Corrections: sign, scale, configured ratios. Never touches raw data.
    r.patch('/deployments/:id/corrections', ...guard, handle(async (req, res) => {
        const reason = text(req.body?.reason)?.trim();
        if (!reason) throw new InputError('reason is required: every correction is audit-logged');
        const f = pickFields(req.body, CORRECTION_FIELDS);
        if (!Object.keys(f).length) throw new InputError('Nothing to correct (power_sign, scale_correction, ct_ratio_configured, pt_ratio_configured)');
        const out = await tx(async (c) => {
            const before = await c.query(`SELECT * FROM deployments WHERE id = $1 FOR UPDATE`, [req.params.id]);
            if (!before.rows.length) return null;
            const s = setClause(f);
            const after = await c.query(`UPDATE deployments SET ${s.sql} WHERE id = $1 RETURNING *`, [req.params.id, ...s.values]);
            const pick = (row: any) => Object.fromEntries(Object.keys(f).map((k) => [k, row[k]]));
            await audit(c, req.user, 'deployment.correct', 'deployment', req.params.id, pick(before.rows[0]), pick(after.rows[0]), reason);
            return after.rows[0];
        });
        if (!out) return res.status(404).json({ error: 'Not found' });
        res.json(out);
    }));

    // ── Fleet overview ──────────────────────────────────────────────────────
    r.get('/fleet', ...guard, handle(async (req, res) => {
        const vals: unknown[] = [];
        let where = '';
        if (req.query.status) { vals.push(oneOf(req.query.status, DEVICE_STATUSES, 'status')); where = 'WHERE dv.status = $1'; }
        const q = await pool.query(`
            WITH lag AS (
                SELECT meter_id, date_trunc('minute', ingested_at) AS minute,
                       min(abs(extract(epoch FROM ingested_at - device_time))) AS lag_s
                FROM meter_readings
                WHERE time >= NOW() - INTERVAL '75 minutes' AND ingested_at >= NOW() - INTERVAL '1 hour'
                  AND device_time IS NOT NULL
                GROUP BY 1, 2
            ), drift AS (
                SELECT meter_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_s) AS drift_s FROM lag GROUP BY 1
            ), cover AS (
                SELECT meter_id, count(*) AS minutes FROM readings_1m
                WHERE bucket >= NOW() - INTERVAL '24 hours' GROUP BY 1
            ), bytes AS (
                SELECT meter_id, SUM(payload_bytes) AS b FROM ingest_stats
                WHERE hour >= date_trunc('hour', NOW()) - INTERVAL '23 hours' GROUP BY 1
            )
            SELECT dv.id, dv.code, dv.name, dv.serial_number, dv.model, dv.status, dv.mqtt_username,
                   dv.calibration_due_on, dv.firmware, dv.comms_module,
                   dep.id AS deployment_id, dep.installed_at, dep.commissioning->>'overall' AS commissioning,
                   mp.id AS point_id, mp.name AS point_name, mp.role AS point_role,
                   pr.id AS project_id, pr.name AS project_name, t.name AS tenant_name,
                   (SELECT max(time) FROM meter_readings r WHERE r.meter_id = dv.id AND r.time >= NOW() - INTERVAL '30 days') AS last_seen,
                   ROUND(COALESCE(cover.minutes, 0) / 1440.0, 3) AS coverage_24h,
                   ROUND(drift.drift_s::numeric, 1) AS clock_drift_s,
                   COALESCE(bytes.b, 0)::bigint AS payload_bytes_24h
            FROM devices dv
            LEFT JOIN deployments dep ON dep.device_id = dv.id AND dep.removed_at IS NULL
            LEFT JOIN measurement_points mp ON mp.id = dep.measurement_point_id
            LEFT JOIN projects pr ON pr.id = mp.project_id
            LEFT JOIN tenants t ON t.id = pr.tenant_id
            LEFT JOIN cover ON cover.meter_id = dv.id
            LEFT JOIN drift ON drift.meter_id = dv.id
            LEFT JOIN bytes ON bytes.meter_id = dv.id
            ${where}
            ORDER BY dv.code NULLS LAST, dv.name`, vals);
        res.json(q.rows);
    }));

    return r;
}

async function assertSameProject(db: Pool, pointId: string, projectId: string) {
    const q = await db.query(`SELECT project_id FROM measurement_points WHERE id = $1`, [pointId]);
    if (!q.rows.length || q.rows[0].project_id !== projectId) throw new InputError('parent_point_id must be a point of the same project');
}

/**
 * A CSV import may hold history older than the device's first deployment
 * (the legacy Add Meter flow opens it at creation). Extend that first
 * deployment back so the imported range is attributed. Later deployments are
 * never moved: they would overlap the one before.
 */
export async function extendFirstDeployment(db: Pool | PoolClient, deviceId: string, earliest: Date): Promise<void> {
    await db.query(`
        UPDATE deployments SET installed_at = $2
        WHERE id = (SELECT id FROM deployments WHERE device_id = $1 ORDER BY installed_at LIMIT 1)
          AND installed_at > $2`, [deviceId, earliest]);
}
