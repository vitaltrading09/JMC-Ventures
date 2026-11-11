'use strict';
// File storage (src/storage.ts): local disk and Cloudflare R2 (S3 API, here a
// fake client), with the same behaviour; keys can never leave their area.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gq-store-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.EXPORT_DIR = path.join(tmp, 'exports');
const { localStore, r2Store, safeKey, pdfKey } = require('../dist/storage.js');

/** An in-memory S3: commands are told apart by their class name. */
function fakeS3() {
    const objects = new Map();
    const cmd = {};
    for (const n of ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand', 'ListObjectsV2Command', 'DeleteObjectsCommand']) {
        cmd[n] = class { constructor(input) { this.input = input; this.name = n; } };
    }
    const client = {
        calls: [],
        async send(c) {
            this.calls.push(c.name);
            const i = c.input;
            switch (c.name) {
                case 'PutObjectCommand': objects.set(`${i.Bucket}/${i.Key}`, Buffer.from(i.Body)); return {};
                case 'GetObjectCommand': {
                    const b = objects.get(`${i.Bucket}/${i.Key}`);
                    if (!b) { const e = new Error('missing'); e.name = 'NoSuchKey'; throw e; }
                    return { Body: require('node:stream').Readable.from([b]) };
                }
                case 'DeleteObjectCommand': objects.delete(`${i.Bucket}/${i.Key}`); return {};
                case 'ListObjectsV2Command': return { Contents: [...objects.keys()].filter((k) => k.startsWith(`${i.Bucket}/${i.Prefix}`)).map((k) => ({ Key: k.slice(i.Bucket.length + 1) })), IsTruncated: false };
                case 'DeleteObjectsCommand': for (const o of i.Delete.Objects) objects.delete(`${i.Bucket}/${o.Key}`); return {};
            }
            throw new Error(`unexpected ${c.name}`);
        },
    };
    return { client, cmd, objects };
}

for (const [label, make] of [['local', () => ({ s: localStore() })], ['r2', () => { const f = fakeS3(); return { s: r2Store(f.client, 'gq', f.cmd), f }; }]]) {
    test(`${label} store: put, read, stream, remove, remove a prefix`, async () => {
        const { s, f } = make();
        await s.put('uploads', 'report-pdfs/a.pdf', Buffer.from('%PDF-1'));
        await s.put('exports', 'packages/x/r1/manifest.json', Buffer.from('{}'));
        await s.put('exports', 'packages/x/r2/manifest.json', Buffer.from('{"r":2}'));
        await s.put('exports', 'packages/y/r1/manifest.json', Buffer.from('{}'));
        assert.strictEqual((await s.read('uploads', 'report-pdfs/a.pdf')).toString(), '%PDF-1');
        let streamed = '';
        for await (const c of await s.stream('exports', 'packages/x/r2/manifest.json')) streamed += c;
        assert.strictEqual(streamed, '{"r":2}');
        assert.strictEqual(await s.read('uploads', 'report-pdfs/none.pdf'), null);
        assert.strictEqual(await s.stream('uploads', 'report-pdfs/none.pdf'), null);
        assert.strictEqual(await s.removePrefix('exports', 'packages/x/'), 2);
        assert.strictEqual(await s.read('exports', 'packages/x/r1/manifest.json'), null);
        assert.ok(await s.read('exports', 'packages/y/r1/manifest.json'));      // another assessment untouched
        await s.remove('uploads', 'report-pdfs/a.pdf');
        assert.strictEqual(await s.read('uploads', 'report-pdfs/a.pdf'), null);
        if (f) assert.ok([...f.objects.keys()].every((k) => k.startsWith('gq/exports/') || k.startsWith('gq/uploads/')));
    });

    test(`${label} store: putFile moves a local file into the store`, async () => {
        const { s } = make();
        const src = path.join(tmp, `${label}-src.csv.gz`);
        fs.writeFileSync(src, 'gz');
        await s.putFile('exports', 'e1.csv.gz', src);
        assert.strictEqual((await s.read('exports', 'e1.csv.gz')).toString(), 'gz');
        // Remote: the local copy is gone; local: a copy into the export area.
        if (label === 'r2') assert.strictEqual(fs.existsSync(src), false);
    });
}

test('keys cannot leave their area', () => {
    assert.throws(() => safeKey('../etc/passwd'));
    assert.throws(() => safeKey('packages/../../x'));
    assert.throws(() => safeKey(''));
    assert.strictEqual(safeKey('/report-pdfs/a.pdf'), 'report-pdfs/a.pdf');
    assert.strictEqual(pdfKey('uploads/report-pdfs/a.pdf'), 'report-pdfs/a.pdf');   // legacy stored path
    assert.strictEqual(pdfKey('report-pdfs\\a.pdf'), 'report-pdfs/a.pdf');
});
