// ─────────────────────────────────────────────────────────────────────────────
// Client portal API (plan Phase 8, PR 2). Everything a client's /portal pages
// read, through the central scope (src/scope.ts): a client sees its own
// projects only, and no telemetry where the project hides live data.
// Readings come from the corrected point views, attributed by deployment
// window, so a box that moved between clients shows each its own data.
//
//   GET /portal/projects                 projects with live tiles
//   GET /portal/projects/:id             one project, its points, live values
//   GET /points/:id/readings             chart series (point views)
//   GET /points/:id/load-profile         hour × weekday averages, baseload
//   GET /points/:id/demand               30-minute billed demand
//   GET /points/:id/power-quality        NRS 048-2 assessment of the current deployment
//   GET /points/:id/metering-report      period report: energy, TOU, demand, extremes, feasibility
//
// No internal fields: no device codes, corrections, commissioning or notes.
//
// Assessment access (2026-11-11): a client reaches a point's data only while
// it holds a live assessment grant on the project (src/scope.ts), and every
// range is clamped to that assessment's window and aligned inward to whole
// buckets, so nothing from before the start or after the end is returned.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool } from 'pg';
import { withScope, findSite, findPoint, tenantSql, telemetrySql, seesUnpublishedFindings, clampToAccess, alignInward, NO_ACCESS } from './scope';
import { planRead, pointSeriesSql } from './aggregates';
import { loadPointEnergy } from './fleet/balance';
import { assessPowerQuality } from './power-quality';
import { meteringReport, MAX_REPORT_DAYS } from './metering-report';

/**
 * PV / battery / arbitrage sizing is outside GridIQ's product (the feasibility
 * tool belongs to another party): off unless FEATURE_TOOLS=true.
 */
const featureSizing = () => process.env.FEATURE_TOOLS === 'true';

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const LIVE_WINDOW = "INTERVAL '15 minutes'";
/** Sorted-descending values with their share of time, thinned to at most n points (ends kept). */
export function loadDuration(values: number[], n: number): { pct: number; kva: number }[] {
    const v = [...values].sort((a, b) => b - a);
    if (!v.length) return [];
    const step = Math.max(1, Math.ceil(v.length / n));
    const out: { pct: number; kva: number }[] = [];
    for (let i = 0; i < v.length; i += step) out.push({ pct: Math.round((i / v.length) * 1000) / 10, kva: Math.round(v[i] * 10) / 10 });
    if (out[out.length - 1].pct !== Math.round(((v.length - 1) / v.length) * 1000) / 10) out.push({ pct: Math.round(((v.length - 1) / v.length) * 1000) / 10, kva: Math.round(v[v.length - 1] * 10) / 10 });
    return out;
}

/** Local midnight in South Africa (UTC+2, no DST). */
export function sastMidnight(now = new Date()): Date {
    const shifted = new Date(now.getTime() + 2 * 3_600_000);
    shifted.setUTCHours(0, 0, 0, 0);
    return new Date(shifted.getTime() - 2 * 3_600_000);
}

/** Latest 1-minute values per point (within 15 minutes). */
async function livePoints(db: Queryable, pointIds: string[]) {
    if (pointIds.length === 0) return new Map<string, any>();
    const r = await db.query(`
        SELECT DISTINCT ON (measurement_point_id) measurement_point_id, bucket,
               power_active_total_avg AS kw, power_factor_total_avg AS pf,
               (COALESCE(voltage_a_avg, 0) + COALESCE(voltage_b_avg, 0) + COALESCE(voltage_c_avg, 0))
                 / NULLIF((voltage_a_avg IS NOT NULL)::int + (voltage_b_avg IS NOT NULL)::int + (voltage_c_avg IS NOT NULL)::int, 0) AS v
        FROM point_readings_1m
        WHERE measurement_point_id = ANY($1) AND bucket >= NOW() - ${LIVE_WINDOW}
        ORDER BY measurement_point_id, bucket DESC`, [pointIds]);
    return new Map(r.rows.map((x) => [x.measurement_point_id, {
        at: x.bucket, kw: num(x.kw), pf: num(x.pf), v: num(x.v),
    }]));
}

