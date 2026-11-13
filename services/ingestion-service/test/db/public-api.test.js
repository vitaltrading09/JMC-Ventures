// Public API v1 (Phase 9), end to end through the real gateway, auth service
// and ingestion api, against a throwaway database with the migrations applied:
//   - API keys: created once by a client admin, verified by the gateway,
//     refused outside /v1, limited by scope and by project, revocable;
//   - readings at a point: corrected (CT reversed), period-ending, coverage
//     and flags, JSON and CSV, raw only with readings:raw, range caps;
//   - findings and reports: published only; the PDF ops attached;
//   - exports: queued, written by the job as gzip CSV, signed expiring link,
//     expired after their TTL with the file deleted;
//   - OpenAPI and the docs page are served.
//
//   TEST_DATABASE_URL=postgres://... node --test test/db/public-api.test.js
// (services/auth-service and services/api-gateway must be built.)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { freePorts } = require('./ports');

const url = process.env.TEST_DATABASE_URL;
const SECRET = crypto.randomBytes(32).toString('hex');
const ROOT = path.join(__dirname, '..', '..');
const H = 3_600_000;

function start(script, port, env) {
    const child = spawn(process.execPath, [script], {
        cwd: path.dirname(path.dirname(script)),
        env: { ...process.env, DATABASE_URL: url, JWT_SECRET: SECRET, PORT: String(port), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    return { child, log: () => log };
}
async function waitFor(u, svc) {
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(u)).ok) return; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`service did not start: ${svc.log()}`);
}

