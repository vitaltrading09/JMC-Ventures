// ─────────────────────────────────────────────────────────────────────────────
// Report revisions, automatic close-out and final delivery (prompt sections
// 5, 11, 13 and 15).
//
// Close-out (jobs role, every 5 minutes), for an assessment whose effective
// end plus the late-data window (ASSESSMENT_LATE_DATA_HOURS, default 2) has
// passed:
//   1. freeze the overview and handover datasets (issued automatically: they
//      are factual, from reviewed templates) and the power-quality dataset as a
//      draft for engineering review (never published by a timer);
//   2. render the PDFs, write the data package with its manifest;
//   3. create one expiring delivery link per report recipient and queue one
//      email each (dedupe key per assessment and recipient: a restart or a
//      retry does not send twice).
// Each step is idempotent; a failed close-out is retried after 30 minutes and
// shown to staff.
//
// Revisions: an issued report never changes. Late data or a correction makes a
// new revision that supersedes the old one, with a stated reason.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { buildAssessmentDataset, canonical, sha256, TEMPLATE_VERSION, CALC_VERSION, RULE_VERSION } from './dataset';
import { renderReportPdf, TITLES } from './pdf';
import { writePackage, packageDir } from './package';
import { enqueueForGrantee, appUrl } from '../notify/email';
import { uploadDir, toStoredUploadPath, resolveStoredUploadPath } from '../roles';
import { withScope, requireInternal, liveAssessmentSql, deliverySql, NO_ACCESS } from '../scope';