/** The tiles on the projects list: current incomer kW, today's kWh, coverage, open alerts. */
async function projectTiles(db: Queryable, projectId: string, seesDrafts: boolean) {
    const pts = await db.query(`
        SELECT mp.id, mp.name, mp.role, mp.parent_point_id, d.device_id, d.installed_at
        FROM measurement_points mp
        LEFT JOIN deployments d ON d.measurement_point_id = mp.id AND d.removed_at IS NULL
        WHERE mp.project_id = $1 AND mp.archived_at IS NULL`, [projectId]);
    const incomers = pts.rows.filter((p) => p.role === 'incomer' && !p.parent_point_id).map((p) => p.id);
    const live = await livePoints(db, incomers);
    const kw = incomers.length && incomers.every((id) => live.has(id))
        ? incomers.reduce((a, id) => a + (live.get(id).kw ?? 0), 0) : null;
    let todayKwh: number | null = null;
    if (incomers.length) {
        const from = sastMidnight();
        let total = 0, any = false;
        for (const id of incomers) {
            const e = await loadPointEnergy(db, id, from, new Date());
            if (e.coverage > 0) { any = true; total += e.importKwh; }
        }
        todayKwh = any ? Math.round(total * 10) / 10 : null;
    }
    const deployed = pts.rows.filter((p) => p.device_id);
    const cov = deployed.length ? (await db.query(`
        SELECT AVG(COALESCE(device_coverage(d, GREATEST(NOW() - INTERVAL '24 hours', i)), 0)) AS c
        FROM unnest($1::uuid[], $2::timestamptz[]) AS x(d, i)`,
        [deployed.map((p) => p.device_id), deployed.map((p) => p.installed_at)])).rows[0].c : null;
    const alerts = deployed.length ? (await db.query(`
        SELECT count(*)::int AS n FROM alerts
        WHERE meter_id = ANY($1) AND NOT is_read AND created_at >= NOW() - INTERVAL '7 days'`,
        [deployed.map((p) => p.device_id)])).rows[0].n : 0;
    // The tile's detail (2026-11): every metered point with its live state, and the top
    // open alerts and findings, so a client sees at once what each meter is doing.
    const devIds = deployed.map((p) => p.device_id);
    const pointOf = new Map<string, string>(deployed.map((p) => [p.device_id, p.id]));
    const allLive = await livePoints(db, deployed.map((p) => p.id));
    const lastSeen = new Map<string, Date | null>(devIds.length ? (await db.query(`
        SELECT d AS device_id,
               (SELECT max(time) FROM meter_readings WHERE meter_id = d AND time > NOW() - INTERVAL '1 day') AS at
        FROM unnest($1::uuid[]) AS d`, [devIds])).rows.map((x) => [x.device_id, x.at]) : []);
    const meters = deployed.map((p) => {
        const at = lastSeen.get(p.device_id) ?? null;
        const age = at ? Math.max(0, (Date.now() - new Date(at).getTime()) / 1000) : null;
        const lv = allLive.get(p.id);
        return {
            point_id: p.id, name: p.name, role: p.role,
            last_reading_at: at, seconds_ago: age === null ? null : Math.round(age),
            // live: data within 2 minutes; delayed: within 15; silent: nothing for 15 minutes or more.
            state: age === null ? 'silent' : age <= 120 ? 'live' : age <= 900 ? 'delayed' : 'silent',
            kw: lv?.kw ?? null, v: lv?.v ?? null, pf: lv?.pf ?? null,
        };
    });
    const topAlerts = devIds.length ? (await db.query(`
        SELECT id, severity, type, message, created_at, meter_id FROM alerts
        WHERE meter_id = ANY($1) AND NOT is_read AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'WARNING' THEN 2 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 3`, [devIds])).rows.map((a) => ({
            id: a.id, severity: a.severity, type: a.type, message: a.message, created_at: a.created_at,
            point_id: pointOf.get(a.meter_id) ?? null,
        })) : [];
    const findings = (await db.query(`
        SELECT id, type, priority, title, review_status, estimated_monthly_saving_zar AS saving_zar, meter_id
        FROM recommendations
        WHERE site_id = $1 AND status = 'ACTIVE'
          AND ${seesDrafts ? "review_status <> 'dismissed'" : "review_status = 'published'"}
        ORDER BY priority, created_at DESC LIMIT 3`, [projectId])).rows.map((f) => ({
            id: f.id, type: f.type, priority: f.priority, title: f.title, review_status: f.review_status,
            saving_zar: num(f.saving_zar), point_id: f.meter_id ? pointOf.get(f.meter_id) ?? null : null,
        }));
    return {
        meters, top_alerts: topAlerts, findings,
        incomer_kw: kw === null ? null : Math.round(kw * 10) / 10,
        incomer_at: incomers.length ? (live.get(incomers[0])?.at ?? null) : null,
        today_kwh: todayKwh,
        coverage_24h: cov === null ? null : Math.round(Number(cov) * 1000) / 1000,
        open_alerts: alerts,
    };
}

