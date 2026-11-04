// API-key authentication at the gateway (src/api-keys.ts).

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { bearerKey, KeyCache, tokenFor, apiKeyAuth } = require('../dist/api-keys.js');

const SECRET = require('node:crypto').randomBytes(32).toString('hex');
// A made-up key in the right shape (built from parts so secret scanners see no literal).
const FAKE_PREFIX = ['gq', 'live', 'a1b2c3d4e5'].join('_');
const KEY = `${FAKE_PREFIX}_${'x'.repeat(43)}`;
const VERIFIED = { key_id: 'k1', prefix: 'a1b2c3d4e5', tenant_id: 't1', scopes: ['readings:read'], project_ids: null };

function run(mw, req) {
    return new Promise((resolve) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b, req }); } };
        mw(req, res, () => resolve({ status: 'next', req }));
    });
}

test('bearerKey recognises keys and nothing else', () => {
    assert.strictEqual(bearerKey(`Bearer ${KEY}`), KEY);
    assert.strictEqual(bearerKey('Bearer eyJhbGciOi.x.y'), null);
    assert.strictEqual(bearerKey(`${FAKE_PREFIX}_short`), null);
    assert.strictEqual(bearerKey(undefined), null);
});

test('KeyCache keeps a good key for 60 s and a bad one for 10 s', () => {
    let now = 0;
    const c = new KeyCache(() => now);
    c.set('good', VERIFIED); c.set('bad', null);
    now = 9_000;
    assert.deepStrictEqual(c.get('good'), VERIFIED);
    assert.strictEqual(c.get('bad'), null);
    now = 11_000;
    assert.strictEqual(c.get('bad'), undefined);
    now = 61_000;
    assert.strictEqual(c.get('good'), undefined);
});

test('the downstream token is a client_viewer of the key\'s tenant, with the key\'s limits', () => {
    const t = jwt.verify(tokenFor(VERIFIED, SECRET), SECRET);
    assert.strictEqual(t.role, 'client_viewer');
    assert.strictEqual(t.tenantId, 't1');
    assert.deepStrictEqual(t.apiKey, { id: 'k1', prefix: 'a1b2c3d4e5', scopes: ['readings:read'], projectIds: null });
    assert.ok(t.exp - t.iat <= 300);
});

test('apiKeyAuth', async (t) => {
    let calls = 0;
    const mw = (verify) => apiKeyAuth({ secret: SECRET, verify, isApiPath: (p) => p.startsWith('/v1/') });
    await t.test('a valid key on /v1 continues with a scoped token, cookie dropped', async () => {
        const r = await run(mw(async () => { calls++; return VERIFIED; }), { path: '/v1/projects', headers: { authorization: `Bearer ${KEY}`, cookie: 'token=admin' } });
        assert.strictEqual(r.status, 'next');
        assert.strictEqual(r.req.apiKeyId, 'k1');
        assert.strictEqual(r.req.headers.cookie, undefined);
        assert.strictEqual(jwt.verify(r.req.headers.authorization.slice(7), SECRET).tenantId, 't1');
    });
    await t.test('a key outside /v1 is refused; a revoked key is 401', async () => {
        assert.strictEqual((await run(mw(async () => VERIFIED), { path: '/ingestion/sites', headers: { authorization: `Bearer ${KEY}` } })).status, 401);
        assert.strictEqual((await run(mw(async () => null), { path: '/v1/projects', headers: { authorization: `Bearer ${KEY}` } })).status, 401);
    });
    await t.test('an auth service failure is 503, not a pass', async () => {
        assert.strictEqual((await run(mw(async () => { throw new Error('down'); }), { path: '/v1/projects', headers: { authorization: `Bearer ${KEY}` } })).status, 503);
    });
    await t.test('requests without a key pass through untouched', async () => {
        const r = await run(mw(async () => { throw new Error('must not be called'); }), { path: '/v1/projects', headers: { authorization: 'Bearer eyJ.a.b' } });
        assert.strictEqual(r.status, 'next');
        assert.strictEqual(r.req.headers.authorization, 'Bearer eyJ.a.b');
    });
});