type Kind = 'overview' | 'power_quality' | 'handover';
const KINDS: Kind[] = ['overview', 'power_quality', 'handover'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const lateDataHours = () => Math.max(0, Number(process.env.ASSESSMENT_LATE_DATA_HOURS ?? 2) || 0);

const pdfDir = () => path.join(uploadDir(), 'report-pdfs');

/**
 * Freeze a new report revision for an assessment: dataset, hash, PDF. `issue`
 * publishes it at once (factual baseline); otherwise it waits for review.
 * Supersedes the previous issued revision of the same kind.
 */
export async function createRevision(db: Pool, assessmentId: string, kind: Kind,
    o: { cutoff: Date; issue: boolean; reason?: string | null; actorId?: string | null; provisional?: boolean }) {
    const ds = await buildAssessmentDataset(db, assessmentId, o.cutoff, { provisional: o.provisional });
    const hash = sha256(canonical(ds));
    const c = await db.connect();
    try {
        await c.query('BEGIN');
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`report:${assessmentId}:${kind}`]);
        const prev = (await c.query(`
            SELECT id, revision, published_at FROM reports WHERE assessment_id = $1 AND kind = $2 ORDER BY revision DESC LIMIT 1`, [assessmentId, kind])).rows[0];
        const revision = (prev?.revision ?? 0) + 1;
        const a = (await c.query(`SELECT project_id, reference FROM assessments WHERE id = $1`, [assessmentId])).rows[0];
        const row = (await c.query(`
            INSERT INTO reports (project_id, title, period_start, period_end, status, created_by, assessment_id, kind, revision, supersedes_id,
                                 revision_reason, provisional, dataset, dataset_sha256, data_cutoff_at, calc_version, rule_version, template_version, generated_at)
            VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW()) RETURNING *`,
            [a.project_id, `${TITLES[kind]} · ${a.reference}${revision > 1 ? ` (rev ${revision})` : ''}`, ds.assessment.period_from, ds.assessment.period_to,
             o.actorId ?? null, assessmentId, kind, revision, prev?.id ?? null, o.reason ?? null, !!o.provisional, ds, hash, o.cutoff,
             CALC_VERSION, RULE_VERSION, TEMPLATE_VERSION])).rows[0];
        const pdf = await renderReportPdf(kind, ds, { revision, sha256: hash, status: o.issue ? 'published' : 'draft', generatedAt: new Date(), reason: o.reason });
        fs.mkdirSync(pdfDir(), { recursive: true });
        const file = path.join(pdfDir(), `${row.id}.pdf`);
        fs.writeFileSync(file, pdf);
        await c.query(`UPDATE reports SET pdf_path = $2, pdf_sha256 = $3 WHERE id = $1`, [row.id, toStoredUploadPath(file), sha256(pdf)]);
        if (o.issue) {
            await c.query(`UPDATE reports SET status = 'published', approved_at = NOW(), published_at = NOW() WHERE id = $1`, [row.id]);
            if (prev?.published_at) await c.query(`UPDATE reports SET superseded_at = NOW() WHERE id = $1`, [prev.id]);
        }
        await c.query(`INSERT INTO audit_log (actor_user_id, actor_email, action, entity_type, entity_id, after, reason)
                       VALUES ($1, $2, $3, 'report', $4, $5, $6)`,
            [o.actorId ?? null, o.actorId ? null : 'system', o.issue ? 'report.issue' : 'report.draft', row.id,
             JSON.stringify({ assessment_id: assessmentId, kind, revision, dataset_sha256: hash }), o.reason ?? null]);
        await c.query('COMMIT');
        return { ...row, revision, dataset_sha256: hash, file, ds };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/** Latest revision per kind (issued, or any when staff). */
async function latestReports(db: Pool | PoolClient, assessmentId: string, issuedOnly: boolean) {
    return (await db.query(`
        SELECT DISTINCT ON (kind) id, kind, revision, status, published_at, superseded_at, pdf_path, pdf_sha256, dataset_sha256, data_cutoff_at,
               provisional, revision_reason, generated_at
        FROM reports WHERE assessment_id = $1 ${issuedOnly ? "AND status = 'published'" : ''}
        ORDER BY kind, revision DESC`, [assessmentId])).rows;
}

/** Build (or rebuild) the data package from the latest issued datasets. */
export async function buildPackage(db: Pool, assessmentId: string) {
    const reps = await latestReports(db, assessmentId, true);
    const overview = reps.find((r) => r.kind === 'overview');
    if (!overview) throw new Error('no issued overview yet');
    const ds = (await db.query(`SELECT dataset FROM reports WHERE id = $1`, [overview.id])).rows[0].dataset;
    const pdfs = reps.filter((r) => r.pdf_path).map((r) => ({ name: `${r.kind}-r${r.revision}.pdf`, file: resolveStoredUploadPath(r.pdf_path)! }))
        .filter((x) => x.file && fs.existsSync(x.file));
    const pkg = await writePackage(db, ds, overview.revision, pdfs);
    await db.query(`UPDATE assessments SET package_path = $2 WHERE id = $1`, [assessmentId, pkg.dir]);
    return pkg;
}

/** Create (or reuse) a delivery link for each report recipient and queue the email. */
export async function deliver(db: Pool, assessmentId: string, why: 'closeout' | 'revision' = 'closeout', tag = '1') {
    const a = (await db.query(`
        SELECT a.*, LEAST(a.end_at, COALESCE(a.closed_at, a.end_at)) AS eff_end, p.name AS project_name
        FROM assessments a JOIN projects p ON p.id = a.project_id WHERE a.id = $1`, [assessmentId])).rows[0];
    const until = new Date(Math.min(new Date(a.eff_end).getTime() + a.delivery_days * 86_400_000,
        a.retention_until ? new Date(a.retention_until).getTime() : Infinity));
    const grants = (await db.query(`SELECT id, email FROM assessment_grants WHERE assessment_id = $1 AND revoked_at IS NULL AND receives_reports`, [assessmentId])).rows;
    const reps = await latestReports(db, assessmentId, true);
    const pending = (await latestReports(db, assessmentId, false)).filter((r) => r.status !== 'published');
    let queued = 0;
    for (const g of grants) {
        const token = crypto.randomBytes(32).toString('base64url');
        // One link per recipient per send; the email holds the only copy of the token.
        const key = `${why}:${assessmentId}:${g.id}:${tag}`;
        const exists = (await db.query(`SELECT 1 FROM email_outbox WHERE dedupe_key = $1`, [key])).rows.length;
        if (exists) continue;
        await db.query(`INSERT INTO delivery_links (assessment_id, grant_id, email, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
            [assessmentId, g.id, g.email, sha256(token), until]);
        const link = `${appUrl()}/delivery/${token}`;
        const lines = [
            `Your GridIQ assessment ${a.reference} of ${a.project_name} has ${why === 'closeout' ? 'ended' : 'a corrected report'}.`,
            '',
            why === 'closeout' ? 'The deliverables are ready:' : 'The corrected deliverables:',
            ...reps.map((r) => `  - ${TITLES[r.kind as Kind]} (revision ${r.revision})`),
            '  - the data package (CSV files and a manifest)',
            ...(pending.length ? ['', `Still in engineering review: ${pending.map((r) => TITLES[r.kind as Kind]).join(', ')}. You will receive it when it is issued.`] : []),
            '',
            `Download (this link is personal and works until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC):`,
            link,
            '',
            `Live data, history and the consultant closed at the end of the assessment. The data is kept until ${a.retention_until ? new Date(a.retention_until).toISOString().slice(0, 10) : 'the agreed retention date'}, then deleted.`,
        ];
        if (await enqueueForGrantee(db, assessmentId, { dedupeKey: key, to: g.email, subject: `GridIQ ${a.reference}: your assessment deliverables`, text: lines.join('\n'), purpose: `delivery_${why}` })) queued++;
    }
    return queued;
}

/** Jobs role: close out assessments whose end (plus the late-data window) has passed. */
export async function runCloseouts(pool: Pool): Promise<number> {
    const due = (await pool.query(`
        UPDATE assessments SET closeout_status = 'running', closeout_at = NOW(), closeout_error = NULL
        WHERE id IN (
            SELECT id FROM assessments
            WHERE status IN ('active', 'ended') AND start_at IS NOT NULL
              AND LEAST(end_at, COALESCE(closed_at, end_at)) + make_interval(hours => $1) <= NOW()
              AND (closeout_status = 'pending'
                   OR (closeout_status = 'failed' AND closeout_at < NOW() - INTERVAL '30 minutes')
                   OR (closeout_status = 'running' AND closeout_at < NOW() - INTERVAL '1 hour'))
              AND retention_status = 'retained'
            ORDER BY end_at LIMIT 3 FOR UPDATE SKIP LOCKED)
        RETURNING id, end_at, closed_at`, [lateDataHours()])).rows;
    for (const a of due) {
        try {
            const cutoff = new Date(Math.min(new Date(a.end_at).getTime(), a.closed_at ? new Date(a.closed_at).getTime() : Infinity));
            const have = await latestReports(pool, a.id, false);
            for (const kind of KINDS) {
                if (have.some((r) => r.kind === kind && !r.provisional)) continue;
                // The factual baseline and the data handover are issued automatically;
                // engineering conclusions (power quality) wait for review.
                await createRevision(pool, a.id, kind, { cutoff, issue: kind !== 'power_quality' });
            }
            await buildPackage(pool, a.id);
            await deliver(pool, a.id, 'closeout');
            const pqIssued = (await latestReports(pool, a.id, true)).some((r) => r.kind === 'power_quality');
            await pool.query(`UPDATE assessments SET closeout_status = 'done', report_status = $2, status = 'ended' WHERE id = $1`,
                [a.id, pqIssued ? 'issued' : 'awaiting_review']);
            await pool.query(`INSERT INTO audit_log (actor_email, action, entity_type, entity_id, reason) VALUES ('system', 'assessment.closeout', 'assessment', $1, 'end reached')`, [a.id]);
        } catch (e: any) {
            console.error(`[closeout] ${a.id} failed:`, e);
            await pool.query(`UPDATE assessments SET closeout_status = 'failed', closeout_error = $2 WHERE id = $1`, [a.id, String(e?.message ?? e).slice(0, 500)]);
        }
    }
    return due.length;
}

/** Jobs role: one "ends in 24 hours" notice per recipient per assessment. */
export async function notifyNearingEnd(pool: Pool): Promise<number> {
    const rows = (await pool.query(`
        SELECT a.id, a.reference, a.end_at, g.email, p.name AS project_name
        FROM assessments a JOIN assessment_grants g ON g.assessment_id = a.id AND g.revoked_at IS NULL
        JOIN projects p ON p.id = a.project_id
        WHERE a.status = 'active' AND a.closed_at IS NULL AND a.end_at > NOW() AND a.end_at <= NOW() + INTERVAL '24 hours'`)).rows;
    let n = 0;
    for (const r of rows) {
        if (await enqueueForGrantee(pool, r.id, {
            dedupeKey: `ending:${r.id}:${r.email}`, to: r.email, purpose: 'nearing_end',
            subject: `GridIQ ${r.reference}: your assessment ends within 24 hours`,
            text: `Your GridIQ assessment ${r.reference} of ${r.project_name} ends at ${new Date(r.end_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.\nLive data, history, exports and the consultant close at that moment. Reports and the data package follow.\n\n${appUrl()}/portal`,
        })) n++;
    }
    return n;
}

/** Late data after an issued revision's snapshot: rows in its window ingested after it was generated. */
export async function lateData(db: Pool | PoolClient, assessmentId: string) {
    const reps = (await db.query(`
        SELECT r.id, r.kind, r.revision, r.generated_at, r.period_start, r.period_end
        FROM reports r WHERE r.assessment_id = $1 AND r.status = 'published' AND r.superseded_at IS NULL`, [assessmentId])).rows;
    const out = [];
    for (const r of reps) {
        const n = (await db.query(`
            SELECT count(*)::int AS n FROM meter_readings mr
            JOIN deployments d ON d.device_id = mr.meter_id
            JOIN assessment_points ap ON ap.measurement_point_id = d.measurement_point_id AND ap.assessment_id = $1
            WHERE mr.time >= GREATEST($2, d.installed_at) AND mr.time < LEAST($3, COALESCE(d.removed_at, 'infinity'::timestamptz))
              AND mr.ingested_at > $4`, [assessmentId, r.period_start, r.period_end, r.generated_at])).rows[0].n;
        out.push({ report_id: r.id, kind: r.kind, revision: r.revision, late_rows: n });
    }
    return out;
}

// ── Routes ─────────────────────────────────────────────────────────────────
export function deliverablesRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r = Router();
    const auth = withScope(authenticateJwt);
    const staff = [auth, requireInternal];
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try { await fn(req, res); } catch (e: any) {
            console.error(`[deliverables] ${req.method} ${req.path}:`, e);
            if (!res.headersSent) res.status(500).json({ error: String(e?.message ?? 'Server error').slice(0, 200) });
        }
    };

    /** The assessment if the caller may see it live (clients: grant; staff: any). */
    const liveFor = async (req: any, id: string) => {
        if (!UUID.test(id)) return null;
        if (req.scope.isInternal) return (await pool.query(`SELECT * FROM assessments WHERE id = $1`, [id])).rows[0] ?? null;
        return (await pool.query(`SELECT a.* FROM assessments a WHERE a.id = $1 AND a.tenant_id = $2 AND ${liveAssessmentSql(req.scope, 'a')}`,
            [id, req.scope.tenantId])).rows[0] ?? null;
    };
    /** The assessment if the caller may download its frozen deliverables (live or delivery window). */
    const deliverableFor = async (req: any, id: string) => {
        if (!UUID.test(id)) return null;
        if (req.scope.isInternal) return (await pool.query(`SELECT * FROM assessments WHERE id = $1`, [id])).rows[0] ?? null;
        return (await pool.query(`
            SELECT a.* FROM assessments a JOIN projects p ON p.id = a.project_id
            WHERE a.id = $1 AND a.tenant_id = $2 AND ${deliverySql(req.scope, 'p')}
              AND EXISTS (SELECT 1 FROM assessment_grants g WHERE g.assessment_id = a.id AND g.revoked_at IS NULL
                          AND (g.user_id = $3 OR (g.user_id IS NULL AND g.email = (SELECT lower(email) FROM users WHERE id = $3))))`,
            [id, req.scope.tenantId, req.scope.userId])).rows[0] ?? null;
    };

    // Provisional preview for the elapsed period (staff, or a client while live). Not stored.
    r.get('/assessments/:id/preview.pdf', auth, handle(async (req, res) => {
        const a = await liveFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
        if (!a.start_at) return res.status(409).json({ error: 'The assessment has not started' });
        const kind = (KINDS as string[]).includes(String(req.query.kind)) ? (req.query.kind as Kind) : 'overview';
        const ds = await buildAssessmentDataset(pool, a.id, new Date(), { provisional: true });
        const pdf = await renderReportPdf(kind, ds, { revision: 0, sha256: sha256(canonical(ds)), status: 'provisional preview', generatedAt: new Date() });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${a.reference}-${kind}-provisional.pdf"`);
        res.send(pdf);
    }));

    // Staff: revisions and the close-out state.
    r.get('/assessments/:id/reports', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const reps = (await pool.query(`
            SELECT id, kind, revision, status, provisional, published_at, superseded_at, revision_reason, dataset_sha256, pdf_sha256,
                   data_cutoff_at, calc_version, rule_version, template_version, generated_at, (pdf_path IS NOT NULL) AS has_pdf
            FROM reports WHERE assessment_id = $1 ORDER BY kind, revision DESC`, [req.params.id])).rows;
        const a = (await pool.query(`SELECT closeout_status, closeout_at, closeout_error, package_path FROM assessments WHERE id = $1`, [req.params.id])).rows[0];
        const outbox = (await pool.query(`SELECT to_email, purpose, status, attempts, last_error, sent_at, provider FROM email_outbox WHERE assessment_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.params.id])).rows;
        res.json({ reports: reps, closeout: a, late_data: await lateData(pool, req.params.id), emails: outbox });
    }));

    // Staff: issue an interim snapshot or a corrected revision (reason required).
    r.post('/assessments/:id/reports', ...staff, handle(async (req, res) => {
        const a = UUID.test(req.params.id) ? (await pool.query(`SELECT * FROM assessments WHERE id = $1`, [req.params.id])).rows[0] : null;
        if (!a) return res.status(404).json({ error: 'Not found' });
        const kind = String(req.body?.kind ?? '') as Kind;
        if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind: one of ${KINDS.join(', ')}` });
        const reason = String(req.body?.reason ?? '').trim();
        if (!reason) return res.status(400).json({ error: 'reason is required: every revision states why it exists' });
        const end = Math.min(new Date(a.end_at).getTime(), a.closed_at ? new Date(a.closed_at).getTime() : Infinity);
        const provisional = Date.now() < end;
        const rev = await createRevision(pool, a.id, kind, { cutoff: new Date(Math.min(end, Date.now())), issue: req.body?.issue === true,
            reason, actorId: req.scope.userId, provisional });
        if (!provisional && rev.status !== 'draft') { await buildPackage(pool, a.id).catch(() => undefined); }
        res.status(201).json({ id: rev.id, kind, revision: rev.revision, dataset_sha256: rev.dataset_sha256, provisional });
    }));

    // Staff: re-send the deliverables (a new link, a new dedupe tag).
    r.post('/assessments/:id/deliver', ...staff, handle(async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        await buildPackage(pool, req.params.id);
        const n = await deliver(pool, req.params.id, 'revision', String(Date.now()));
        res.json({ queued: n });
    }));

    // Client (live or delivery window) and staff: the frozen deliverables.
    r.get('/assessments/:id/deliverables', auth, handle(async (req, res) => {
        const a = await deliverableFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: 'No access to these deliverables' });
        res.json(await deliverablesList(pool, a, `/api/ingestion/assessments/${a.id}/files`));
    }));
    r.get('/assessments/:id/files/:name', auth, handle(async (req, res) => {
        const a = await deliverableFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: 'No access to these deliverables' });
        await sendFile(pool, a, String(req.params.name), res);
    }));

    // Final-delivery link: frozen files only, no session; expires; revocable.
    r.get('/delivery/:token', handle(async (req, res) => {
        const a = await byToken(pool, String(req.params.token));
        if (!a) return res.status(410).json({ error: 'This delivery link is invalid, revoked or has expired' });
        res.json(await deliverablesList(pool, a, `/api/ingestion/delivery/${encodeURIComponent(String(req.params.token))}/files`));
    }));
    r.get('/delivery/:token/files/:name', handle(async (req, res) => {
        const a = await byToken(pool, String(req.params.token));
        if (!a) return res.status(410).json({ error: 'This delivery link is invalid, revoked or has expired' });
        await sendFile(pool, a, String(req.params.name), res);
    }));

    return r;
}

