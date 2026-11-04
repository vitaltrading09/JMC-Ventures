// ─────────────────────────────────────────────────────────────────────────────
// Ops console API (plan Phase 8): what the internal pages need beyond the
// fleet and review routers. Internal roles only.
//
//   GET /tenants            every tenant (the install wizard and filters;
//                           the auth service's list is super_admin only)
//   GET /ops/data-health    silent meters, dead letters, unknown parameter
//                           names, duplicate-timestamp conflicts, register
//                           resets and clock drift, in one call
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool } from 'pg';
import { requireInternal, withScope } from './scope';
import { loadEnergyHours, periodEnergy } from './energy';

const envPos = (name: string, def: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : def;
};

export function opsRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const guard = [withScope(authenticateJwt), requireInternal];
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try { await fn(req, res); } catch (e) {
            console.error(`[ops] ${req.method} ${req.path}:`, e);
            res.status(500).json({ error: 'Database error' });
        }
    };

    r.get('/tenants', ...guard, handle(async (_req, res) => {
        const q = await pool.query(`
            SELECT t.id, t.name, t.kind, t.slug,
                   (SELECT count(*) FROM projects p WHERE p.tenant_id = t.id AND p.archived_at IS NULL)::int AS projects
            FROM tenants t ORDER BY t.kind DESC, t.name`);
        res.json(q.rows);
    }));

    r.get('/ops/data-health', ...guard, handle(async (_req, res) => {
        const silentMin = envPos('METER_SILENT_MINUTES', 5);
        const [devices, deadByError, deadRecent, unknown, conflicts] = await Promise.all([
            pool.query(`
                WITH lag AS (
                    SELECT meter_id, date_trunc('minute', ingested_at) AS minute,
                           min(abs(extract(epoch FROM ingested_at - device_time))) AS lag_s
                    FROM meter_readings
                    WHERE time >= NOW() - INTERVAL '75 minutes' AND ingested_at >= NOW() - INTERVAL '1 hour'
                      AND device_time IS NOT NULL AND time_source = 'DEVICE'
                    GROUP BY 1, 2
                )
                SELECT d.id, d.code, d.name, d.status, p.name AS project_name, mp.name AS point_name,
                       (SELECT max(time) FROM meter_readings r WHERE r.meter_id = d.id AND r.time >= NOW() - INTERVAL '30 days') AS last_seen,
                       device_spacing_s(d.id, NOW() - INTERVAL '24 hours') AS spacing_s,
                       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_s) FROM lag WHERE lag.meter_id = d.id) AS drift_s
                FROM devices d
                LEFT JOIN deployments dep ON dep.device_id = d.id AND dep.removed_at IS NULL
                LEFT JOIN measurement_points mp ON mp.id = dep.measurement_point_id
                LEFT JOIN projects p ON p.id = mp.project_id
                WHERE d.status = 'deployed' AND d.archived_at IS NULL`),
            pool.query(`
                SELECT error_msg, count(*)::int AS n, max(received_at) AS last
                FROM dead_letter_payloads WHERE received_at >= NOW() - INTERVAL '24 hours'
                GROUP BY 1 ORDER BY n DESC`),
            pool.query(`
                SELECT id, received_at, topic, error_msg, left(raw_payload, 300) AS payload
                FROM dead_letter_payloads ORDER BY received_at DESC LIMIT 50`),
            pool.query(`
                SELECT u.meter_id, d.code, d.name AS meter_name, d.model, u.name, u.first_seen, u.last_seen
                FROM ingest_unknown_params u JOIN devices d ON d.id = u.meter_id
                WHERE u.last_seen >= NOW() - INTERVAL '7 days'
                ORDER BY u.last_seen DESC, u.name`),
            pool.query(`
                SELECT s.meter_id, d.code, d.name, SUM(s.conflicts)::int AS conflicts, SUM(s.rows_written)::int AS rows
                FROM ingest_stats s JOIN devices d ON d.id = s.meter_id
                WHERE s.hour >= NOW() - INTERVAL '24 hours'
                GROUP BY 1, 2, 3 HAVING SUM(s.conflicts) > 0
                ORDER BY 4 DESC`),
        ]);

        const now = Date.now();
        // Silent: nothing for METER_SILENT_MINUTES, or three reporting intervals if the box reports less often.
        const silentAfterMs = (d: any) => Math.max(silentMin * 60_000, 3 * (Number(d.spacing_s) || 0) * 1000);
        const silent = devices.rows.filter((d) => !d.last_seen || now - new Date(d.last_seen).getTime() > silentAfterMs(d));
        const drift = devices.rows.filter((d) => d.drift_s !== null && Number(d.drift_s) > 5)
            .map((d) => ({ ...d, drift_s: Math.round(Number(d.drift_s) * 10) / 10 }));

        // Register resets and implausible jumps over the last 7 days, per deployed device.
        const since = new Date(now - 7 * 86_400_000);
        const registers: any[] = [];
        for (const d of devices.rows) {
            const [p] = periodEnergy(await loadEnergyHours(pool, d.id, since), () => '7d');
            if (p && (p.data_quality.register_resets > 0 || p.data_quality.implausible_jumps > 0)) {
                registers.push({ id: d.id, code: d.code, name: d.name, project_name: d.project_name, ...p.data_quality });
            }
        }

        res.json({
            generated_at: new Date().toISOString(),
            silent_minutes: silentMin,
            silent: silent.map(({ drift_s, spacing_s, ...d }) => d),
            clock_drift: drift,
            dead_letters: { last_24h: deadByError.rows, recent: deadRecent.rows },
            unknown_params: unknown.rows,
            conflicts: conflicts.rows,
            registers,
        });
    }));

    return r;
}
