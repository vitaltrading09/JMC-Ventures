// ─────────────────────────────────────────────────────────────────────────────
// Email through a durable outbox (prompt section 15). Callers enqueue with a
// dedupe key; the jobs role sends. A worker restart or a retry never sends the
// same message twice (the key is unique; a row is claimed with SKIP LOCKED).
//
// EMAIL_PROVIDER:
//   smtp   nodemailer with SMTP_URL (smtps://user:pass@host:465) and EMAIL_FROM
//   file   development adapter: writes .eml files to EMAIL_DIR (/data/outbox)
//   unset  not configured: messages fail visibly ("EMAIL_PROVIDER not set")
//
// 'sent' = the provider accepted the message; it is not proof of delivery
// (bounces arrive later and are not tracked yet).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export interface OutgoingEmail {
    dedupeKey: string; to: string; subject: string; text: string; html?: string;
    attachments?: { filename: string; path: string }[]; assessmentId?: string | null; purpose: string;
}

/** Queue a message; returns false when the dedupe key was already queued (no second send). */
export async function enqueueEmail(db: Queryable, m: OutgoingEmail): Promise<boolean> {
    const r = await db.query(`
        INSERT INTO email_outbox (dedupe_key, to_email, subject, body_text, body_html, attachments, assessment_id, purpose)
        VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [m.dedupeKey, m.to, m.subject, m.text, m.html ?? null, JSON.stringify(m.attachments ?? []), m.assessmentId ?? null, m.purpose]);
    return r.rows.length > 0;
}

/** Queue only for a recipient who holds an unrevoked grant on the assessment. */
export async function enqueueForGrantee(db: Queryable, assessmentId: string, m: Omit<OutgoingEmail, 'assessmentId'>): Promise<boolean> {
    const ok = (await db.query(`SELECT 1 FROM assessment_grants WHERE assessment_id = $1 AND email = lower($2) AND revoked_at IS NULL`,
        [assessmentId, m.to])).rows.length > 0;
    if (!ok) return false;
    return enqueueEmail(db, { ...m, assessmentId });
}

type Sender = (m: { to: string; subject: string; text: string; html?: string | null; attachments: { filename: string; path: string }[] }) => Promise<string | null>;

export function emailProvider(): { name: string; send: Sender } | null {
    const p = process.env.EMAIL_PROVIDER;
    const from = process.env.EMAIL_FROM || 'GridIQ <no-reply@localhost>';
    if (p === 'file') {
        const dir = path.resolve(process.env.EMAIL_DIR || '/data/outbox');
        return {
            name: 'file',
            send: async (m) => {
                fs.mkdirSync(dir, { recursive: true });
                const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const eml = [`From: ${from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${new Date().toUTCString()}`,
                    'Content-Type: text/plain; charset=utf-8', '', m.text,
                    ...(m.attachments.length ? ['', `[attachments: ${m.attachments.map((a) => a.filename).join(', ')}]`] : [])].join('\r\n');
                fs.writeFileSync(path.join(dir, `${id}.eml`), eml);
                return `file:${id}`;
            },
        };
    }
    if (p === 'smtp') {
        if (!process.env.SMTP_URL) return null;
        // Loaded only when configured.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport(process.env.SMTP_URL);
        return {
            name: 'smtp',
            send: async (m) => {
                const info = await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html ?? undefined, attachments: m.attachments });
                return info?.messageId ?? null;
            },
        };
    }
    return null;
}

const BACKOFF_MIN = [1, 5, 30, 120, 360];

/** Jobs role, every minute: send what is due. Returns the number handled. */
export async function sendDueEmails(pool: Pool, max = 50): Promise<number> {
    // A sender that died mid-send leaves 'sending': retry after 10 minutes.
    await pool.query(`UPDATE email_outbox SET status = 'queued' WHERE status = 'sending' AND next_attempt_at < NOW() - INTERVAL '10 minutes'`);
    const provider = emailProvider();
    let n = 0;
    for (; n < max; n++) {
        const m = (await pool.query(`
            UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = NOW()
            WHERE id = (SELECT id FROM email_outbox WHERE status = 'queued' AND next_attempt_at <= NOW()
                        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *`)).rows[0];
        if (!m) break;
        if (!provider) {
            await pool.query(`UPDATE email_outbox SET status = 'failed', last_error = $2 WHERE id = $1`,
                [m.id, process.env.EMAIL_PROVIDER === 'smtp' ? 'EMAIL_PROVIDER=smtp but SMTP_URL is not set' : 'EMAIL_PROVIDER not set: email is not configured']);
            continue;
        }
        try {
            const attachments = (m.attachments ?? []).filter((a: any) => a?.path && fs.existsSync(a.path));
            const id = await provider.send({ to: m.to_email, subject: m.subject, text: m.body_text, html: m.body_html, attachments });
            await pool.query(`UPDATE email_outbox SET status = 'sent', sent_at = NOW(), provider = $2, provider_message_id = $3, last_error = NULL WHERE id = $1`,
                [m.id, provider.name, id]);
        } catch (e: any) {
            const giveUp = m.attempts >= BACKOFF_MIN.length + 1;
            await pool.query(`UPDATE email_outbox SET status = $2, last_error = $3, next_attempt_at = NOW() + make_interval(mins => $4) WHERE id = $1`,
                [m.id, giveUp ? 'failed' : 'queued', String(e?.message ?? e).slice(0, 500), BACKOFF_MIN[Math.min(m.attempts - 1, BACKOFF_MIN.length - 1)]]);
        }
    }
    return n;
}

export const appUrl = () => (process.env.FRONTEND_URL || 'https://localhost').replace(/\/$/, '');
