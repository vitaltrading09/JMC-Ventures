// ─────────────────────────────────────────────────────────────────────────────
// The assessment summary (engineering UI brief, sections 2 and 5): the first
// screen of a site, built only from the assessment dataset (dataset.ts), so
// the website, the consultant and the PDF executive page say the same thing.
//
//   context     site, assessment, point, observed window, freshness, coverage
//   glance      short narrative of supported statements only
//   metrics     four headline metrics, each with its definition
//   categories  supply / installation & load / demand exposure / measurement
//               quality: "no material issue observed" | "investigate" |
//               "insufficient evidence", each with the rule that decided it
//   findings    up to three prioritised items, each linked to its evidence
//   next        what to do next, and feasibility handover readiness
//
// No overall score: a number out of 100 would look like a certification.
// ─────────────────────────────────────────────────────────────────────────────

import { SCREENING } from './dataset';

export type CategoryState = 'ok' | 'investigate' | 'insufficient';
export const STATE_LABEL: Record<CategoryState, string> = {
    ok: 'No material issue observed', investigate: 'Investigate', insufficient: 'Insufficient evidence',
};

const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 100));
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** The point a site summary is about: the requested one, else the top-level incomer with the most data, else any point with the most data. */
export function mainPoint(ds: any, pointId?: string | null) {
    const pts = ds.points ?? [];
    const requested = pts.find((p: any) => p.id === pointId);
    if (requested) return requested;
    // Of several top-level incomers, the one with the most data (a test point must not lead).
    const most = (xs: any[]) => xs.slice().sort((x, y) => (y.coverage?.samples ?? 0) - (x.coverage?.samples ?? 0))[0];
    return most(pts.filter((p: any) => p.role === 'incomer' && !p.parent_point_id)) ?? most(pts) ?? null;
}

/** Hours (SAST) where the weekday median is within 10 % of its maximum: the operating peak. */
export function peakWindow(typ: any): { from: number; to: number } | null {
    const med = (typ?.hours ?? []).map((h: any) => h.median as number | null);
    const vals = med.filter((x: number | null): x is number => x !== null);
    if (vals.length < 12) return null;
    const max = Math.max(...vals);
    if (max <= 0) return null;
    const hot = med.map((v: number | null) => v !== null && v >= 0.9 * max);
    const first = hot.indexOf(true), last = hot.lastIndexOf(true);
    return first < 0 ? null : { from: first, to: last + 1 };
}

