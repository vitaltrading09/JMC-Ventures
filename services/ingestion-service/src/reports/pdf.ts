// ─────────────────────────────────────────────────────────────────────────────
// Report PDFs from the frozen assessment dataset (src/reports/dataset.ts).
// No numbers are computed here beyond formatting: the PDF, the portal and the
// export agree because they read the same dataset.
//
//   overview        every completed assessment: the readable baseline
//   power_quality   core PQ assessment plus sections driven by what was found
//                   (a harmonic issue gets a harmonic section; a clean site a
//                   concise, evidence-supported summary)
//   handover        for the external feasibility consultant: the data supplied,
//                   units, topology, limits; no system sizing
//
// Layout: A4, readable labels, page numbers, units on every axis and value,
// SAST stated, technical appendix with the dataset hash and versions.
// ─────────────────────────────────────────────────────────────────────────────

import PDFDocument from 'pdfkit';

type Doc = InstanceType<typeof PDFDocument>;
type Kind = 'overview' | 'power_quality' | 'handover';

const C = { ink: '#0f172a', mute: '#475569', faint: '#94a3b8', line: '#cbd5e1', blue: '#1d4ed8', green: '#047857', amber: '#b45309', red: '#b91c1c',
    phase: ['#b91c1c', '#ca8a04', '#1d4ed8'] };
const M = 50; // margin
const SAST = 2 * 3_600_000;

const fmtT = (iso: string | Date | null | undefined) => {
    if (!iso) return '–';
    const d = new Date(new Date(iso).getTime() + SAST);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const f = (v: number | null | undefined, unit = '', d?: number) =>
    v === null || v === undefined ? '–' : `${d === undefined ? v.toLocaleString('en-ZA') : v.toFixed(d)}${unit ? ` ${unit}` : ''}`;

export const TITLES: Record<Kind, string> = {
    overview: 'Site assessment: overview',
    power_quality: 'Power-quality assessment',
    handover: 'Feasibility data handover',
};

/** Render a report PDF; resolves with the bytes. */
export function renderReportPdf(kind: Kind, ds: any, meta: { revision: number; sha256: string; status: string; generatedAt: Date; reason?: string | null }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: {
            Title: `${TITLES[kind]} · ${ds.assessment.reference}`, Author: 'GridIQ', Subject: ds.assessment.site } });
        // The built-in Helvetica covers WinAnsi only: map the few symbols outside it.
        const text = doc.text.bind(doc);
        (doc as any).text = (t: any, ...rest: any[]) => text(typeof t === 'string' ? winAnsi(t) : t, ...rest);
        const chunks: Buffer[] = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        try {
            cover(doc, kind, ds, meta);
            if (kind === 'overview') overview(doc, ds);
            if (kind === 'power_quality') powerQuality(doc, ds);
            if (kind === 'handover') handover(doc, ds);
            appendix(doc, ds, meta);
            footers(doc, ds, kind, meta);
            doc.end();
        } catch (e) { reject(e); }
    });
}

// ── Building blocks ─────────────────────────────────────────────────────────
const width = (doc: Doc) => doc.page.width - 2 * M;
function ensure(doc: Doc, h: number) { if (doc.y + h > doc.page.height - M - 30) doc.addPage(); }
function h1(doc: Doc, t: string) { ensure(doc, 60); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(15).fillColor(C.ink).text(t, M); doc.moveDown(0.3); }
function h2(doc: Doc, t: string) { ensure(doc, 40); doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11.5).fillColor(C.ink).text(t, M); doc.moveDown(0.2); }
function p(doc: Doc, t: string, o: { color?: string; size?: number } = {}) {
    ensure(doc, 24); doc.font('Helvetica').fontSize(o.size ?? 9.5).fillColor(o.color ?? C.ink).text(t, M, doc.y, { width: width(doc), lineGap: 1.5 }); doc.moveDown(0.35);
}
function note(doc: Doc, t: string) { p(doc, t, { color: C.mute, size: 8 }); }
function bullet(doc: Doc, t: string, color = C.ink) {
    ensure(doc, 18);
    const y = doc.y;
    doc.circle(M + 3, y + 5, 1.6).fill(color);
    doc.font('Helvetica').fontSize(9.5).fillColor(C.ink).text(t, M + 12, y, { width: width(doc) - 12, lineGap: 1.5 });
    doc.moveDown(0.25);
}
/** Key/value grid in two columns. */
function kv(doc: Doc, rows: [string, string][]) {
    const colW = width(doc) / 2;
    for (let i = 0; i < rows.length; i += 2) {
        ensure(doc, 16);
        const y = doc.y;
        for (let j = 0; j < 2 && i + j < rows.length; j++) {
            const [k, v] = rows[i + j];
            doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(k, M + j * colW, y, { width: colW - 10 });
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(v, M + j * colW, y + 10, { width: colW - 10 });
        }
        doc.y = y + 28;
    }
}
/** A simple table with a header row; column widths as fractions. */
function table(doc: Doc, head: string[], rows: string[][], widths?: number[]) {
    const w = widths ?? head.map(() => 1 / head.length);
    const W = width(doc);
    const row = (cells: string[], bold: boolean) => {
        const heights = cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(c, { width: w[i] * W - 6 }));
        const h = Math.max(...heights) + 6;
        ensure(doc, h + 2);
        const y = doc.y;
        let x = M;
        cells.forEach((c, i) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? C.mute : C.ink).text(c, x + 3, y + 3, { width: w[i] * W - 6 }); x += w[i] * W; });
        doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.4).strokeColor(C.line).stroke();
        doc.y = y + h;
    };
    row(head, true);
    for (const r of rows) row(r, false);
    doc.moveDown(0.5);
}