async function byToken(pool: Pool, token: string) {
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) return null;
    const row = (await pool.query(`
        UPDATE delivery_links l SET last_used_at = NOW()
        FROM assessments a
        WHERE l.token_hash = $1 AND a.id = l.assessment_id AND l.revoked_at IS NULL AND l.expires_at > NOW()
          AND a.retention_status = 'retained' AND (a.retention_until IS NULL OR a.retention_until > NOW())
          AND (l.grant_id IS NULL OR EXISTS (SELECT 1 FROM assessment_grants g WHERE g.id = l.grant_id AND g.revoked_at IS NULL))
        RETURNING a.*, l.expires_at AS link_expires_at`, [sha256(token)])).rows[0];
    return row ?? null;
}

async function deliverablesList(pool: Pool, a: any, base: string) {
    const reps = await latestReports(pool, a.id, true);
    const files: { name: string; title: string; sha256: string | null; url: string }[] = reps.filter((r) => r.pdf_path).map((r) => ({
        name: `${r.kind}-r${r.revision}.pdf`, title: `${TITLES[r.kind as Kind]} (revision ${r.revision})`, sha256: r.pdf_sha256, url: `${base}/${r.kind}-r${r.revision}.pdf`,
    }));
    let manifest: any = null;
    if (a.package_path && fs.existsSync(path.join(a.package_path, 'manifest.json'))) {
        manifest = JSON.parse(fs.readFileSync(path.join(a.package_path, 'manifest.json'), 'utf8'));
        for (const f of manifest.files) if (!f.name.endsWith('.pdf')) files.push({ name: f.name, title: f.description, sha256: f.sha256, url: `${base}/${f.name}` });
        files.push({ name: 'manifest.json', title: 'Manifest and data dictionary', sha256: null, url: `${base}/manifest.json` });
    }
    return { assessment: { id: a.id, reference: a.reference, link_expires_at: a.link_expires_at ?? null }, files,
             pending_review: (await latestReports(pool, a.id, false)).filter((r) => r.status !== 'published').map((r) => TITLES[r.kind as Kind]) };
}

