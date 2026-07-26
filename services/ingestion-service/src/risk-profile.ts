import { createHash } from 'crypto';
import { Pool } from 'pg';
import { ComplianceReport, EquipmentRisk } from './power-quality';

// ─────────────────────────────────────────────────────────────────────────────
// Risk profile — restates the measured findings in the categories an insurer or
// broker uses to classify electrical risk.
//
// This adds NO new judgement. Every peril below is a fixed mapping from a
// finding that power-quality.ts already produced from measured data. Nothing
// here estimates a premium, a discount, or a probability of loss — those are the
// insurer's to determine, and inventing them would make the whole report
// untrustworthy the moment an underwriter checked one.
//
// What this section IS: an evidence pack. It says what is being monitored, for
// how long, what has been found, and against which published standard. That is
// the thing a broker can actually put in front of an underwriter today.
// ─────────────────────────────────────────────────────────────────────────────

export type Peril = 'FIRE' | 'MACHINERY_BREAKDOWN' | 'BUSINESS_INTERRUPTION';

export interface PerilExposure {
    peril:     Peril;
    label:     string;
    status:    'OPEN' | 'CLEAR';
    findings:  string[];   // titles of the measured findings driving this peril
    mechanism: string;     // the physical route from finding to loss
}

export interface MonitoringEvidence {
    monitored_since:       string | null;
    assessments_on_record: number;
    days_covered:          number;
    coverage_pct:          number | null;  // % of days in the window carrying data
    continuous:            boolean;
}

export interface RiskProfile {
    perils:            PerilExposure[];
    monitoring:        MonitoringEvidence;
    open_findings:     number;
    critical_or_high:  number;
    degrading:         string[];
    standards:         string[];
    verification_code: string;
    statement:         string;
    scope_note:        string;
}

const PERIL_LABEL: Record<Peril, string> = {
    FIRE:                  'Fire — electrical origin',
    MACHINERY_BREAKDOWN:   'Machinery breakdown',
    BUSINESS_INTERRUPTION: 'Business interruption',
};

/**
 * Fixed mapping from a measured finding to the insurable perils it bears on.
 * Keys match EquipmentRisk.key in power-quality.ts. A finding with no perils
 * listed is a commercial exposure only and is deliberately excluded from this
 * section rather than inflated into a risk.
 */
const PERIL_MAP: Record<string, { perils: Peril[]; mechanism: string }> = {
    current_unbalance: {
        perils: ['FIRE', 'MACHINERY_BREAKDOWN'],
        mechanism:
            'Unevenly loaded phases push the most heavily loaded conductor and the neutral above their design temperature. '
            + 'Sustained conductor and termination overheating is a recognised origin of distribution board fires, and the '
            + 'same negative-sequence current accelerates motor winding failure.',
    },
    motor_derating: {
        perils: ['MACHINERY_BREAKDOWN'],
        mechanism:
            'Voltage unbalance induces negative-sequence current that produces heat rather than torque. Winding insulation '
            + 'life approximately halves for every 10 °C of additional temperature rise, so the loss is a shortened service '
            + 'life that presents as a sudden failure.',
    },
    voltage_excursions: {
        perils: ['BUSINESS_INTERRUPTION', 'MACHINERY_BREAKDOWN'],
        mechanism:
            'Drives, PLCs and contactor coils drop out at 80–90% of nominal voltage, causing unplanned production stops. '
            + 'Repeated excursions also wear contactor contacts and DC-bus capacitors in variable-speed drives.',
    },
    harmonic_resonance: {
        perils: ['FIRE', 'MACHINERY_BREAKDOWN'],
        mechanism:
            'Harmonic currents cause additional heating in transformers, cables and power-factor-correction capacitors. '
            + 'Capacitor failure under harmonic resonance is a known ignition source, and transformer overheating shortens '
            + 'insulation life.',
    },
    // Power factor is a tariff exposure, not an insurable peril. Listed
    // explicitly so the omission is a decision rather than an oversight.
    power_factor: { perils: [], mechanism: '' },
};

/**
 * Stable content fingerprint for a report. Printed on the document and on any
 * shared copy: if the two codes match, the recipient is looking at exactly the
 * assessment that was issued. First step toward a verifiable evidence trail.
 */