export function portalRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const auth = withScope(authenticateJwt);
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try { await fn(req, res); } catch (e) {
            console.error(`[portal] ${req.method} ${req.path}:`, e);
            res.status(500).json({ error: 'Database error' });
        }
    };
    // A point in scope with a live assessment (clients); 403 otherwise.
    const point = async (req: any, res: any) => {
        const p = await findPoint(pool, req.scope, req.params.id);
        if (!p) { res.status(403).json({ error: 'Forbidden' }); return null; }
        if (!p.telemetry_visible) { res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' }); return null; }
        return p;
    };
    // The last `days` up to now, clamped to the access window and aligned to
    // whole buckets of widthMs; null (and an empty answer) if nothing is left.
    const lastDays = (p: any, days: number, widthMs: number) => {
        const to = new Date();
        const c = clampToAccess(new Date(to.getTime() - days * 86_400_000), to, p);
        return c ? alignInward(c, widthMs, p) : null;
    };

    r.get('/portal/projects', auth, handle(async (req, res) => {
        const params: unknown[] = [];
        const q = await pool.query(`
            SELECT p.id, p.name, p.end_client_name, p.address, p.status, p.starts_on, p.ends_on, p.timezone,
                   ${telemetrySql(req.scope, 'p')} AS telemetry_visible,
                   (SELECT row_to_json(x) FROM (
                        SELECT id, title, period_start, period_end FROM reports
                        WHERE project_id = p.id AND status = 'published' ORDER BY period_end DESC LIMIT 1) x) AS latest_report,
                   (SELECT count(*) FROM measurement_points mp WHERE mp.project_id = p.id AND mp.archived_at IS NULL)::int AS points
            FROM projects p
            WHERE p.archived_at IS NULL AND ${tenantSql(req.scope, 'p.tenant_id', params)}
            ORDER BY (p.status = 'active') DESC, p.name`, params);
        const out = [];
        for (const p of q.rows) out.push({ ...p, tiles: p.telemetry_visible ? await projectTiles(pool, p.id, seesUnpublishedFindings(req.scope)) : null });
        res.json(out);
    }));

    r.get('/portal/projects/:id', auth, handle(async (req, res) => {
        const site = await findSite(pool, req.scope, req.params.id);
        if (!site) return res.status(403).json({ error: 'Forbidden' });
        const p = (await pool.query(`
            SELECT id, name, end_client_name, address, status, starts_on, ends_on, timezone FROM projects WHERE id = $1`, [site.id])).rows[0];
        const pts = await pool.query(`
            SELECT mp.id, mp.name, mp.role, mp.parent_point_id, mp.nominal_voltage_v, mp.ct_primary_a,
                   mp.contracted_mdi_kva, mp.sort_order,
                   d.device_id, d.installed_at
            FROM measurement_points mp
            LEFT JOIN deployments d ON d.measurement_point_id = mp.id AND d.removed_at IS NULL
            WHERE mp.project_id = $1 AND mp.archived_at IS NULL
            ORDER BY mp.sort_order, mp.name`, [site.id]);
        const live = site.telemetry_visible ? await livePoints(pool, pts.rows.map((x) => x.id)) : new Map();
        res.json({
            ...p,
            telemetry_visible: site.telemetry_visible,
            points: pts.rows.map((x) => ({
                id: x.id, name: x.name, role: x.role, parent_point_id: x.parent_point_id,
                nominal_voltage_v: num(x.nominal_voltage_v), ct_primary_a: num(x.ct_primary_a),
                contracted_mdi_kva: num(x.contracted_mdi_kva),
                metered: !!x.device_id, metered_since: x.installed_at,
                // The device id is what share links and the health check address.
                device_id: x.device_id,
                live: live.get(x.id) ?? null,
            })),
        });
    }));

    r.get('/points/:id/readings', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const to = req.query.to ? new Date(String(req.query.to)) : new Date();
        const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 86_400_000);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return res.status(400).json({ error: 'from must be before to' });
        const clamped = clampToAccess(from, to, p);
        const plan = planRead(clamped?.from ?? from, clamped?.to ?? to);
        const bucket = plan.source === 'raw' && plan.bucketSeconds < 60 ? '1 minute' : plan.bucket;
        const range = clamped && alignInward(clamped, Math.max(60, plan.bucketSeconds) * 1000, p);
        if (!range) return res.json([]);
        const rows = await pool.query(pointSeriesSql(plan.source), [bucket, p.id, range.from, range.to]);
        res.setHeader('X-Readings-Source', `${plan.source === 'raw' ? 'point_readings_1m' : `point_${plan.source}`}; bucket=${bucket}`);
        res.json(rows.rows);
    }));

    r.get('/points/:id/load-profile', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const days = Math.min(Math.max(parseInt(String(req.query.days ?? '28')) || 28, 7), 90);
        const w = lastDays(p, days, 3_600_000) ?? { from: new Date(), to: new Date() };
        const q = await pool.query(`
            WITH h AS (
                SELECT bucket AT TIME ZONE 'Africa/Johannesburg' AS local, power_active_total_avg AS kw
                FROM point_readings_1h
                WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND power_active_total_avg IS NOT NULL
            )
            SELECT extract(isodow FROM local)::int AS weekday, extract(hour FROM local)::int AS hour,
                   avg(kw) AS kw, count(*)::int AS hours
            FROM h GROUP BY 1, 2 ORDER BY 1, 2`, [p.id, w.from, w.to]);
        const base = await pool.query(`
            SELECT percentile_cont(0.1) WITHIN GROUP (ORDER BY power_active_total_avg) AS p10,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY power_active_total_avg) FILTER (
                       WHERE extract(hour FROM bucket AT TIME ZONE 'Africa/Johannesburg') NOT BETWEEN 6 AND 17
                          OR extract(isodow FROM bucket AT TIME ZONE 'Africa/Johannesburg') >= 6) AS after_hours
            FROM point_readings_1h
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND power_active_total_avg IS NOT NULL`, [p.id, w.from, w.to]);
        res.json({
            point_id: p.id, days, timezone: 'Africa/Johannesburg', from: w.from, to: w.to,
            basis: 'hourly averages of active power (point_readings_1h), by local weekday (1 = Monday) and hour',
            cells: q.rows.map((x) => ({ weekday: x.weekday, hour: x.hour, kw: Math.round(Number(x.kw) * 10) / 10, hours: x.hours })),
            baseload_kw: base.rows[0].p10 === null ? null : Math.round(Number(base.rows[0].p10) * 10) / 10,
            after_hours_kw: base.rows[0].after_hours === null ? null : Math.round(Number(base.rows[0].after_hours) * 10) / 10,
        });
    }));

    r.get('/points/:id/demand', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30')) || 30, 1), 365);
        const w = lastDays(p, days, 1_800_000) ?? { from: new Date(), to: new Date() };
        // 30-minute intervals at least 80 % covered (billing basis): 24 of 30
        // minutes with data, or, for a meter that reports less often than once
        // a minute, its samples × its reporting interval ≥ 24 minutes.
        const spacing = Number((await pool.query(`
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t_last - t_first) / (n - 1)) AS s
            FROM point_readings_1h
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND n > 1`, [p.id, w.from, w.to])).rows[0].s) || 0;
        const iv = await pool.query(`
            SELECT bucket, kva_demand, kw_demand, minutes FROM point_readings_30m
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3
              AND (minutes >= 24 OR ($4::float8 > 60 AND n * $4::float8 >= 0.8 * 1800))
            ORDER BY bucket`, [p.id, w.from, w.to, spacing]);
        const rows = iv.rows.map((x) => ({ bucket: x.bucket, kva: num(x.kva_demand), kw: num(x.kw_demand) }));
        const top = [...rows].filter((x) => x.kva !== null).sort((a, b) => b.kva! - a.kva!).slice(0, 5);
        const daily = new Map<string, { date: string; kva: number; kw: number | null; at: Date }>();
        for (const x of rows) {
            if (x.kva === null) continue;
            const date = new Date(new Date(x.bucket).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
            const d = daily.get(date);
            if (!d || x.kva > d.kva) daily.set(date, { date, kva: x.kva, kw: x.kw, at: x.bucket });
        }
        const mdi = num(p.contracted_mdi_kva);
        const max = top[0] ?? null;
        res.json({
            point_id: p.id, days, timezone: 'Africa/Johannesburg', from: w.from, to: w.to,
            basis: `30-minute minute-weighted averages (point_readings_30m), intervals at least 80 % measured${spacing > 60 ? ` (meter reports every ${Math.round(spacing)} s)` : ''}`,
            intervals_assessed: rows.length,
            max_kva: max?.kva ?? null, max_kw: max?.kw ?? null, max_at: max?.bucket ?? null,
            contracted_mdi_kva: mdi,
            utilisation_pct: mdi && max?.kva ? Math.round((max.kva / mdi) * 1000) / 10 : null,
            top_intervals: top,
            daily_max: [...daily.values()],
            // Load-duration curve: every assessed interval, highest first, thinned to ≤ 300 points
            // (the first and last are always kept), and the time spent near the contracted limit.
            duration_curve: loadDuration(rows.map((x) => x.kva).filter((v): v is number => v !== null), 300),
            hours_above_90pct_mdi: mdi ? rows.filter((x) => x.kva !== null && x.kva > 0.9 * mdi).length / 2 : null,
        });
    }));

    r.get('/points/:id/power-quality', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const dep = (await pool.query(
            `SELECT device_id, installed_at FROM deployments WHERE measurement_point_id = $1 AND removed_at IS NULL`, [p.id])).rows[0];
        if (!dep) return res.json({ point_id: p.id, report: null, reason: 'no_device' });
        // The current deployment only: never data the box took somewhere else.
        const requested = Math.min(Math.max(parseInt(String(req.query.days ?? '7')) || 7, 1), 90);
        // Clients: never before their assessment start (whole days back from now).
        const since = Math.max(new Date(dep.installed_at).getTime(), p.access_from ? new Date(p.access_from).getTime() : 0);
        const sinceStart = Math.floor((Date.now() - since) / 86_400_000);
        if (p.access_from && sinceStart < 1) return res.json({ point_id: p.id, report: null, reason: 'insufficient_data', basis: 'needs one full day of the assessment' });
        const days = Math.max(1, Math.min(requested, p.access_from ? sinceStart : Math.ceil((Date.now() - since) / 86_400_000)));
        const report = await assessPowerQuality(pool, dep.device_id, days);
        res.json({
            point_id: p.id, days, requested_days: requested, timezone: 'Africa/Johannesburg',
            basis: 'NRS 048-2: 10-minute values (readings_10m) of the box currently at this point, since its install',
            report,
        });
    }));

    // Metering report for a period (src/metering-report.ts): energy and TOU split, maximum
    // demand, best/worst values, feasibility pointers and rough peak-shaving / arbitrage /
    // solar sizing. Default: the last 30 days; at most MAX_REPORT_DAYS.
    r.get('/points/:id/metering-report', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const to = req.query.to ? new Date(String(req.query.to)) : new Date();
        const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86_400_000);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return res.status(400).json({ error: 'from must be before to' });
        if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * 86_400_000) return res.status(400).json({ error: `A report covers at most ${MAX_REPORT_DAYS} days` });
        const c = clampToAccess(from, to, p);
        const range = c && alignInward(c, 1_800_000, p);
        if (!range) return res.status(400).json({ error: 'No part of this period lies inside the assessment', code: 'outside_assessment' });
        res.json(await meteringReport(pool, p.id, range.from, range.to, { sizing: featureSizing() }));
    }));

    return r;
}
