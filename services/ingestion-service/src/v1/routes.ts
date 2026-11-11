// ─────────────────────────────────────────────────────────────────────────────
// Public API v1 (plan Phase 9). Read-only, versioned, under /api/v1.
//
// Authentication: an API key (`Authorization: Bearer gq_live_…`, checked by
// the gateway) or a logged-in session. Everything is confined to the caller's
// tenant through the central scope (src/scope.ts); a key additionally to its
// scopes and, when it names them, its projects. Readings come from the
// corrected point views, attributed by deployment window.
//
// Each route is declared once, with its OpenAPI description next to the
// handler; GET /v1/openapi.json is generated from these declarations.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { withScope, findSite, findPoint, tenantSql, telemetrySql, hasApiScope, projectAllowed, forClient, Scope, NO_ACCESS,
    clampToAccess, alignInward, exportEntitledSql, deliverySql, AccessWindow } from '../scope';
import { projectEnergyBalance } from '../fleet/balance';
import { loadSeries, toCsv, datasetId, conventions, INTERVALS, Interval, MAX_RANGE_DAYS, COLUMNS } from './series';
import { resolveStoredUploadPath } from '../roles';
import { exportDir } from './exports-job';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

/** One declared route: express path, OpenAPI description, handler. */
export interface ApiRoute {
    method: 'get' | 'post';
    path: string;                // express path, e.g. /v1/projects/:id
    openapiPath: string;         // e.g. /v1/projects/{id}
    summary: string;
    description?: string;
    scope?: string;              // API-key scope required (sessions: role rules only)
    auth?: false;                // false: public (signed link)
    params?: { name: string; in: 'path' | 'query'; required?: boolean; description: string; schema: object }[];
    body?: object;
    responses: Record<string, { description: string; content?: object }>;
    handler: (req: any, res: any) => Promise<void>;
}

const secret = () => String(process.env.JWT_SECRET);

/** Signed, expiring download link for an export (no API key needed to follow it). */
export function signDownload(exportId: string, expires: number): string {
    return createHmac('sha256', secret()).update(`export:${exportId}:${expires}`).digest('hex');
}
export function checkDownload(exportId: string, expires: number, sig: string): boolean {
    if (!Number.isFinite(expires) || expires < Date.now()) return false;
    const want = Buffer.from(signDownload(exportId, expires));
    const got = Buffer.from(String(sig));
    return want.length === got.length && timingSafeEqual(want, got);
}

function dateParam(v: unknown, name: string): Date {
    const d = new Date(String(v));
    if (v === undefined || v === '' || Number.isNaN(d.getTime())) throw new ApiError(400, `${name}: an ISO 8601 date-time is required`);
    return d;
}

function needScope(s: Scope, scope: string) {
    if (!hasApiScope(s, scope)) throw new ApiError(403, `This API key lacks the ${scope} scope`);
}