async function sendFile(pool: Pool, a: any, name: string, res: any) {
    if (!/^[a-z0-9_.-]+$/i.test(name) || name.includes('..')) return res.status(404).json({ error: 'Not found' });
    const m = /^(overview|power_quality|handover)-r(\d+)\.pdf$/.exec(name);
    let file: string | null = null;
    if (m) {
        const r = (await pool.query(`SELECT pdf_path FROM reports WHERE assessment_id = $1 AND kind = $2 AND revision = $3 AND status = 'published'`,
            [a.id, m[1], Number(m[2])])).rows[0];
        file = r?.pdf_path ? resolveStoredUploadPath(r.pdf_path) : null;
    } else if (a.package_path) {
        const f = path.join(a.package_path, name);
        if (path.dirname(f) === path.resolve(a.package_path)) file = f;
    }
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.json') ? 'application/json' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${a.reference}-${name}"`);
    fs.createReadStream(file).pipe(res);
}

export { packageDir };

/** After staff publish a reviewed assessment report (src/review.ts). */
export async function onAssessmentReportIssued(pool: Pool, report: any) {
    await pool.query(`UPDATE reports SET superseded_at = NOW()
                      WHERE assessment_id = $1 AND kind = $2 AND revision < $3 AND published_at IS NOT NULL AND superseded_at IS NULL`,
        [report.assessment_id, report.kind, report.revision]).catch(() => undefined);
    const a = (await pool.query(`SELECT closeout_status FROM assessments WHERE id = $1`, [report.assessment_id])).rows[0];
    if (a?.closeout_status !== 'done') return;   // still running: close-out sends everything together
    const pending = (await latestReports(pool, report.assessment_id, false)).filter((r) => r.status !== 'published').length;
    await pool.query(`UPDATE assessments SET report_status = $2 WHERE id = $1`, [report.assessment_id, pending ? 'awaiting_review' : 'issued']);
    await buildPackage(pool, report.assessment_id);
    await deliver(pool, report.assessment_id, 'revision', report.id);
}
