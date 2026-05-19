import Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';
import { EnergyScoreResult } from './energy-score';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface Recommendation {
    type:                               string;
    priority:                           number;
    title:                              string;
    problem:                            string;
    solution:                           string;
    estimated_monthly_saving_zar:       number;
    estimated_implementation_cost_zar:  number;
    payback_months:                     number;
    confidence:                         'HIGH' | 'MEDIUM' | 'LOW';
    standard_reference?:                string;
}

// Valid recommendation types
const VALID_TYPES = new Set([
    'POWER_FACTOR_CORRECTION',
    'HARMONIC_FILTER',
    'PV_INSTALL',
    'LIGHTING_UPGRADE',
    'LOAD_SHIFTING',
    'VOLTAGE_REGULATION',
    'DEMAND_MANAGEMENT',
    'ENERGY_AUDIT',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Generate and store AI recommendations for a site
// Called manually (via API endpoint) or automatically after score calculation.
// Uses Claude to analyse real meter data and produce ranked, ROI-backed findings.
// ─────────────────────────────────────────────────────────────────────────────
export async function generateAndStoreSiteRecommendations(
    pool:        Pool,
    siteId:      string,
    tenantId:    string,
    score:       EnergyScoreResult,
    siteName:    string,
    siteAddress: string,
): Promise<Recommendation[]> {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.warn('[AI] ANTHROPIC_API_KEY not set — skipping recommendation generation');
        return [];
    }

    // ── Fetch supporting data ──────────────────────────────────────────────
    const client = await pool.connect();
    let tariffContext = 'No tariff data configured.';
    let activeAlerts: { type: string; message: string }[] = [];
    let loadProfile  = 'No load profile declared by site owner.';
    let declaredSiteType: string | null = null;
    try {
        const settingsRes = await client.query(
            `SELECT tariff_peak, tariff_standard, tariff_offpeak, peak_times, offpeak_times
             FROM site_settings WHERE site_id = $1`,
            [siteId]
        );
        const s = settingsRes.rows[0];
        if (s?.tariff_peak) {
            tariffContext =
                `Peak R${s.tariff_peak}/kWh (${s.peak_times || 'times not set'}), ` +
                `Standard R${s.tariff_standard}/kWh, ` +
                `Off-peak R${s.tariff_offpeak}/kWh (${s.offpeak_times || 'times not set'})`;
        }

        const alertRes = await client.query(
            `SELECT type, message FROM alerts
             WHERE tenant_id = $1
               AND created_at >= NOW() - INTERVAL '7 days'
               AND is_read = false
             ORDER BY created_at DESC LIMIT 5`,
            [tenantId]
        );
        activeAlerts = alertRes.rows;

        // Load profile — what each active meter on this site actually measures.
        // This stops Claude from inventing/guessing about motors, VFDs, lighting type, etc.
        const profileRes = await client.query(
            `SELECT name, load_types, load_description, site_type
             FROM meters
             WHERE site_id = $1 AND is_active = true
             ORDER BY name ASC`,
            [siteId]
        );
        if (profileRes.rows.length > 0) {
            const declaredTypes = profileRes.rows
                .map(m => m.site_type)
                .filter(Boolean);
            declaredSiteType = declaredTypes[0] || null;

            const lines = profileRes.rows.map(m => {
                const types = (m.load_types && m.load_types.length > 0)
                    ? m.load_types.join(', ')
                    : 'not specified';
                const desc = m.load_description ? ` (notes: ${m.load_description})` : '';
                return `  • ${m.name}: ${types}${desc}`;
            });
            loadProfile = lines.join('\n');
        }
    } finally {
        client.release();
    }

    // ── Build Claude prompt ────────────────────────────────────────────────
    const { metrics, components, tariffType, score: totalScore } = score;
    const lf = metrics.loadFactor !== null ? metrics.loadFactor.toFixed(2) : 'N/A';

    const prompt = `You are PowerGuard's energy analysis engine for South African industrial and commercial sites.
Analyse the data below and return ONLY a valid JSON array — no prose, no markdown fences, just raw JSON.

SITE: ${siteName} | ${siteAddress}
SITE TYPE: ${declaredSiteType || 'Not declared'}
TARIFF TYPE: ${tariffType} (SA context: Megaflex = large demand tariff, TOU = time-of-use, FLAT = single rate)

DECLARED LOADS PER METER (this is what's physically connected — do NOT invent loads that aren't listed):
${loadProfile}

ENERGY SCORE: ${totalScore}/100
  Power Factor component:    ${components.pf}/100
  Load Factor component:     ${components.loadFactor}/100
  Voltage Quality component: ${components.voltageQuality}/100
  THD component:             ${components.thd}/100

PERFORMANCE METRICS (last 7 days of available data):
  Avg Power Factor:  ${metrics.avgPf?.toFixed(3) ?? 'N/A'}   (SA target ≥0.95, penalty below 0.90)
  Avg THD (voltage): ${metrics.avgThd?.toFixed(2) ?? 'N/A'}% (NRS 048 limit 8%, EN 50160 planning level 5%)
  Peak Demand:       ${metrics.peakKw?.toFixed(1) ?? 'N/A'} kW
  Avg Demand:        ${metrics.avgKw?.toFixed(1) ?? 'N/A'} kW
  Load Factor:       ${lf}                                   (ideal ≥0.80 on demand tariffs)
  Avg Voltage:       ${metrics.avgV?.toFixed(1) ?? 'N/A'} V  (SA nominal 230 V phase-neutral / 400 V line-line)
  Min Voltage:       ${metrics.minV?.toFixed(1) ?? 'N/A'} V
  Max Voltage:       ${metrics.maxV?.toFixed(1) ?? 'N/A'} V
  Monthly Energy:    ${metrics.energyKwh?.toFixed(0) ?? 'N/A'} kWh

TARIFF: ${tariffContext}
RECENT ALERTS: ${activeAlerts.length > 0
    ? activeAlerts.map(a => `${a.type}: ${a.message}`).join('; ')
    : 'None'}

INSTRUCTIONS:
- Return 2–5 recommendations only where the data clearly supports them.
- Be specific — reference actual numbers from the metrics above.
- Use South African market pricing for cost estimates (ZAR).
- Apply NRS 048-2, SANS 10142, EN 50160 where relevant.
- If insufficient data for a recommendation type, omit it.
- Priority 1 = highest urgency / best ROI.
- ONLY recommend retrofits/upgrades for loads that appear in DECLARED LOADS. Do not suggest VFD installation if no DOL motors are listed, do not suggest LED retrofits if lighting is already LED, etc. If a load type is not declared, do not assume it exists.
- If load profile is incomplete or "not specified" for the main meter, flag this as an ENERGY_AUDIT recommendation so the site owner declares loads — better data → better recommendations.

JSON schema for each item:
{
  "type": "POWER_FACTOR_CORRECTION|HARMONIC_FILTER|PV_INSTALL|LIGHTING_UPGRADE|LOAD_SHIFTING|VOLTAGE_REGULATION|DEMAND_MANAGEMENT|ENERGY_AUDIT",
  "priority": 1,
  "title": "concise actionable title (max 60 chars)",
  "problem": "specific finding from the data with exact numbers",
  "solution": "specific recommended action",
  "estimated_monthly_saving_zar": 0,
  "estimated_implementation_cost_zar": 0,
  "payback_months": 0,
  "confidence": "HIGH|MEDIUM|LOW",
  "standard_reference": "e.g. NRS 048-2 clause 4.3 (optional)"
}`;

    // ── Call Claude ────────────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let recommendations: Recommendation[] = [];

    try {
        const message = await anthropic.messages.create({
            model:      'claude-sonnet-4-5',
            max_tokens: 2048,
            messages:   [{ role: 'user', content: prompt }],
        });

        const raw = message.content[0].type === 'text' ? message.content[0].text : '';

        // Strip accidental markdown fences
        const cleaned = raw
            .replace(/^```(?:json)?\n?/gm, '')
            .replace(/\n?```$/gm, '')
            .trim();

        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) throw new Error('Claude response is not a JSON array');

        // Validate and sanitise each recommendation
        recommendations = parsed
            .filter((r: any) => r && typeof r.title === 'string' && VALID_TYPES.has(r.type))
            .map((r: any): Recommendation => ({
                type:                               r.type,
                priority:                           Math.max(1, Math.min(5, Number(r.priority) || 1)),
                title:                              String(r.title).slice(0, 255),
                problem:                            String(r.problem || ''),
                solution:                           String(r.solution || ''),
                estimated_monthly_saving_zar:       Math.max(0, Number(r.estimated_monthly_saving_zar) || 0),
                estimated_implementation_cost_zar:  Math.max(0, Number(r.estimated_implementation_cost_zar) || 0),
                payback_months:                     Math.max(0, Number(r.payback_months) || 0),
                confidence:                         (['HIGH','MEDIUM','LOW'].includes(r.confidence) ? r.confidence : 'MEDIUM') as any,
                standard_reference:                 r.standard_reference ? String(r.standard_reference).slice(0, 255) : undefined,
            }))
            .slice(0, 5); // max 5 per run

        console.log(`[AI] Claude generated ${recommendations.length} recommendations for site ${siteId}`);
    } catch (err: any) {
        console.error('[AI] Claude generation failed:', err.message || err);
        return [];
    }

    // ── Persist to DB ──────────────────────────────────────────────────────
    const dbClient = await pool.connect();
    try {
        // Mark previous active recommendations as superseded
        await dbClient.query(`
            UPDATE recommendations
            SET status = 'SUPERSEDED'
            WHERE site_id = $1 AND status = 'ACTIVE'
        `, [siteId]);

        for (const rec of recommendations) {
            await dbClient.query(`
                INSERT INTO recommendations (
                    site_id, tenant_id, type, priority, title, problem, solution,
                    estimated_monthly_saving_zar, estimated_implementation_cost_zar,
                    payback_months, confidence, standard_reference, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE')
            `, [
                siteId, tenantId,
                rec.type, rec.priority, rec.title, rec.problem, rec.solution,
                rec.estimated_monthly_saving_zar,
                rec.estimated_implementation_cost_zar,
                rec.payback_months,
                rec.confidence,
                rec.standard_reference ?? null,
            ]);
        }
    } finally {
        dbClient.release();
    }

    return recommendations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch stored active recommendations for a site
// ─────────────────────────────────────────────────────────────────────────────
export async function getSiteRecommendations(
    pool:   Pool,
    siteId: string,
): Promise<any[]> {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT r.*, s.name as site_name
            FROM recommendations r
            JOIN sites s ON r.site_id = s.id
            WHERE r.site_id = $1
              AND r.status = 'ACTIVE'
            ORDER BY r.priority ASC, r.estimated_monthly_saving_zar DESC
        `, [siteId]);
        return res.rows;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch ALL active recommendations for a tenant (or all tenants for super_admin)
// ─────────────────────────────────────────────────────────────────────────────
export async function getTenantRecommendations(
    pool:      Pool,
    tenantId:  string | null,   // null = all tenants (super_admin)
): Promise<any[]> {
    const client = await pool.connect();
    try {
        let query = `
            SELECT r.*, s.name as site_name, s.address as site_address
            FROM recommendations r
            JOIN sites s ON r.site_id = s.id
            WHERE r.status = 'ACTIVE'
        `;
        const params: any[] = [];
        if (tenantId) {
            query += ` AND r.tenant_id = $1`;
            params.push(tenantId);
        }
        query += ` ORDER BY r.priority ASC, r.estimated_monthly_saving_zar DESC`;
        const res = await client.query(query, params);
        return res.rows;
    } finally {
        client.release();
    }
}
