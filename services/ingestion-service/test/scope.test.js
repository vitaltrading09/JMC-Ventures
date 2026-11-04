// Central tenant scope (src/scope.ts) and the review state machines
// (src/review.ts), without a database.

const test = require('node:test');
const assert = require('node:assert');

const { normaliseRole, buildScope, canWrite, viewerMayCall, tenantSql, telemetrySql, exclusiveDeviceSql, forClient } =
    require('../dist/scope.js');
const { canReview, reportTransition } = require('../dist/review.js');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

test('roles', async (t) => {
    await t.test('old role names map to the new ones; unknown is least privilege', () => {
        assert.strictEqual(normaliseRole('admin'), 'client_admin');
        assert.strictEqual(normaliseRole('viewer'), 'client_viewer');
        assert.strictEqual(normaliseRole('user'), 'client_viewer');
        assert.strictEqual(normaliseRole('super_admin'), 'super_admin');
        assert.strictEqual(normaliseRole('engineer'), 'engineer');
        assert.strictEqual(normaliseRole('root'), 'client_viewer');
        assert.strictEqual(normaliseRole(undefined), 'client_viewer');
    });

    await t.test('only internal users and client_admin may write', () => {
        assert.strictEqual(canWrite(buildScope({ role: 'client_admin', tenantId: A })), true);
        assert.strictEqual(canWrite(buildScope({ role: 'engineer' })), true);
        assert.strictEqual(canWrite(buildScope({ role: 'client_viewer', tenantId: A })), false);
        assert.strictEqual(canWrite(buildScope({ role: 'broker' })), false);
    });

    await t.test('a viewer may read, ask, mark alerts read and notify; nothing else', () => {
        assert.ok(viewerMayCall('GET', '/sites'));
        assert.ok(viewerMayCall('POST', `/meters/${A}/compliance/ask`));
        assert.ok(viewerMayCall('POST', `/alerts/${A}/read`));
        assert.ok(viewerMayCall('POST', `/recommendations/${A}/notify`));
        for (const [m, p] of [['POST', '/sites'], ['DELETE', `/meters/${A}`], ['POST', `/sites/${A}/settings`],
            ['POST', '/upload'], ['POST', `/meters/${A}/shares`], ['PUT', '/branding'], ['PATCH', `/leads/${A}`]]) {
            assert.strictEqual(viewerMayCall(m, p), false, `${m} ${p}`);
        }
    });
});

test('scope filters', async (t) => {
    await t.test('a client is always confined to its own tenant, whatever it asks for', () => {
        const s = buildScope({ role: 'client_admin', tenantId: A }, { query: { tenant_id: B }, body: { tenant_id: B } });
        assert.strictEqual(s.filterTenantId, A);
        const params = [];
        assert.strictEqual(tenantSql(s, 'p.tenant_id', params), 'p.tenant_id = $1');
        assert.deepStrictEqual(params, [A]);
    });

    await t.test('an internal user sees all tenants, or the one it names', () => {
        const all = buildScope({ role: 'super_admin', tenantId: A });
        assert.strictEqual(all.filterTenantId, null);
        assert.strictEqual(tenantSql(all, 'x', []), 'TRUE');
        const one = buildScope({ role: 'engineer', tenantId: A }, { query: { tenant_id: B } });
        assert.strictEqual(one.filterTenantId, B);
        // A malformed tenant id is ignored rather than passed to SQL.
        assert.strictEqual(buildScope({ role: 'super_admin' }, { query: { tenant_id: "x' OR 1=1" } }).filterTenantId, null);
    });

    await t.test('a client without a tenant matches nothing', () => {
        const s = buildScope({ role: 'client_admin' });
        assert.strictEqual(s.filterTenantId, '00000000-0000-0000-0000-000000000000');
    });

    await t.test('the tenant parameter is shared between conditions of one query', () => {
        const s = buildScope({ role: 'client_admin', tenantId: A });
        const params = ['other'];
        const a = tenantSql(s, 's.tenant_id', params);
        const b = exclusiveDeviceSql(s, 'm', params);
        assert.strictEqual(a, 's.tenant_id = $2');
        assert.match(b, /px\.tenant_id <> \$2/);
        assert.deepStrictEqual(params, ['other', A]);
    });

    await t.test('telemetry and moved-device conditions apply to clients only', () => {
        assert.strictEqual(telemetrySql(buildScope({ role: 'super_admin' }), 'p'), 'TRUE');
        assert.match(telemetrySql(buildScope({ role: 'client_viewer', tenantId: A }), 'p'), /p\.live_data_visible OR EXISTS/);
        assert.strictEqual(exclusiveDeviceSql(buildScope({ role: 'engineer' }), 'd', []), 'TRUE');
    });

    await t.test('internal fields are stripped for clients, kept for internal users', () => {
        const row = { id: 1, title: 'x', internal_notes: 'secret', reviewed_by: 'u' };
        assert.deepStrictEqual(forClient(buildScope({ role: 'client_admin', tenantId: A }), row), { id: 1, title: 'x' });
        assert.deepStrictEqual(forClient(buildScope({ role: 'super_admin' }), row), row);
    });
});

test('review workflow', async (t) => {
    await t.test('recommendation review moves', () => {
        assert.ok(canReview('draft', 'published'));
        assert.ok(canReview('draft', 'in_review'));
        assert.ok(canReview('in_review', 'dismissed'));
        assert.ok(canReview('published', 'in_review'));
        assert.ok(!canReview('dismissed', 'published'));
        assert.ok(canReview('dismissed', 'draft'));
    });

    await t.test('reports: draft → approved → published; withdraw back to draft', () => {
        assert.strictEqual(reportTransition('draft', 'approve'), 'approved');
        assert.strictEqual(reportTransition('approved', 'publish'), 'published');
        assert.strictEqual(reportTransition('draft', 'publish'), null);      // must be approved first
        assert.strictEqual(reportTransition('published', 'approve'), null);
        assert.strictEqual(reportTransition('published', 'withdraw'), 'draft');
        assert.strictEqual(reportTransition('draft', 'withdraw'), null);
    });
});
