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
// Live data visibility: a client sees no telemetry for a project with
// live_data_visible = false until a report for it has been published.
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
        filterTenantId: internal
            ? (typeof named === 'string' && UUID.test(named) ? named : null)
            // A client without a tenant sees nothing: filter on an id no row has.
            : (user?.tenantId ?? '00000000-0000-0000-0000-000000000000'),
    };
}

/** May this scope change data? client_viewer and broker are read-only here. */
export const canWrite = (s: Scope) => s.isInternal || s.role === 'client_admin';

/**
 * Non-GET routes a client_viewer may still call: asking about a report,
 * marking an alert read, asking Grid-IQ to follow up a recommendation.
 */
const VIEWER_ALLOWED = [
    /^\/meters\/[^/]+\/compliance\/ask$/,
    /^\/alerts\/[^/]+\/read$/,
    /^\/recommendations\/[^/]+\/notify$/,
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

/** Live-data condition on a project alias: always TRUE for internal users. */
export function telemetrySql(scope: Scope, projectAlias: string): string {
    if (scope.isInternal) return 'TRUE';
    return `(${projectAlias}.live_data_visible OR EXISTS (SELECT 1 FROM reports rp
              WHERE rp.project_id = ${projectAlias}.id AND rp.status = 'published'))`;
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
}

/** A site/project the scope may reach, or null. */
export async function findSite(db: Queryable, scope: Scope, id: string): Promise<ScopedSite | null> {
    if (!UUID.test(String(id))) return null;
    const params: unknown[] = [id];
    const t = tenantSql(scope, 'p.tenant_id', params);
    const r = await db.query(`
        SELECT p.id, p.tenant_id, p.name, p.address, p.archived_at, p.live_data_visible,
               ${telemetrySql(scope, 'p')} AS telemetry_visible
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

type Mw = (req: any, res: any, next: any) => void;

/** Resolves :id to a meter in scope (403 otherwise) as req.meter. */
export function meterParam(db: Queryable, opts: { telemetry?: boolean; write?: boolean } = {}): Mw {
    return async (req, res, next) => {
        try {
            if (opts.write && !canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
            const m = await findMeter(db, req.scope, req.params.id);
            if (!m) return res.status(403).json({ error: 'Forbidden' });
            if (opts.telemetry && !m.telemetry_visible) {
                return res.status(403).json({ error: 'Live data for this project is shared through published reports' });
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
                return res.status(403).json({ error: 'Live data for this project is shared through published reports' });
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