test('public API v1', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 300_000 }, async (t) => {
    const { Pool } = require('pg');
    const jwt = require('jsonwebtoken');
    const { refreshAggregates } = require('@gridiq/db');
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const run = crypto.randomBytes(4).toString('hex');

    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gq-v1-up-'));
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gq-v1-ex-'));
    process.env.EXPORT_DIR = exportDir;
    process.env.JWT_SECRET = SECRET; // the export job and link signing in this process
    const [apiPort, authPort, gwPort] = await freePorts(3);
    const api = start(path.join(ROOT, 'dist', 'main.js'), apiPort, { ROLES: 'api', UPLOAD_DIR: uploadDir, EXPORT_DIR: exportDir, OPENAI_API_KEY: '' });
    const auth = start(path.join(ROOT, '..', 'auth-service', 'dist', 'main.js'), authPort, {});
    const gw = start(path.join(ROOT, '..', 'api-gateway', 'dist', 'main.js'), gwPort, {
        AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`, INGESTION_SERVICE_URL: `http://127.0.0.1:${apiPort}`,
        API_KEY_RATE_PER_MIN: '1000',
    });
    t.after(() => { api.child.kill(); auth.child.kill(); gw.child.kill(); });
    await waitFor(`http://127.0.0.1:${apiPort}/health`, api);
    await waitFor(`http://127.0.0.1:${authPort}/health`, auth);
    await waitFor(`http://127.0.0.1:${gwPort}/health`, gw);
    const GW = `http://127.0.0.1:${gwPort}`;

    // ── Seed: client tenant C (two projects), client tenant D, internal ops ─
    const tenant = async (name, kind = 'client') => (await q(`INSERT INTO tenants (name, kind) VALUES ($1, $2) RETURNING id`, [`${name} ${run}`, kind]))[0].id;
    const C = await tenant('C'), D = await tenant('D'), I = await tenant('I', 'internal');
    const user = async (tid, role) => (await q(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [tid, `${role}.${crypto.randomBytes(3).toString('hex')}.${run}@test.local`, role]))[0].id;
    const cAdminId = await user(C, 'client_admin'), cViewerId = await user(C, 'client_viewer');
    const cAdmin = jwt.sign({ userId: cAdminId, tenantId: C, role: 'client_admin' }, SECRET);
    const cViewer = jwt.sign({ userId: cViewerId, tenantId: C, role: 'client_viewer' }, SECRET);
    const dAdmin = jwt.sign({ userId: await user(D, 'client_admin'), tenantId: D, role: 'client_admin' }, SECRET);
    const ops = jwt.sign({ userId: await user(I, 'super_admin'), tenantId: I, role: 'super_admin' }, SECRET);

    const project = async (tid, name) => (await q(`INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tid, `${name} ${run}`]))[0].id;
    const p1 = await project(C, 'Plant'), p2 = await project(C, 'Office'), pD = await project(D, 'Other');
    const point = async (proj) => (await q(`INSERT INTO measurement_points (project_id, name, role) VALUES ($1, 'Incomer', 'incomer') RETURNING id`, [proj]))[0].id;
    const pt1 = await point(p1), ptD = await point(pD);
    const box = (await q(`INSERT INTO devices (name, code, mqtt_username, status) VALUES ($1, $2, $3, 'deployed') RETURNING id`,
        [`GQ-V${run}`, `GQ-V${run}`.toUpperCase(), `gq-v${run}`]))[0].id;

    // Three whole hours, 1-minute samples. The CT is reversed: the meter sees
    // −20 kW and counts on its export register; the deployment's sign −1 fixes both.
    const t0 = Math.floor((Date.now() - 5 * H) / H) * H;
    await q(`INSERT INTO deployments (device_id, measurement_point_id, installed_at, power_sign) VALUES ($1, $2, $3, -1)`, [box, pt1, new Date(t0 - H)]);
    await q(`UPDATE devices SET site_id = $2 WHERE id = $1`, [box, p1]);
    for (let ts = t0; ts < t0 + 3 * H; ts += 60_000) {
        await q(`INSERT INTO meter_readings (time, meter_id, voltage_a, voltage_b, voltage_c, current_a, power_active_total, power_apparent_total,
                                             power_factor_total, frequency, energy_import_total, energy_export_total, time_source, device_time)
                 VALUES ($1, $2, 230, 231, 229, 30, -20, 22, -0.9, 50, 7, $3, 'DEVICE', $1)`,
            [new Date(ts), box, 1000 + (20 * (ts - t0)) / H]);
    }
    await refreshAggregates(pool, new Date(t0 - 86_400_000), new Date(t0 + 86_400_000));

    // GridIQ: C's plant has a live assessment from the install, granted to both
    // C users. API keys inherit it (they read only while it is live).
    const assessment = (await q(`INSERT INTO assessments (tenant_id, project_id, title, status, duration_days, start_at, end_at, payment_state)
                                 VALUES ($1, $2, 't', 'active', 7, $3, $4, 'paid') RETURNING id`, [C, p1, new Date(t0 - H), new Date(t0 - H + 7 * 86_400_000)]))[0].id;
    for (const u of [cAdminId, cViewerId]) await q(`INSERT INTO assessment_grants (assessment_id, user_id, email) VALUES ($1, $2, $3)`, [assessment, u, `g.${u}@t.local`]);

    // Findings and reports: one published, one draft each.
    const rec = (title, status) => q(`INSERT INTO recommendations (site_id, tenant_id, type, title, status, review_status, internal_notes)
                                      VALUES ($1, $2, 'TEST', $3, 'ACTIVE', $4, 'SECRET-NOTE') RETURNING id`, [p1, C, title, status]);
    await rec(`pub-${run}`, 'published');
    await rec(`draft-${run}`, 'draft');

    const call = async (auth, method, p, body, extra = {}) => {
        const headers = { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) };
        const r = await fetch(`${GW}${p}`, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual', ...extra });
        const buf = Buffer.from(await r.arrayBuffer());
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8'), json };
    };
    const newKey = async (token, body) => {
        const r = await call(token, 'POST', '/auth/keys', body);
        assert.strictEqual(r.status, 201, r.text);
        return r.json;
    };

    let key, keyRow;
    await t.test('a client admin creates a key; it is shown once and stored only as a hash', async () => {
        keyRow = await newKey(cAdmin, { name: 'BMS integration' });
        key = keyRow.key;
        assert.match(key, /^gq_live_[a-z0-9]{10}_/);
        assert.ok(!keyRow.scopes.includes('readings:raw'), 'raw is not a default scope');
        const [stored] = await q(`SELECT key_hash, prefix FROM api_keys WHERE id = $1`, [keyRow.id]);
        assert.strictEqual(stored.key_hash, crypto.createHash('sha256').update(key).digest('hex'));
        assert.ok(!JSON.stringify(stored).includes(key));
        const list = await call(cAdmin, 'GET', '/auth/keys');
        assert.ok(list.json.some((k) => k.id === keyRow.id) && !list.text.includes(key), 'listed without the key');
        assert.strictEqual((await call(cViewer, 'POST', '/auth/keys', { name: 'x' })).status, 403, 'viewers cannot create keys');
        assert.strictEqual((await call(ops, 'POST', '/auth/keys', { name: 'x', tenant_id: I })).status, 400, 'keys belong to client tenants');
        assert.strictEqual((await call(cAdmin, 'POST', '/auth/keys', { name: 'x', project_ids: [pD] })).status, 400, 'own projects only');
        const audit = await q(`SELECT action FROM audit_log WHERE entity_id = $1`, [keyRow.id]);
        assert.deepStrictEqual(audit.map((a) => a.action), ['api_key.create']);
    });

    await t.test('the gateway accepts a key on /v1 only, and hides the verify endpoint', async () => {
        const r = await call(key, 'GET', '/v1/projects');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.map((p) => p.id).sort(), [p1, p2].sort());
        assert.ok(r.headers.get('ratelimit-limit'), 'per-key rate limit headers');
        assert.strictEqual((await call(key, 'GET', '/ingestion/meters')).status, 401);
        assert.strictEqual((await call(key, 'GET', '/auth/users')).status, 401);
        assert.strictEqual((await call(null, 'POST', '/auth/internal/keys/verify', { key })).status, 404);
        assert.strictEqual((await call('gq_live_0000000000_' + 'A'.repeat(43), 'GET', '/v1/projects')).status, 401);
        // A session works on /v1 as well.
        assert.strictEqual((await call(cAdmin, 'GET', '/v1/projects')).status, 200);
    });

    await t.test('a key reaches only its tenant, and only its projects when limited', async () => {
        assert.strictEqual((await call(key, 'GET', `/v1/projects/${pD}`)).status, 404);
        assert.strictEqual((await call(key, 'GET', `/v1/points/${ptD}/readings`)).status, 404);
        const limited = (await newKey(cAdmin, { name: 'office only', project_ids: [p2], scopes: ['projects:read', 'readings:read'] })).key;
        const list = await call(limited, 'GET', '/v1/projects');
        assert.deepStrictEqual(list.json.map((p) => p.id), [p2]);
        assert.strictEqual((await call(limited, 'GET', `/v1/projects/${p1}`)).status, 404);
        assert.strictEqual((await call(limited, 'GET', `/v1/points/${pt1}/readings`)).status, 404);
        assert.strictEqual((await call(limited, 'GET', `/v1/projects/${p2}/findings`)).status, 403, 'scope findings:read missing');
        const dKey = (await newKey(dAdmin, { name: 'D' })).key;
        assert.deepStrictEqual((await call(dKey, 'GET', '/v1/projects')).json.map((p) => p.id), [pD]);
    });

    await t.test('project detail lists points and their metered windows, no internal fields', async () => {
        const r = await call(key, 'GET', `/v1/projects/${p1}`);
        assert.strictEqual(r.status, 200);
        const pt = r.json.points.find((p) => p.id === pt1);
        assert.strictEqual(pt.role, 'incomer');
        assert.strictEqual(pt.metered.length, 1);
        assert.ok(!('internal_notes' in r.json) && !('notes' in r.json));
    });

    await t.test('readings: corrected, period-ending, full coverage, flagged', async () => {
        const r = await call(key, 'GET', `/v1/points/${pt1}/readings?interval=1h&from=${new Date(t0).toISOString()}&to=${new Date(t0 + 3 * H).toISOString()}`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.dataset.interval, '1h');
        assert.match(r.json.dataset.timestamps, /period-ending/);
        const rows = r.json.rows;
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].period_end, new Date(t0 + H).toISOString());
        for (const x of rows) {
            assert.ok(Math.abs(x.power_active_kw - 20) < 1e-6, 'sign corrected');
            assert.ok(x.power_factor > 0);
            assert.strictEqual(x.coverage, 1);
            assert.match(x.flags, /correction_applied/);
            assert.doesNotMatch(x.flags, /gap/);
        }
        assert.ok(Math.abs(rows[1].energy_import_kwh - 20) < 0.01, `import from the export register: ${rows[1].energy_import_kwh}`);
        assert.ok(Math.abs(rows[2].energy_import_kwh - 20) < 0.01);
        // Daily rows are SAST days: the whole sample lands in one. A key reads only
        // whole days inside its assessment (none yet: it started hours ago); staff see all.
        const asked = `/v1/points/${pt1}/readings?interval=1d&from=${new Date(t0 - 2 * 86_400_000).toISOString()}&to=${new Date(t0 + 2 * 86_400_000).toISOString()}`;
        assert.strictEqual((await call(key, 'GET', asked)).status, 400);
        const d = await call(ops, 'GET', asked);
        assert.strictEqual(d.status, 200, d.text);
        assert.ok(d.json.rows.every((x) => /T22:00:00\.000Z$/.test(x.period_start)), 'SAST midnight');
        assert.strictEqual(d.json.rows.reduce((s, x) => s + x.n, 0), 180);
    });

    await t.test('readings as CSV carry the conventions', async () => {
        const r = await call(key, 'GET', `/v1/points/${pt1}/readings?interval=15m&format=csv&from=${new Date(t0).toISOString()}&to=${new Date(t0 + H).toISOString()}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/csv/);
        const lines = r.text.trimEnd().split('\n');
        assert.match(lines[0], /^# Grid-IQ dataset /);
        const header = lines.findIndex((l) => l.startsWith('period_start,'));
        assert.ok(header > 0);
        assert.strictEqual(lines.length - header - 1, 4);
    });

    await t.test('raw readings need readings:raw; ranges are capped', async () => {
        const range = `from=${new Date(t0).toISOString()}&to=${new Date(t0 + H).toISOString()}`;
        assert.strictEqual((await call(key, 'GET', `/v1/points/${pt1}/readings?interval=raw&${range}`)).status, 403);
        const rawKey = (await newKey(cAdmin, { name: 'raw', scopes: ['readings:read', 'readings:raw'] })).key;
        const raw = await call(rawKey, 'GET', `/v1/points/${pt1}/readings?interval=raw&${range}`);
        assert.strictEqual(raw.status, 200, raw.text);
        assert.strictEqual(raw.json.rows.length, 60);
        assert.ok(raw.json.rows.every((x) => x.power_active_kw === 20));
        const long = await call(key, 'GET', `/v1/points/${pt1}/readings?interval=1m&from=${new Date(t0 - 40 * 86_400_000).toISOString()}&to=${new Date(t0).toISOString()}`);
        assert.strictEqual(long.status, 400);
        assert.match(long.json.error, /exports/);
        assert.strictEqual((await call(key, 'GET', `/v1/points/${pt1}/readings?interval=5m`)).status, 400);
        assert.strictEqual((await call(key, 'GET', `/v1/points/${pt1}/readings?from=yesterday`)).status, 400);
    });

    await t.test('energy balance per SAST day', async () => {
        const from = new Date(Math.floor((t0 + 2 * H) / 86_400_000) * 86_400_000 - 2 * H - 86_400_000);
        const r = await call(key, 'GET', `/v1/projects/${p1}/energy-balance?interval=day&from=${from.toISOString()}&to=${new Date(from.getTime() + 3 * 86_400_000).toISOString()}`);
        assert.strictEqual(r.status, 200, r.text);
        // Clamped to the assessment (from the install, t0 − 1 h, to now).
        assert.ok(r.json.balances.length >= 1 && r.json.balances.length <= 2, JSON.stringify(r.json.balances.map((b) => b.period_start)));
        assert.strictEqual(r.json.balances[0].period_start, new Date(t0 - H).toISOString());
        const total = r.json.balances.reduce((s, b) => s + (b.grid_import_kwh ?? 0), 0);
        assert.ok(total > 55 && total < 61, `about 60 kWh imported: ${total}`);
    });

    await t.test('findings: published only, without internal notes', async () => {
        const r = await call(key, 'GET', `/v1/projects/${p1}/findings`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.map((f) => f.title), [`pub-${run}`]);
        assert.ok(!r.text.includes('SECRET-NOTE'));
    });

    let reportId;
    await t.test('reports: ops attach a PDF to the draft; the API serves it once published', async () => {
        const created = await call(ops, 'POST', '/ingestion/reports', { project_id: p1, title: `Oct ${run}`, period_start: new Date(t0 - 86_400_000).toISOString(), period_end: new Date(t0).toISOString() });
        assert.strictEqual(created.status, 201, created.text);
        reportId = created.json.id;
        const pdf = Buffer.from(`%PDF-1.4\n% test report ${run}\n%%EOF\n`);
        const notPdf = new FormData();
        notPdf.append('file', new Blob(['hello'], { type: 'application/pdf' }), 'x.pdf');
        assert.strictEqual((await call(ops, 'POST', `/ingestion/reports/${reportId}/pdf`, notPdf)).status, 400, 'content is checked');
        const form = new FormData();
        form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'report.pdf');
        const clientTry = new FormData();
        clientTry.append('file', new Blob([pdf], { type: 'application/pdf' }), 'report.pdf');
        assert.strictEqual((await call(cAdmin, 'POST', `/ingestion/reports/${reportId}/pdf`, clientTry)).status, 403);
        const up = await call(ops, 'POST', `/ingestion/reports/${reportId}/pdf`, form);
        assert.strictEqual(up.status, 200, up.text);
        assert.strictEqual(up.json.pdf_path, `report-pdfs/${reportId}.pdf`);
        // Draft: invisible to clients.
        assert.strictEqual((await call(key, 'GET', `/v1/reports/${reportId}.pdf`)).status, 404);
        assert.strictEqual((await call(cAdmin, 'GET', `/ingestion/reports/${reportId}/pdf`)).status, 404);
        assert.strictEqual((await call(ops, 'POST', `/ingestion/reports/${reportId}/approve`)).status, 200);
        assert.strictEqual((await call(ops, 'POST', `/ingestion/reports/${reportId}/publish`)).status, 200);
        const list = await call(key, 'GET', `/v1/projects/${p1}/reports`);
        const item = list.json.find((x) => x.id === reportId);
        assert.strictEqual(item.has_pdf, true);
        assert.strictEqual(item.pdf_url, `/api/v1/reports/${reportId}.pdf`);
        const got = await call(key, 'GET', `/v1/reports/${reportId}.pdf`);
        assert.strictEqual(got.status, 200);
        assert.strictEqual(got.headers.get('content-type'), 'application/pdf');
        assert.ok(got.buf.equals(pdf));
        assert.ok((await call(cAdmin, 'GET', `/ingestion/reports/${reportId}/pdf`)).buf.equals(pdf), 'and the portal route');
        const dKey = (await newKey(dAdmin, { name: 'D2' })).key;
        assert.strictEqual((await call(dKey, 'GET', `/v1/reports/${reportId}.pdf`)).status, 404, 'other tenant');
        // Published: no more uploads.
        const again = new FormData();
        again.append('file', new Blob([pdf], { type: 'application/pdf' }), 'r.pdf');
        assert.strictEqual((await call(ops, 'POST', `/ingestion/reports/${reportId}/pdf`, again)).status, 409);
        const log = await q(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [reportId]);
        assert.deepStrictEqual(log.map((x) => x.action), ['report.create', 'report.attach_pdf', 'report.approve', 'report.publish']);
    });

    await t.test('exports: queued, written as gzip CSV, signed link, expired after the TTL', async () => {
        const { runExports, expireExports } = require('../../dist/v1/exports-job.js');
        const body = { point_id: pt1, interval: '15m', from: new Date(t0).toISOString(), to: new Date(t0 + 3 * H).toISOString() };
        const made = await call(key, 'POST', '/v1/exports', body);
        assert.strictEqual(made.status, 202, made.text);
        assert.strictEqual(made.json.status, 'queued');
        assert.strictEqual(made.json.download_url, null);
        assert.strictEqual((await call(cViewer, 'POST', '/v1/exports', body)).status, 202, 'a viewer may export');
        const dKey = (await newKey(dAdmin, { name: 'D3' })).key;
        assert.strictEqual((await call(dKey, 'GET', `/v1/exports/${made.json.id}`)).status, 404, 'other tenant');
        assert.strictEqual((await call(dKey, 'POST', '/v1/exports', body)).status, 404);
        const noScope = (await newKey(cAdmin, { name: 'ro', scopes: ['readings:read'] })).key;
        assert.strictEqual((await call(noScope, 'POST', '/v1/exports', body)).status, 403);

        assert.ok(await runExports(pool) >= 1);
        const st = await call(key, 'GET', `/v1/exports/${made.json.id}`);
        assert.strictEqual(st.json.status, 'done', st.text);
        assert.strictEqual(st.json.rows, 12);
        assert.ok(st.json.download_url.startsWith(`/api/v1/exports/${made.json.id}/download?`));
        const link = st.json.download_url.replace(/^\/api/, '');
        const dl = await call(null, 'GET', link);
        assert.strictEqual(dl.status, 200);
        const csv = zlib.gunzipSync(dl.buf).toString('utf8');
        assert.match(csv, /^# Grid-IQ dataset /);
        assert.strictEqual(csv.trimEnd().split('\n').filter((l) => /^\d{4}-/.test(l)).length, 12);
        assert.strictEqual((await call(null, 'GET', link.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).status, 403, 'tampered');
        // TTL passes: the file goes, the row says expired, the link stops working.
        await q(`UPDATE exports SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [made.json.id]);
        assert.ok(await expireExports(pool) >= 1);
        assert.ok(!fs.existsSync(path.join(exportDir, `${made.json.id}.csv.gz`)));
        assert.strictEqual((await call(key, 'GET', `/v1/exports/${made.json.id}`)).json.status, 'expired');
        assert.notStrictEqual((await call(null, 'GET', link)).status, 200);
    });

    await t.test('a revoked key stops verifying', async () => {
        assert.strictEqual((await call(cAdmin, 'DELETE', `/auth/keys/${keyRow.id}`)).status, 200);
        const v = await fetch(`http://127.0.0.1:${authPort}/internal/keys/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
        assert.strictEqual(v.status, 401);
        assert.strictEqual((await call(dAdmin, 'DELETE', `/auth/keys/${keyRow.id}`)).status, 404, 'other tenant cannot revoke');
    });

    await t.test('OpenAPI and docs are served', async () => {
        const spec = await call(null, 'GET', '/v1/openapi.json');
        assert.strictEqual(spec.status, 200);
        assert.strictEqual(spec.json.openapi, '3.1.0');
        assert.ok(spec.json.paths['/v1/points/{id}/readings']);
        const redirect = await call(null, 'GET', '/docs');
        assert.strictEqual(redirect.status, 301);
        assert.strictEqual(redirect.headers.get('location'), 'docs/');
        const page = await call(null, 'GET', '/docs/');
        assert.match(page.text, /swagger-ui-bundle\.js/);
        assert.strictEqual((await call(null, 'GET', '/docs/swagger-ui-bundle.js')).status, 200);
        assert.strictEqual((await call(null, 'GET', '/docs/openapi.json')).json.openapi, '3.1.0');
    });
});
