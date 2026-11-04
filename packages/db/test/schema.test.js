// The startup check that makes services refuse to run on a database that is
// behind the latest migration.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    listMigrations, appliedMigrations, compareMigrations, assertSchemaCurrent, SchemaBehindError,
} = require('..');

// Minimal stand-in for a pg Pool: answers the two queries the check makes.
function fakeDb({ table = true, applied = [] } = {}) {
    return {
        async query(sql) {
            if (/to_regclass/.test(sql)) return { rows: [{ present: table }] };
            if (/FROM pgmigrations/.test(sql)) return { rows: applied.map((name) => ({ name })) };
            throw new Error(`unexpected query: ${sql}`);
        },
    };
}

test('listMigrations', async (t) => {
    await t.test('the shipped migrations start with the baseline, in timestamp order', () => {
        const names = listMigrations();
        assert.ok(names.length >= 2);
        assert.match(names[0], /^\d+_baseline$/);
        const stamps = names.map((n) => BigInt(n.split('_')[0]));
        assert.deepStrictEqual([...stamps].sort((a, b) => (a < b ? -1 : 1)), stamps);
    });

    await t.test('sorts numerically and ignores non-migration files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
        for (const f of ['20_b.sql', '3_a.sql', '100_c.sql', 'README.md', 'x.sql']) fs.writeFileSync(path.join(dir, f), '');
        assert.deepStrictEqual(listMigrations(dir), ['3_a', '20_b', '100_c']);
    });
});

test('appliedMigrations', async (t) => {
    await t.test('is empty before the migrations table exists', async () => {
        assert.deepStrictEqual(await appliedMigrations(fakeDb({ table: false })), []);
    });
    await t.test('returns the applied names', async () => {
        assert.deepStrictEqual(await appliedMigrations(fakeDb({ applied: ['1_a', '2_b'] })), ['1_a', '2_b']);
    });
});

test('compareMigrations', () => {
    assert.deepStrictEqual(compareMigrations(['1_a', '2_b'], ['1_a', '2_b']), { pending: [], unknown: [] });
    assert.deepStrictEqual(compareMigrations(['1_a', '2_b', '3_c'], ['1_a']), { pending: ['2_b', '3_c'], unknown: [] });
    assert.deepStrictEqual(compareMigrations(['1_a'], ['1_a', '9_z']), { pending: [], unknown: ['9_z'] });
});

test('assertSchemaCurrent', async (t) => {
    const expected = ['1_baseline', '2_next'];
    const quiet = { warn() {} };

    await t.test('passes when every migration is applied', async () => {
        const r = await assertSchemaCurrent(fakeDb({ applied: expected }), { expected, log: quiet });
        assert.deepStrictEqual(r, { applied: 2, unknown: [] });
    });

    await t.test('refuses an unmigrated database', async () => {
        await assert.rejects(
            assertSchemaCurrent(fakeDb({ table: false }), { expected, log: quiet }),
            (e) => e instanceof SchemaBehindError && e.pending.length === 2 && /docker compose run --rm migrate/.test(e.message),
        );
    });

    await t.test('refuses a database one migration behind', async () => {
        await assert.rejects(
            assertSchemaCurrent(fakeDb({ applied: ['1_baseline'] }), { expected, log: quiet }),
            (e) => e instanceof SchemaBehindError && e.pending[0] === '2_next',
        );
    });

    await t.test('warns, but starts, when the database is ahead of the code', async () => {
        const warnings = [];
        const r = await assertSchemaCurrent(fakeDb({ applied: [...expected, '3_future'] }), {
            expected, log: { warn: (m) => warnings.push(m) },
        });
        assert.deepStrictEqual(r.unknown, ['3_future']);
        assert.strictEqual(warnings.length, 1);
    });
});
