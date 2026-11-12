// ─────────────────────────────────────────────────────────────────────────────
// Central tenant scoping (plan Phase 7, item 2).
//
// authenticateToken builds req.scope from the JWT. Routes never write their
// own tenant filter: they call the repository functions here, which add it.
//
//   internal (super_admin, engineer)  every tenant, or one tenant when the
//                                     request names it (?tenant_id= or
//                                     body.tenant_id)
//   client_admin                      own tenant, read and write
//   client_viewer                     own tenant, read only
//   broker                            nothing here; broker routes resolve
//                                     their own grants (FEATURE_BROKER)
//
// Live data visibility (GridIQ assessment model, 2026-11-11): a client sees
// telemetry, findings and chat for a project only through an access grant on an
// assessment of that project whose window [start_at, end_at) contains NOW(),
// that is active and not closed early, and whose grant is not revoked. This is
// evaluated in SQL on every request, so expiry needs no background job and
// no token, session or cache can extend it. API-key requests inherit the
// assessment window (the key is the tenant's, limited to its projects).
// Client reads are also clamped to the window ([access_from, access_to)).
// projects.live_data_visible no longer grants anything (kept for staff views).
//
// Moved devices: the legacy per-meter routes find a device through its
// current project (devices.site_id), and its readings are keyed by device
// across every deployment. A client therefore reaches a device through them
// only while every deployment of it was at that client's own projects;
// otherwise the readings of another client's site would be in reach.
// Per-window access is through the project/point views (point_readings_*).
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'super_admin' | 'engineer' | 'client_admin' | 'client_viewer' | 'broker';

/** Tokens issued before the Phase 7 role rename keep working until they expire. */
const LEGACY_ROLES: Record<string, Role> = { admin: 'client_admin', user: 'client_viewer', viewer: 'client_viewer' };
const KNOWN: Role[] = ['super_admin', 'engineer', 'client_admin', 'client_viewer', 'broker'];

export function normaliseRole(role: unknown): Role {
    const r = String(role ?? '');
    if ((KNOWN as string[]).includes(r)) return r as Role;
    return LEGACY_ROLES[r] ?? 'client_viewer';
}

export interface Scope {
    userId: string | null;
    email: string | null;
    role: Role;
    /** The user's own tenant. */
    tenantId: string | null;
    isInternal: boolean;
    /**
     * The tenant every query is confined to: the user's own for client
     * roles; for internal users the tenant the request names, else null (all).
     */
    filterTenantId: string | null;
    /**
     * Set when the request came with an API key (Phase 9; the gateway turns
     * the key into a short-lived token): what it may read, and where.
     * projectIds null = all of the tenant's projects.
     */
    apiKey: { id: string; scopes: string[]; projectIds: string[] | null } | null;
}

export const isInternalRole = (role: Role) => role === 'super_admin' || role === 'engineer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildScope(user: any, req?: { query?: any; body?: any }): Scope {
    const role = normaliseRole(user?.role);
    const internal = isInternalRole(role);
    const named = req?.query?.tenant_id ?? (typeof req?.body === 'object' ? req?.body?.tenant_id : undefined);
    return {
        userId: user?.userId ?? null,
        email: user?.email ?? null,
        role,
        tenantId: user?.tenantId ?? null,
        isInternal: internal,
        apiKey: user?.apiKey && typeof user.apiKey === 'object'
            ? { id: String(user.apiKey.id), scopes: Array.isArray(user.apiKey.scopes) ? user.apiKey.scopes.map(String) : [],
                projectIds: Array.isArray(user.apiKey.projectIds) ? user.apiKey.projectIds.map(String) : null }
            : null,
        filterTenantId: internal
            ? (typeof named === 'string' && UUID.test(named) ? named : null)
            // A client without a tenant sees nothing: filter on an id no row has.
            : (user?.tenantId ?? '00000000-0000-0000-0000-000000000000'),
    };
}

