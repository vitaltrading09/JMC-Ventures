// ─────────────────────────────────────────────────────────────────────────────
// Passwordless sign-in and staff MFA (GridIQ prompt section 13).
//
//   POST /login/code/request { email }          always 202, same answer whether
//                                               or not the address is known
//   POST /login/code/verify  { email, code }    single-use, 10 minutes, 5 tries
//   POST /login/mfa          { mfa_token, code } second step for staff with MFA
//   POST /mfa/setup | /mfa/enable { code }      staff enrol a TOTP authenticator
//
// Who may receive a code: an existing user, or an address named on an
// unrevoked assessment grant (the user is created on first sign-in, as a
// client_viewer of that assessment's client). Signing in grants nothing by
// itself: access to data still follows a live assessment grant on every
// request. Codes are emailed through the shared outbox (the ingestion jobs
// role sends them); only an HMAC of a code is stored and no code is logged.
//
// Limits: one code per address per 60 s, 5 per hour; 20 requests per IP per
// hour; 5 wrong attempts burn the code.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import jwt from 'jsonwebtoken';

export const CODE_TTL_MIN = 10;
export const MAX_ATTEMPTS = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hmac = (secret: string, v: string) => crypto.createHmac('sha256', secret).update(v).digest('hex');
export const codeHash = (secret: string, email: string, code: string) => hmac(secret, `login:${email}:${code}`);

// ── TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ──────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
    let bits = 0, value = 0, out = '';
    for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
export function base32Decode(s: string): Buffer {
    let bits = 0, value = 0;
    const out: number[] = [];
    for (const ch of s.replace(/=+$/, '').toUpperCase()) {
        const i = B32.indexOf(ch);
        if (i < 0) continue;
        value = (value << 5) | i; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}
export function totp(secretB32: string, at = Date.now(), step = 30): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
    const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
    const o = h[h.length - 1] & 0xf;
    const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 1_000_000).padStart(6, '0');
}
export function totpValid(secretB32: string, code: string, at = Date.now()): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    return [-1, 0, 1].some((w) => crypto.timingSafeEqual(Buffer.from(totp(secretB32, at + w * 30_000)), Buffer.from(code)));
}

