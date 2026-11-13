// ─────────────────────────────────────────────────────────────────────────────
// File storage for deliverables: report PDFs, data packages and API exports.
//
//   FILE_STORE=local (default)  UPLOAD_DIR / EXPORT_DIR on the server's disk
//   FILE_STORE=r2               a Cloudflare R2 bucket (S3-compatible):
//                               R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com),
//                               R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//
// Files are addressed by (area, key): area 'uploads' for report PDFs
// (key 'report-pdfs/<id>.pdf', as stored in reports.pdf_path) and 'exports' for
// packages ('packages/<assessment>/r<n>/<file>') and API exports ('<id>.csv.gz').
// In R2 the object key is '<area>/<key>'. Objects are private: they are only
// ever streamed through the API, after its access checks; no public URLs.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { uploadDir } from './roles';

export type Area = 'uploads' | 'exports';

export interface FileStore {
    name: 'local' | 'r2';
    put(area: Area, key: string, body: Buffer, contentType?: string): Promise<void>;
    /** Upload a local file, then remove the local copy when the store is remote. */
    putFile(area: Area, key: string, file: string, contentType?: string): Promise<void>;
    read(area: Area, key: string): Promise<Buffer | null>;
    stream(area: Area, key: string): Promise<Readable | null>;
    remove(area: Area, key: string): Promise<boolean>;
    /** Removes every object under a prefix ('packages/<id>/'); returns how many. */
    removePrefix(area: Area, prefix: string): Promise<number>;
}

const exportRoot = () => path.resolve(process.env.EXPORT_DIR || '/data/exports');
const rootOf = (area: Area) => (area === 'uploads' ? uploadDir() : exportRoot());

/** A key must stay inside its area: no absolute paths, no '..'. */
export function safeKey(key: string): string {
    const k = key.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!k || k.split('/').some((s) => s === '..' || s === '') ) throw new Error(`unsafe storage key: ${key}`);
    return k;
}

export function localStore(): FileStore {
    const file = (area: Area, key: string) => path.join(rootOf(area), ...safeKey(key).split('/'));
    return {
        name: 'local',
        async put(area, key, body) {
            const f = file(area, key);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, body);
        },
        async putFile(area, key, src) {
            const f = file(area, key);
            if (path.resolve(src) === path.resolve(f)) return;
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.copyFileSync(src, f);
        },
        async read(area, key) {
            const f = file(area, key);
            return fs.existsSync(f) ? fs.readFileSync(f) : null;
        },
        async stream(area, key) {
            const f = file(area, key);
            return fs.existsSync(f) ? fs.createReadStream(f) : null;
        },
        async remove(area, key) {
            const f = file(area, key);
            if (!fs.existsSync(f)) return false;
            fs.rmSync(f, { force: true });
            return true;
        },
        async removePrefix(area, prefix) {
            const d = file(area, prefix.replace(/\/+$/, ''));
            if (!fs.existsSync(d)) return 0;
            let n = 0;
            const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name)) : n++; };
            walk(d);
            fs.rmSync(d, { recursive: true, force: true });
            return n;
        },
    };
}

/** Minimal client surface used here (the AWS SDK v3 S3Client, or a test double). */
export interface S3Like { send(command: any): Promise<any> }

export function r2Store(client: S3Like, bucket: string, cmd = require('@aws-sdk/client-s3')): FileStore {
    const objectKey = (area: Area, key: string) => `${area}/${safeKey(key)}`;
    const missing = (e: any) => e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404 || e?.Code === 'NoSuchKey';
    return {
        name: 'r2',
        async put(area, key, body, contentType) {
            await client.send(new cmd.PutObjectCommand({ Bucket: bucket, Key: objectKey(area, key), Body: body, ContentType: contentType }));
        },
        async putFile(area, key, file, contentType) {
            await this.put(area, key, fs.readFileSync(file), contentType);
            fs.rmSync(file, { force: true });
        },
        async read(area, key) {
            const s = await this.stream(area, key);
            if (!s) return null;
            const chunks: Buffer[] = [];
            for await (const c of s) chunks.push(Buffer.from(c));
            return Buffer.concat(chunks);
        },
        async stream(area, key) {
            try {
                const r = await client.send(new cmd.GetObjectCommand({ Bucket: bucket, Key: objectKey(area, key) }));
                const b = r.Body;
                return b instanceof Readable ? b : Readable.from(b as any);
            } catch (e) { if (missing(e)) return null; throw e; }
        },
        async remove(area, key) {
            await client.send(new cmd.DeleteObjectCommand({ Bucket: bucket, Key: objectKey(area, key) }));
            return true;
        },
        async removePrefix(area, prefix) {
            let n = 0, token: string | undefined;
            do {
                const r = await client.send(new cmd.ListObjectsV2Command({ Bucket: bucket, Prefix: `${objectKey(area, prefix.replace(/\/+$/, ''))}/`, ContinuationToken: token }));
                const keys = (r.Contents ?? []).map((o: any) => ({ Key: o.Key }));
                if (keys.length) {
                    await client.send(new cmd.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
                    n += keys.length;
                }
                token = r.IsTruncated ? r.NextContinuationToken : undefined;
            } while (token);
            return n;
        },
    };
}

let cached: FileStore | null = null;
/** The configured store (FILE_STORE). Fails clearly when R2 is chosen but not configured. */
export function store(): FileStore {
    if (cached) return cached;
    if ((process.env.FILE_STORE ?? 'local') === 'r2') {
        const need = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !process.env[k]);
        if (need.length) throw new Error(`FILE_STORE=r2 but ${need.join(', ')} not set`);
        const { S3Client } = require('@aws-sdk/client-s3');
        const client = new S3Client({
            region: 'auto', endpoint: process.env.R2_ENDPOINT,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
        });
        cached = r2Store(client, process.env.R2_BUCKET!);
    } else cached = localStore();
    return cached;
}
/** For tests. */
export function setStore(s: FileStore | null) { cached = s; }

/** Area and key of a stored report PDF path (relative 'report-pdfs/…', or a legacy 'uploads/…'). */
export const pdfKey = (stored: string) => safeKey(stored.replace(/\\/g, '/').replace(/^\.?\/*uploads\//, ''));