/** API scope check: a user session may do anything its role allows; a key only its scopes. */
export const hasApiScope = (s: Scope, scope: string) => !s.apiKey || s.apiKey.scopes.includes(scope);

/** A key limited to some projects reaches only those. */
export const projectAllowed = (s: Scope, projectId: string) => !s.apiKey?.projectIds || s.apiKey.projectIds.includes(projectId);

/** May this scope change data? client_viewer and broker are read-only here. */
export const canWrite = (s: Scope) => s.isInternal || s.role === 'client_admin';

/**
 * Non-GET routes a client_viewer may still call: asking about a report,
 * marking an alert read, asking GridIQ to follow up a recommendation,
 * requesting a data export (it only reads; an API key's token is a viewer's),
 * asking GridIQ to book a follow-up assessment.
 */
const VIEWER_ALLOWED = [
    /^\/meters\/[^/]+\/compliance\/ask$/,
    /^\/alerts\/[^/]+\/read$/,
    /^\/recommendations\/[^/]+\/notify$/,
    /^\/v1\/exports$/,
    /^\/booking-requests$/,
];
export function viewerMayCall(method: string, path: string): boolean {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    return VIEWER_ALLOWED.some((re) => re.test(path));
}

/**
 * The tenant condition for a query: "<column> = $n" (pushing the value), or
 * TRUE for an internal user acting on all tenants.
 */
export function tenantSql(scope: Scope, column: string, params: unknown[]): string {
    if (scope.filterTenantId === null) return 'TRUE';
    return `${column} = ${tenantParam(scope, params)}`;
}

/** "$n" for the scope's tenant, reusing it if params already holds it. */
function tenantParam(scope: Scope, params: unknown[]): string {
    const i = params.indexOf(scope.filterTenantId);
    if (i >= 0) return `$${i + 1}`;
    params.push(scope.filterTenantId);
    return `$${params.length}`;
}

/** A user id that is safe to inline in SQL (validated), or null. */
const safeUuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);

/**
 * The live assessments (alias a) a scope may use, as a WHERE condition: in
 * window, active, not closed; for a user, through an unrevoked grant naming
 * the user or, before the user existed, the user's email.
 */
export function liveAssessmentSql(scope: Scope, assessmentAlias = 'a'): string {
    const a = assessmentAlias;
    const live = `${a}.status = 'active' AND ${a}.closed_at IS NULL AND ${a}.start_at <= NOW() AND NOW() < ${a}.end_at`;
    if (scope.apiKey) return live;
    const uid = safeUuid(scope.userId);
    if (!uid) return 'FALSE';
    return `${live} AND EXISTS (SELECT 1 FROM assessment_grants g WHERE g.assessment_id = ${a}.id AND g.revoked_at IS NULL
              AND (g.user_id = '${uid}'::uuid
                   OR (g.user_id IS NULL AND g.email = (SELECT lower(u.email) FROM users u WHERE u.id = '${uid}'::uuid))))`;
}

/** Live-data condition on a project alias: always TRUE for internal users. */
export function telemetrySql(scope: Scope, projectAlias: string): string {
    if (scope.isInternal) return 'TRUE';
    return `EXISTS (SELECT 1 FROM assessments ax WHERE ax.project_id = ${projectAlias}.id AND ${liveAssessmentSql(scope, 'ax')})`;
}

/**
 * The time window a client may read for a project: [access_from, access_to)
 * over its live assessments, as two select-list expressions. NULL for
 * internal users (no clamp).
 */
export function accessWindowSql(scope: Scope, projectAlias: string): string {
    if (scope.isInternal) return 'NULL::timestamptz AS access_from, NULL::timestamptz AS access_to';
    const w = (agg: string, col: string) =>
        `(SELECT ${agg}(${col}) FROM assessments ax WHERE ax.project_id = ${projectAlias}.id AND ${liveAssessmentSql(scope, 'ax')})`;
    return `${w('min', 'ax.start_at')} AS access_from, ${w('max', 'ax.end_at')} AS access_to`;
}

