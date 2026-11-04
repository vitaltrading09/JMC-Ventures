// Public API v1 (Phase 9): interval shaping, CSV conventions, periods, export
// chunks, signed download links, OpenAPI generation and API-key scope rules.
// Run with: npm run build && npm test

const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-unit-test-secret-0000';
const { shapeRows, toCsv, csvHeader, csvRows, medianSpacing, datasetId, COLUMNS, MAX_RANGE_DAYS } = require('../dist/v1/series.js');
const { splitPeriods, signDownload, checkDownload, openapi, v1Routes, exportView } = require('../dist/v1/routes.js');
const { chunks } = require('../dist/v1/exports-job.js');
const { buildScope, hasApiScope, projectAllowed, viewerMayCall } = require('../dist/scope.js');

const bucket = (iso, o = {}) => ({
    deployment_id: 'd1', period_start: iso, n: 15, correction_applied: false,
    t_first: iso, t_last: new Date(new Date(iso).getTime() + 14 * 60_000).toISOString(),
    voltage_a: 230.12345, power_active_kw: 10, power_active_kw_max: 12,
    imp_first: null, imp_last: null, exp_first: null, exp_last: null, ...o,
});

test('shapeRows: period-ending labels, coverage from the box spacing, gap flag', () => {
    const rows = shapeRows([
        bucket('2026-10-01T00:00:00Z', { n: 15 }),
        bucket('2026-10-01T00:15:00Z', { n: 6 }),
    ], '15m', 60);
    assert.strictEqual(rows[0].period_start, '2026-10-01T00:00:00.000Z');
    assert.strictEqual(rows[0].period_end, '2026-10-01T00:15:00.000Z');
    assert.strictEqual(rows[0].coverage, 1);
    assert.strictEqual(rows[0].flags, '');
    assert.strictEqual(rows[1].coverage, 0.4);
    assert.strictEqual(rows[1].flags, 'gap');
    assert.strictEqual(rows[0].voltage_a, 230.123, 'rounded to 3 decimals');
});

test('shapeRows: a 5-minute meter is fully covered with 3 samples per 15 minutes', () => {
    const rows = shapeRows([bucket('2026-10-01T00:00:00Z', { n: 3 })], '15m', 300);
    assert.strictEqual(rows[0].coverage, 1);
    assert.strictEqual(rows[0].flags, '');
});

test('shapeRows: energy is the register step; a reset is flagged and left empty, never summed through', () => {
    const rows = shapeRows([
        bucket('2026-10-01T00:00:00Z', { imp_first: 100, imp_last: 102 }),
        bucket('2026-10-01T00:15:00Z', { imp_first: 102.5, imp_last: 105 }),
        bucket('2026-10-01T00:30:00Z', { imp_first: 1, imp_last: 3 }),   // register reset
        bucket('2026-10-01T00:45:00Z', { imp_first: 3.5, imp_last: 4 }),
    ], '15m', 60);
    assert.strictEqual(rows[0].energy_import_kwh, 2, 'first row: last - first');
    assert.strictEqual(rows[1].energy_import_kwh, 3, 'then last - previous last (includes the step between buckets)');
    assert.strictEqual(rows[2].energy_import_kwh, null);
    assert.match(rows[2].flags, /register_reset/);
    assert.strictEqual(rows[3].energy_import_kwh, 1, 'continues from the new register');
    assert.strictEqual(rows[0].energy_export_kwh, null, 'no export register: null, not 0');
});

test('shapeRows: registers are tracked per deployment (a swapped box does not produce a step)', () => {
    const rows = shapeRows([
        bucket('2026-10-01T00:00:00Z', { deployment_id: 'old', imp_first: 5000, imp_last: 5001 }),
        bucket('2026-10-01T00:15:00Z', { deployment_id: 'new', imp_first: 10, imp_last: 12 }),
    ], '15m', 60);
    assert.strictEqual(rows[1].energy_import_kwh, 2);
    assert.strictEqual(rows[1].flags, '');
});

test('shapeRows: correction flag; daily rows end 24 h later; raw rows are instants with register values', () => {
    const d = shapeRows([bucket('2026-09-30T22:00:00Z', { correction_applied: true, n: 1440 })], '1d', 60);
    assert.strictEqual(d[0].period_end, '2026-10-01T22:00:00.000Z');
    assert.match(d[0].flags, /correction_applied/);
    const r = shapeRows([bucket('2026-10-01T00:00:00Z', { n: 1, imp_last: 77 })], 'raw');
    assert.strictEqual(r[0].period_end, r[0].period_start);
    assert.strictEqual(r[0].coverage, 1);
    assert.strictEqual(r[0].energy_import_kwh, 77);
});

test('medianSpacing: seconds between samples, from bucket counts', () => {
    assert.strictEqual(medianSpacing([{ n: 13, t_first: '2026-10-01T00:00:00Z', t_last: '2026-10-01T01:00:00Z' }]), 300);
    assert.strictEqual(medianSpacing([{ n: 1, t_first: '2026-10-01T00:00:00Z', t_last: '2026-10-01T00:00:00Z' }]), null);
});

