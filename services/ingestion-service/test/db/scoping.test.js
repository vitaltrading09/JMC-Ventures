// Phase 7 acceptance, against a throwaway database with the migrations
// applied (CI: the migrations job). Runs the real API (dist/main.js, api
// role) and the auth service as child processes.
//
//   - Every route of the ingestion API, called with a client token of tenant A
//     aimed at tenant B's ids (path, body and ?tenant_id=), returns nothing of
//     B and changes nothing of B.
//   - A client never sees drafts, internal notes or unpublished reports.
//   - client_viewer is read-only; live_data_visible hides telemetry until a
//     report is published; a device that served another client is not
//     reachable through the legacy meter routes; share links serve published
//     reports only; the SLD upload checks the site before touching the disk.
//   - The auth service lets only super_admin manage tenants and users.
//
//   TEST_DATABASE_URL=postgres://... node --test test/db/scoping.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const url = process.env.TEST_DATABASE_URL;
// A fresh signing key per run, shared with the services this test starts.
const SECRET = require('node:crypto').randomBytes(32).toString('hex');
const ROOT = path.join(__dirname, '..', '..');

function startService(script, port, extraEnv) {
    const child = spawn(process.execPath, [script], {
        cwd: path.dirname(path.dirname(script)),
        env: { ...process.env, DATABASE_URL: url, JWT_SECRET: SECRET, PORT: String(port), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    return { child, log: () => log };
}

async function waitFor(urlStr, svc) {
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(urlStr)).ok) return; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`service did not start: ${svc.log()}`);
}

/** Every route of the ingestion API, from the sources. */
function routes() {
    const out = [];
    const scan = (file, prefixRe) => {
        const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
        for (const m of src.matchAll(new RegExp(`${prefixRe}\\.(get|post|put|patch|delete)\\((['\`])([^'\`]+)\\2`, 'g'))) {
            const p = m[3];
            if (p.includes('${action}')) for (const a of ['approve', 'publish', 'withdraw']) out.push([m[1].toUpperCase(), p.replace('${action}', a)]);
            else out.push([m[1].toUpperCase(), p]);
        }
    };
    scan('main.ts', 'app');
    scan('fleet/routes.ts', 'r');
    scan('review.ts', 'r');
    return out;
}