/** Line chart: x = index or time, several series; never connects across nulls. */
function lineChart(doc: Doc, o: { title: string; yUnit: string; labels: string[]; series: { name: string; color: string; values: (number | null)[] }[]; refLines?: { y: number; label: string }[]; height?: number }) {
    const H = o.height ?? 150, W = width(doc), left = M + 34, right = M + W - 6, top0 = 18;
    ensure(doc, H + 40);
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(o.title, M, y0);
    const all = [...o.series.flatMap((s) => s.values), ...(o.refLines ?? []).map((r) => r.y)].filter((v): v is number => v !== null && Number.isFinite(v));
    if (!all.length) { doc.font('Helvetica').fontSize(8.5).fillColor(C.mute).text('No data in this period.', M, y0 + 16); doc.y = y0 + 34; return; }
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const top = y0 + top0, bottom = y0 + H;
    const n = Math.max(1, o.labels.length - 1);
    const X = (i: number) => left + (i / n) * (right - left);
    const Y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    // axes and ticks
    doc.lineWidth(0.4).strokeColor(C.line);
    for (let k = 0; k <= 4; k++) {
        const v = lo + ((hi - lo) * k) / 4, yy = Y(v);
        doc.moveTo(left, yy).lineTo(right, yy).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(C.faint).text(v.toFixed(Math.abs(hi - lo) < 5 ? 2 : 0), M, yy - 4, { width: 30, align: 'right' });
    }
    doc.font('Helvetica').fontSize(7).fillColor(C.mute).text(o.yUnit, M, top - 10, { width: 40 });
    const step = Math.max(1, Math.ceil(o.labels.length / 8));
    o.labels.forEach((l, i) => { if (i % step === 0) doc.font('Helvetica').fontSize(6.5).fillColor(C.faint).text(l, X(i) - 20, bottom + 3, { width: 40, align: 'center' }); });
    for (const r of o.refLines ?? []) {
        if (r.y < lo || r.y > hi) continue;
        doc.save().dash(3, { space: 2 }).lineWidth(0.7).strokeColor(C.red).moveTo(left, Y(r.y)).lineTo(right, Y(r.y)).stroke().undash().restore();
        doc.font('Helvetica').fontSize(6.5).fillColor(C.red).text(r.label, right - 120, Y(r.y) - 9, { width: 118, align: 'right' });
    }
    for (const s of o.series) {
        doc.lineWidth(1).strokeColor(s.color);
        let pen = false;
        s.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) { pen = false; return; }
            if (!pen) { doc.moveTo(X(i), Y(v)); pen = true; } else doc.lineTo(X(i), Y(v));
        });
        doc.stroke();
    }
    // legend
    let lx = left;
    for (const s of o.series) {
        doc.rect(lx, bottom + 14, 8, 3).fill(s.color);
        doc.font('Helvetica').fontSize(7).fillColor(C.mute).text(s.name, lx + 11, bottom + 11, { width: 90 });
        lx += 14 + doc.widthOfString(s.name) + 10;
    }
    doc.y = bottom + 26;
}

