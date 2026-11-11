// ─────────────────────────────────────────────────────────────────────────────
// Retention and deletion (prompt section 14). The explicit, documented
// retention step that may delete raw meter_readings (master rule 5): see
// docs/gridiq/RUNBOOK-assessments.md → Retention.
//
// At an assessment's retention deadline (retention_until, or a documented
// exception) the jobs role deletes the assessment-linked measurement and
// report content:
//   raw readings of its points' deployments inside the assessment's data range
//   (from the install that served it to the end + late-data window), minus any
//   time another still-retained assessment of the same point covers; pq_events
//   and alerts of those devices in that range; findings; report datasets,
//   PDFs and the data package; exports of its points in the range; delivery
//   links; AI conversations.
// It keeps: the device, its deployments and maintenance history (the fleet's
// administrative record), the assessment row with its dates and commercial
// fields (financial record), the audit log (no measurement content), and a
// deletion receipt with counts. Tombstones record each deleted range so a
// restore from an older backup re-applies them before access
// (deploy/scripts/apply-tombstones.sh).
//
// Access already stopped at the deadline: deliverySql and byToken require
// retention_status = 'retained' and NOW() < retention_until, even if this job
// has not run. A failure is recorded (purge_failed) and retried.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type { Pool, PoolClient } from 'pg';
import { refreshAggregates } from '@gridiq/db';
import { lateDataHours, packagePrefix } from '../reports/closeout';
import { store, pdfKey } from '../storage';

/** The [from, to) ranges per device that belong to this assessment only. */
export async function purgeRanges(db: Pool | PoolClient, assessmentId: string) {
    return (await db.query(`
        WITH a AS (SELECT * FROM assessments WHERE id = $1),
        own AS (
            SELECT d.device_id,
                   d.installed_at AS r_from,
                   LEAST(COALESCE(d.removed_at, 'infinity'::timestamptz),
                         LEAST(a.end_at, COALESCE(a.closed_at, a.end_at)) + make_interval(hours => $2)) AS r_to
            FROM a JOIN assessment_points ap ON ap.assessment_id = a.id
            JOIN deployments d ON d.measurement_point_id = ap.measurement_point_id
            WHERE d.installed_at < LEAST(a.end_at, COALESCE(a.closed_at, a.end_at))
              AND (d.removed_at IS NULL OR d.removed_at > a.start_at)
        )
        SELECT o.device_id, o.r_from, o.r_to,
               -- other retained assessments of a point this device served, overlapping the range
               COALESCE((SELECT json_agg(json_build_object('from', b.start_at, 'to', LEAST(b.end_at, COALESCE(b.closed_at, b.end_at)) + make_interval(hours => $2)))
                         FROM assessments b JOIN assessment_points bp ON bp.assessment_id = b.id
                         JOIN deployments bd ON bd.measurement_point_id = bp.measurement_point_id AND bd.device_id = o.device_id
                         WHERE b.id <> $1 AND b.retention_status = 'retained' AND b.start_at IS NOT NULL
                           AND b.start_at < o.r_to AND b.end_at > o.r_from), '[]') AS keep
        FROM own o`, [assessmentId, lateDataHours()])).rows;
}

/** Subtract the kept windows from [from, to). */
export function subtractRanges(from: Date, to: Date, keep: { from: string | Date; to: string | Date }[]): [Date, Date][] {
    let parts: [number, number][] = [[from.getTime(), to.getTime()]];
    for (const k of keep) {
        const kf = new Date(k.from).getTime(), kt = new Date(k.to).getTime();
        parts = parts.flatMap(([f, t]) => {
            if (kt <= f || kf >= t) return [[f, t]] as [number, number][];
            const out: [number, number][] = [];
            if (kf > f) out.push([f, kf]);
            if (kt < t) out.push([kt, t]);
            return out;
        });
    }
    return parts.filter(([f, t]) => t > f).map(([f, t]) => [new Date(f), new Date(t)]);
}

