import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Pre-renewal review.
//
// Insurance renews on a known date, which is the one moment a broker's client is
// guaranteed to be paying attention. Arriving 60 days beforehand with "here is
// what changed over the policy year" turns the platform from something the
// broker remembers to check into something that shows up on its own.
//
// Everything here is a comparison of assessment SNAPSHOTS already stored in
// pq_assessments. Nothing is recomputed from raw telemetry, so a review reflects
// exactly what was reported at the time — which is what makes a year-on-year
// claim defensible rather than a re-interpretation after the fact.
// ─────────────────────────────────────────────────────────────────────────────

/** Days before renewal at which a review is produced. */
export const RENEWAL_MILESTONES = [60, 30, 7];

export interface MeterComparison {
    meter_id:      string;
    meter_name:    string;
    site_name:     string;
    now_verdict:   string | null;
    then_verdict:  string | null;
    now_supply:    number | null;
    then_supply:   number | null;
    now_install:   number | null;
    then_install:  number | null;
    now_findings:  number;
    then_findings: number;
    closed:        string[];   // finding titles present a year ago, absent now
    opened:        string[];   // findings that appeared during the policy year
}

export interface RenewalReview {
    tenant_id:        string;
    client_name:      string;
    renewal_date:     string;
    policy_year_from: string;
    policy_year_to:   string;
    meters:           MeterComparison[];
    total_now_findings:  number;
    total_then_findings: number;
    total_closed:     number;
    total_opened:     number;
    install_delta:    number | null;   // weakest install score, now minus then
    has_baseline:     boolean;
    headline:         string;
}

/** Titles of the findings in a snapshot's `risks` JSON. */
function riskTitles(risks: any): string[] {
    if (!Array.isArray(risks)) return [];
    return risks.map(r => String(r?.title ?? '')).filter(Boolean);
}