/** Bar chart of one series. */
function barChart(doc: Doc, o: { title: string; yUnit: string; labels: string[]; values: (number | null)[]; color?: string; height?: number }) {
    const H = o.height ?? 130, W = width(doc), left = M + 34, right = M + W - 6;
    ensure(doc, H + 30);
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(o.title, M, y0);
    const vals = o.values.filter((v): v is number => v !== null);
    if (!vals.length) { doc.font('Helvetica').fontSize(8.5).fillColor(C.mute).text('No data in this period.', M, y0 + 16); doc.y = y0 + 34; return; }
    const hi = Math.max(...vals) * 1.1 || 1, top = y0 + 18, bottom = y0 + H;
    const bw = (right - left) / o.values.length;
    doc.lineWidth(0.4).strokeColor(C.line);
    for (let k = 0; k <= 4; k++) {
        const v = (hi * k) / 4, yy = bottom - (v / hi) * (bottom - top);
        doc.moveTo(left, yy).lineTo(right, yy).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(C.faint).text(v.toFixed(0), M, yy - 4, { width: 30, align: 'right' });
    }
    doc.font('Helvetica').fontSize(7).fillColor(C.mute).text(o.yUnit, M, top - 10, { width: 40 });
    const step = Math.max(1, Math.ceil(o.labels.length / 10));
    o.values.forEach((v, i) => {
        if (v !== null) { const hh = (v / hi) * (bottom - top); doc.rect(left + i * bw + 1, bottom - hh, Math.max(1, bw - 2), hh).fill(o.color ?? C.blue); }
        if (i % step === 0) doc.font('Helvetica').fontSize(6.5).fillColor(C.faint).text(o.labels[i], left + i * bw - 10, bottom + 3, { width: bw + 20, align: 'center' });
    });
    doc.y = bottom + 16;
}

// ── Sections ────────────────────────────────────────────────────────────────
function cover(doc: Doc, kind: Kind, ds: any, meta: { revision: number; status: string; reason?: string | null }) {
    const a = ds.assessment;
    doc.rect(0, 0, doc.page.width, 6).fill(C.blue);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.blue).text('GridIQ', M, M);
    doc.moveDown(1.2).font('Helvetica-Bold').fontSize(20).fillColor(C.ink).text(TITLES[kind]);
    doc.font('Helvetica').fontSize(12).fillColor(C.mute).text(`${a.client} · ${a.site}`);
    doc.moveDown(0.8);
    if (ds.provisional) {
        const by = doc.y;
        doc.rect(M, by, width(doc), 26).fill('#fef3c7');
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.amber).text('PROVISIONAL: the assessment is still running. Results cover the elapsed period only and are not final.', M + 8, by + 8, { width: width(doc) - 16 });
        doc.y = by + 36;
    }
    kv(doc, [
        ['Assessment', `${a.reference}${a.package ? ` · ${a.package}` : ''}`],
        ['Report', `revision ${meta.revision}${meta.status === 'published' ? ' · issued' : ` · ${meta.status}`}`],
        ['Observation period (SAST)', `${fmtT(a.period_from)} → ${fmtT(a.period_to)}`],
        ['Observed', `${f(a.observed_days, 'days', 2)} of ${a.duration_days}`],
        ['Site address', a.address ?? '–'],
        ['Measurement points', ds.points.map((x: any) => `${x.name} (${x.role})`).join(', ') || '–'],
    ]);
    if (meta.revision > 1 && meta.reason) note(doc, `This revision replaces revision ${meta.revision - 1}: ${meta.reason}`);
}

function coverageTable(doc: Doc, ds: any) {
    table(doc, ['Point', 'Coverage', 'Samples', 'Reporting interval', 'Gaps ≥ 30 min', 'Meter'],
        ds.points.map((x: any) => [x.name, x.coverage.fraction === null ? '–' : `${(x.coverage.fraction * 100).toFixed(1)} %`, f(x.coverage.samples),
            `${f(x.coverage.median_spacing_s, 's')}`, String(x.coverage.gaps.length), x.deployments.map((d: any) => d.device ?? 'device').join(', ')]),
        [0.24, 0.13, 0.13, 0.17, 0.13, 0.2]);
    note(doc, 'Coverage = samples received × the meter’s median reporting interval ÷ the observation window. Missing data is never filled or shown as zero.');
}

const SEV: Record<string, [string, string]> = { act: ['Act', C.red], investigate: ['Investigate', C.amber], note: ['Note', C.mute] };