/** Delete one assessment's content. Returns the receipt counts. */
export async function purgeAssessment(pool: Pool, assessmentId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const add = (k: string, n: number | null | undefined) => { counts[k] = (counts[k] ?? 0) + (n ?? 0); };
    const receipt = (await pool.query(`INSERT INTO assessment_purges (assessment_id) VALUES ($1) RETURNING id`, [assessmentId])).rows[0].id;
    try {
        await pool.query(`UPDATE assessments SET retention_status = 'purge_pending' WHERE id = $1`, [assessmentId]);
        const ranges = await purgeRanges(pool, assessmentId);
        const pointIds = (await pool.query(`SELECT measurement_point_id FROM assessment_points WHERE assessment_id = $1`, [assessmentId])).rows.map((x) => x.measurement_point_id);
        let minT = Infinity, maxT = -Infinity;
        for (const r of ranges) {
            const to = r.r_to && new Date(r.r_to).getTime() !== Infinity ? new Date(r.r_to) : new Date();
            for (const [f, t] of subtractRanges(new Date(r.r_from), to, r.keep ?? [])) {
                minT = Math.min(minT, f.getTime()); maxT = Math.max(maxT, t.getTime());
                // Compressed chunks: TimescaleDB decompresses what a DELETE touches.
                add('meter_readings', (await pool.query(`DELETE FROM meter_readings WHERE meter_id = $1 AND time >= $2 AND time < $3`, [r.device_id, f, t])).rowCount);
                add('pq_events', (await pool.query(`DELETE FROM pq_events WHERE meter_id = $1 AND started_at >= $2 AND started_at < $3`, [r.device_id, f, t])).rowCount);
                add('alerts', (await pool.query(`DELETE FROM alerts WHERE meter_id = $1 AND created_at >= $2 AND created_at < $3`, [r.device_id, f, t])).rowCount);
                add('recommendations', (await pool.query(`DELETE FROM recommendations WHERE meter_id = $1 AND created_at >= $2 AND created_at < $3`, [r.device_id, f, t])).rowCount);
                await pool.query(`INSERT INTO deletion_tombstones (assessment_id, entity, device_id, range_from, range_to) VALUES ($1, 'meter_readings', $2, $3, $4)`,
                    [assessmentId, r.device_id, f, t]);
            }
        }
        // Aggregates over the deleted ranges.
        if (Number.isFinite(minT)) await refreshAggregates(pool, new Date(minT - 86_400_000), new Date(maxT + 86_400_000));

        // Reports: content (dataset, PDF) removed; the row stays as a record that it existed.
        const reps = (await pool.query(`SELECT id, pdf_path FROM reports WHERE assessment_id = $1`, [assessmentId])).rows;
        for (const rp of reps) {
            if (rp.pdf_path && await store().remove('uploads', pdfKey(rp.pdf_path))) add('files', 1);
        }
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query(`SET LOCAL gridiq.purge = 'on'`);
            add('report_datasets', (await c.query(`UPDATE reports SET dataset = NULL, pdf_path = NULL WHERE assessment_id = $1 AND (dataset IS NOT NULL OR pdf_path IS NOT NULL)`, [assessmentId])).rowCount);
            await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
        await pool.query(`INSERT INTO deletion_tombstones (assessment_id, entity, ref) VALUES ($1, 'reports', 'datasets and PDFs of every revision')`, [assessmentId]);

        // The data package and API exports of these points in the range.
        const pkg = (await pool.query(`SELECT package_path FROM assessments WHERE id = $1`, [assessmentId])).rows[0]?.package_path;
        const prefix = packagePrefix(pkg);
        // Every revision of the package: packages/<assessment>/.
        if (prefix) add('files', await store().removePrefix('exports', `${prefix.split('/').slice(0, 2).join('/')}/`));
        if (pointIds.length && Number.isFinite(minT)) {
            const ex = (await pool.query(`
                UPDATE exports SET status = 'expired' WHERE measurement_point_id = ANY($1) AND period_from < $3 AND period_to > $2 AND status <> 'expired'
                RETURNING id`, [pointIds, new Date(minT), new Date(maxT)])).rows;
            for (const e of ex) if (await store().remove('exports', `${e.id}.csv.gz`)) add('files', 1);
            add('exports', ex.length);
        }
        add('delivery_links', (await pool.query(`DELETE FROM delivery_links WHERE assessment_id = $1`, [assessmentId])).rowCount);
        add('ai_messages', (await pool.query(`DELETE FROM ai_messages WHERE assessment_id = $1`, [assessmentId])).rowCount);
        // Emails keep no copy of content: bodies are cleared, the send record stays.
        add('email_bodies', (await pool.query(`UPDATE email_outbox SET body_text = '[deleted with the assessment data]', body_html = NULL, attachments = '[]'::jsonb
                                               WHERE assessment_id = $1 AND body_text <> '[deleted with the assessment data]'`, [assessmentId])).rowCount);
        await pool.query(`UPDATE assessments SET retention_status = 'purged', package_path = NULL WHERE id = $1`, [assessmentId]);
        await pool.query(`UPDATE assessment_purges SET status = 'done', finished_at = NOW(), counts = $2 WHERE id = $1`, [receipt, JSON.stringify(counts)]);
        await pool.query(`INSERT INTO audit_log (actor_email, action, entity_type, entity_id, after, reason)
                          VALUES ('system', 'assessment.purge', 'assessment', $1, $2, 'retention deadline')`, [assessmentId, JSON.stringify(counts)]);
        return counts;
    } catch (e: any) {
        await pool.query(`UPDATE assessments SET retention_status = 'purge_failed' WHERE id = $1`, [assessmentId]);
        await pool.query(`UPDATE assessment_purges SET status = 'failed', finished_at = NOW(), counts = $2, error = $3 WHERE id = $1`,
            [receipt, JSON.stringify(counts), String(e?.message ?? e).slice(0, 500)]);
        throw e;
    }
}

/** Jobs role (hourly): purge every assessment past its deadline; retry failures. */
export async function runRetention(pool: Pool): Promise<number> {
    const due = (await pool.query(`
        SELECT id FROM assessments
        WHERE retention_status IN ('retained', 'purge_failed', 'purge_pending')
          AND start_at IS NOT NULL AND retention_until IS NOT NULL
          AND COALESCE(retention_exception_until, retention_until) <= NOW()
        ORDER BY retention_until LIMIT 5`)).rows;
    let n = 0;
    for (const a of due) {
        try { await purgeAssessment(pool, a.id); n++; } catch (e) { console.error(`[retention] ${a.id} failed:`, e); }
    }
    return n;
}
