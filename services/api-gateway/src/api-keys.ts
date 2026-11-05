// ─────────────────────────────────────────────────────────────────────────────
// API-key authentication at the gateway (plan Phase 9, item 2).
//
// A request with `Authorization: Bearer gq_live_…`:
//   1. is verified against the auth service (POST /internal/keys/verify),
//      cached for 60 s (failures for 10 s);
//   2. is rate-limited per key (API_KEY_RATE_PER_MIN, default 120);
//   3. continues with the key replaced by a short-lived JWT the services
//      already understand: role client_viewer, the key's tenant, plus
//      `apiKey: { id, scopes, projectIds }` so they can limit it further.
// Keys work on the public API (/v1) only; anywhere else they are refused.
// ─────────────────────────────────────────────────────────────────────────────

import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';

export interface VerifiedKey { key_id: string; prefix: string; tenant_id: string; scopes: string[]; project_ids: string[] | null }

const KEY_RE = /^gq_live_[a-z0-9]{10}_[A-Za-z0-9_-]{40,}$/;

/** The API key in an Authorization header, or null when it carries something else. */
export function bearerKey(header: unknown): string | null {
    const h = String(header ?? '');
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m && KEY_RE.test(m[1]) ? m[1] : null;
}

/** Cache of verify results by key hash (the key itself is never held). */
export class KeyCache {
    private entries = new Map<string, { until: number; value: VerifiedKey | null }>();
    constructor(private readonly now: () => number = Date.now, private readonly okMs = 60_000, private readonly failMs = 10_000) {}
    get(hash: string): VerifiedKey | null | undefined {
        const e = this.entries.get(hash);
        if (!e) return undefined;
        if (e.until < this.now()) { this.entries.delete(hash); return undefined; }
        return e.value;
    }
    set(hash: string, value: VerifiedKey | null) {
        if (this.entries.size > 10_000) this.entries.clear(); // bound memory
        this.entries.set(hash, { until: this.now() + (value ? this.okMs : this.failMs), value });
    }
}

/** The downstream token for a verified key: 5 minutes, client_viewer of its tenant. */
export function tokenFor(k: VerifiedKey, secret: string): string {
    return jwt.sign({
        userId: null,
        role: 'client_viewer',
        tenantId: k.tenant_id,
        apiKey: { id: k.key_id, prefix: k.prefix, scopes: k.scopes, projectIds: k.project_ids },
    }, secret, { expiresIn: 300 });
}

type Verify = (key: string) => Promise<VerifiedKey | null>;

export function verifyWithAuthService(authUrl: string): Verify {
    return async (key) => {
        const r = await fetch(`${authUrl}/internal/keys/verify`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
        });
        if (r.status === 401) return null;
        if (!r.ok) throw new Error(`key verify failed: ${r.status}`);
        return (await r.json()) as VerifiedKey;
    };
}

/**
 * Express middleware. `isApiPath` says where keys are accepted. Sets
 * req.apiKeyId (for the per-key rate limiter) and rewrites Authorization.
 */
export function apiKeyAuth(opts: { secret: string; verify: Verify; cache?: KeyCache; isApiPath: (path: string) => boolean }) {
    const cache = opts.cache ?? new KeyCache();
    return async (req: any, res: any, next: any) => {
        const key = bearerKey(req.headers.authorization);
        if (!key) return next();
        if (!opts.isApiPath(req.path)) return res.status(401).json({ error: 'API keys are accepted on /api/v1 only' });
        const hash = createHash('sha256').update(key).digest('hex');
        let k = cache.get(hash);
        if (k === undefined) {
            try {
                k = await opts.verify(key);
            } catch (e) {
                console.error('[gateway] API key check failed:', (e as Error).message);
                return res.status(503).json({ error: 'Could not check the API key; try again' });
            }
            cache.set(hash, k);
        }
        if (!k) return res.status(401).json({ error: 'Invalid or revoked API key' });
        req.apiKeyId = k.key_id;
        req.headers.authorization = `Bearer ${tokenFor(k, opts.secret)}`;
        // The cookie (if any) must not override the key's narrower token.
        delete req.headers.cookie;
        next();
    };
}
