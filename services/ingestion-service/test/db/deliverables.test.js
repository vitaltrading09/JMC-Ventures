'use strict';
// GridIQ close-out end to end, against a migrated database:
//   - an ended assessment is closed out once: overview and handover issued,
//     power quality drafted for review, a data package with checksums, one
//     email per recipient; a worker restart and a re-run send nothing twice;
//   - the dataset is frozen (the database refuses a change); a correction is a
//     new revision and the issued PDF stays byte-identical;
//   - THD-only data never yields individual harmonic orders;
//   - dashboard numbers, the package CSV and the consultant agree with the dataset;
//   - after the end the client reaches only the frozen files (delivery link);
//   - retention removes this assessment's readings and content, keeps another
//     client's data and the fleet history, writes a receipt and tombstones;
//   - email sign-in codes: single use, attempt-capped, never logged.
//   TEST_DATABASE_URL=postgres://... node --test test/db/deliverables.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;

test('close-out, revisions, delivery, retention, sign-in codes', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 300_000 }, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gq-deliv-'));
    process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
    process.env.EXPORT_DIR = path.join(tmp, 'exports');
    process.env.EMAIL_PROVIDER = 'file';
    process.env.EMAIL_DIR = path.join(tmp, 'outbox');
    process.env.FRONTEND_URL = 'https://gridiq.test';
    process.env.ASSESSMENT_LATE_DATA_HOURS = '2';
    delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_PROVIDER;
    const { Pool } = require('pg');
    const express = require('express');
    const { refreshAggregates } = require('@gridiq/db');
    const closeout = require('../../dist/reports/closeout.js');
    const { sendDueEmails } = require('../../dist/notify/email.js');
    const { purgeAssessment } = require('../../dist/assessments/retention.js');
    const { deterministicAnswer } = require('../../dist/consultant.js');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const run = Date.now().toString(36);
    const H = 3_600_000;

    // Client C with one point; client D (another tenant) with its own meter.
    const mk = async (label) => {
        const tenant = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${label} ${run}`]))[0].id;
        const project = (await q(`INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenant, `${label} plant`]))[0].id;
        const point = (await q(`INSERT INTO measurement_points (project_id, name, role, contracted_mdi_kva) VALUES ($1, 'Incomer', 'incomer', 100) RETURNING id`, [project]))[0].id;
        const dev = (await q(`INSERT INTO devices (name, code, mqtt_username, status) VALUES ('b', $1, $2, 'deployed') RETURNING id`, [`D-${label}-${run}`.toUpperCase(), `d-${label}-${run}`.toLowerCase()]))[0].id;
        return { tenant, project, point, dev };
    };
    const C = await mk('C'), D = await mk('D');
    const end = new Date(Math.floor((Date.now() - 3 * H) / H) * H);         // ended 3+ h ago
    const start = new Date(end.getTime() - 2 * 86_400_000);
    for (const x of [C, D]) await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at) VALUES ($1, $2, $3)`, [x.dev, x.point, new Date(start.getTime() - H)]);
    // 1-minute data: 80 kW at PF 0.8 (100 kVA), THD-V 9.5 % on L1 while loaded (06–18 SAST), 3 % otherwise.
    for (const x of [C, D]) {
        await q(`
            INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, current_b, current_c,
                power_active_total, power_apparent_total, power_factor_total, frequency, thd_voltage_a, thd_voltage_b, thd_voltage_c,
                energy_import_total, time_source, device_time)
            SELECT t, $1, 231, 230, 229, 145, 145, 145, 80, 100, 0.8, 50,
                   CASE WHEN extract(hour FROM t AT TIME ZONE 'Africa/Johannesburg') BETWEEN 6 AND 17 THEN 9.5 ELSE 3 END, 2.5, 2.5,
                   1000 + extract(epoch FROM t - $2::timestamptz) / 3600 * 80, 'DEVICE', t
            FROM generate_series($2::timestamptz, $3::timestamptz, INTERVAL '1 minute') t`, [x.dev, new Date(start.getTime() - H), new Date(end.getTime() + H)]);
    }
    await refreshAggregates(pool, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000));
    const user = (await q(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'client_admin') RETURNING id`, [C.tenant, `boss.${run}@c.test`]))[0].id;
    const a = (await q(`
        INSERT INTO assessments (tenant_id, project_id, title, status, duration_days, start_at, end_at, payment_state, retention_months, retention_until)
        VALUES ($1, $2, 'C test', 'active', 2, $3, $4, 'paid', 3, $5) RETURNING id, reference`,
        [C.tenant, C.project, start, end, new Date(end.getTime() + 90 * 86_400_000)]))[0];
    await q(`INSERT INTO assessment_points VALUES ($1, $2)`, [a.id, C.point]);
    await q(`INSERT INTO assessment_grants (assessment_id, user_id, email) VALUES ($1, $2, $3), ($1, NULL, $4)`,
        [a.id, user, `boss.${run}@c.test`, `engineer.${run}@c.test`]);
    // D has its own (unrelated) live assessment that must survive C's purge.
    const aD = (await q(`INSERT INTO assessments (tenant_id, project_id, title, status, duration_days, start_at, end_at, payment_state)
                         VALUES ($1, $2, 'D', 'active', 7, $3, NOW() + INTERVAL '5 days', 'paid') RETURNING id`, [D.tenant, D.project, start]))[0].id;
    await q(`INSERT INTO assessment_points VALUES ($1, $2)`, [aD, D.point]);

    // An app with the deliverables routes; the stub auth makes the caller user `who`.
    let who = { userId: user, tenantId: C.tenant, role: 'client_admin', email: `boss.${run}@c.test` };
    const app = express();
    app.use(closeout.deliverablesRouter(pool, (req, _res, next) => { req.user = who; next(); }));
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    t.after(() => srv.close());
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };

    let ds;
    await t.test('close-out issues the baseline, drafts PQ for review, writes the package and one email per recipient', async () => {
        assert.strictEqual(await closeout.runCloseouts(pool) >= 1, true);
        const reps = await q(`SELECT kind, revision, status, dataset, dataset_sha256, pdf_path FROM reports WHERE assessment_id = $1 ORDER BY kind`, [a.id]);
        const err = (await q(`SELECT closeout_error FROM assessments WHERE id = $1`, [a.id]))[0].closeout_error;
        assert.strictEqual(err, null);
        assert.deepStrictEqual(reps.map((r) => [r.kind, r.status]), [['handover', 'published'], ['overview', 'published'], ['power_quality', 'draft']]);
        ds = reps.find((r) => r.kind === 'overview').dataset;
        assert.strictEqual(ds.assessment.period_to, end.toISOString());
        const st = (await q(`SELECT closeout_status, report_status, status, package_path FROM assessments WHERE id = $1`, [a.id]))[0];
        assert.deepStrictEqual([st.closeout_status, st.report_status, st.status], ['done', 'awaiting_review', 'ended']);
        const manifest = JSON.parse(fs.readFileSync(path.join(st.package_path, 'manifest.json'), 'utf8'));
        for (const f of manifest.files) {
            const body = fs.readFileSync(path.join(st.package_path, f.name));
            assert.strictEqual(require('node:crypto').createHash('sha256').update(body).digest('hex'), f.sha256, f.name);
        }
        const mails = await q(`SELECT to_email, purpose FROM email_outbox WHERE assessment_id = $1 AND purpose = 'delivery_closeout' ORDER BY to_email`, [a.id]);
        assert.strictEqual(mails.length, 2);
    });

    await t.test('a re-run or a worker restart sends nothing twice', async () => {
        await closeout.runCloseouts(pool);
        await q(`UPDATE assessments SET closeout_status = 'running', closeout_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [a.id]);
        await closeout.runCloseouts(pool);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM email_outbox WHERE assessment_id = $1 AND purpose = 'delivery_closeout'`, [a.id]))[0].n, 2);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM reports WHERE assessment_id = $1`, [a.id]))[0].n, 3);
        assert.ok(await sendDueEmails(pool) >= 2);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM email_outbox WHERE assessment_id = $1 AND status = 'sent'`, [a.id]))[0].n, 2);
        assert.strictEqual(await sendDueEmails(pool), 0);
    });

    await t.test('THD-only data: a THD finding with no invented harmonic orders', async () => {
        const pq = ds.points[0].power_quality;
        assert.strictEqual(pq.harmonic_orders.available, false);
        assert.ok(pq.thd_v.find((x) => x.phase === 'A').p95 > 8);
        assert.ok(ds.executive.some((e) => /THD on phase A/.test(e.text) && /not recorded/.test(e.text)));
        assert.strictEqual(pq.verdict.type, 'screening');
        assert.ok(!JSON.stringify(ds).includes('"order":'));
    });

    await t.test('the package, the dashboard figure and the consultant agree with the dataset', async () => {
        const st = (await q(`SELECT package_path FROM assessments WHERE id = $1`, [a.id]))[0];
        const lp = fs.readFileSync(path.join(st.package_path, 'load_profile_30min.csv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
        const head = lp[0].split(',');
        const maxCsv = Math.max(...lp.slice(1).map((l) => Number(l.split(',')[head.indexOf('kva_demand')])));
        assert.ok(Math.abs(maxCsv - ds.points[0].demand.max_kva) < 0.11, `${maxCsv} vs ${ds.points[0].demand.max_kva}`);
        const ans = deterministicAnswer(ds, 'What was the peak demand?');
        assert.match(ans.answer, new RegExp(`${ds.points[0].demand.max_kva} kVA`));
        assert.deepStrictEqual(ans.evidence, ['demand']);
    });

    await t.test('an issued dataset is frozen; a correction is a new revision', async () => {
        const rev1 = (await q(`SELECT id, pdf_path, pdf_sha256 FROM reports WHERE assessment_id = $1 AND kind = 'overview'`, [a.id]))[0];
        await assert.rejects(q(`UPDATE reports SET dataset = '{}'::jsonb WHERE id = $1`, [rev1.id]), /frozen/);
        await assert.rejects(q(`UPDATE reports SET status = 'draft', published_at = NULL WHERE id = $1`, [rev1.id]), /frozen/);
        const r2 = await closeout.createRevision(pool, a.id, 'overview', { cutoff: end, issue: true, reason: 'late data accepted' });
        assert.strictEqual(r2.revision, 2);
        const old = (await q(`SELECT superseded_at, pdf_sha256 FROM reports WHERE id = $1`, [rev1.id]))[0];
        assert.ok(old.superseded_at);
        const file = path.join(process.env.UPLOAD_DIR, rev1.pdf_path);
        assert.strictEqual(require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), rev1.pdf_sha256);
    });

    await t.test('after the end: the client gets the frozen files only, and so does the delivery link', async () => {
        const list = await get(`/assessments/${a.id}/deliverables`);
        assert.strictEqual(list.status, 200, list.buf.toString());
        assert.strictEqual((await get(`/assessments/${a.id}/preview.pdf`)).status, 403);   // no live data
        const pdf = await get(`/assessments/${a.id}/files/overview-r2.pdf`);
        assert.strictEqual(pdf.status, 200);
        assert.strictEqual(pdf.buf.subarray(0, 5).toString(), '%PDF-');
        // A user of another tenant reaches nothing.
        who = { userId: '00000000-0000-0000-0000-000000000001', tenantId: D.tenant, role: 'client_admin' };
        assert.strictEqual((await get(`/assessments/${a.id}/deliverables`)).status, 403);
        who = { userId: user, tenantId: C.tenant, role: 'client_admin', email: `boss.${run}@c.test` };
        const body = (await q(`SELECT body_text FROM email_outbox WHERE assessment_id = $1 AND purpose = 'delivery_closeout' LIMIT 1`, [a.id]))[0].body_text;
        const token = /\/delivery\/([A-Za-z0-9_-]+)/.exec(body)[1];
        const viaLink = await get(`/delivery/${token}`);
        assert.strictEqual(viaLink.status, 200);
        assert.ok(JSON.parse(viaLink.buf).files.some((f) => f.name === 'manifest.json'));
        assert.strictEqual((await get(`/delivery/${token}/files/..%2F..%2Fetc%2Fpasswd`)).status, 404);
        assert.strictEqual((await get(`/delivery/not-a-real-token-but-long-enough-xxxxx`)).status, 410);
        await q(`UPDATE delivery_links SET revoked_at = NOW() WHERE assessment_id = $1`, [a.id]);
        assert.strictEqual((await get(`/delivery/${token}`)).status, 410);
    });

    await t.test('retention removes this assessment only and leaves a receipt', async () => {
        const before = async (dev) => (await q(`SELECT count(*)::int AS n FROM meter_readings WHERE meter_id = $1`, [dev]))[0].n;
        const dBefore = await before(D.dev);
        await q(`UPDATE assessments SET retention_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [a.id]);
        // Access is closed at the deadline before any purge runs.
        assert.strictEqual((await get(`/assessments/${a.id}/deliverables`)).status, 403);
        const counts = await purgeAssessment(pool, a.id);
        assert.ok(counts.meter_readings > 2000, JSON.stringify(counts));
        assert.strictEqual(await before(D.dev), dBefore);                              // other client untouched
        const left = (await q(`SELECT count(*)::int AS n FROM meter_readings WHERE meter_id = $1 AND time >= $2 AND time < $3`, [C.dev, start, end]))[0].n;
        assert.strictEqual(left, 0);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM deployments WHERE device_id = $1`, [C.dev]))[0].n, 1);   // fleet history kept
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM reports WHERE assessment_id = $1 AND dataset IS NOT NULL`, [a.id]))[0].n, 0);
        const st = (await q(`SELECT retention_status, package_path FROM assessments WHERE id = $1`, [a.id]))[0];
        assert.deepStrictEqual([st.retention_status, st.package_path], ['purged', null]);
        const receipt = (await q(`SELECT status, counts FROM assessment_purges WHERE assessment_id = $1`, [a.id]))[0];
        assert.strictEqual(receipt.status, 'done');
        assert.ok((await q(`SELECT count(*)::int AS n FROM deletion_tombstones WHERE assessment_id = $1 AND entity = 'meter_readings'`, [a.id]))[0].n >= 1);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM point_readings_1h WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3`, [C.point, start, end]))[0].n, 0);
    });

    await t.test('email sign-in codes: single use, capped attempts, nothing logged', async () => {
        const { loginRouter, codeHash } = require('../../../auth-service/dist/login.js');
        const secret = 'x'.repeat(40);
        const logs = [];
        const orig = [console.log, console.error];
        console.log = (...x) => logs.push(x.join(' ')); console.error = (...x) => logs.push(x.join(' '));
        const lapp = express(); lapp.use(express.json());
        let sessions = 0;
        lapp.use(loginRouter(pool, secret, (res, u) => { sessions++; res.json({ user: { id: u.id, role: u.role } }); }));
        const ls = await new Promise((r) => { const s = lapp.listen(0, () => r(s)); });
        const post = async (p, b) => { const r = await fetch(`http://127.0.0.1:${ls.address().port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
        try {
            const email = `invited.${run}@d.test`;
            const g = (await q(`INSERT INTO assessment_grants (assessment_id, email) VALUES ($1, $2) RETURNING id`, [aD, email]))[0].id;
            const unknown = await post('/login/code/request', { email: `nobody.${run}@x.test` });
            const known = await post('/login/code/request', { email });
            assert.deepStrictEqual([unknown.status, known.status], [202, 202]);
            assert.deepStrictEqual(unknown.body, known.body);   // no enumeration
            const code = /code: (\d{6})/.exec((await q(`SELECT subject FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1`, [email]))[0].subject)[1];
            assert.strictEqual((await q(`SELECT count(*)::int AS n FROM login_codes WHERE email = $1 AND code_hash = $2`, [email, codeHash(secret, email, code)]))[0].n, 1);
            const wrong = code === '000000' ? '111111' : '000000';
            assert.strictEqual((await post('/login/code/verify', { email, code: wrong })).status, 401);
            const ok = await post('/login/code/verify', { email, code });
            assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
            assert.strictEqual(ok.body.user.role, 'client_viewer');
            assert.strictEqual((await q(`SELECT user_id FROM assessment_grants WHERE id = $1`, [g]))[0].user_id, ok.body.user.id);
            assert.strictEqual((await post('/login/code/verify', { email, code })).status, 401);              // reuse
            // A new code (after the resend throttle) is burnt by 5 wrong attempts.
            await q(`UPDATE login_codes SET created_at = created_at - INTERVAL '2 minutes' WHERE email = $1`, [email]);
            await post('/login/code/request', { email });
            const code2 = /code: (\d{6})/.exec((await q(`SELECT subject FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1`, [email]))[0].subject)[1];
            const bad = code2 === '000000' ? '111111' : '000000';
            for (let i = 0; i < 5; i++) await post('/login/code/verify', { email, code: bad });
            assert.strictEqual((await post('/login/code/verify', { email, code: code2 })).status, 401);
            // Expired codes fail.
            await q(`UPDATE login_codes SET created_at = created_at - INTERVAL '2 minutes', expires_at = NOW() - INTERVAL '1 second' WHERE email = $1`, [email]);
            assert.strictEqual(sessions, 1);
            assert.ok(!logs.some((l) => l.includes(code) || l.includes(code2)), 'codes must never be logged');
        } finally { ls.close(); [console.log, console.error] = orig; }
    });
});