test('tenant scoping across every route', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 300_000 }, async (t) => {
    const { Pool } = require('pg');
    const jwt = require('jsonwebtoken');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());

    const run = crypto.randomBytes(4).toString('hex');
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gq-scope-'));
    const apiPort = 39100 + Math.floor(Math.random() * 400);
    const authPort = apiPort + 500;
    const api = startService(path.join(ROOT, 'dist', 'main.js'), apiPort, { ROLES: 'api', UPLOAD_DIR: uploadDir, FEATURE_BROKER: 'false', OPENAI_API_KEY: '' });
    const auth = startService(path.join(ROOT, '..', 'auth-service', 'dist', 'main.js'), authPort, {});
    t.after(() => { api.child.kill(); auth.child.kill(); });
    await waitFor(`http://127.0.0.1:${apiPort}/health`, api);
    await waitFor(`http://127.0.0.1:${authPort}/health`, auth);

    // ── Seed: tenants A, B (clients) and I (internal) ───────────────────────
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const seedTenant = async (label, kind = 'client') => {
        const mark = `zz${label}${run}`;
        const [tenant] = await q(`INSERT INTO tenants (name, kind, brand_name) VALUES ($1, $2, $3) RETURNING id`, [`${mark}-tenant`, kind, `${mark}-brand`]);
        return { mark, tenant: tenant.id };
    };
    const seedClient = async (label) => {
        const x = await seedTenant(label);
        x.site = (await q(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [x.tenant, `${x.mark}-site`]))[0].id;
        x.meter = (await q(`INSERT INTO meters (site_id, name, serial_number) VALUES ($1, $2, $3) RETURNING id`, [x.site, `${x.mark}-meter`, `${x.mark}-SN`]))[0].id;
        x.point = x.meter; // the legacy trigger names the point after the meter
        x.deployment = (await q(`SELECT id FROM deployments WHERE device_id = $1`, [x.meter]))[0].id;
        for (let i = 0; i < 30; i++) {
            await q(`INSERT INTO meter_readings (time, meter_id, voltage_a, power_active_total, energy_import_total, time_source)
                     VALUES ($1, $2, 230, 12, $3, 'DEVICE')`, [new Date(now - (i + 1) * 60_000), x.meter, 1000 + i]);
        }
        await q(`INSERT INTO site_settings (site_id, alert_max_kw) VALUES ($1, 123)`, [x.site]);
        x.alert = (await q(`INSERT INTO alerts (tenant_id, meter_id, type, severity, message) VALUES ($1, $2, 'TEST', 'LOW', $3) RETURNING id`,
            [x.tenant, x.meter, `${x.mark}-alert`]))[0].id;
        const rec = (title, status, notes) => q(`
            INSERT INTO recommendations (site_id, meter_id, tenant_id, type, title, status, review_status, internal_notes)
            VALUES ($1, $2, $3, 'TEST', $4, 'ACTIVE', $5, $6) RETURNING id`, [x.site, x.meter, x.tenant, title, status, notes]);
        x.rec = (await rec(`${x.mark}-rec-published`, 'published', `${x.mark}-INTERNAL-note`))[0].id;
        x.draft = (await rec(`${x.mark}-DRAFT-rec`, 'draft', null))[0].id;
        const report = (title, status) => q(`
            INSERT INTO reports (project_id, title, period_start, period_end, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [x.site, title, iso(now - 7 * 86_400_000), iso(now), status]);
        x.report = (await report(`${x.mark}-report-published`, 'published'))[0].id;
        x.unpublished = (await report(`${x.mark}-UNPUB-report`, 'draft'))[0].id;
        x.token = crypto.randomBytes(32).toString('base64url');
        x.share = (await q(`
            INSERT INTO report_shares (tenant_id, site_id, meter_id, token_hash, label, period_days, expires_at, report_id)
            VALUES ($1, $2, $3, $4, $5, 7, NOW() + INTERVAL '7 days', $6) RETURNING id`,
            [x.tenant, x.site, x.meter, crypto.createHash('sha256').update(x.token).digest('hex'), `${x.mark}-share`, x.report]))[0].id;
        x.lead = (await q(`INSERT INTO leads (site_id, tenant_id, recommendation_id, status) VALUES ($1, $2, $3, 'NEW') RETURNING id`,
            [x.site, x.tenant, x.rec]))[0].id;
        await q(`INSERT INTO site_diagrams (site_id, layout) VALUES ($1, $2)`, [x.site, JSON.stringify({ nodes: [{ id: `${x.mark}-diagram` }], edges: [] })]);
        const user = async (role) => (await q(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
            [x.tenant, `${role}.${x.mark}@test.local`, role]))[0].id;
        x.adminToken = jwt.sign({ userId: await user('client_admin'), tenantId: x.tenant, role: 'client_admin' }, SECRET);
        x.viewerToken = jwt.sign({ userId: await user('client_viewer'), tenantId: x.tenant, role: 'client_viewer' }, SECRET);
        x.legacyToken = jwt.sign({ userId: null, tenantId: x.tenant, role: 'admin' }, SECRET); // a pre-Phase-7 token
        return x;
    };
    const A = await seedClient('A');
    const B = await seedClient('B');
    const I = await seedTenant('I', 'internal');
    const opsId = (await q(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'super_admin') RETURNING id`,
        [I.tenant, `ops.${I.mark}@test.local`]))[0].id;
    const ops = jwt.sign({ userId: opsId, tenantId: I.tenant, role: 'super_admin' }, SECRET);

    // B's SLD PDF on disk, which A must not be able to overwrite or delete.
    fs.mkdirSync(path.join(uploadDir, 'sld-pdfs'), { recursive: true });
    const bPdf = path.join(uploadDir, 'sld-pdfs', `${B.site}.pdf`);
    fs.writeFileSync(bPdf, `${B.mark}-original-pdf`);
    await q(`UPDATE site_diagrams SET background_pdf_path = $2 WHERE site_id = $1`, [B.site, `sld-pdfs/${B.site}.pdf`]);

    const call = async (token, method, p, body) => {
        const r = await fetch(`http://127.0.0.1:${apiPort}${p}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
        });
        return { status: r.status, text: await r.text() };
    };
    const ids = (x) => ({
        sites: x.site, meters: x.meter, alerts: x.alert, shares: x.share, recommendations: x.rec, leads: x.lead,
        projects: x.site, points: x.point, devices: x.meter, deployments: x.deployment, reports: x.report,
        clients: x.tenant, 'broker-access': crypto.randomUUID(),
    });
    const fill = (p, x) => {
        const map = ids(x);
        return p.split('/').map((seg, i, all) => (seg.startsWith(':') ? (seg === ':token' ? 'x' : map[all[i - 1]] ?? crypto.randomUUID()) : seg)).join('/');
    };
    const ROUTES = routes().filter(([, p]) => !['/health', '/health/deep', '/public/report/:token'].includes(p));
    assert.ok(ROUTES.length > 60, `only ${ROUTES.length} routes found`);

    const bSecrets = [B.mark, B.tenant, B.site, B.meter, B.alert, B.share, B.rec, B.draft, B.lead, B.report, B.unpublished, B.deployment];
    const leaks = (text) => bSecrets.filter((s) => text.includes(s));

    await t.test('tenant A, aimed at tenant B, gets nothing of B from any route', async () => {
        const failures = [];
        const probeBody = {
            site_id: B.site, meter_id: B.meter, project_id: B.site, tenant_id: B.tenant, device_id: B.meter,
            measurement_point_id: B.point, report_id: B.report, name: 'probe', label: 'probe', code: `P${run}`.toUpperCase(),
            layout: { nodes: [], edges: [] }, status: 'NEW', question: 'q', review_status: 'published', reason: 'probe',
            period_start: iso(now - 86_400_000), period_end: iso(now), power_sign: -1, days_valid: 7, load_types: [],
        };
        for (const [method, p] of ROUTES) {
            const target = `${fill(p, B)}?tenant_id=${B.tenant}&project_id=${B.site}&meter_id=${B.meter}`;
            for (const token of [A.adminToken, A.legacyToken]) {
                const r = await call(token, method, target, probeBody);
                const leaked = leaks(r.text);
                if (leaked.length) failures.push(`${method} ${p} → ${r.status} leaks ${leaked.join(', ')}`);
                if (p.includes('/:') && r.status < 400) failures.push(`${method} ${p} → ${r.status} for a B resource`);
            }
        }
        assert.deepStrictEqual(failures, []);
    });

    await t.test('and changed nothing of B', async () => {
        const [s] = await q(`SELECT archived_at, status FROM projects WHERE id = $1`, [B.site]);
        assert.strictEqual(s.archived_at, null);
        const [m] = await q(`SELECT archived_at, is_active, load_types, name FROM devices WHERE id = $1`, [B.meter]);
        assert.deepStrictEqual([m.archived_at, m.is_active, m.name], [null, true, `${B.mark}-meter`]);
        assert.strictEqual((await q(`SELECT is_read FROM alerts WHERE id = $1`, [B.alert]))[0].is_read, false);
        assert.strictEqual((await q(`SELECT status FROM leads WHERE id = $1`, [B.lead]))[0].status, 'NEW');
        assert.strictEqual((await q(`SELECT revoked_at FROM report_shares WHERE id = $1`, [B.share]))[0].revoked_at, null);
        assert.strictEqual((await q(`SELECT review_status FROM recommendations WHERE id = $1`, [B.draft]))[0].review_status, 'draft');
        assert.strictEqual((await q(`SELECT status FROM reports WHERE id = $1`, [B.unpublished]))[0].status, 'draft');
        assert.strictEqual(Number((await q(`SELECT alert_max_kw FROM site_settings WHERE site_id = $1`, [B.site]))[0].alert_max_kw), 123);
        assert.strictEqual((await q(`SELECT brand_name FROM tenants WHERE id = $1`, [B.tenant]))[0].brand_name, `${B.mark}-brand`);
        const [d] = await q(`SELECT layout, background_pdf_path FROM site_diagrams WHERE site_id = $1`, [B.site]);
        assert.strictEqual(d.layout.nodes[0].id, `${B.mark}-diagram`);
        assert.strictEqual(d.background_pdf_path, `sld-pdfs/${B.site}.pdf`);
        assert.strictEqual(fs.readFileSync(bPdf, 'utf8'), `${B.mark}-original-pdf`);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM devices WHERE site_id = $1`, [B.site]))[0].n, 1);
        assert.strictEqual((await q(`SELECT count(*)::int AS n FROM deployments d JOIN measurement_points p ON p.id = d.measurement_point_id WHERE p.project_id = $1`, [B.site]))[0].n, 1);
    });

    await t.test('the SLD upload refuses another tenant\'s site before writing the file', async () => {
        const form = new FormData();
        form.append('pdf', new Blob([`${A.mark}-overwrite`], { type: 'application/pdf' }), 'x.pdf');
        const r = await fetch(`http://127.0.0.1:${apiPort}/sites/${B.site}/diagram/pdf`, {
            method: 'POST', headers: { authorization: `Bearer ${A.adminToken}` }, body: form,
        });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(fs.readFileSync(bPdf, 'utf8'), `${B.mark}-original-pdf`);
    });

    await t.test('a client never sees drafts, internal notes or unpublished reports', async () => {
        const failures = [];
        const hidden = [A.draft, `${A.mark}-DRAFT`, `${A.mark}-INTERNAL`, A.unpublished, `${A.mark}-UNPUB`, 'internal_notes'];
        for (const [method, p] of ROUTES.filter(([m]) => m === 'GET')) {
            const r = await call(A.adminToken, 'GET', fill(p, A));
            const seen = hidden.filter((h) => r.text.includes(h));
            if (seen.length) failures.push(`GET ${p} → ${seen.join(', ')}`);
        }
        assert.deepStrictEqual(failures, []);
        // ... while the published items are there.
        assert.match((await call(A.adminToken, 'GET', '/recommendations')).text, new RegExp(`${A.mark}-rec-published`));
        assert.match((await call(A.adminToken, 'GET', '/reports')).text, new RegExp(`${A.mark}-report-published`));
        assert.strictEqual((await call(A.adminToken, 'GET', `/reports/${A.unpublished}`)).status, 404);
        // An internal user sees the draft and its notes.
        const internal = await call(ops, 'GET', `/review/recommendations?review_status=all&tenant_id=${A.tenant}`);
        assert.match(internal.text, new RegExp(`${A.mark}-DRAFT-rec`));
        assert.match(internal.text, new RegExp(`${A.mark}-INTERNAL-note`));
    });

    await t.test('client_viewer is read-only', async () => {
        const allowed = [/\/compliance\/ask$/, /\/alerts\/:id\/read$/, /\/recommendations\/:id\/notify$/];
        const failures = [];
        for (const [method, p] of ROUTES.filter(([m]) => m !== 'GET')) {
            if (allowed.some((re) => re.test(p))) continue;
            const r = await call(A.viewerToken, method, fill(p, A), { name: 'viewer-probe', site_id: A.site, meter_id: A.meter });
            if (r.status !== 403) failures.push(`${method} ${p} → ${r.status}`);
        }
        assert.deepStrictEqual(failures, []);
        assert.strictEqual((await call(A.viewerToken, 'POST', `/alerts/${A.alert}/read`)).status, 200);
        assert.strictEqual((await call(A.viewerToken, 'GET', `/meters/${A.meter}/readings?raw=1`)).status, 200);
    });

    await t.test('live_data_visible = false hides telemetry until a report is published', async () => {
        const site = (await q(`INSERT INTO projects (tenant_id, name, live_data_visible) VALUES ($1, $2, false) RETURNING id`, [A.tenant, `${A.mark}-hidden`]))[0].id;
        const meter = (await q(`INSERT INTO meters (site_id, name) VALUES ($1, 'hidden meter') RETURNING id`, [site]))[0].id;
        await q(`INSERT INTO meter_readings (time, meter_id, power_active_total, time_source) VALUES (NOW() - INTERVAL '1 minute', $1, 5, 'DEVICE')`, [meter]);
        assert.strictEqual((await call(A.adminToken, 'GET', `/meters/${meter}/readings?raw=1`)).status, 403);
        assert.strictEqual((await call(A.adminToken, 'GET', `/projects/${site}/energy-balance`)).status, 404);
        const list = JSON.parse((await call(A.adminToken, 'GET', '/meters')).text);
        assert.strictEqual(list.find((m) => m.id === meter).latest_reading, null);
        assert.strictEqual((await call(ops, 'GET', `/meters/${meter}/readings?raw=1`)).status, 200);
        // Publish a report: draft → approved → published, by an internal user.
        const rep = JSON.parse((await call(ops, 'POST', '/reports', { project_id: site, period_start: iso(now - 86_400_000), period_end: iso(now) })).text);
        assert.strictEqual((await call(ops, 'POST', `/reports/${rep.id}/publish`)).status, 409); // not approved yet
        assert.strictEqual((await call(A.adminToken, 'POST', `/reports/${rep.id}/approve`)).status, 403); // clients cannot
        assert.strictEqual((await call(ops, 'POST', `/reports/${rep.id}/approve`)).status, 200);
        assert.strictEqual((await call(ops, 'POST', `/reports/${rep.id}/publish`)).status, 200);
        assert.strictEqual((await call(A.adminToken, 'GET', `/meters/${meter}/readings?raw=1`)).status, 200);
        const log = await q(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [rep.id]);
        assert.deepStrictEqual(log.map((r) => r.action), ['report.create', 'report.approve', 'report.publish']);
    });

    await t.test('a device that served another client is out of reach of the legacy meter routes', async () => {
        // B's box is moved to A's project.
        const point = JSON.parse((await call(ops, 'POST', `/projects/${A.site}/points`, { name: 'sub', role: 'sub_load' })).text);
        const moveAt = Date.now();
        assert.strictEqual((await call(ops, 'POST', `/deployments/${B.deployment}/remove`, { removed_at: iso(moveAt) })).status, 200);
        assert.strictEqual((await call(ops, 'POST', '/deployments', { device_id: B.meter, measurement_point_id: point.id, installed_at: iso(moveAt + 1000) })).status, 201);
        // A now "owns" the device, but its readings are B's site's readings.
        const r = await call(A.adminToken, 'GET', `/meters/${B.meter}/readings?raw=1`);
        assert.strictEqual(r.status, 403);
        assert.deepStrictEqual(leaks((await call(A.adminToken, 'GET', '/meters')).text), []);
        assert.deepStrictEqual(leaks((await call(A.adminToken, 'GET', '/ai-context')).text), []);
        assert.strictEqual((await call(ops, 'GET', `/meters/${B.meter}/readings?raw=1`)).status, 200);
    });

    await t.test('share links serve published reports only', async () => {
        const pub = await fetch(`http://127.0.0.1:${apiPort}/public/report/${A.token}`);
        assert.notStrictEqual(pub.status, 410);
        assert.strictEqual((await call(ops, 'POST', `/reports/${A.report}/withdraw`)).status, 200);
        const gone = await fetch(`http://127.0.0.1:${apiPort}/public/report/${A.token}`);
        assert.strictEqual(gone.status, 410);
        assert.strictEqual((await gone.json()).error, 'not_published');
        // A link without a report (made before Phase 7) no longer works either.
        const legacy = crypto.randomBytes(32).toString('base64url');
        await q(`INSERT INTO report_shares (tenant_id, site_id, meter_id, token_hash, period_days, expires_at)
                 VALUES ($1, $2, $3, $4, 7, NOW() + INTERVAL '1 day')`,
            [A.tenant, A.site, A.meter, crypto.createHash('sha256').update(legacy).digest('hex')]);
        assert.strictEqual((await fetch(`http://127.0.0.1:${apiPort}/public/report/${legacy}`)).status, 410);
        // Creating a link needs a published report of the meter's project.
        assert.strictEqual((await call(A.adminToken, 'POST', `/meters/${A.meter}/shares`, {})).status, 400);
        assert.strictEqual((await call(A.adminToken, 'POST', `/meters/${A.meter}/shares`, { report_id: A.unpublished })).status, 400);
    });

    await t.test('review: engines write drafts, an internal user publishes, the client then sees it', async () => {
        const noReview = await call(A.adminToken, 'PATCH', `/recommendations/${A.draft}/review`, { review_status: 'published' });
        assert.strictEqual(noReview.status, 403);
        const ok = await call(ops, 'PATCH', `/recommendations/${A.draft}/review`, { review_status: 'published', internal_notes: 'checked' });
        assert.strictEqual(ok.status, 200);
        const seen = (await call(A.adminToken, 'GET', `/sites/${A.site}/recommendations`)).text;
        assert.match(seen, new RegExp(`${A.mark}-DRAFT-rec`));
        assert.doesNotMatch(seen, /checked/); // internal_notes stay internal
        const log = await q(`SELECT action, actor_user_id FROM audit_log WHERE entity_id = $1`, [A.draft]);
        assert.deepStrictEqual(log.map((r) => [r.action, r.actor_user_id]), [['finding.published', opsId]]);
    });

    await t.test('the auth service lets only super_admin manage tenants and users', async () => {
        const authCall = (token, method, p, body) => fetch(`http://127.0.0.1:${authPort}${p}`, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
        });
        assert.strictEqual((await authCall(A.adminToken, 'GET', '/tenants')).status, 403);
        assert.strictEqual((await authCall(A.legacyToken, 'GET', '/tenants')).status, 403); // the old 'admin' shortcut
        assert.strictEqual((await authCall(A.adminToken, 'POST', '/users', { email: `x.${run}@t.local`, password: 'pw-123456', tenant_id: B.tenant, role: 'super_admin' })).status, 403);
        assert.strictEqual((await authCall(ops, 'GET', '/tenants')).status, 200);
        // Internal roles only in the internal tenant, client roles only in a client tenant.
        assert.strictEqual((await authCall(ops, 'POST', '/users', { email: `y.${run}@t.local`, password: 'pw-123456', tenant_id: B.tenant, role: 'super_admin' })).status, 400);
        assert.strictEqual((await authCall(ops, 'POST', '/users', { email: `z.${run}@t.local`, password: 'pw-123456', tenant_id: B.tenant, role: 'root' })).status, 400);
        const made = await authCall(ops, 'POST', '/users', { email: `v.${run}@t.local`, password: 'pw-123456', tenant_id: B.tenant, role: 'viewer' });
        assert.strictEqual(made.status, 201);
        assert.strictEqual((await made.json()).role, 'client_viewer');
    });
});