export function categoriesFor(ds: any, p: any) {
    const pq = p?.power_quality;
    const observedH = (ds.assessment.observed_days ?? 0) * 24;
    const cats: { key: string; title: string; state: CategoryState; reason: string; evidence: string }[] = [];

    // Measurement quality first: it limits everything else.
    const cov = p?.coverage?.fraction ?? null;
    cats.push({ key: 'measurement', title: 'Measurement quality', evidence: 'coverage',
        ...(observedH < 24 ? { state: 'insufficient' as const, reason: `${Math.round(observedH)} h observed so far; at least 24 h are needed for a daily pattern.` }
            : cov === null ? { state: 'insufficient' as const, reason: 'No measurements received.' }
            : cov < 0.8 ? { state: 'investigate' as const, reason: `${pct(cov)} % of expected 10-minute slots measured (rule: investigate below 80 %).` }
            : { state: 'ok' as const, reason: `${pct(cov)} % of expected 10-minute slots measured${p.coverage.mixed_cadence ? '; mixed reporting intervals are counted per slot' : ''}.` }) });

    // Supply observations: voltage, frequency, interruptions, voltage distortion.
    const vOut = (pq?.voltage ?? []).filter((v: any) => (v.outside_pct ?? 0) > 5);
    const thdHigh = (pq?.thd_v ?? []).filter((t: any) => (t.p95 ?? 0) > SCREENING.thd_v_pct);
    const freqOut = pq?.frequency?.outside_values ?? 0;
    const supplyIssues = [
        ...vOut.map((v: any) => `phase ${v.phase} voltage outside ±10 % in ${v.outside_pct} % of 10-minute values`),
        ...(thdHigh.length ? [`voltage THD P95 above ${SCREENING.thd_v_pct} % on ${thdHigh.map((t: any) => t.phase).join(', ')}`] : []),
        ...(pq?.interruption_minutes ? [`${pq.interruption_minutes} minute(s) below ${SCREENING.interruption_v} V`] : []),
        ...(freqOut ? [`frequency outside ${SCREENING.f_low}–${SCREENING.f_high} Hz in ${freqOut} 10-minute value(s)`] : []),
    ];
    cats.push({ key: 'supply', title: 'Supply observations', evidence: 'power_quality.voltage',
        ...(!pq || !(pq.voltage ?? []).length || observedH < 24 ? { state: 'insufficient' as const, reason: 'Fewer than 24 h of valid voltage values.' }
            : supplyIssues.length ? { state: 'investigate' as const, reason: `${supplyIssues.join('; ')} (NRS 048-2 screening thresholds).` }
            : { state: 'ok' as const, reason: `Voltage, frequency and voltage THD within the NRS 048-2 screening thresholds in the observed period.` }) });

    // Installation and load behaviour: loaded PF, current unbalance, after-hours load.
    const pf = pq?.pf?.avg_loaded ?? null;
    const iu = pq?.unbalance?.current_p95 ?? null;
    const br = p?.patterns?.baseload_ratio ?? null;
    const loadIssues = [
        ...(pf !== null && pf < SCREENING.pf_min ? [`average loaded PF ${pf}`] : []),
        ...(iu !== null && iu > 15 ? [`current unbalance P95 ${iu} %`] : []),
        ...(br !== null && br > 0.6 ? [`load outside operating hours at ${pct(br)} % of the operating average`] : []),
    ];
    cats.push({ key: 'load', title: 'Installation and load behaviour', evidence: 'power_quality.pf',
        ...(pf === null && iu === null ? { state: 'insufficient' as const, reason: 'Power factor and current unbalance not available yet.' }
            : loadIssues.length ? { state: 'investigate' as const, reason: `${loadIssues.join('; ')}.` }
            : { state: 'ok' as const, reason: `Loaded PF ${pf ?? '–'}, current unbalance P95 ${iu ?? '–'} %${br !== null ? `, after-hours load ${pct(br)} % of operating` : ''}.` }) });

    // Demand exposure: needs a declared contracted demand.
    const d = p?.demand;
    cats.push({ key: 'demand', title: 'Demand exposure', evidence: 'demand',
        ...(!d || d.max_kva === null ? { state: 'insufficient' as const, reason: 'No complete 30-minute interval yet.' }
            : !d.contracted_mdi_kva ? { state: 'insufficient' as const, reason: `Maximum 30-minute demand ${d.max_kva} kVA; no contracted demand is declared to compare it with.` }
            : (d.utilisation ?? 0) > 0.9 ? { state: 'investigate' as const, reason: `Maximum 30-minute demand ${d.max_kva} kVA is ${pct(d.utilisation)} % of the contracted ${d.contracted_mdi_kva} kVA${d.intervals_over_mdi ? ` (${d.intervals_over_mdi} interval(s) above it)` : ''}.` }
            : { state: 'ok' as const, reason: `Maximum 30-minute demand ${d.max_kva} kVA, ${pct(d.utilisation)} % of the contracted ${d.contracted_mdi_kva} kVA.` }) });
    return cats;
}

/** Plain sentences, only from supported facts. */
export function glanceFor(ds: any, p: any, cats: ReturnType<typeof categoriesFor>): string[] {
    const out: string[] = [];
    const observedH = (ds.assessment.observed_days ?? 0) * 24;
    if (!p) return ['No measurement point is part of this assessment yet.'];
    if (observedH < 24) {
        out.push(`The assessment has ${Math.max(0, Math.round(observedH))} hour(s) of data so far: too little for a daily pattern. This is a partial picture.`);
        out.push('A full day of measurements gives the first operating profile; a full week gives weekday and weekend behaviour and a power-quality screening.');
        return out;
    }
    const wk = p.patterns?.typical_weekday;
    const peak = peakWindow(wk);
    if (peak && wk.days >= 2) out.push(`On weekdays the load is highest between ${hh(peak.from)} and ${hh(peak.to)} (median of ${wk.days} weekdays).`);
    const br = p.patterns?.baseload_ratio;
    if (br !== null && br !== undefined) out.push(br > 0.6
        ? `Outside operating hours the site keeps drawing ${pct(br)} % of its operating-hours load.`
        : `Outside operating hours the load falls to ${pct(br)} % of its operating-hours level.`);
    const thd = (p.power_quality?.thd_v ?? []).filter((t: any) => (t.p95 ?? 0) > SCREENING.thd_v_pct);
    if (thd.length) out.push(`Voltage distortion is highest around ${thd[0].worst_hours.map(hh).join(', ')} (phase ${thd.map((t: any) => t.phase).join(', ')}).`);
    const n = cats.filter((c) => c.state === 'investigate').length;
    const ins = cats.filter((c) => c.state === 'insufficient').length;
    out.push(n ? `${n} area${n === 1 ? '' : 's'} merit${n === 1 ? 's' : ''} follow-up.` : 'No material issue was observed in the measured period.');
    if (ins) out.push(`${ins} area${ins === 1 ? ' has' : 's have'} too little evidence for a conclusion yet.`);
    return out;
}