// MFA secrets are encrypted at rest (AES-256-GCM, key derived from JWT_SECRET).
const mfaKey = (secret: string) => crypto.createHash('sha256').update(`gridiq-mfa:${secret}`).digest();
export function sealSecret(secret: string, plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', mfaKey(secret), iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function openSecret(secret: string, sealed: string): string {
    const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', mfaKey(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const ipHits = new Map<string, number[]>();
function ipLimited(ip: string, max = 20): boolean {
    const now = Date.now();
    const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    hits.push(now);
    ipHits.set(ip, hits);
    return hits.length > max;
}

export function loginRouter(pool: Pool, secret: string, issueSession: (res: any, user: any) => void): Router {
    const r = Router();
    const ipOf = (req: any) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const appUrl = (process.env.FRONTEND_URL || 'https://localhost').replace(/\/$/, '');
    const GENERIC = { sent: true, message: `If this address may sign in, a code is on its way. It is valid for ${CODE_TTL_MIN} minutes.` };

    r.post('/login/code/request', async (req, res) => {
        try {
            const email = String(req.body?.email ?? '').trim().toLowerCase();
            if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter an email address' });
            if (ipLimited(ipOf(req))) return res.status(429).json({ error: 'Too many requests; try again later' });
            const recent = (await pool.query(`SELECT count(*) FILTER (WHERE created_at > NOW() - INTERVAL '60 seconds')::int AS m,
                                                     count(*)::int AS h
                                              FROM login_codes WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [email])).rows[0];
            // Throttled requests get the same answer: nothing reveals whether the address exists.
            if (recent.m > 0 || recent.h >= 5) return res.status(202).json(GENERIC);
            const eligible = (await pool.query(`
                SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1)
                    OR EXISTS (SELECT 1 FROM assessment_grants g JOIN assessments a ON a.id = g.assessment_id
                               WHERE g.email = $1 AND g.revoked_at IS NULL AND a.status <> 'cancelled') AS ok`, [email])).rows[0].ok;
            if (!eligible) return res.status(202).json(GENERIC);
            const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
            const row = (await pool.query(`INSERT INTO login_codes (email, code_hash, expires_at, ip) VALUES ($1, $2, NOW() + make_interval(mins => $3), $4) RETURNING id`,
                [email, codeHash(secret, email, code), CODE_TTL_MIN, ipOf(req)])).rows[0];
            await pool.query(`
                INSERT INTO email_outbox (dedupe_key, to_email, subject, body_text, purpose)
                VALUES ($1, $2, $3, $4, 'login_code') ON CONFLICT (dedupe_key) DO NOTHING`,
                [`login:${row.id}`, email, `Your GridIQ sign-in code: ${code}`,
                 `Your GridIQ sign-in code is ${code}.\nIt works once, for ${CODE_TTL_MIN} minutes.\n\nIf you did not ask for it, ignore this message.\n${appUrl}/login`]);
            res.status(202).json(GENERIC);
        } catch (e) {
            console.error('[login] code request failed:', (e as Error).message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    r.post('/login/code/verify', async (req, res) => {
        const fail = () => res.status(401).json({ error: 'That code is not valid. Request a new one.' });
        try {
            const email = String(req.body?.email ?? '').trim().toLowerCase();
            const code = String(req.body?.code ?? '').trim();
            if (!EMAIL.test(email) || !/^\d{6}$/.test(code)) return fail();
            if (ipLimited(`v:${ipOf(req)}`, 60)) return res.status(429).json({ error: 'Too many attempts; try again later' });
            const c = (await pool.query(`
                UPDATE login_codes SET attempts = attempts + 1
                WHERE id = (SELECT id FROM login_codes WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
                            ORDER BY created_at DESC LIMIT 1)
                RETURNING id, code_hash, attempts`, [email])).rows[0];
            if (!c) return fail();
            if (c.attempts > MAX_ATTEMPTS) { await pool.query(`UPDATE login_codes SET used_at = NOW() WHERE id = $1`, [c.id]); return fail(); }
            const ok = crypto.timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(codeHash(secret, email, code)));
            if (!ok) return fail();
            // Single use: only the first verify of a code wins.
            const used = await pool.query(`UPDATE login_codes SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id`, [c.id]);
            if (!used.rows.length) return fail();
            let user = (await pool.query(`SELECT * FROM users WHERE lower(email) = $1`, [email])).rows[0];
            if (!user) {
                // First sign-in of an invited recipient: a client_viewer of the grant's client.
                const g = (await pool.query(`
                    SELECT a.tenant_id FROM assessment_grants g JOIN assessments a ON a.id = g.assessment_id
                    WHERE g.email = $1 AND g.revoked_at IS NULL AND a.status <> 'cancelled' ORDER BY g.created_at DESC LIMIT 1`, [email])).rows[0];
                if (!g) return fail();
                user = (await pool.query(`INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, '!passwordless', 'client_viewer') RETURNING *`,
                    [g.tenant_id, email])).rows[0];
            }
            await pool.query(`UPDATE assessment_grants SET user_id = $1 WHERE email = $2 AND user_id IS NULL
                              AND assessment_id IN (SELECT id FROM assessments WHERE tenant_id = $3)`, [user.id, email, user.tenant_id]);
            if (needsMfa(user)) return res.json(mfaChallenge(secret, user));
            issueSession(res, user);
        } catch (e) {
            console.error('[login] code verify failed:', (e as Error).message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    r.post('/login/mfa', async (req, res) => {
        try {
            const t: any = jwt.verify(String(req.body?.mfa_token ?? ''), mfaSecret(secret));
            if (t.purpose !== 'mfa') throw new Error('wrong token');
            const user = (await pool.query(`SELECT * FROM users WHERE id = $1`, [t.userId])).rows[0];
            if (!user?.mfa_secret_enc || !totpValid(openSecret(secret, user.mfa_secret_enc), String(req.body?.code ?? ''))) {
                return res.status(401).json({ error: 'That authenticator code is not valid' });
            }
            issueSession(res, user);
        } catch { res.status(401).json({ error: 'Sign in again' }); }
    });

    // Enrolment (a signed-in staff user).
    const signedIn = (req: any): any => {
        const m = (req.headers.cookie || '').match(/(?:^|;\s*)token=([^;]+)/);
        const token = (m ? m[1] : null) || (req.headers.authorization ? String(req.headers.authorization).split(' ')[1] : null);
        try { return token ? jwt.verify(token, secret) : null; } catch { return null; }
    };
    r.post('/mfa/setup', async (req, res) => {
        const u = signedIn(req);
        if (!u?.userId) return res.status(401).json({ error: 'Unauthorized' });
        const s = base32Encode(crypto.randomBytes(20));
        await pool.query(`UPDATE users SET mfa_secret_enc = $2, mfa_enabled_at = NULL WHERE id = $1`, [u.userId, sealSecret(secret, s)]);
        res.json({ secret: s, otpauth_url: `otpauth://totp/GridIQ:${encodeURIComponent(u.email ?? 'user')}?secret=${s}&issuer=GridIQ` });
    });
    r.post('/mfa/enable', async (req, res) => {
        const u = signedIn(req);
        if (!u?.userId) return res.status(401).json({ error: 'Unauthorized' });
        const row = (await pool.query(`SELECT mfa_secret_enc FROM users WHERE id = $1`, [u.userId])).rows[0];
        if (!row?.mfa_secret_enc || !totpValid(openSecret(secret, row.mfa_secret_enc), String(req.body?.code ?? ''))) {
            return res.status(400).json({ error: 'That code does not match: check the authenticator app and try again' });
        }
        await pool.query(`UPDATE users SET mfa_enabled_at = NOW() WHERE id = $1`, [u.userId]);
        res.json({ enabled: true });
    });
    return r;
}

/** A separate key, so an MFA step token can never pass as a session. */
const mfaSecret = (secret: string) => hmac(secret, 'gridiq-mfa-step');

/** Staff with MFA set up must pass it; STAFF_MFA_REQUIRED=true makes it mandatory for staff. */
export function needsMfa(user: any): boolean {
    const staff = user.role === 'super_admin' || user.role === 'engineer';
    return staff && (!!user.mfa_enabled_at || process.env.STAFF_MFA_REQUIRED === 'true');
}

/** The second-step answer: a 5-minute token that only /login/mfa accepts. */
export function mfaChallenge(secret: string, user: any) {
    if (!user.mfa_enabled_at) {
        return { mfa_required: true, mfa_setup_required: true, error: 'Staff accounts need an authenticator app: ask an administrator to enrol you' };
    }
    return { mfa_required: true, mfa_token: jwt.sign({ userId: user.id, purpose: 'mfa' }, mfaSecret(secret), { expiresIn: '5m' }) };
}