export interface AccessWindow { access_from?: Date | string | null; access_to?: Date | string | null }

/**
 * Clamps a requested range to a client's access window (and to now).
 * Internal users (no window) get the range unchanged. Null when nothing is left.
 */
export function clampToAccess(from: Date, to: Date, w: AccessWindow): { from: Date; to: Date } | null {
    let f = from.getTime(), t = to.getTime();
    if (w.access_from) f = Math.max(f, new Date(w.access_from).getTime());
    if (w.access_to) t = Math.min(t, new Date(w.access_to).getTime(), Date.now());
    return f < t ? { from: new Date(f), to: new Date(t) } : null;
}

/**
 * Aligns a clamped range inward to whole buckets of widthMs, so no aggregate
 * bucket that lies partly outside a client's window is returned. Internal
 * users get the range unchanged.
 */
export function alignInward(r: { from: Date; to: Date }, widthMs: number, w: AccessWindow, offsetMs = 0): { from: Date; to: Date } | null {
    if (!w.access_from && !w.access_to) return r;
    const f = w.access_from ? Math.ceil((r.from.getTime() + offsetMs) / widthMs) * widthMs - offsetMs : r.from.getTime();
    const t = w.access_to ? Math.floor((r.to.getTime() + offsetMs) / widthMs) * widthMs - offsetMs : r.to.getTime();
    return f < t ? { from: new Date(f), to: new Date(t) } : null;
}

/**
 * Whoever started an export (alias e) may still receive it: staff always; a
 * client user only while it holds a live grant on the point's project; an
 * API key only while the project has a live assessment. Checked when the job
 * runs and again at download, so an export never outlives the assessment.
 */
export function exportEntitledSql(e = 'e'): string {
    const live = `ax.status = 'active' AND ax.closed_at IS NULL AND ax.start_at <= NOW() AND NOW() < ax.end_at`;
    return `(
        (${e}.api_key_id IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${e}.created_by AND u.role IN ('super_admin', 'engineer')))
        OR EXISTS (SELECT 1 FROM assessments ax JOIN measurement_points mpx ON mpx.project_id = ax.project_id
                   WHERE mpx.id = ${e}.measurement_point_id AND ${live}
                     AND (${e}.api_key_id IS NOT NULL OR EXISTS (
                          SELECT 1 FROM assessment_grants g WHERE g.assessment_id = ax.id AND g.revoked_at IS NULL
                            AND (g.user_id = ${e}.created_by
                                 OR (g.user_id IS NULL AND g.email = (SELECT lower(u.email) FROM users u WHERE u.id = ${e}.created_by)))))))`;
}

/**
 * Final-delivery access to a project's frozen deliverables (published reports
 * and their PDFs) for a client: during a live assessment, or for the
 * assessment's delivery_days after it ended (capped by retention), through a
 * grant that receives reports. It never reopens readings, findings or chat.
 */
export function deliverySql(scope: Scope, projectAlias: string): string {
    if (scope.isInternal) return 'TRUE';
    const uid = safeUuid(scope.userId);
    const grant = scope.apiKey ? 'TRUE' : !uid ? 'FALSE' : `EXISTS (SELECT 1 FROM assessment_grants g WHERE g.assessment_id = ad.id AND g.revoked_at IS NULL
              AND g.receives_reports
              AND (g.user_id = '${uid}'::uuid
                   OR (g.user_id IS NULL AND g.email = (SELECT lower(u.email) FROM users u WHERE u.id = '${uid}'::uuid))))`;
    return `(${telemetrySql(scope, projectAlias)} OR EXISTS (
        SELECT 1 FROM assessments ad WHERE ad.project_id = ${projectAlias}.id
          AND ad.status IN ('active', 'ended') AND ad.start_at IS NOT NULL
          AND NOW() >= LEAST(ad.end_at, COALESCE(ad.closed_at, ad.end_at))
          AND NOW() < LEAST(LEAST(ad.end_at, COALESCE(ad.closed_at, ad.end_at)) + make_interval(days => ad.delivery_days),
                            COALESCE(ad.retention_until, 'infinity'::timestamptz))
          AND ad.retention_status = 'retained'
          AND ${grant}))`;
}