export function verificationCode(report: ComplianceReport): string {
    const canonical = JSON.stringify({
        meter:   report.meter_id,
        from:    report.from,
        to:      report.to,
        days:    report.period_days,
        n:       report.readings,
        verdict: report.verdict,
        supply:  report.supply_score,
        install: report.install_score,
        params:  report.parameters.map(p => [p.key, p.measured, p.status]),
        risks:   report.risks.map(r => [r.key, r.severity]),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16).toUpperCase();
}

export async function buildRiskProfile(
    pool:   Pool,
    report: ComplianceReport,
): Promise<RiskProfile> {
    // ── Peril exposure, derived only from findings already measured ──────────
    const byPeril = new Map<Peril, EquipmentRisk[]>();
    for (const risk of report.risks) {
        const mapping = PERIL_MAP[risk.key];
        if (!mapping) continue;
        for (const peril of mapping.perils) {
            const list = byPeril.get(peril) ?? [];
            list.push(risk);
            byPeril.set(peril, list);
        }
    }

    const allPerils: Peril[] = ['FIRE', 'MACHINERY_BREAKDOWN', 'BUSINESS_INTERRUPTION'];
    const perils: PerilExposure[] = allPerils.map(peril => {
        const hits = byPeril.get(peril) ?? [];
        return {
            peril,
            label:  PERIL_LABEL[peril],
            status: hits.length > 0 ? 'OPEN' : 'CLEAR',
            findings: hits.map(h => h.title),
            mechanism: hits.length > 0
                // Where several findings share a peril, lead with the most severe —
                // risks arrive from power-quality.ts already sorted by severity.
                ? PERIL_MAP[hits[0].key].mechanism
                : 'No finding in the observation period bears on this peril.',
        };
    });

    // ── Monitoring evidence — how much history actually stands behind this ───
    const client = await pool.connect();
    let monitoring: MonitoringEvidence = {
        monitored_since: null, assessments_on_record: 0,
        days_covered: 0, coverage_pct: null, continuous: false,
    };
    try {
        const hist = await client.query(`
            SELECT COUNT(*)::int                        AS assessments,
                   MIN(assessed_at)                     AS first_at
            FROM pq_assessments
            WHERE meter_id = $1
        `, [report.meter_id]);

        // Distinct calendar days carrying telemetry, over the last 12 months.
        // Counting days rather than readings avoids rewarding a meter that
        // reports very frequently for a short time.
        const cover = await client.query(`
            SELECT COUNT(DISTINCT time::date)::int      AS days_with_data,
                   MIN(time)                            AS earliest
            FROM meter_readings
            WHERE meter_id = $1
              AND time >= NOW() - INTERVAL '365 days'
        `, [report.meter_id]);

        const assessments = Number(hist.rows[0]?.assessments) || 0;
        const firstAssess = hist.rows[0]?.first_at ?? null;
        const daysWithData = Number(cover.rows[0]?.days_with_data) || 0;
        const earliest = cover.rows[0]?.earliest ?? null;

        // Coverage is measured against the span actually claimed, not against a
        // full year — a meter installed 3 weeks ago should not read as 6% covered.
        let coveragePct: number | null = null;
        if (earliest) {
            const spanDays = Math.max(
                1,
                Math.ceil((Date.now() - new Date(earliest).getTime()) / 86_400_000)
            );
            coveragePct = Math.min(100, (daysWithData / spanDays) * 100);
        }

        monitoring = {
            monitored_since: earliest ? new Date(earliest).toISOString() : firstAssess,
            assessments_on_record: assessments,
            days_covered: daysWithData,
            coverage_pct: coveragePct,
            // "Continuous" is a claim an underwriter may lean on, so it needs a
            // real bar: a month of history and few gaps in it.
            continuous: daysWithData >= 28 && (coveragePct ?? 0) >= 90,
        };
    } catch (e: any) {
        console.error('Risk profile monitoring query failed:', e.message || e);
    } finally {
        client.release();
    }

    const standards = Array.from(new Set([
        ...report.parameters.map(p => p.standard.split('—')[0].trim()),
        ...report.risks.map(r => r.standard),
    ])).filter(Boolean);

    const criticalOrHigh = report.risks.filter(
        r => r.severity === 'CRITICAL' || r.severity === 'HIGH'
    ).length;

    return {
        perils,
        monitoring,
        open_findings: report.risks.length,
        critical_or_high: criticalOrHigh,
        degrading: report.degrading,
        standards,
        verification_code: verificationCode(report),
        statement:
            'This section restates the measured findings above in the categories used to classify electrical risk. '
            + 'It is an evidence pack, not an actuarial assessment: no probability of loss, premium impact or discount '
            + 'is expressed or implied here, and any underwriting decision remains entirely the insurer\'s.',
        scope_note:
            'Scope is limited to electrical parameters measurable at the metering point named above. It does not cover '
            + 'physical switchgear condition, earthing and bonding integrity, surge protection, or certification status, '
            + 'none of which can be determined from telemetry and all of which require physical inspection.',
    };
}