function overview(doc: Doc, ds: any) {
    h1(doc, '1. Executive findings');
    if (!ds.executive.length) p(doc, 'Nothing significant was found in this period: demand, power factor, voltage and distortion stayed within the screening thresholds at every point with sufficient data.');
    for (const e of ds.executive) bullet(doc, `${SEV[e.severity][0]} (${e.point}, confidence ${e.confidence}; for: ${e.who}): ${e.text}`, SEV[e.severity][1]);

    h1(doc, '2. Installation and measurement boundary');
    table(doc, ['Point', 'Role', 'Nominal', 'CT primary', 'Contracted MDI', 'Device · installed (SAST)'],
        ds.points.map((x: any) => [x.name, x.role, f(x.nominal_voltage_v, 'V'), f(x.ct_primary_a, 'A'), f(x.contracted_mdi_kva, 'kVA'),
            x.deployments.map((d: any) => `${d.device ?? 'device'} · ${fmtT(d.installed_at)}${d.sign === -1 ? ' · sign corrected' : ''}`).join('\n')]),
        [0.18, 0.11, 0.11, 0.12, 0.14, 0.34]);
    coverageTable(doc, ds);
    note(doc, ds.site_totals.basis);

    h1(doc, '3. Energy, demand and operating pattern');
    for (const x of ds.points) {
        h2(doc, x.name);
        kv(doc, [
            ['Energy imported', f(x.energy.import_kwh, 'kWh')], ['Energy exported', f(x.energy.export_kwh, 'kWh')],
            ['Maximum billed demand (30 min)', `${f(x.demand.max_kva, 'kVA')}${x.demand.max_kva_at ? ` at ${fmtT(x.demand.max_kva_at)}` : ''}`],
            ['Contracted MDI', x.demand.contracted_mdi_kva ? `${f(x.demand.contracted_mdi_kva, 'kVA')} (${x.demand.utilisation === null ? '–' : `${Math.round(x.demand.utilisation * 100)} % used`})` : 'not recorded'],
            ['Highest instantaneous active power', `${f(x.instantaneous.max_kw, 'kW')}${x.instantaneous.at ? ` (minute of ${fmtT(x.instantaneous.at)})` : ''}`],
            ['Baseload (10th percentile)', f(x.patterns.baseload_kw, 'kW')],
            ['Operating-hours average', f(x.patterns.operating_avg_kw, 'kW')], ['Outside operating hours', f(x.patterns.outside_avg_kw, 'kW')],
        ]);
        lineChart(doc, { title: 'Average day (active power by hour, SAST)', yUnit: 'kW', labels: Array.from({ length: 24 }, (_, h) => `${h}:00`),
            series: [{ name: 'Weekday', color: C.blue, values: x.patterns.weekday_kw_by_hour }, { name: 'Weekend', color: C.green, values: x.patterns.weekend_kw_by_hour }] });
        barChart(doc, { title: 'Daily maximum active power (SAST days)', yUnit: 'kW', labels: x.daily.map((d: any) => d.date.slice(5)), values: x.daily.map((d: any) => d.max_kw) });
        note(doc, `${x.patterns.basis}. Instantaneous peaks are shown separately from billed (30-minute) demand.`);
    }

    h1(doc, '4. Electrical summary');
    for (const x of ds.points) {
        const pq = x.power_quality;
        const vr = pq.voltage.map((v: any) => `${v.phase} ${f(v.min)}–${f(v.max)} V`).join(', ') || 'no voltage data';
        bullet(doc, `${x.name}: voltage ${vr}; THD-V p95 ${pq.thd_v ? pq.thd_v.map((t: any) => `${t.phase} ${f(t.p95, '%', 1)}`).join(', ') : 'not measured'}; PF (loaded) ${pq.pf ? f(pq.pf.avg_loaded, '', 3) : '–'}; ${pq.interruption_minutes} minute(s) below ${23} V.`);
    }
    note(doc, 'Screening against NRS 048-2 thresholds; see the power-quality report for detail and the basis of every figure.');

    h1(doc, '5. Notable events and data limitations');
    for (const l of ds.limitations) bullet(doc, l, C.mute);
    const ev = ds.points.reduce((s: number, x: any) => s + x.power_quality.events.count, 0);
    p(doc, `${ev} voltage/frequency excursion event(s) recorded; ${ds.points[0]?.power_quality.events.source ?? ''}.`);

    h1(doc, '6. Prioritised actions');
    const acts = ds.executive.filter((e: any) => e.severity !== 'note');
    if (!acts.length) p(doc, 'No action is required from this assessment. Keep the data for comparison with later periods.');
    else table(doc, ['#', 'Action', 'Who investigates', 'Urgency', 'Confidence'],
        acts.map((e: any, i: number) => [String(i + 1), e.text, e.who, e.severity === 'act' ? 'within a month' : 'next maintenance', e.confidence]), [0.05, 0.55, 0.16, 0.13, 0.11]);

    h1(doc, '7. Feasibility-data readiness');
    p(doc, `Supplied: ${ds.feasibility_readiness.supplied.join('; ')}.`);
    if (ds.feasibility_readiness.missing.length) p(doc, `Missing inputs: ${ds.feasibility_readiness.missing.join('; ')}.`);
    note(doc, ds.feasibility_readiness.note);
}