/**
 * For client scopes: the device (alias) has never been deployed at another
 * tenant's project. TRUE for internal users.
 */
export function exclusiveDeviceSql(scope: Scope, deviceAlias: string, params: unknown[]): string {
    if (scope.isInternal) return 'TRUE';
    return `NOT EXISTS (SELECT 1 FROM deployments dx
                JOIN measurement_points mx ON mx.id = dx.measurement_point_id
                JOIN projects px ON px.id = mx.project_id
                WHERE dx.device_id = ${deviceAlias}.id AND px.tenant_id <> ${tenantParam(scope, params)})`;
}

/** Fields client roles never receive, even if a query selects them. */
const INTERNAL_FIELDS = ['internal_notes', 'reviewed_by'];
/**
 * Whether clients also see draft (unreviewed) findings, which the portal labels
 * "Draft, not yet reviewed". Internal users always do. Off unless
 * CLIENT_SEES_DRAFT_FINDINGS=true (compose turns it on); dismissed findings and
 * internal notes stay hidden either way. The public API (/v1/findings) stays
 * published-only.
 */
export function clientSeesDraftFindings(): boolean {
    return process.env.CLIENT_SEES_DRAFT_FINDINGS === 'true';
}

/** May this scope read findings that are not yet published (drafts, in review)? */
export function seesUnpublishedFindings(scope: Scope): boolean {
    return scope.isInternal || clientSeesDraftFindings();
}

export function forClient<T extends Record<string, any>>(scope: Scope, row: T): T {
    if (scope.isInternal || !row) return row;
    const out: any = { ...row };
    for (const f of INTERNAL_FIELDS) delete out[f];
    return out;
}

// ── Repository ──────────────────────────────────────────────────────────────

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export interface ScopedSite {
    id: string; tenant_id: string; name: string; address: string | null; archived_at: Date | null;
    live_data_visible: boolean; telemetry_visible: boolean;
    access_from: Date | null; access_to: Date | null;
}

/** A site/project the scope may reach, or null. */
export async function findSite(db: Queryable, scope: Scope, id: string): Promise<ScopedSite | null> {
    if (!UUID.test(String(id))) return null;
    const params: unknown[] = [id];
    const t = tenantSql(scope, 'p.tenant_id', params);
    const r = await db.query(`
        SELECT p.id, p.tenant_id, p.name, p.address, p.archived_at, p.live_data_visible,
               ${telemetrySql(scope, 'p')} AS telemetry_visible, ${accessWindowSql(scope, 'p')}
        FROM projects p WHERE p.id = $1 AND ${t}`, params);
    return r.rows[0] ?? null;
}

export interface ScopedMeter {
    id: string; name: string; site_id: string; tenant_id: string;
    site_name: string; site_address: string | null; telemetry_visible: boolean;
}

/** A meter the scope may reach (through its current project), or null. */
export async function findMeter(db: Queryable, scope: Scope, id: string): Promise<ScopedMeter | null> {
    if (!UUID.test(String(id))) return null;
    const params: unknown[] = [id];
    const t = tenantSql(scope, 'p.tenant_id', params);
    const x = exclusiveDeviceSql(scope, 'd', params);
    const r = await db.query(`
        SELECT d.id, d.name, d.site_id, p.tenant_id, p.name AS site_name, p.address AS site_address,
               ${telemetrySql(scope, 'p')} AS telemetry_visible
        FROM devices d JOIN projects p ON p.id = d.site_id
        WHERE d.id = $1 AND ${t} AND ${x}`, params);
    return r.rows[0] ?? null;
}