export function buildSummary(ds: any, pointId?: string | null) {
    const p = mainPoint(ds, pointId);
    const a = ds.assessment;
    const cats = categoriesFor(ds, p);
    const hours = Math.max(0, (new Date(a.period_to).getTime() - new Date(a.period_from).getTime()) / 3_600_000);
    const kwh = p?.energy?.import_kwh ?? null;
    const avgKw = kwh !== null && hours > 0 ? kwh / hours : null;
    const maxKw = p?.demand?.max_kw ?? null;
    const lastSample = (p?.hourly_series?.t ?? []).at(-1) ?? null;
    const exec = (ds.executive ?? []).filter((e: any) => !p || e.point === p.name);
    const prioritised = exec.filter((e: any) => e.severity !== 'note');

    const next: { text: string; who: string }[] = prioritised.slice(0, 3).map((e: any) => ({ text: nextStep(e.evidence), who: e.who }));
    if (cats.find((c) => c.key === 'measurement')?.state !== 'ok') next.unshift({ text: 'Keep the meter connected and reporting; GridIQ checks the gaps listed under measurement quality.', who: 'GridIQ' });
    if (!next.length) next.push({ text: 'No corrective action is indicated by the measurements so far. Keep the assessment running to its end for the full picture.', who: 'site' });

    return {
        context: {
            assessment_id: a.id, reference: a.reference, site: a.site, client: a.client,
            point: p ? { id: p.id, name: p.name, role: p.role } : null,
            points: (ds.points ?? []).map((x: any) => ({ id: x.id, name: x.name, role: x.role })),
            period_from: a.period_from, period_to: a.period_to, observed_days: a.observed_days,
            start_at: a.start_at, end_at: a.end_at, timezone: a.timezone ?? 'Africa/Johannesburg',
            provisional: ds.provisional, data_cutoff_at: ds.data_cutoff_at, last_data_at: lastSample,
            coverage: p?.coverage ? { fraction: p.coverage.fraction, expected_slots: p.coverage.expected_slots, slots_with_data: p.coverage.slots_with_data, mixed_cadence: p.coverage.mixed_cadence, gaps: p.coverage.gaps.length } : null,
        },
        glance: glanceFor(ds, p, cats),
        metrics: [
            { key: 'energy', label: 'Energy imported', value: kwh === null ? null : Math.round(kwh), unit: 'kWh', evidence: 'energy',
              definition: `Register energy over the observed ${Math.round(hours)} h (${p?.energy?.method ?? 'register'}).` },
            { key: 'demand', label: 'Maximum demand', value: p?.demand?.max_kva ?? null, unit: 'kVA', at: p?.demand?.max_kva_at ?? null, evidence: 'demand',
              definition: p?.demand?.contracted_mdi_kva ? `Highest 30-minute average (billing basis); contracted ${p.demand.contracted_mdi_kva} kVA.` : 'Highest 30-minute average (billing basis).' },
            { key: 'load_factor', label: 'Load factor', value: avgKw !== null && maxKw ? Math.round((avgKw / maxKw) * 100) : null, unit: '%', evidence: 'patterns',
              definition: `Average kW ÷ maximum 30-minute kW. Typical operating load ${p?.patterns?.operating_avg_kw ?? '–'} kW.` },
            { key: 'findings', label: 'Areas to follow up', value: cats.filter((c) => c.state === 'investigate').length, unit: `of ${cats.length}`, evidence: 'executive',
              definition: `${prioritised.length} prioritised observation(s); ${cats.filter((c) => c.state === 'insufficient').length} area(s) with insufficient evidence.` },
        ],
        categories: cats.map((c) => ({ ...c, label: STATE_LABEL[c.state] })),
        findings: prioritised.slice(0, 3).map((e: any) => ({ ...e, next: nextStep(e.evidence) })),
        next,
        fingerprint: p ? { weekday: p.patterns?.typical_weekday ?? null, weekend: p.patterns?.typical_weekend ?? null,
                           operating_hours: p.patterns?.operating_hours ?? null } : null,
        feasibility: ds.feasibility_readiness,
        limitations: ds.limitations,
        versions: ds.versions,
    };
}

/** A concrete next verification per evidence area (brief section 12). */
export function nextStep(evidence: string): string {
    switch (evidence) {
        case 'demand': return 'Review which operations coincide with the highest 30-minute windows and whether start-ups can be sequenced; share the windows with the feasibility engineer.';
        case 'power_quality.pf': return 'Inspect the reactive behaviour and any existing compensation; consider the harmonic situation before a capacitor study.';
        case 'power_quality.thd_v': return 'Log individual harmonic orders per phase, compare distortion with site operation, and request supply (PCC) information.';
        case 'power_quality.voltage': return 'Check regulation and connections at the measurement location, and correlate deviations with site loading.';
        case 'power_quality.unbalance': return 'Review circuit allocation against a verified load schedule.';
        case 'power_quality.interruptions': return 'Compare the low-voltage times with production trips or the site incident log.';
        case 'patterns': return 'Verify the operating schedule and which equipment needs to run outside operating hours.';
        case 'coverage': return 'Restore the meter connection; GridIQ will check what data can be recovered.';
        default: return 'Review the evidence with GridIQ.';
    }
}
