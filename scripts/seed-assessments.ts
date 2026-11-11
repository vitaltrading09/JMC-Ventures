// ─────────────────────────────────────────────────────────────────────────────
// Demo assessments for LOCAL DEVELOPMENT. Never run on a server.
//
// Since the GridIQ assessment model (2026-11-11) a client sees data only
// through a live assessment it holds a grant on. This gives the five demo
// sites (found by their DEMO-* meters) labelled "[DEMO]" assessments that
// cover the scenarios the brief asks for, and grants them to the demo client:
//
//   Headquarters          healthy                       30 days, started 20 d ago
//   Cape Town Factory     low PF, demand over the MDI   14 days, started 5 d ago
//   Sandton Mall          harmonic issue (THD-V > 8 %)  21 days, started 10 d ago
//   Pretoria Data Center  insufficient data (6 h in)     7 days, started 6 h ago
//   Durban                ended (shows expiry)           7 days, ended 2 d ago
//
// Payment is recorded as an exception ("demo data"). Idempotent: a site that
// already has a [DEMO] assessment is left alone. Nothing else is touched.
//
//   ALLOW_DEMO_SEED=true DATABASE_URL=... npx tsx scripts/seed-assessments.ts [--grant email]
// ─────────────────────────────────────────────────────────────────────────────

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

if (process.env.ALLOW_DEMO_SEED !== 'true') {
    console.error('Refusing to seed: set ALLOW_DEMO_SEED=true to create demo data (local dev only).');
    process.exit(1);
}
if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set.');
    process.exit(1);
}

const H = 3_600_000, D = 24 * H;
const SCENARIOS: { match: RegExp; days: number; startedAgoMs: number; note: string }[] = [
    { match: /headquarters/i, days: 30, startedAgoMs: 20 * D, note: 'healthy site' },
    { match: /factory/i, days: 14, startedAgoMs: 5 * D, note: 'low PF and demand above the contracted MDI' },
    { match: /mall/i, days: 21, startedAgoMs: 10 * D, note: 'harmonic issue: THD-V above 8 % while trading' },
    { match: /data cent/i, days: 7, startedAgoMs: 6 * H, note: 'insufficient data: started 6 hours ago' },
    { match: /durban/i, days: 7, startedAgoMs: 9 * D, note: 'ended two days ago: shows expiry and the delivery window' },
];

async function main() {
    const grantArg = process.argv.indexOf('--grant');
    const grantEmail = (grantArg >= 0 ? process.argv[grantArg + 1] : 'demo@grid-iq.co.za').toLowerCase();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const sites = (await pool.query(`
            SELECT DISTINCT p.id, p.name, p.tenant_id, p.timezone
            FROM devices d JOIN deployments dp ON dp.device_id = d.id
            JOIN measurement_points mp ON mp.id = dp.measurement_point_id JOIN projects p ON p.id = mp.project_id
            WHERE d.serial_number LIKE 'DEMO-%'`)).rows;
        if (!sites.length) { console.log('No demo sites (DEMO-* meters) found: run the seed first.'); return; }
        const user = (await pool.query(`SELECT id, tenant_id FROM users WHERE lower(email) = $1`, [grantEmail])).rows[0] ?? null;
        const pkgs = (await pool.query(`SELECT id, duration_days, price_cents FROM assessment_packages`)).rows;
        for (const s of sites) {
            const sc = SCENARIOS.find((x) => x.match.test(s.name));
            if (!sc) { console.log(`- ${s.name}: no scenario, skipped`); continue; }
            const exists = (await pool.query(`SELECT 1 FROM assessments WHERE project_id = $1 AND title LIKE '[DEMO]%'`, [s.id])).rows.length;
            if (exists) { console.log(`- ${s.name}: already has a [DEMO] assessment`); continue; }
            const start = new Date(Date.now() - sc.startedAgoMs);
            const end = new Date(start.getTime() + sc.days * D);
            const ended = end.getTime() <= Date.now();
            const pkg = pkgs.find((p) => p.duration_days === sc.days) ?? null;
            // Retention: 3 calendar months after the end (same rule as the API, end-of-month clamped).
            const ret = new Date(end); const day = ret.getUTCDate(); ret.setUTCDate(1); ret.setUTCMonth(ret.getUTCMonth() + 3);
            ret.setUTCDate(Math.min(day, new Date(Date.UTC(ret.getUTCFullYear(), ret.getUTCMonth() + 1, 0)).getUTCDate()));
            const a = (await pool.query(`
                INSERT INTO assessments (tenant_id, project_id, package_id, title, status, duration_days, start_at, end_at, timezone,
                                         price_cents, payment_state, payment_exception_reason, retention_months, retention_until, internal_notes,
                                         quote, report_status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'exception', 'demo data (local development only)', 3, $11, $12,
                        $13, $14) RETURNING id, reference`,
                [s.tenant_id, s.id, pkg?.id ?? null, `[DEMO] ${s.name}: ${sc.days}-day assessment`, ended ? 'ended' : 'active', sc.days,
                 start, end, s.timezone ?? 'Africa/Johannesburg', pkg ? Number(pkg.price_cents) : null, ret, `Demo scenario: ${sc.note}`,
                 JSON.stringify({ demo: true, duration_days: sc.days, snapshot_at: new Date().toISOString() }),
                 ended ? 'awaiting_review' : 'provisional'])).rows[0];
            await pool.query(`
                INSERT INTO assessment_points (assessment_id, measurement_point_id)
                SELECT DISTINCT $1::uuid, mp.id FROM measurement_points mp JOIN deployments dp ON dp.measurement_point_id = mp.id
                WHERE mp.project_id = $2`, [a.id, s.id]);
            if (user && user.tenant_id === s.tenant_id) {
                await pool.query(`INSERT INTO assessment_grants (assessment_id, user_id, email) VALUES ($1, $2, $3)`, [a.id, user.id, grantEmail]);
            }
            await pool.query(`INSERT INTO audit_log (actor_email, action, entity_type, entity_id, reason) VALUES ('seed', 'assessment.create', 'assessment', $1, 'demo seed')`, [a.id]);
            console.log(`- ${s.name}: ${a.reference} ${ended ? 'ended' : 'live'} (${sc.note})${user && user.tenant_id === s.tenant_id ? `, granted to ${grantEmail}` : ''}`);
        }
    } finally {
        await pool.end();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