export interface ScopedPoint {
    id: string; name: string; role: string; project_id: string; project_name: string; tenant_id: string;
    nominal_voltage_v: string | null; ct_primary_a: string | null; contracted_mdi_kva: string | null;
    telemetry_visible: boolean; access_from: Date | null; access_to: Date | null;
}

/** A measurement point the scope may reach (through its project), or null. */
export async function findPoint(db: Queryable, scope: Scope, id: string): Promise<ScopedPoint | null> {
    if (!UUID.test(String(id))) return null;
    const params: unknown[] = [id];
    const t = tenantSql(scope, 'p.tenant_id', params);
    const r = await db.query(`
        SELECT mp.id, mp.name, mp.role, mp.project_id, p.name AS project_name, p.tenant_id,
               mp.nominal_voltage_v, mp.ct_primary_a, mp.contracted_mdi_kva,
               ${telemetrySql(scope, 'p')} AS telemetry_visible, ${accessWindowSql(scope, 'p')}
        FROM measurement_points mp JOIN projects p ON p.id = mp.project_id
        WHERE mp.id = $1 AND ${t}`, params);
    return r.rows[0] ?? null;
}

/** A row of a tenant-owned table (alerts, leads, recommendations, report_shares), or null. */
export async function findOwned(db: Queryable, scope: Scope, table: 'alerts' | 'leads' | 'recommendations' | 'report_shares',
                                id: string, extraWhere = 'TRUE'): Promise<any | null> {
    if (!UUID.test(String(id))) return null;
    const params: unknown[] = [id];
    const t = tenantSql(scope, 'x.tenant_id', params);
    const r = await db.query(`SELECT x.* FROM ${table} x WHERE x.id = $1 AND ${t} AND ${extraWhere}`, params);
    return r.rows[0] ?? null;
}

// ── Express middleware ──────────────────────────────────────────────────────

export const NO_ACCESS = 'No active assessment: live data, history and chat are available only during the assessment period';

type Mw = (req: any, res: any, next: any) => void;

/** Resolves :id to a meter in scope (403 otherwise) as req.meter. */
export function meterParam(db: Queryable, opts: { telemetry?: boolean; write?: boolean } = {}): Mw {
    return async (req, res, next) => {
        try {
            if (opts.write && !canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
            const m = await findMeter(db, req.scope, req.params.id);
            if (!m) return res.status(403).json({ error: 'Forbidden' });
            // Legacy per-meter telemetry is keyed by device across every
            // deployment and cannot be confined to an assessment window:
            // clients read through the point views (/points/:id/...).
            if (opts.telemetry && !req.scope.isInternal) {
                return res.status(403).json({ error: 'Readings are available through the assessment views (/points/:id)', code: 'use_point_views' });
            }
            req.meter = m;
            next();
        } catch (e) { next(e); }
    };
}

/** Resolves :id to a site/project in scope (403 otherwise) as req.site. */
export function siteParam(db: Queryable, opts: { telemetry?: boolean; write?: boolean } = {}): Mw {
    return async (req, res, next) => {
        try {
            if (opts.write && !canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
            const s = await findSite(db, req.scope, req.params.id);
            if (!s) return res.status(403).json({ error: 'Forbidden' });
            if (opts.telemetry && !s.telemetry_visible) {
                return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
            }
            req.site = s;
            next();
        } catch (e) { next(e); }
    };
}

/**
 * Wraps an authenticate middleware so req.scope is always set after it, for
 * routers that may be mounted behind a plain JWT check.
 */
export function withScope(authenticate: Mw): Mw {
    return (req, res, next) => authenticate(req, res, (err?: any) => {
        if (err) return next(err);
        if (!req.scope && req.user) req.scope = buildScope(req.user, req);
        next();
    });
}

export const requireInternal: Mw = (req, res, next) =>
    (req.scope?.isInternal ? next() : res.status(403).json({ error: 'Internal users only' }));

export const requireWrite: Mw = (req, res, next) =>
    (req.scope && canWrite(req.scope) ? next() : res.status(403).json({ error: 'Read-only role' }));