export async function buildRenewalReview(
    pool:        Pool,
    tenantId:    string,
    renewalDate: string,
): Promise<RenewalReview | null> {
    const client = await pool.connect();
    try {
        const meta = await client.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
        if (meta.rows.length === 0) return null;

        // The policy year running up to this renewal.
        const to = new Date(renewalDate);
        const from = new Date(to);
        from.setFullYear(from.getFullYear() - 1);

        // For each meter: the latest snapshot, and the one closest to the START
        // of the policy year. DISTINCT ON with an ordering by absolute distance
        // picks the nearest available snapshot rather than requiring an exact
        // date, since assessments are not taken on a fixed calendar.
        const rows = await client.query(`
            WITH mine AS (
                SELECT m.id AS meter_id, m.name AS meter_name, s.name AS site_name
                FROM meters m
                JOIN sites s ON m.site_id = s.id
                WHERE s.tenant_id = $1 AND m.is_active
            ), current AS (
                SELECT DISTINCT ON (a.meter_id)
                       a.meter_id, a.verdict, a.supply_score, a.install_score, a.risks, a.assessed_at
                FROM pq_assessments a
                JOIN mine ON mine.meter_id = a.meter_id
                WHERE a.assessed_at <= $3::date + INTERVAL '1 day'
                ORDER BY a.meter_id, a.assessed_at DESC
            ), baseline AS (
                SELECT DISTINCT ON (a.meter_id)
                       a.meter_id, a.verdict, a.supply_score, a.install_score, a.risks, a.assessed_at
                FROM pq_assessments a
                JOIN mine ON mine.meter_id = a.meter_id
                -- Nearest snapshot to the start of the policy year, within 90 days
                -- either side; beyond that it is not a fair comparison point.
                WHERE a.assessed_at BETWEEN $2::date - INTERVAL '90 days'
                                        AND $2::date + INTERVAL '90 days'
                ORDER BY a.meter_id, ABS(EXTRACT(EPOCH FROM (a.assessed_at - $2::date)))
            )
            SELECT mine.meter_id, mine.meter_name, mine.site_name,
                   c.verdict AS now_verdict, c.supply_score AS now_supply,
                   c.install_score AS now_install, c.risks AS now_risks,
                   b.verdict AS then_verdict, b.supply_score AS then_supply,
                   b.install_score AS then_install, b.risks AS then_risks
            FROM mine
            LEFT JOIN current  c ON c.meter_id = mine.meter_id
            LEFT JOIN baseline b ON b.meter_id = mine.meter_id
            ORDER BY mine.site_name, mine.meter_name
        `, [tenantId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);

        const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

        const meters: MeterComparison[] = rows.rows.map((r: any) => {
            const nowTitles  = riskTitles(r.now_risks);
            const thenTitles = riskTitles(r.then_risks);
            return {
                meter_id: r.meter_id,
                meter_name: r.meter_name,
                site_name: r.site_name,
                now_verdict:  r.now_verdict  ?? null,
                then_verdict: r.then_verdict ?? null,
                now_supply:   num(r.now_supply),
                then_supply:  num(r.then_supply),
                now_install:  num(r.now_install),
                then_install: num(r.then_install),
                now_findings:  nowTitles.length,
                then_findings: thenTitles.length,
                closed: thenTitles.filter(t => !nowTitles.includes(t)),
                opened: nowTitles.filter(t => !thenTitles.includes(t)),
            };
        });

        const totalNow    = meters.reduce((a, m) => a + m.now_findings, 0);
        const totalThen   = meters.reduce((a, m) => a + m.then_findings, 0);
        const totalClosed = meters.reduce((a, m) => a + m.closed.length, 0);
        const totalOpened = meters.reduce((a, m) => a + m.opened.length, 0);

        // A baseline only counts if at least one meter actually had a snapshot
        // near the start of the year. Without it there is nothing to compare and
        // the review must say so rather than imply a year of history.
        const hasBaseline = meters.some(m => m.then_install !== null);

        const installsNow  = meters.map(m => m.now_install).filter((v): v is number => v !== null);
        const installsThen = meters.map(m => m.then_install).filter((v): v is number => v !== null);
        const weakestNow  = installsNow.length  ? Math.min(...installsNow)  : null;
        const weakestThen = installsThen.length ? Math.min(...installsThen) : null;
        const installDelta = weakestNow !== null && weakestThen !== null
            ? weakestNow - weakestThen : null;

        let headline: string;
        if (!hasBaseline) {
            headline = `This is the first policy year on continuous monitoring, so there is no prior assessment to `
                + `compare against. ${totalNow === 0 ? 'No open findings at renewal.' : `${totalNow} open finding${totalNow === 1 ? '' : 's'} at renewal.`} `
                + `Next renewal will carry a full year-on-year comparison.`;
        } else if (totalClosed > 0 && totalOpened === 0) {
            headline = `${totalClosed} finding${totalClosed === 1 ? '' : 's'} closed over the policy year and none opened`
                + (installDelta !== null && installDelta > 0 ? `; installation health improved by ${installDelta} points.` : '.');
        } else if (totalOpened > 0 && totalClosed === 0) {
            headline = `${totalOpened} new finding${totalOpened === 1 ? '' : 's'} appeared during the policy year`
                + (installDelta !== null && installDelta < 0 ? `; installation health fell by ${Math.abs(installDelta)} points.` : '.');
        } else if (totalOpened > 0 || totalClosed > 0) {
            headline = `${totalClosed} finding${totalClosed === 1 ? '' : 's'} closed and ${totalOpened} opened during the policy year`
                + (installDelta !== null
                    ? `; installation health ${installDelta === 0 ? 'is unchanged' : installDelta > 0 ? `improved by ${installDelta} points` : `fell by ${Math.abs(installDelta)} points`}.`
                    : '.');
        } else {
            headline = `No change in open findings over the policy year`
                + (totalNow === 0 ? ' — nothing outstanding at renewal.' : `; ${totalNow} remain${totalNow === 1 ? 's' : ''} outstanding.`);
        }

        return {
            tenant_id: tenantId,
            client_name: meta.rows[0].name,
            renewal_date: renewalDate,
            policy_year_from: from.toISOString().slice(0, 10),
            policy_year_to:   to.toISOString().slice(0, 10),
            meters,
            total_now_findings:  totalNow,
            total_then_findings: totalThen,
            total_closed: totalClosed,
            total_opened: totalOpened,
            install_delta: installDelta,
            has_baseline: hasBaseline,
            headline,
        };
    } finally {
        client.release();
    }
}

/**
 * Daily sweep. For every client with a renewal date, produce any milestone
 * review that is due and not yet on record.
 *
 * Milestones are checked with `days <= milestone` rather than `days ===`, so a
 * server that was down on the exact day still catches up rather than skipping
 * the client's renewal entirely. ON CONFLICT makes re-running harmless.
 */
export async function runRenewalSweep(pool: Pool): Promise<number> {
    const client = await pool.connect();
    let generated = 0;
    try {
        const due = await client.query(`
            SELECT id, name, renewal_date,
                   (renewal_date - CURRENT_DATE) AS days_out
            FROM tenants
            WHERE renewal_date IS NOT NULL
              AND renewal_date >= CURRENT_DATE
              AND renewal_date <= CURRENT_DATE + $1::int
        `, [Math.max(...RENEWAL_MILESTONES)]);

        for (const t of due.rows) {
            const daysOut = Number(t.days_out);
            for (const milestone of RENEWAL_MILESTONES) {
                if (daysOut > milestone) continue;

                const exists = await client.query(
                    `SELECT 1 FROM renewal_reviews
                     WHERE tenant_id = $1 AND renewal_date = $2 AND days_before = $3`,
                    [t.id, t.renewal_date, milestone]
                );
                if (exists.rows.length > 0) continue;

                const review = await buildRenewalReview(
                    pool, t.id, new Date(t.renewal_date).toISOString().slice(0, 10)
                );
                if (!review) continue;

                await client.query(`
                    INSERT INTO renewal_reviews (tenant_id, renewal_date, days_before, summary)
                    VALUES ($1, $2, $3, $4::jsonb)
                    ON CONFLICT (tenant_id, renewal_date, days_before) DO NOTHING
                `, [t.id, t.renewal_date, milestone, JSON.stringify(review)]);

                generated++;
                console.log(`[renewal] ${t.name}: ${milestone}-day review generated (renews ${t.renewal_date})`);
            }
        }
    } catch (e: any) {
        console.error('[renewal] sweep failed:', e.message || e);
    } finally {
        client.release();
    }
    return generated;
}