export function v1Routes(pool: Pool): ApiRoute[] {
    /** A project in scope (tenant, key projects); 404 otherwise. */
    const project = async (s: Scope, id: string) => {
        const p = await findSite(pool, s, id);
        if (!p || !projectAllowed(s, p.id)) throw new ApiError(404, 'Project not found');
        return p;
    };
    const point = async (s: Scope, id: string) => {
        const p = await findPoint(pool, s, id);
        if (!p || !projectAllowed(s, p.project_id)) throw new ApiError(404, 'Point not found');
        if (!p.telemetry_visible) throw new ApiError(403, NO_ACCESS);
        return p;
    };
    /** A range clamped to the caller's assessment window, aligned to whole intervals. */
    const WIDTH: Record<Interval, number> = { raw: 1000, '1m': 60_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '1d': DAY };
    const inWindow = (from: Date, to: Date, interval: Interval, w: AccessWindow) => {
        const c = clampToAccess(from, to, w);
        const r = c && alignInward(c, WIDTH[interval], w, interval === '1d' ? 2 * 3_600_000 : 0);
        if (!r) throw new ApiError(400, 'No part of this range lies inside the assessment period');
        return r;
    };
    const rangeOf = (q: any, interval: Interval) => {
        const to = q.to ? dateParam(q.to, 'to') : new Date();
        const from = q.from ? dateParam(q.from, 'from') : new Date(to.getTime() - DAY);
        if (from >= to) throw new ApiError(400, 'from must be before to');
        if (to.getTime() - from.getTime() > MAX_RANGE_DAYS[interval] * DAY) {
            throw new ApiError(400, `At most ${MAX_RANGE_DAYS[interval]} days per request at interval ${interval}; use POST /v1/exports for more`);
        }
        return { from, to };
    };
    const intervalOf = (v: unknown, s: Scope): Interval => {
        const i = String(v ?? '15m') as Interval;
        if (!INTERVALS.includes(i)) throw new ApiError(400, `interval: one of ${INTERVALS.join(', ')}`);
        if (i === 'raw') needScope(s, 'readings:raw');
        return i;
    };

    const uuidPath = (name: string, what: string) => ({ name, in: 'path' as const, required: true, description: `${what} id`, schema: { type: 'string', format: 'uuid' } });
    const json = (schema: object) => ({ 'application/json': { schema } });

    return [
        {
            method: 'get', path: '/v1/projects', openapiPath: '/v1/projects', scope: 'projects:read',
            summary: 'List projects',
            description: "Your tenant's projects (an API key limited to some projects lists those).",
            responses: { 200: { description: 'Projects', content: json({ type: 'array', items: { $ref: '#/components/schemas/Project' } }) } },
            handler: async (req, res) => {
                needScope(req.scope, 'projects:read');
                const params: unknown[] = [];
                const q = await pool.query(`
                    SELECT id, name, end_client_name, address, status, starts_on, ends_on, timezone,
                           ${telemetrySql(req.scope, 'p')} AS live_data_available
                    FROM projects p WHERE archived_at IS NULL AND ${tenantSql(req.scope, 'tenant_id', params)}
                    ORDER BY name`, params);
                res.json(q.rows.filter((p) => projectAllowed(req.scope, p.id)));
            },
        },
        {
            method: 'get', path: '/v1/projects/:id', openapiPath: '/v1/projects/{id}', scope: 'projects:read',
            summary: 'A project with its measurement points',
            description: 'Points with their role and hierarchy, and the time windows during which each was metered.',
            params: [uuidPath('id', 'Project')],
            responses: { 200: { description: 'Project', content: json({ $ref: '#/components/schemas/ProjectDetail' }) }, 404: { description: 'Not found' } },
            handler: async (req, res) => {
                needScope(req.scope, 'projects:read');
                const p = await project(req.scope, req.params.id);
                const detail = (await pool.query(`SELECT id, name, end_client_name, address, status, starts_on, ends_on, timezone FROM projects WHERE id = $1`, [p.id])).rows[0];
                const pts = await pool.query(`
                    SELECT mp.id, mp.name, mp.role, mp.parent_point_id, mp.nominal_voltage_v, mp.ct_primary_a, mp.contracted_mdi_kva,
                           COALESCE(json_agg(json_build_object('from', d.installed_at, 'to', d.removed_at) ORDER BY d.installed_at)
                                    FILTER (WHERE d.id IS NOT NULL), '[]') AS metered
                    FROM measurement_points mp LEFT JOIN deployments d ON d.measurement_point_id = mp.id
                    WHERE mp.project_id = $1 AND mp.archived_at IS NULL
                    GROUP BY mp.id ORDER BY mp.sort_order, mp.name`, [p.id]);
                res.json({ ...detail, live_data_available: p.telemetry_visible, points: pts.rows });
            },
        },
        {
            method: 'get', path: '/v1/points/:id/readings', openapiPath: '/v1/points/{id}/readings', scope: 'readings:read',
            summary: 'Readings of a measurement point',
            description: 'Interval data from the corrected point views. Timestamps are period-ending; see the `dataset` block (JSON) or the `#` header lines (CSV) for units, sign convention, coverage and flags. `interval=raw` needs the readings:raw scope and is limited to one day.',
            params: [
                uuidPath('id', 'Measurement point'),
                { name: 'interval', in: 'query', description: 'raw, 1m, 15m, 30m, 1h or 1d (SAST days). Default 15m.', schema: { type: 'string', enum: INTERVALS } },
                { name: 'from', in: 'query', description: 'Start, ISO 8601. Default: 24 h before to.', schema: { type: 'string', format: 'date-time' } },
                { name: 'to', in: 'query', description: 'End (exclusive), ISO 8601. Default: now.', schema: { type: 'string', format: 'date-time' } },
                { name: 'format', in: 'query', description: 'json (default) or csv', schema: { type: 'string', enum: ['json', 'csv'] } },
            ],
            responses: {
                200: { description: 'Readings', content: { ...json({ $ref: '#/components/schemas/Readings' }), 'text/csv': { schema: { type: 'string' } } } },
                400: { description: 'Bad interval or range' }, 403: { description: 'Scope or live-data restriction' }, 404: { description: 'Not found' },
            },
            handler: async (req, res) => {
                needScope(req.scope, 'readings:read');
                const p = await point(req.scope, req.params.id);
                const interval = intervalOf(req.query.interval, req.scope);
                const asked = rangeOf(req.query, interval);
                const { from, to } = inWindow(asked.from, asked.to, interval, p);
                const rows = await loadSeries(pool, p.id, interval, from, to);
                const id = datasetId(p.id, interval, from, to);
                if (String(req.query.format ?? 'json') === 'csv') {
                    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="gridiq-${id}.csv"`);
                    res.send(toCsv(rows, { dataset_id: id, point: p.name, project: p.project_name, interval, from, to }));
                    return;
                }
                res.json({
                    dataset: { id, point_id: p.id, point: p.name, project: p.project_name, interval, from: from.toISOString(), to: to.toISOString(), ...conventions(interval) },
                    columns: COLUMNS, rows,
                });
            },
        },
        {
            method: 'get', path: '/v1/projects/:id/energy-balance', openapiPath: '/v1/projects/{id}/energy-balance', scope: 'energy:read',
            summary: 'Energy balance of a project',
            description: 'Grid import/export, PV, battery, generator, site consumption, metered sub-loads and the unmetered remainder (kWh), from the registers. A component whose point has no data is null, never 0. `interval=day|month` returns one balance per SAST day or month.',
            params: [
                uuidPath('id', 'Project'),
                { name: 'from', in: 'query', required: true, description: 'Start, ISO 8601', schema: { type: 'string', format: 'date-time' } },
                { name: 'to', in: 'query', required: true, description: 'End (exclusive), ISO 8601', schema: { type: 'string', format: 'date-time' } },
                { name: 'interval', in: 'query', description: 'total (default), day or month', schema: { type: 'string', enum: ['total', 'day', 'month'] } },
            ],
            responses: { 200: { description: 'Balances', content: json({ type: 'object' }) }, 404: { description: 'Not found' } },
            handler: async (req, res) => {
                needScope(req.scope, 'energy:read');
                const p = await project(req.scope, req.params.id);
                if (!p.telemetry_visible) throw new ApiError(403, NO_ACCESS);
                const asked = { from: dateParam(req.query.from, 'from'), to: dateParam(req.query.to, 'to') };
                if (asked.from >= asked.to) throw new ApiError(400, 'from must be before to');
                const { from, to } = inWindow(asked.from, asked.to, 'raw', p);
                const interval = String(req.query.interval ?? 'total');
                if (!['total', 'day', 'month'].includes(interval)) throw new ApiError(400, 'interval: total, day or month');
                const periods = splitPeriods(from, to, interval as any);
                if (periods.length > (interval === 'day' ? 93 : 36)) throw new ApiError(400, 'Too many periods: at most 93 days or 36 months per request');
                const out = [];
                for (const [a, b] of periods) {
                    const { points, ...bal } = await projectEnergyBalance(pool, p.id, a, b);
                    out.push({ ...bal, period_start: a.toISOString(), period_end: b.toISOString(), points });
                }
                res.json({ project_id: p.id, interval, time_zone: 'Africa/Johannesburg', basis: 'kWh registers per point; power-integrated where a meter has none', balances: out });
            },
        },
        {
            method: 'get', path: '/v1/projects/:id/findings', openapiPath: '/v1/projects/{id}/findings', scope: 'findings:read',
            summary: 'Published findings of a project',
            description: 'Findings Grid-IQ has reviewed and published, with their evidence window.',
            params: [uuidPath('id', 'Project')],
            responses: { 200: { description: 'Findings', content: json({ type: 'array', items: { type: 'object' } }) }, 404: { description: 'Not found' } },
            handler: async (req, res) => {
                needScope(req.scope, 'findings:read');
                const p = await project(req.scope, req.params.id);
                if (!p.telemetry_visible) throw new ApiError(403, NO_ACCESS);
                const q = await pool.query(`
                    SELECT id, meter_id, type, priority, title, problem, solution, estimated_monthly_saving_zar,
                           estimated_implementation_cost_zar, payback_months, confidence, standard_reference, evidence,
                           reviewed_at, created_at
                    FROM recommendations
                    WHERE site_id = $1 AND status = 'ACTIVE' AND review_status = 'published'
                    ORDER BY priority, estimated_monthly_saving_zar DESC`, [p.id]);
                res.json(q.rows.map((r) => forClient(req.scope, r)));
            },
        },
        {
            method: 'get', path: '/v1/projects/:id/reports', openapiPath: '/v1/projects/{id}/reports', scope: 'reports:read',
            summary: 'Published reports of a project',
            params: [uuidPath('id', 'Project')],
            responses: { 200: { description: 'Reports', content: json({ type: 'array', items: { type: 'object' } }) }, 404: { description: 'Not found' } },
            handler: async (req, res) => {
                needScope(req.scope, 'reports:read');
                const p = await project(req.scope, req.params.id);
                const q = await pool.query(`
                    SELECT rp.id, rp.title, rp.period_start, rp.period_end, rp.published_at, (rp.pdf_path IS NOT NULL) AS has_pdf
                    FROM reports rp JOIN projects pj ON pj.id = rp.project_id
                    WHERE rp.project_id = $1 AND rp.status = 'published' AND ${deliverySql(req.scope, 'pj')}
                    ORDER BY rp.period_end DESC`, [p.id]);
                res.json(q.rows.map((r) => ({ ...r, pdf_url: r.has_pdf ? `/api/v1/reports/${r.id}.pdf` : null })));
            },
        },
        {
            method: 'get', path: '/v1/reports/:file', openapiPath: '/v1/reports/{id}.pdf', scope: 'reports:read',
            summary: 'The PDF of a published report',
            description: 'The PDF Grid-IQ attached when publishing the report. 404 while none is attached.',
            params: [uuidPath('id', 'Report')],
            responses: { 200: { description: 'PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 404: { description: 'Not found, or no PDF attached' } },
            handler: async (req, res) => {
                needScope(req.scope, 'reports:read');
                const m = /^([0-9a-f-]{36})\.pdf$/i.exec(req.params.file);
                if (!m) throw new ApiError(404, 'Not found');
                const params: unknown[] = [m[1]];
                const r = (await pool.query(`
                    SELECT rp.id, rp.project_id, rp.pdf_path, rp.title FROM reports rp JOIN projects p ON p.id = rp.project_id
                    WHERE rp.id = $1 AND rp.status = 'published' AND ${tenantSql(req.scope, 'p.tenant_id', params)}
                      AND ${deliverySql(req.scope, 'p')}`, params)).rows[0];
                if (!r || !projectAllowed(req.scope, r.project_id)) throw new ApiError(404, 'Not found');
                const file = r.pdf_path ? resolveStoredUploadPath(r.pdf_path) : null;
                if (!file || !fs.existsSync(file)) throw new ApiError(404, 'No PDF attached to this report');
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="report-${r.id}.pdf"`);
                fs.createReadStream(file).pipe(res);
            },
        },
        {
            method: 'post', path: '/v1/exports', openapiPath: '/v1/exports', scope: 'exports:write',
            summary: 'Start an export',
            description: 'A CSV (gzip) of one point\'s readings over a longer range, written in the background. Poll GET /v1/exports/{id} for the download link. Ranges: raw up to 31 days, 1m up to 1 year, coarser up to 10 years.',
            body: json({ type: 'object', required: ['point_id', 'interval', 'from', 'to'], properties: {
                point_id: { type: 'string', format: 'uuid' }, interval: { type: 'string', enum: INTERVALS },
                from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } } }),
            responses: { 202: { description: 'Queued', content: json({ $ref: '#/components/schemas/Export' }) }, 400: { description: 'Bad request' } },
            handler: async (req, res) => {
                needScope(req.scope, 'exports:write');
                needScope(req.scope, 'readings:read');
                const b = req.body ?? {};
                const p = await point(req.scope, String(b.point_id ?? ''));
                const interval = intervalOf(b.interval, req.scope);
                const asked = { from: dateParam(b.from, 'from'), to: dateParam(b.to, 'to') };
                if (asked.from >= asked.to) throw new ApiError(400, 'from must be before to');
                const { from, to } = inWindow(asked.from, asked.to, interval, p);
                const maxDays = interval === 'raw' ? 31 : interval === '1m' ? 366 : 3660;
                if (to.getTime() - from.getTime() > maxDays * DAY) throw new ApiError(400, `At most ${maxDays} days at interval ${interval}`);
                const row = (await pool.query(`
                    INSERT INTO exports (tenant_id, measurement_point_id, interval, period_from, period_to, api_key_id, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                    [p.tenant_id, p.id, interval, from, to, req.scope.apiKey?.id ?? null, req.scope.userId])).rows[0];
                res.status(202).json(exportView(row));
            },
        },
        {
            method: 'get', path: '/v1/exports', openapiPath: '/v1/exports', scope: 'exports:write',
            summary: 'Recent exports',
            description: "Your tenant's exports of the last 30 days, newest first (an API key limited to some projects sees those).",
            params: [{ name: 'point_id', in: 'query', description: 'Only this measurement point', schema: { type: 'string', format: 'uuid' } }],
            responses: { 200: { description: 'Exports', content: json({ type: 'array', items: { $ref: '#/components/schemas/Export' } }) } },
            handler: async (req, res) => {
                needScope(req.scope, 'exports:write');
                const params: unknown[] = [];
                const where = [tenantSql(req.scope, 'e.tenant_id', params), `e.created_at > NOW() - INTERVAL '30 days'`];
                if (req.query.point_id !== undefined) {
                    if (!UUID.test(String(req.query.point_id))) throw new ApiError(400, 'point_id: a point id');
                    params.push(req.query.point_id);
                    where.push(`e.measurement_point_id = $${params.length}`);
                }
                const q = await pool.query(`
                    SELECT e.*, mp.project_id, mp.name AS point_name FROM exports e JOIN measurement_points mp ON mp.id = e.measurement_point_id
                    WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT 100`, params);
                res.json(q.rows.filter((r) => projectAllowed(req.scope, r.project_id)).map((r) => ({ ...exportView(r), point_name: r.point_name })));
            },
        },
        {
            method: 'get', path: '/v1/exports/:id', openapiPath: '/v1/exports/{id}', scope: 'exports:write',
            summary: 'An export\'s status and download link',
            params: [uuidPath('id', 'Export')],
            responses: { 200: { description: 'Export', content: json({ $ref: '#/components/schemas/Export' }) }, 404: { description: 'Not found' } },
            handler: async (req, res) => {
                needScope(req.scope, 'exports:write');
                if (!UUID.test(req.params.id)) throw new ApiError(404, 'Not found');
                const params: unknown[] = [req.params.id];
                const row = (await pool.query(`SELECT * FROM exports WHERE id = $1 AND ${tenantSql(req.scope, 'tenant_id', params)}`, params)).rows[0];
                if (!row) throw new ApiError(404, 'Not found');
                const pt = await findPoint(pool, req.scope, row.measurement_point_id);
                if (!pt || !projectAllowed(req.scope, pt.project_id)) throw new ApiError(404, 'Not found');
                res.json(exportView(row));
            },
        },
        {
            method: 'get', path: '/v1/exports/:id/download', openapiPath: '/v1/exports/{id}/download', auth: false,
            summary: 'Download an export (signed link)',
            description: 'The link from GET /v1/exports/{id}; works without an API key until it expires (1 hour).',
            params: [uuidPath('id', 'Export'),
                { name: 'expires', in: 'query', required: true, description: 'Link expiry (ms since epoch)', schema: { type: 'integer' } },
                { name: 'sig', in: 'query', required: true, description: 'Signature', schema: { type: 'string' } }],
            responses: { 200: { description: 'CSV, gzip', content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } }, 403: { description: 'Link invalid or expired' } },
            handler: async (req, res) => {
                if (!UUID.test(req.params.id) || !checkDownload(req.params.id, Number(req.query.expires), String(req.query.sig ?? ''))) {
                    throw new ApiError(403, 'This download link is invalid or has expired');
                }
                // Re-checked at download: an export never outlives the assessment it came from.
                const row = (await pool.query(`SELECT e.id, e.status FROM exports e WHERE e.id = $1 AND ${exportEntitledSql('e')}`, [req.params.id])).rows[0];
                const file = path.join(exportDir(), `${req.params.id}.csv.gz`);
                if (!row || row.status !== 'done' || !fs.existsSync(file)) throw new ApiError(404, 'Export not available');
                res.setHeader('Content-Type', 'application/gzip');
                res.setHeader('Content-Disposition', `attachment; filename="gridiq-export-${row.id}.csv.gz"`);
                fs.createReadStream(file).pipe(res);
            },
        },
    ];
}

/** Export status for the API, with a 1-hour signed link once it is done. */
export function exportView(row: any) {
    const done = row.status === 'done';
    const linkExpiry = done ? Math.min(Date.now() + 3_600_000, new Date(row.expires_at).getTime()) : null;
    return {
        id: row.id, status: row.status, point_id: row.measurement_point_id, interval: row.interval,
        from: row.period_from, to: row.period_to, format: 'csv.gz', rows: row.rows, bytes: row.bytes === null ? null : Number(row.bytes),
        error: row.error, created_at: row.created_at, finished_at: row.finished_at, expires_at: row.expires_at,
        download_url: done && linkExpiry ? `/api/v1/exports/${row.id}/download?expires=${linkExpiry}&sig=${signDownload(row.id, linkExpiry)}` : null,
    };
}

/** [start, end) periods: one total, or SAST days / months. */
export function splitPeriods(from: Date, to: Date, interval: 'total' | 'day' | 'month'): [Date, Date][] {
    if (interval === 'total') return [[from, to]];
    const SAST = 2 * 3_600_000;
    const out: [Date, Date][] = [];
    let a = from;
    while (a < to) {
        const local = new Date(a.getTime() + SAST);
        const next = interval === 'day'
            ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - SAST
            : Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - SAST;
        const b = new Date(Math.min(next, to.getTime()));
        out.push([a, b]);
        a = b;
    }
    return out;
}

/** OpenAPI 3.1 from the declarations. */
export function openapi(routes: ApiRoute[], serverUrl = '/api') {
    const paths: Record<string, any> = {};
    for (const r of routes) {
        paths[r.openapiPath] ??= {};
        paths[r.openapiPath][r.method] = {
            summary: r.summary,
            ...(r.description ? { description: r.description } : {}),
            ...(r.auth === false ? { security: [] } : {}),
            ...(r.scope ? { 'x-required-scope': r.scope } : {}),
            ...(r.params ? { parameters: r.params } : {}),
            ...(r.body ? { requestBody: { required: true, content: r.body } } : {}),
            responses: r.responses,
        };
    }
    return {
        openapi: '3.1.0',
        info: {
            title: 'Grid-IQ API', version: '1.0.0',
            description: [
                'Read-only access to your projects, measurement points, readings, energy balance, findings and reports.',
                '',
                '**Authentication**: `Authorization: Bearer gq_live_…`. Keys are created by an admin in the portal (Settings → API keys); each key has scopes (x-required-scope on every operation) and may be limited to some projects.',
                '',
                '**Conventions**: timestamps are ISO 8601 UTC and **period-ending** (a row covers [period_start, period_end) and is labelled by period_end). Daily rows are South African calendar days (Africa/Johannesburg, UTC+2). Units: V, A, kW, kvar, kVA, Hz, %, kWh. Sign: import / consumption positive. Every interval carries n (samples), coverage (0–1) and flags (gap, register_reset, correction_applied).',
                '',
                'Rate limit: per key, see the RateLimit-* response headers.',
            ].join('\n'),
        },
        servers: [{ url: serverUrl }],
        security: [{ apiKey: [] }],
        components: {
            securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'gq_live_… API key' } },
            schemas: {
                Project: { type: 'object', properties: {
                    id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, end_client_name: { type: ['string', 'null'] },
                    address: { type: ['string', 'null'] }, status: { type: 'string', enum: ['planned', 'active', 'completed', 'archived'] },
                    starts_on: { type: ['string', 'null'], format: 'date' }, ends_on: { type: ['string', 'null'], format: 'date' },
                    timezone: { type: 'string' }, live_data_available: { type: 'boolean' } } },
                ProjectDetail: { allOf: [{ $ref: '#/components/schemas/Project' }, { type: 'object', properties: { points: { type: 'array', items: { type: 'object', properties: {
                    id: { type: 'string', format: 'uuid' }, name: { type: 'string' },
                    role: { type: 'string', enum: ['incomer', 'sub_load', 'pv', 'bess', 'generator', 'other'] },
                    parent_point_id: { type: ['string', 'null'], format: 'uuid' },
                    metered: { type: 'array', items: { type: 'object', properties: { from: { type: 'string', format: 'date-time' }, to: { type: ['string', 'null'], format: 'date-time' } } } } } } } } }] },
                Readings: { type: 'object', properties: {
                    dataset: { type: 'object', description: 'Id, version and conventions of this dataset' },
                    columns: { type: 'array', items: { type: 'string' } },
                    rows: { type: 'array', items: { type: 'object', properties: Object.fromEntries(COLUMNS.map((c) => [c, { type: c === 'period_start' || c === 'period_end' || c === 'flags' ? 'string' : ['number', 'null'] }])) } } } },
                Export: { type: 'object', properties: {
                    id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'expired'] },
                    rows: { type: ['integer', 'null'] }, bytes: { type: ['integer', 'null'] }, expires_at: { type: ['string', 'null'], format: 'date-time' },
                    download_url: { type: ['string', 'null'], description: 'Signed, valid 1 hour' } } },
            },
        },
        paths,
    };
}

/** Express router for the declarations, plus /v1/openapi.json and /v1/docs. */
export function v1Router(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const auth = withScope(authenticateJwt);
    const routes = v1Routes(pool);
    for (const route of routes) {
        const handle = async (req: any, res: any) => {
            try {
                await route.handler(req, res);
            } catch (e: any) {
                if (e instanceof ApiError) return res.status(e.status).json({ error: e.message });
                if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') return res.status(400).json({ error: 'Malformed value' });
                console.error(`[v1] ${req.method} ${req.path}:`, e);
                res.status(500).json({ error: 'Server error' });
            }
        };
        if (route.auth === false) r[route.method](route.path, handle);
        else r[route.method](route.path, auth, handle);
    }
    r.get('/v1/openapi.json', (_req, res) => { res.json(openapi(routes)); });
    // Swagger UI from the swagger-ui-dist package (no CDN): /api/docs.
    const ui = path.dirname(require.resolve('swagger-ui-dist/package.json'));
    r.get(['/v1/docs', '/v1/docs/'], (req, res) => {
        if (!req.path.endsWith('/')) return res.redirect(301, 'docs/'); // relative: /api/docs -> /api/docs/
        res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Grid-IQ API</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="swagger-ui-bundle.js"></script><script src="docs-init.js"></script></body></html>`);
    });
    // Relative to the docs page, so it works behind the gateway (/api/docs/) and direct (/v1/docs/).
    r.get('/v1/docs/openapi.json', (_req, res) => { res.json(openapi(routes)); });
    r.get('/v1/docs/docs-init.js', (_req, res) => {
        res.type('js').send(`window.ui = SwaggerUIBundle({ url: 'openapi.json', dom_id: '#swagger-ui' });`);
    });
    r.get(['/v1/docs/swagger-ui.css', '/v1/docs/swagger-ui-bundle.js'], (req, res) => {
        res.sendFile(path.join(ui, path.basename(req.path)));
    });
    return r;
}