function powerQuality(doc: Doc, ds: any) {
    h1(doc, '1. Scope and method');
    p(doc, `Ten-minute values of every measured phase across the observation period, screened against ${ds.conventions.screening.source}. Observed values, derived indicators, rule findings, possible causes and recommended verification are kept separate below.`);
    coverageTable(doc, ds);
    for (const x of ds.points) {
        const pq = x.power_quality;
        h1(doc, `${x.name}`);
        p(doc, `Verdict type: ${pq.verdict.type === 'formal' ? 'formal NRS 048-2 assessment' : 'screening only'}. ${pq.verdict.reason}`, { color: pq.verdict.type === 'formal' ? C.green : C.amber });

        h2(doc, 'Voltage (observed)');
        table(doc, ['Phase', 'Min (V)', 'Max (V)', 'P5 (V)', 'P95 (V)', `Outside ±10 % of ${pq.nominal_v} V`, '10-min values'],
            pq.voltage.map((v: any) => [v.phase, f(v.min), f(v.max), f(v.p05), f(v.p95), `${f(v.outside_pct, '%', 1)}`, f(v.values)]));
        const ser = x.hourly_series;
        const lbl = ser.t.map((t: string) => fmtT(t).slice(5, 10));
        lineChart(doc, { title: 'Phase voltage, hourly averages (SAST)', yUnit: 'V', labels: lbl,
            series: [{ name: 'L1', color: C.phase[0], values: ser.v_a }, { name: 'L2', color: C.phase[1], values: ser.v_b }, { name: 'L3', color: C.phase[2], values: ser.v_c }],
            refLines: [{ y: pq.nominal_v * 0.9, label: `−10 % (${(pq.nominal_v * 0.9).toFixed(0)} V)` }, { y: pq.nominal_v * 1.1, label: `+10 % (${(pq.nominal_v * 1.1).toFixed(0)} V)` }] });

        // Harmonic section: depth follows the evidence and the meter's capability.
        const thdIssue = (pq.thd_v ?? []).some((t: any) => t.p95 !== null && t.p95 > ds.conventions.screening.thd_v_pct);
        h2(doc, thdIssue ? 'Harmonic distortion: a finding' : 'Harmonic distortion');
        if (!pq.thd_v) p(doc, 'THD of voltage was not measured at this point.');
        else {
            table(doc, ['Phase', 'THD-V P95 (%)', 'THD-V max (%)', `10-min values > ${ds.conventions.screening.thd_v_pct} %`, 'Worst hours (SAST)'],
                pq.thd_v.map((t: any) => [t.phase, f(t.p95, '', 2), f(t.max, '', 2), `${f(t.over_limit_pct, '%', 1)}`, t.worst_hours.map((h: number) => `${h}:00`).join(', ')]));
            if (thdIssue || pq.thd_v.some((t: any) => (t.p95 ?? 0) > 5)) {
                lineChart(doc, { title: 'Voltage THD per phase, hourly averages (SAST)', yUnit: '%', labels: lbl,
                    series: [{ name: 'L1', color: C.phase[0], values: ser.thd_v_a }, { name: 'L2', color: C.phase[1], values: ser.thd_v_b }, { name: 'L3', color: C.phase[2], values: ser.thd_v_c }],
                    refLines: [{ y: ds.conventions.screening.thd_v_pct, label: `NRS 048-2 screening ${ds.conventions.screening.thd_v_pct} %` }] });
            }
            if (pq.thd_i) p(doc, `Current THD (P95): ${pq.thd_i.map((t: any) => `${t.phase} ${f(t.p95, '%', 1)}`).join(', ')}. THD-I is relative to the present current, not TDD: no IEEE 519 conclusion is drawn without the demand current and fault level.`);
            p(doc, `Individual orders: ${pq.harmonic_orders.reason}`, { color: C.mute });
            if (thdIssue) {
                h2(doc, 'Possible causes (hypotheses, to verify)');
                bullet(doc, 'Non-linear loads on site: variable-speed drives, rectifiers, UPS, LED lighting. Distortion that follows the site’s operating hours points this way.');
                bullet(doc, 'Background distortion from the supply network: distortion present outside operating hours, or at a similar level on all phases, points this way.');
                bullet(doc, 'Resonance with PF-correction capacitors (if installed and not detuned) can amplify a harmonic order.');
                h2(doc, 'Recommended follow-up measurements');
                bullet(doc, 'Log individual voltage and current harmonic orders (at least 3, 5, 7, 11, 13) per phase for one week at the incomer and the main suspected feeders.');
                bullet(doc, 'Record the transformer rating and the fault level at the point of supply; list drives and capacitor banks with their ratings.');
                note(doc, 'No filter or capacitor size is recommended from THD data alone; that needs an engineering study.');
            } else if (pq.thd_v) p(doc, 'Voltage distortion stayed within the screening threshold in this period.');
        }

        h2(doc, 'Power factor and reactive demand');
        if (!pq.pf) p(doc, 'Power factor was not available while loaded.');
        else p(doc, `Average power factor while loaded ${f(pq.pf.avg_loaded, '', 3)}; 5th percentile ${f(pq.pf.p05, '', 3)}; ${Math.round((pq.pf.share_below_min ?? 0) * 100)} % of loaded 10-minute values below ${ds.conventions.screening.pf_min}. Low PF increases kVA and reactive charges; it is not a supply-quality breach.`);
        lineChart(doc, { title: 'Power factor, hourly averages (SAST)', yUnit: 'PF', labels: lbl, series: [{ name: 'PF', color: C.blue, values: ser.pf }],
            refLines: [{ y: ds.conventions.screening.pf_min, label: `${ds.conventions.screening.pf_min}` }], height: 110 });

        h2(doc, 'Unbalance, frequency, interruptions and events');
        p(doc, `Voltage unbalance P95 ${f(pq.unbalance.voltage_p95, '%', 2)}; current unbalance P95 ${f(pq.unbalance.current_p95, '%', 1)} (${pq.unbalance.metric}). Frequency ${f(pq.frequency.min, 'Hz', 2)}–${f(pq.frequency.max, 'Hz', 2)}; ${pq.frequency.outside_values} 10-minute value(s) outside ${ds.conventions.screening.f_low}–${ds.conventions.screening.f_high} Hz. ${pq.interruption_minutes} minute(s) with voltage below ${ds.conventions.screening.interruption_v} V.`);
        p(doc, `${pq.events.count} excursion event(s). Source: ${pq.events.source}. ${pq.events.capability}.`, { color: C.mute });
        if (pq.events.list.length) table(doc, ['Start (SAST)', 'Type', 'Channel', 'Duration', 'Extreme'],
            pq.events.list.slice(0, 15).map((e: any) => [fmtT(e.started_at), e.type, e.phase ?? '–', f(e.duration_s, 's', 0), f(e.extreme, '', 1)]));

        if (x.findings.length) {
            h2(doc, 'Rule findings for this point');
            table(doc, ['Finding', 'Observed', 'Recommended verification', 'Review'],
                x.findings.map((g: any) => [g.title, g.observed ?? '–', g.recommended_verification ?? '–', g.review_status === 'published' ? 'reviewed' : 'not yet reviewed']), [0.22, 0.32, 0.32, 0.14]);
        }
    }
}

