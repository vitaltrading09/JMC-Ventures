// Run with: npm run build && npm test
//
// ROLES decides which parts of the ingestion service a container starts. A
// typo that silently started nothing (or everything) would either drop
// telemetry or run every cron twice, so parsing is strict.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');

const {
    parseRoles, uploadDir, toStoredUploadPath, resolveStoredUploadPath,
    waitUntil, startHealthServer,
} = require('../dist/roles.js');

test('parseRoles', async (t) => {
    await t.test('defaults to all roles when unset or blank', () => {
        assert.deepStrictEqual([...parseRoles(undefined)].sort(), ['api', 'ingest', 'jobs']);
        assert.deepStrictEqual([...parseRoles('')].sort(), ['api', 'ingest', 'jobs']);
        assert.deepStrictEqual([...parseRoles('   ')].sort(), ['api', 'ingest', 'jobs']);
    });

    await t.test('parses a single role', () => {
        assert.deepStrictEqual([...parseRoles('ingest')], ['ingest']);
    });

    await t.test('trims, lower-cases and de-duplicates', () => {
        assert.deepStrictEqual([...parseRoles(' API , jobs,api ,')].sort(), ['api', 'jobs']);
    });

    await t.test('rejects unknown roles', () => {
        assert.throws(() => parseRoles('api,worker'), /Unknown role "worker"/);
    });

    await t.test('rejects a list with no roles', () => {
        assert.throws(() => parseRoles(',,'), /ROLES is empty/);
    });
});

test('upload paths', async (t) => {
    const root = path.resolve('/data/uploads');

    await t.test('UPLOAD_DIR defaults to /data/uploads', () => {
        assert.strictEqual(uploadDir({}), root);
        assert.strictEqual(uploadDir({ UPLOAD_DIR: '/srv/up' }), path.resolve('/srv/up'));
    });

    await t.test('new rows store a path relative to UPLOAD_DIR', () => {
        assert.strictEqual(toStoredUploadPath(path.join(root, 'sld-pdfs', 'a.pdf'), root), 'sld-pdfs/a.pdf');
    });

    await t.test('resolves new-style stored paths', () => {
        assert.strictEqual(resolveStoredUploadPath('sld-pdfs/a.pdf', root), path.join(root, 'sld-pdfs', 'a.pdf'));
    });

    await t.test('resolves legacy rows stored relative to the service folder', () => {
        assert.strictEqual(resolveStoredUploadPath('uploads/sld-pdfs/a.pdf', root), path.join(root, 'sld-pdfs', 'a.pdf'));
        assert.strictEqual(resolveStoredUploadPath('uploads\\sld-pdfs\\a.pdf', root), path.join(root, 'sld-pdfs', 'a.pdf'));
    });

    await t.test('refuses paths that escape UPLOAD_DIR', () => {
        assert.strictEqual(resolveStoredUploadPath('../etc/passwd', root), null);
        assert.strictEqual(resolveStoredUploadPath('uploads/../../etc/passwd', root), null);
    });
});

test('waitUntil', async (t) => {
    await t.test('retries through failures until the check passes', async () => {
        let calls = 0;
        await waitUntil('thing', async () => {
            calls++;
            if (calls === 1) throw new Error('ECONNREFUSED');
            return calls >= 3;
        }, { intervalMs: 1 });
        assert.strictEqual(calls, 3);
    });

    await t.test('times out with the last reason', async () => {
        await assert.rejects(
            waitUntil('db', async () => { throw new Error('ECONNREFUSED'); }, { intervalMs: 1, timeoutMs: 20 }),
            /Timed out waiting for db: ECONNREFUSED/,
        );
    });
});

test('startHealthServer', async (t) => {
    const get = (port, p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });

    let healthy = true;
    const server = startHealthServer(0, async () => ({ ok: healthy, mqtt: healthy ? 'connected' : 'disconnected' }));
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    t.after(() => server.close());

    await t.test('200 when healthy', async () => {
        const r = await get(port, '/health');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(JSON.parse(r.body), { status: 'ok', ok: true, mqtt: 'connected' });
    });

    await t.test('503 when unhealthy', async () => {
        healthy = false;
        const r = await get(port, '/health');
        assert.strictEqual(r.status, 503);
        assert.strictEqual(JSON.parse(r.body).status, 'unhealthy');
    });

    await t.test('404 for other paths', async () => {
        const r = await get(port, '/');
        assert.strictEqual(r.status, 404);
    });
});
