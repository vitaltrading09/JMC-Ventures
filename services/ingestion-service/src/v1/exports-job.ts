// ─────────────────────────────────────────────────────────────────────────────
// Background exports (plan Phase 9; jobs role, every minute).
//
// POST /v1/exports queues a row in `exports`. The worker claims one (FOR UPDATE
// SKIP LOCKED, so two jobs containers never take the same one), reads the
// point's series in chunks of at most MAX_RANGE_DAYS, and streams it as gzip
// CSV to EXPORT_DIR/<id>.csv.gz (written as .part, renamed when complete).
// Done exports are downloadable for EXPORT_TTL_DAYS (7), then the file is
// deleted and the row marked expired. A job left `running` by a dead worker
// for more than an hour is put back in the queue.
//
// Exports only read readings; nothing here writes meter_readings.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { Pool } from 'pg';
import { loadSeries, csvHeader, csvRows, datasetId, MAX_RANGE_DAYS, Interval } from './series';
import { exportEntitledSql } from '../scope';
import { store } from '../storage';

const DAY = 86_400_000;
export const EXPORT_TTL_DAYS = 7;
export const exportDir = () => path.resolve(process.env.EXPORT_DIR || '/data/exports');

/** [from, to) in chunks the series reader accepts. */
export function chunks(from: Date, to: Date, interval: Interval): [Date, Date][] {
    const step = MAX_RANGE_DAYS[interval] * DAY;
    const out: [Date, Date][] = [];
    for (let a = from.getTime(); a < to.getTime(); a += step) out.push([new Date(a), new Date(Math.min(a + step, to.getTime()))]);
    return out;
}

/** Write one export to `file`; returns rows and bytes. */
export async function writeExport(pool: Pool, job: any, file: string): Promise<{ rows: number; bytes: number }> {
    const meta = (await pool.query(`
        SELECT mp.name AS point, p.name AS project FROM measurement_points mp JOIN projects p ON p.id = mp.project_id
        WHERE mp.id = $1`, [job.measurement_point_id])).rows[0];
    if (!meta) throw new Error('measurement point no longer exists');
    const interval = job.interval as Interval;
    const from = new Date(job.period_from), to = new Date(job.period_to);
    const part = `${file}.part`;
    const gz = zlib.createGzip();
    const out = fs.createWriteStream(part);
    const done = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.on('error', reject); });
    gz.pipe(out);
    const write = (s: string) => new Promise<void>((resolve) => { if (gz.write(s)) resolve(); else gz.once('drain', resolve); });
    let rows = 0;
    try {
        await write(csvHeader({ dataset_id: datasetId(job.measurement_point_id, interval, from, to), ...meta, interval, from, to }));
        for (const [a, b] of chunks(from, to, interval)) {
            const series = await loadSeries(pool, job.measurement_point_id, interval, a, b);
            rows += series.length;
            await write(csvRows(series));
        }
        gz.end();
        await done;
    } catch (e) {
        gz.destroy(); out.destroy();
        fs.rmSync(part, { force: true });
        throw e;
    }
    fs.renameSync(part, file);
    return { rows, bytes: fs.statSync(file).size };
}

/** Claim and run queued exports (at most `max` per call). */
export async function runExports(pool: Pool, max = 5): Promise<number> {
    const dir = exportDir();
    fs.mkdirSync(dir, { recursive: true });
    // A worker that died mid-export leaves `running`; give it back to the queue.
    await pool.query(`UPDATE exports SET status = 'queued', started_at = NULL
                      WHERE status = 'running' AND started_at < NOW() - INTERVAL '1 hour'`);
    let n = 0;
    for (; n < max; n++) {
        const job = (await pool.query(`
            UPDATE exports SET status = 'running', started_at = NOW()
            WHERE id = (SELECT id FROM exports WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *`)).rows[0];
        if (!job) break;
        // The requester's assessment may have ended while the job waited.
        const ok = (await pool.query(`SELECT 1 FROM exports e WHERE e.id = $1 AND ${exportEntitledSql('e')}`, [job.id])).rows.length > 0;
        if (!ok) {
            await pool.query(`UPDATE exports SET status = 'failed', error = 'assessment access ended before the export ran', finished_at = NOW() WHERE id = $1`, [job.id]);
            continue;
        }
        if (!job) break;
        const file = path.join(dir, `${job.id}.csv.gz`);
        try {
            const { rows, bytes } = await writeExport(pool, job, file);
            // FILE_STORE=r2: upload and drop the local copy; local: no-op.
            await store().putFile('exports', `${job.id}.csv.gz`, file, 'application/gzip');
            await pool.query(`
                UPDATE exports SET status = 'done', rows = $2, bytes = $3, finished_at = NOW(),
                       expires_at = NOW() + make_interval(days => $4) WHERE id = $1`, [job.id, rows, bytes, EXPORT_TTL_DAYS]);
            console.log(`[EXPORT] ${job.id}: ${rows} rows, ${bytes} bytes`);
        } catch (e: any) {
            console.error(`[EXPORT] ${job.id} failed:`, e);
            await pool.query(`UPDATE exports SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
                [job.id, String(e?.message ?? e).slice(0, 500)]);
        }
    }
    return n;
}

/** Delete files of expired exports and mark them expired. */
export async function expireExports(pool: Pool): Promise<number> {
    const dir = exportDir();
    const q = await pool.query(`UPDATE exports SET status = 'expired' WHERE status = 'done' AND expires_at < NOW() RETURNING id`);
    for (const { id } of q.rows) { fs.rmSync(path.join(dir, `${id}.csv.gz`), { force: true }); await store().remove('exports', `${id}.csv.gz`); }
    return q.rowCount ?? 0;
}