function handover(doc: Doc, ds: any) {
    h1(doc, '1. What is supplied');
    p(doc, 'Measured data for an independent feasibility study. GridIQ does not size PV, batteries or generators and makes no savings claim; the receiving engineer applies their own tariffs, assumptions and models.');
    for (const s of ds.feasibility_readiness.supplied) bullet(doc, s);
    h2(doc, 'Files in the data package');
    table(doc, ['File', 'Content'], [
        ['manifest.json', 'IDs, period, conventions, units, file list with SHA-256 checksums'],
        ['load_profile_30min.csv', '30-minute kW, kVA, coverage per point (period-ending rows)'],
        ['readings_1min.csv', '1-minute averages of the core channels per point'],
        ['daily_energy.csv', 'SAST daily energy and peaks per point'],
        ['findings.csv', 'rule findings with evidence and review state'],
        ['*.pdf', 'overview and power-quality reports (where issued)'],
    ], [0.3, 0.7]);
    h1(doc, '2. Metering topology and limits');
    table(doc, ['Point', 'Role', 'Parent', 'Coverage', 'Import (kWh)', 'Max demand (kVA)'],
        ds.points.map((x: any) => [x.name, x.role, x.parent_point_id ? 'sub-meter' : 'top level', x.coverage.fraction === null ? '–' : `${(x.coverage.fraction * 100).toFixed(1)} %`, f(x.energy.import_kwh), f(x.demand.max_kva)]));
    p(doc, ds.site_totals.basis);
    for (const l of ds.limitations) bullet(doc, l, C.mute);
    h1(doc, '3. Relevant power-quality concerns');
    const pqItems = ds.executive.filter((e: any) => e.evidence.startsWith('power_quality'));
    if (!pqItems.length) p(doc, 'None that affect equipment selection were found in this period.');
    for (const e of pqItems) bullet(doc, `${e.point}: ${e.text}`);
    h1(doc, '4. Operating context and missing inputs');
    const ctx = ds.site_context ?? {};
    kv(doc, Object.entries(ctx).slice(0, 12).map(([k, v]) => [k.replace(/_/g, ' '), String(v)] as [string, string]));
    if (ds.feasibility_readiness.missing.length) p(doc, `Still missing: ${ds.feasibility_readiness.missing.join('; ')}.`);
}

