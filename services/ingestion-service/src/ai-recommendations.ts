import OpenAI from 'openai';
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
// Deterministic standards guardrails, applied AFTER the model returns. The LLM
// is not trusted to police physics/standards, so we enforce them in code:
//  · drop recommendations that contradict the measured data (PF already ≥ 0.95,
//    THD < 5%, or voltage sitting inside the 207–253 V NRS band)
//  · drop "spend money, save nothing" items (a cost with no quantified saving)
//  · recompute payback from saving + cost so it is always internally consistent
//  · keep at most one recommendation per type (the highest-saving instance)
// ─────────────────────────────────────────────────────────────────────────────
function enforceStandards(
    recs: Recommendation[],
    m:    EnergyScoreResult['metrics'],
): Recommendation[] {
    const kept = recs.filter(r => {
        if (r.type === 'POWER_FACTOR_CORRECTION' && m.avgPf  !== null && m.avgPf >= 0.95) return false;
        if (r.type === 'HARMONIC_FILTER'         && m.avgThd !== null && m.avgThd < 5)    return false;
        if (r.type === 'VOLTAGE_REGULATION'
            && m.minV !== null && m.maxV !== null
            && m.minV >= 207 && m.maxV <= 253) return false;
        // "Pay to save nothing" — a costed upgrade with no quantified return is noise.
        if (r.type !== 'ENERGY_AUDIT'
            && r.estimated_monthly_saving_zar <= 0
            && r.estimated_implementation_cost_zar > 0) return false;
        return true;
    });

    // Recompute payback so it always agrees with the saving/cost we display.
    for (const r of kept) {
        r.payback_months = (r.estimated_monthly_saving_zar > 0 && r.estimated_implementation_cost_zar > 0)
            ? Math.round(r.estimated_implementation_cost_zar / r.estimated_monthly_saving_zar)
            : 0;
    }

    // De-duplicate by type — keep the highest-saving instance of each.
    const bestByType = new Map<string, Recommendation>();
    for (const r of kept) {
        const cur = bestByType.get(r.type);
        if (!cur || r.estimated_monthly_saving_zar > cur.estimated_monthly_saving_zar) {
            bestByType.set(r.type, r);
        }
    }

    return [...bestByType.values()]
        .sort((a, b) => a.priority - b.priority || b.estimated_monthly_saving_zar - a.estimated_monthly_saving_zar);
}

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
    meterId?:    string,         // when set, recs are scoped to one meter
    meterName?:  string,         // human-readable for the prompt
): Promise<Recommendation[]> {
    if (!process.env.OPENAI_API_KEY) {
        console.warn('[AI] OPENAI_API_KEY not set — skipping recommendation generation');
        return [];
    }

    // ── Fetch supporting data ──────────────────────────────────────────────
    const client = await pool.connect();
    // Standard SA Megaflex / TOU times — used as defaults when the user hasn't
    // entered their own schedule. Keep the AI from telling them "set the times"
    // every single run.
    const DEFAULT_PEAK_TIMES    = '07:00-10:00 & 18:00-20:00 (weekdays)';
    const DEFAULT_STANDARD_TIMES = '06:00-07:00, 10:00-18:00, 20:00-22:00 (weekdays)';
    const DEFAULT_OFFPEAK_TIMES = '22:00-06:00 (all days) + all weekend';

    let tariffContext = 'NOT CONFIGURED — recommend the user enter tariff rates on the Settings → Tariffs page.';
    let tariffsConfigured = false;
    let activeAlerts: { type: string; message: string }[] = [];
    let loadProfile  = 'No load profile declared by site owner.';
    let declaredSiteType: string | null = null;
    try {
        const settingsRes = await client.query(
            `SELECT tariff_peak, tariff_standard, tariff_offpeak, tariff_demand,
                    peak_times, standard_times, offpeak_times,
                    contracted_mdi_kva, alert_max_kw
             FROM site_settings WHERE site_id = $1`,
            [siteId]
        );
        const s = settingsRes.rows[0];
        if (s?.tariff_peak) {
            tariffsConfigured = true;
            const peakTimes   = s.peak_times    || DEFAULT_PEAK_TIMES    + ' (SA default, user hasn\'t overridden)';
            const stdTimes    = s.standard_times || DEFAULT_STANDARD_TIMES + ' (SA default, user hasn\'t overridden)';
            const offTimes    = s.offpeak_times || DEFAULT_OFFPEAK_TIMES + ' (SA default, user hasn\'t overridden)';
            const demandLine  = s.tariff_demand
                ? `\n  Demand (MDI) charge: R${Number(s.tariff_demand).toFixed(2)}/kVA/month`
                : '';
            const mdiLine     = s.contracted_mdi_kva
                ? `\n  Contracted MDI capacity: ${s.contracted_mdi_kva} kVA`
                : '';
            const peakAlert   = s.alert_max_kw
                ? `\n  Configured peak-demand alert threshold: ${s.alert_max_kw} kW`
                : '';
            tariffContext =
                `CONFIGURED — use these exact rates in all saving calculations:\n` +
                `  Peak rate:     R${Number(s.tariff_peak).toFixed(2)}/kWh   during ${peakTimes}\n` +
                `  Standard rate: R${Number(s.tariff_standard ?? 0).toFixed(2)}/kWh   during ${stdTimes}\n` +
                `  Off-peak rate: R${Number(s.tariff_offpeak ?? 0).toFixed(2)}/kWh   during ${offTimes}` +
                demandLine + mdiLine + peakAlert;
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
        // When scoped to a single meter, we only include THAT meter's profile.
        const profileQuery = meterId
            ? `SELECT name, load_types, load_description, site_type FROM meters WHERE id = $1`
            : `SELECT name, load_types, load_description, site_type FROM meters WHERE site_id = $1 AND is_active = true ORDER BY name ASC`;
        const profileRes = await client.query(profileQuery, [meterId ?? siteId]);
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
    const lf  = metrics.loadFactor !== null   ? metrics.loadFactor.toFixed(2)   : 'N/A';
    const unb = metrics.unbalancePct !== null ? metrics.unbalancePct.toFixed(2) + '%' : 'N/A (single-phase or insufficient data)';
    const vab = metrics.avgVa !== null ? `${metrics.avgVa.toFixed(1)}V / ${metrics.avgVb?.toFixed(1) ?? '—'}V / ${metrics.avgVc?.toFixed(1) ?? '—'}V` : 'N/A';
    // Apparent power (kVA) for a like-for-like comparison against the contracted
    // MDI, which utilities bill in kVA. Comparing raw kW to a kVA limit is wrong.
    const peakKva = (metrics.peakKw !== null && metrics.avgPf && metrics.avgPf > 0)
        ? metrics.peakKw / metrics.avgPf
        : null;

    const prompt = `You are Grid-IQ's energy analysis engine for South African industrial and commercial sites.
Analyse the data below and return ONLY a valid JSON object of the form:
{ "recommendations": [ ... 2 to 5 items matching the schema below ... ] }
No prose, no markdown fences — just raw parseable JSON.

SITE: ${siteName} | ${siteAddress}
${meterId ? `SCOPE: Single meter analysis — "${meterName}". Treat the loads and metrics below as belonging to this meter only.` : 'SCOPE: Site-wide — aggregate of all active meters.'}
SITE TYPE: ${declaredSiteType || 'Not declared'}
TARIFF TYPE: ${tariffType} (SA context: Megaflex = large demand tariff, TOU = time-of-use, FLAT = single rate)

DECLARED LOADS${meterId ? ' (this meter)' : ' PER METER'} (this is what's physically connected — do NOT invent loads that aren't listed):
${loadProfile}

ENERGY SCORE: ${totalScore}/100
  Power Factor component:      ${components.pf}/100
  Voltage Unbalance component: ${components.voltageUnbalance}/100
  Voltage Quality component:   ${components.voltageQuality}/100
  THD component:               ${components.thd}/100

PERFORMANCE METRICS (last 7 days of available data):
  Avg Power Factor:   ${metrics.avgPf?.toFixed(3) ?? 'N/A'}   (SA target ≥0.95, penalty below 0.90)
  Avg THD (voltage):  ${metrics.avgThd?.toFixed(2) ?? 'N/A'}% (NRS 048 limit 8%, EN 50160 planning level 5%)
  Peak Demand (real):     ${metrics.peakKw?.toFixed(1) ?? 'N/A'} kW
  Peak Demand (apparent): ${peakKva?.toFixed(1) ?? 'N/A'} kVA  ← compare THIS to contracted MDI (kVA), never the kW figure
  Avg Demand:         ${metrics.avgKw?.toFixed(1) ?? 'N/A'} kW
  Load Factor:        ${lf}                                   (informational — ideal ≥0.80 on demand tariffs)
  Per-phase avg V:    ${vab}
  Voltage Unbalance:  ${unb}                                  (NRS 048-2 limit 2%; >2% damages motors / drives)
  Avg Voltage:        ${metrics.avgV?.toFixed(1) ?? 'N/A'} V  (SA nominal 230 V phase-neutral / 400 V line-line)
  Min Voltage:        ${metrics.minV?.toFixed(1) ?? 'N/A'} V
  Max Voltage:        ${metrics.maxV?.toFixed(1) ?? 'N/A'} V
  Monthly Energy:     ${metrics.energyKwh?.toFixed(0) ?? 'N/A'} kWh

TARIFF CONFIGURATION:
${tariffContext}

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
- STANDARDS DISCIPLINE — hard rules. A recommendation that breaks any of these is wrong and will be discarded:
  • Power factor: recommend POWER_FACTOR_CORRECTION ONLY if Avg PF < 0.95. At or above 0.95 the SA target is already met — there is no reactive penalty to recover, so do not suggest it.
  • Harmonics: recommend HARMONIC_FILTER ONLY if Avg THD ≥ 5%. Below 5% it is within the EN 50160 planning level and far under the NRS 048-2 8% limit — a filter is not justified.
  • Voltage: recommend VOLTAGE_REGULATION ONLY if Min or Max Voltage is outside 207–253 V. A voltage inside that band is compliant — do not flag it as a problem.
  • Demand vs MDI: compare demand to the contracted MDI in kVA using the "Peak Demand (apparent)" figure. Never compare a kW value to a kVA limit.
  • Quantify or omit: every recommendation except ENERGY_AUDIT MUST carry estimated_monthly_saving_zar > 0, derived from the configured tariff rates. If you cannot compute a real rand saving from the data, OMIT the item — never output an upgrade that costs money but saves nothing.
  • One per type: output at most one recommendation of each type; pick the single best.
  • No hedging: state the finding plainly and cite the exact standard clause, or omit the reference entirely. Do not write "may", "possibly", "depending on billing rules", or tag a reference "(optional)".
- Tariff handling: ${tariffsConfigured
    ? 'rates ARE configured (see TARIFF CONFIGURATION above). Use those exact rand values in every saving estimate. Do NOT recommend that the user "enter their tariffs" or "configure TOU rates" — that has already been done. You may recommend optimising tariff structure with their utility if the data supports it.'
    : 'rates are NOT yet configured. Include exactly ONE recommendation of type ENERGY_AUDIT asking the user to enter tariff rates on Settings → Tariffs so future analyses can quantify rand savings.'}

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

    // ── Call OpenAI ────────────────────────────────────────────────────────
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let recommendations: Recommendation[] = [];

    try {
        const completion = await openai.chat.completions.create({
            model:    'gpt-5.4-nano',
            messages: [
                { role: 'system', content: 'You are Grid-IQ\'s energy analysis engine. Reply with ONLY a valid JSON array of recommendations — no prose, no markdown fences, just raw JSON parseable by JSON.parse().' },
                { role: 'user',   content: prompt },
            ],
            // Force JSON output so we never have to strip prose/markdown from the reply.
            response_format: { type: 'json_object' },
            // Newer OpenAI models (gpt-5 / o-series) require max_completion_tokens
            // instead of the legacy max_tokens parameter.
            max_completion_tokens: 2048,
            temperature: 0.4,
        });

        const raw = completion.choices[0]?.message?.content ?? '';

        // Strip accidental markdown fences (defensive — response_format usually prevents this)
        const cleaned = raw
            .replace(/^```(?:json)?\n?/gm, '')
            .replace(/\n?```$/gm, '')
            .trim();

        // response_format: 'json_object' returns an object — we asked for an array,
        // so accept either { recommendations: [...] } or a top-level array.
        const parsedRaw = JSON.parse(cleaned);
        const parsed = Array.isArray(parsedRaw)
            ? parsedRaw
            : (Array.isArray(parsedRaw?.recommendations) ? parsedRaw.recommendations : null);
        if (!parsed) throw new Error('OpenAI response is not a JSON array or { recommendations: [...] } object');

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

        // Deterministic standards guardrails — enforce physics/standards in code,
        // independent of whatever the model returned.
        recommendations = enforceStandards(recommendations, metrics);

        console.log(`[AI] OpenAI generated ${recommendations.length} standards-checked recommendations for site ${siteId}`);
    } catch (err: any) {
        console.error('[AI] OpenAI generation failed:', err.message || err);
        return [];
    }

    // ── Persist to DB ──────────────────────────────────────────────────────
    const dbClient = await pool.connect();
    try {
        // Supersede only recs in the same scope (per-meter OR site-wide).
        // Re-running a site analysis must NOT wipe per-meter recs and vice versa.
        if (meterId) {
            await dbClient.query(
                `UPDATE recommendations SET status = 'SUPERSEDED'
                 WHERE meter_id = $1 AND status = 'ACTIVE'`,
                [meterId]
            );
        } else {
            await dbClient.query(
                `UPDATE recommendations SET status = 'SUPERSEDED'
                 WHERE site_id = $1 AND meter_id IS NULL AND status = 'ACTIVE'`,
                [siteId]
            );
        }

        for (const rec of recommendations) {
            await dbClient.query(`
                INSERT INTO recommendations (
                    site_id, meter_id, tenant_id, type, priority, title, problem, solution,
                    estimated_monthly_saving_zar, estimated_implementation_cost_zar,
                    payback_months, confidence, standard_reference, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ACTIVE')
            `, [
                siteId, meterId ?? null, tenantId,
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
// Fetch stored active recommendations for a site (all scopes — site + meters)
// ─────────────────────────────────────────────────────────────────────────────
export async function getSiteRecommendations(
    pool:   Pool,
    siteId: string,
): Promise<any[]> {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT r.*, s.name as site_name, m.name as meter_name
            FROM recommendations r
            JOIN sites s ON r.site_id = s.id
            LEFT JOIN meters m ON r.meter_id = m.id
            WHERE r.site_id = $1
              AND r.status = 'ACTIVE'
            ORDER BY r.priority ASC, r.estimated_monthly_saving_zar DESC
        `, [siteId]);
        return res.rows;
    } finally {
        client.release();
    }
}

// Per-meter recommendations (active only)
export async function getMeterRecommendations(
    pool:    Pool,
    meterId: string,
): Promise<any[]> {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT r.*, s.name as site_name, m.name as meter_name
            FROM recommendations r
            JOIN sites s ON r.site_id = s.id
            JOIN meters m ON r.meter_id = m.id
            WHERE r.meter_id = $1
              AND r.status = 'ACTIVE'
            ORDER BY r.priority ASC, r.estimated_monthly_saving_zar DESC
        `, [meterId]);
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
            SELECT r.*, s.name as site_name, s.address as site_address, m.name as meter_name
            FROM recommendations r
            JOIN sites s ON r.site_id = s.id
            LEFT JOIN meters m ON r.meter_id = m.id
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