test('CSV: conventions as # lines, then the header, then rows; values with commas are quoted', () => {
    const meta = { dataset_id: 'x', point: 'Main, incomer', project: 'P "1"', interval: '15m', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') };
    const rows = shapeRows([bucket('2026-10-01T00:00:00Z')], '15m', 60);
    const csv = toCsv(rows, meta);
    const lines = csv.trimEnd().split('\n');
    const comments = lines.filter((l) => l.startsWith('#'));
    assert.ok(comments.some((l) => /period-ending/.test(l)), 'states the timestamp convention');
    assert.ok(comments.some((l) => /Africa\/Johannesburg/.test(l)), 'states the time zone');
    assert.ok(comments.some((l) => /import \/ consumption positive/.test(l)), 'states the sign');
    assert.strictEqual(lines[comments.length], COLUMNS.join(','));
    assert.strictEqual(lines.length, comments.length + 2);
    assert.strictEqual(csv, csvHeader(meta) + csvRows(rows));
    const quoted = csvRows([{ ...rows[0], flags: 'a,b' }]);
    assert.match(quoted, /"a,b"\n$/);
});

test('datasetId is stable for the same request', () => {
    const a = datasetId('p', '15m', new Date(0), new Date(1000));
    assert.strictEqual(a, datasetId('p', '15m', new Date(0), new Date(1000)));
    assert.notStrictEqual(a, datasetId('p', '1h', new Date(0), new Date(1000)));
});

test('splitPeriods: SAST days and months', () => {
    const from = new Date('2026-09-29T22:00:00Z'), to = new Date('2026-10-02T22:00:00Z'); // 30 Sep – 2 Oct SAST
    assert.deepStrictEqual(splitPeriods(from, to, 'total').length, 1);
    const days = splitPeriods(from, to, 'day');
    assert.strictEqual(days.length, 3);
    assert.strictEqual(days[1][0].toISOString(), '2026-09-30T22:00:00.000Z');
    const months = splitPeriods(from, to, 'month');
    assert.deepStrictEqual(months.map(([a, b]) => [a.toISOString(), b.toISOString()]), [
        ['2026-09-29T22:00:00.000Z', '2026-09-30T22:00:00.000Z'],
        ['2026-09-30T22:00:00.000Z', '2026-10-02T22:00:00.000Z'],
    ]);
});

test('export chunks stay within the per-request range of the interval', () => {
    const from = new Date('2026-01-01T00:00:00Z'), to = new Date('2026-03-01T00:00:00Z');
    const c = chunks(from, to, '1m');
    assert.strictEqual(c[0][0].getTime(), from.getTime());
    assert.strictEqual(c.at(-1)[1].getTime(), to.getTime());
    for (const [a, b] of c) assert.ok(b - a <= MAX_RANGE_DAYS['1m'] * 86_400_000);
    for (let i = 1; i < c.length; i++) assert.strictEqual(c[i][0].getTime(), c[i - 1][1].getTime(), 'contiguous');
});

test('signed download links: valid until expiry, bound to the export id', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const exp = Date.now() + 60_000;
    const sig = signDownload(id, exp);
    assert.ok(checkDownload(id, exp, sig));
    assert.ok(!checkDownload('00000000-0000-4000-8000-000000000002', exp, sig), 'other export');
    assert.ok(!checkDownload(id, exp + 1, sig), 'tampered expiry');
    assert.ok(!checkDownload(id, Date.now() - 1, signDownload(id, Date.now() - 1)), 'expired');
    assert.ok(!checkDownload(id, exp, 'x'), 'garbage');
});

test('exportView: download link only once done, never past the export expiry', () => {
    const base = { id: '00000000-0000-4000-8000-000000000001', measurement_point_id: 'p', interval: '1h', rows: 1, bytes: '10' };
    assert.strictEqual(exportView({ ...base, status: 'queued' }).download_url, null);
    const soon = new Date(Date.now() + 60_000);
    const v = exportView({ ...base, status: 'done', expires_at: soon });
    const expires = Number(new URL(v.download_url, 'http://x').searchParams.get('expires'));
    assert.ok(expires <= soon.getTime());
    assert.strictEqual(v.bytes, 10);
});

test('OpenAPI: every declared route is documented, scoped, and the download link is public', () => {
    const routes = v1Routes({ query: async () => ({ rows: [] }) });
    const spec = openapi(routes);
    assert.strictEqual(spec.openapi, '3.1.0');
    for (const r of routes) {
        const op = spec.paths[r.openapiPath]?.[r.method];
        assert.ok(op, `${r.method} ${r.openapiPath} documented`);
        if (r.auth === false) assert.deepStrictEqual(op.security, []);
        else assert.ok(op['x-required-scope'], `${r.openapiPath} names its scope`);
    }
    assert.ok(spec.paths['/v1/points/{id}/readings'].get.parameters.some((p) => p.name === 'interval'));
});

test('API-key scope: scopes and project limits apply to keys only', () => {
    const session = buildScope({ userId: 'u', role: 'client_admin', tenantId: 't' }, { query: {}, body: {} });
    assert.ok(hasApiScope(session, 'readings:raw'));
    assert.ok(projectAllowed(session, 'any'));
    const key = buildScope({ userId: null, role: 'client_viewer', tenantId: 't', apiKey: { id: 'k', scopes: ['projects:read'], projectIds: ['p1'] } }, { query: {}, body: {} });
    assert.ok(key.apiKey);
    assert.ok(hasApiScope(key, 'projects:read'));
    assert.ok(!hasApiScope(key, 'readings:read'));
    assert.ok(projectAllowed(key, 'p1'));
    assert.ok(!projectAllowed(key, 'p2'));
    assert.ok(viewerMayCall('POST', '/v1/exports'), 'requesting an export is a read');
    assert.ok(!viewerMayCall('POST', '/v1/projects'));
});
