import OpenAI from 'openai';
import { Pool } from 'pg';
import { ComplianceReport } from './power-quality';

// ─────────────────────────────────────────────────────────────────────────────
// AI narrative layer for the Power Quality Health Check.
//
// Division of responsibility, and the reason this product can be trusted:
//   power-quality.ts  MEASURES  — every number, threshold and verdict
//   pq-narrative.ts   EXPLAINS  — turns those findings into owner-language
//
// The model receives only figures already computed from measured data and is
// forbidden from producing new ones. If it invents a number, the report stops
// being defensible — so the prompt constrains it hard and the caller caches the
// result against the snapshot rather than regenerating text on every page view.
// ─────────────────────────────────────────────────────────────────────────────

// Overridable so the model can be upgraded without a code change.
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-nano';

const SYSTEM_PROMPT = `You are a senior power quality engineer writing the opening summary of a formal report for the business owner who receives it.

WHO YOU ARE WRITING FOR
The reader owns or manages the site. They are not an electrical engineer. They care about: is my equipment at risk, is someone overcharging me, what do I do on Monday morning, and what does it cost.

ABSOLUTE RULES
1. Use ONLY the measurements and findings supplied to you. Never introduce a number that is not in the supplied data — no invented costs, no invented equipment counts, no invented savings.
2. If something was not measured, do not speculate about it. Say what would need to be measured instead.
3. Never contradict the supplied verdict or any pass/fail result.
4. Do not restate the whole report. The reader has the detail below your summary; your job is the interpretation.

HOW TO WRITE
- Three short paragraphs, no headings, no bullet points, no markdown.
- Paragraph 1: the bottom line in one or two sentences — is the supply healthy, is the installation healthy, and which of the two (if either) needs attention.
- Paragraph 2: the single most important finding and what it physically does to their equipment, in plain language. Explain the mechanism simply (e.g. uneven loading makes one phase run hotter, and heat is what kills motor insulation).
- Paragraph 3: what to do next, concretely, and who does it (an electrician, the utility, or nobody yet). If the finding is inside their installation, make clear it is theirs to fix; if it is the supply, make clear it is the utility's responsibility and that this report is the evidence.
- Plain South African business English. No jargon without a short explanation. No hype, no alarmism, no filler like "in today's world".
- Never begin with "This report" or "Based on the data".`;

/** Compact, factual brief. Only measured values — nothing inferred. */
function buildBrief(report: ComplianceReport): string {
    const lines: string[] = [];
    lines.push(`SITE: ${report.site_name} — measurement point: ${report.meter_name}`);
    lines.push(`OBSERVATION: ${report.readings.toLocaleString('en-ZA')} measurements over ${report.period_days} days`);
    lines.push(`VERDICT: ${report.verdict} — ${report.verdict_note}`);
    lines.push(`SUPPLY QUALITY SCORE (utility's responsibility): ${report.supply_score}/100`);
    lines.push(`INSTALLATION HEALTH SCORE (client's responsibility): ${report.install_score}/100`);
    lines.push('');
    lines.push('COMPLIANCE RESULTS (measured against NRS 048-2):');
    for (const p of report.parameters) {
        lines.push(`- ${p.label}: ${p.display} vs limit ${p.limit} → ${p.status}`);
        lines.push(`    ${p.detail}`);
        if (p.trend !== 'NO_BASELINE') lines.push(`    Trend: ${p.trend} — ${p.trend_note}`);
    }
    lines.push('');
    if (report.risks.length === 0) {
        lines.push('EQUIPMENT RISK FINDINGS: none identified in this period.');
    } else {
        lines.push('EQUIPMENT RISK FINDINGS (most severe first):');
        for (const r of report.risks) {
            lines.push(`- [${r.severity}] ${r.title}`);
            lines.push(`    Finding: ${r.finding}`);
            lines.push(`    Mechanism: ${r.mechanism}`);
            lines.push(`    Recommended action: ${r.action}`);
        }
    }
    lines.push('');
    lines.push(`PERIOD-OVER-PERIOD: ${report.trend_summary}`);
    return lines.join('\n');
}

/**
 * Generate the plain-language executive summary for an assessment.
 * Returns null when no API key is configured — the report must remain fully
 * usable without AI, since the engineering content does not depend on it.
 */
export async function generateExecutiveSummary(
    report: ComplianceReport,
): Promise<string | null> {
    if (!process.env.OPENAI_API_KEY) return null;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    try {
        const completion = await openai.chat.completions.create({
            model: MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildBrief(report) },
            ],
            max_completion_tokens: 700,
        });
        const text = completion.choices[0]?.message?.content?.trim();
        return text || null;
    } catch (err: any) {
        console.error('[AI] Executive summary generation failed:', err?.message || err);
        return null;
    }
}

/**
 * Fetch a cached summary for the meter's most recent snapshot, generating and
 * storing one if absent. Caching against the snapshot keeps the wording stable
 * for a given assessment (a report whose text changes on refresh looks
 * untrustworthy) and avoids paying for tokens on every page view.
 */
export async function getOrCreateExecutiveSummary(
    pool:    Pool,
    meterId: string,
    report:  ComplianceReport,
): Promise<string | null> {
    const client = await pool.connect();
    try {
        const existing = await client.query(
            `SELECT id, ai_summary FROM pq_assessments
             WHERE meter_id = $1 ORDER BY assessed_at DESC LIMIT 1`,
            [meterId]
        );
        const row = existing.rows[0];
        if (row?.ai_summary) return row.ai_summary as string;

        const summary = await generateExecutiveSummary(report);
        if (summary && row?.id) {
            await client.query(
                `UPDATE pq_assessments SET ai_summary = $2 WHERE id = $1`,
                [row.id, summary]
            );
        }
        return summary;
    } catch (err: any) {
        console.error('[AI] Summary cache error:', err?.message || err);
        // Fall back to a live generation rather than failing the request.
        return generateExecutiveSummary(report);
    } finally {
        client.release();
    }
}

/**
 * Answer a question about one specific assessment. Scoped deliberately: the
 * model may only reason over this report's measured findings, which keeps
 * answers verifiable and stops it drifting into general energy chit-chat.
 */
export async function answerReportQuestion(
    report:   ComplianceReport,
    question: string,
    history:  { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<string | null> {
    if (!process.env.OPENAI_API_KEY) return null;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    try {
        const completion = await openai.chat.completions.create({
            model: MODEL,
            messages: [
                {
                    role: 'system',
                    content: `You are a senior power quality engineer answering questions about one specific report you have just issued for this client's site.

The full measured findings are below. Rules:
- Answer ONLY from these findings. Never invent a measurement, cost or piece of equipment.
- If the answer requires something that was not measured, say so plainly and state what measurement would answer it.
- Be direct and brief — a few sentences unless real detail is asked for. Plain business English.
- You are the client's independent advisor. If a finding is the utility's responsibility, say so; if it is theirs, say so.
- Where a standard applies (NRS 048-2, SANS 10142-1, NEMA MG-1), name it.

=== MEASURED FINDINGS FOR THIS SITE ===
${buildBrief(report)}`,
                },
                ...history.slice(-6),
                { role: 'user', content: question },
            ],
            max_completion_tokens: 800,
        });
        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (err: any) {
        console.error('[AI] Report Q&A failed:', err?.message || err);
        return null;
    }
}