function appendix(doc: Doc, ds: any, meta: { sha256: string; generatedAt: Date }) {
    doc.addPage();
    h1(doc, 'Technical appendix');
    kv(doc, [
        ['Dataset schema', ds.schema], ['Dataset SHA-256', meta.sha256.slice(0, 32) + '…'],
        ['Calculation version', ds.versions.calc], ['Rule version', ds.versions.rules],
        ['Template version', ds.versions.template], ['Data cutoff (SAST)', fmtT(ds.data_cutoff_at)],
        ['Generated (SAST)', fmtT(meta.generatedAt)], ['Time convention', ds.conventions.intervals],
    ]);
    h2(doc, 'Method');
    bullet(doc, 'Readings are attributed to a measurement point by deployment window at the measurement time; buckets that straddle an install or removal are recomputed from the samples inside the window.');
    bullet(doc, 'Energy from cumulative kWh register differences per deployment; a negative step is a register reset and never summed through; power integration only where registers are absent.');
    bullet(doc, 'Billed demand: 30-minute minute-weighted kVA averages; instantaneous peaks are reported separately.');
    bullet(doc, `Power quality: 10-minute values screened against ${ds.conventions.screening.source}.`);
    bullet(doc, `Sign convention: ${ds.conventions.sign}. Times in the data are UTC; this report shows SAST (UTC+2).`);
    note(doc, `Full SHA-256 of the dataset: ${meta.sha256}`);
}

function footers(doc: Doc, ds: any, kind: Kind, meta: { revision: number }) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Writing inside the bottom margin would otherwise start a new page.
        doc.page.margins.bottom = 0;
        const y = doc.page.height - M + 14;
        doc.font('Helvetica').fontSize(7).fillColor(C.faint)
            .text(`GridIQ · ${ds.assessment.reference} · ${TITLES[kind]} · rev ${meta.revision}${ds.provisional ? ' · PROVISIONAL' : ''}`, M, y, { width: width(doc) - 60, lineBreak: false })
            .text(`page ${i + 1} of ${range.count}`, M + width(doc) - 60, y, { width: 60, align: 'right', lineBreak: false });
    }
}

/** Characters outside WinAnsi (the standard PDF fonts) replaced by plain equivalents. */
export function winAnsi(t: string): string {
    return t.replace(/\u2192/g, '->').replace(/\u2265/g, '>=').replace(/\u2264/g, '<=').replace(/\u2212/g, '-').replace(/\u2248/g, '~')
        .replace(/[\u2009\u202f]/g, ' ')
        .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u20ac]/g, '?');
}
