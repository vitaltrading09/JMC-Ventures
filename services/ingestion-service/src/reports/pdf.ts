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
// Layout (engineering UI brief sections 10-11): A4, ~20 mm margins, 10.5 pt
// body, cover with contents, an executive assessment page, finding-led
// headings, small tables kept whole and long ones repeating their header,
// headings kept with their content, PDF bookmarks, "page X of Y", numbered
// figures with captions, methods in the appendix.
// ─────────────────────────────────────────────────────────────────────────────

import PDFDocument from 'pdfkit';
import { buildSummary } from './summary';

type Doc = InstanceType<typeof PDFDocument>;
type Kind = 'overview' | 'power_quality' | 'handover';

const C = { ink: '#0f172a', mute: '#475569', faint: '#94a3b8', line: '#cbd5e1', blue: '#1d4ed8', green: '#047857', amber: '#b45309', red: '#b91c1c',
    phase: ['#b91c1c', '#ca8a04', '#1d4ed8'] };
const M = 57; // margin, ~20 mm
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
            heads = []; figure = 0; contentsAt = null;
            cover(doc, kind, ds, meta);
            if (kind !== 'handover') executive(doc, ds);
            if (kind === 'overview') overview(doc, ds);
            if (kind === 'power_quality') powerQuality(doc, ds);
            if (kind === 'handover') handover(doc, ds);
            appendix(doc, ds, meta);
            contents(doc);
            footers(doc, ds, kind, meta);
            doc.end();
        } catch (e) { reject(e); }
    });
}

// ── Building blocks ─────────────────────────────────────────────────────────
const width = (doc: Doc) => doc.page.width - 2 * M;
const BODY = 10.5;
const limit = (doc: Doc) => doc.page.height - M - 24;
const pageNo = (doc: Doc) => { const r = doc.bufferedPageRange(); return r.start + r.count - 1; };
function ensure(doc: Doc, h: number) { if (doc.y + h > limit(doc)) doc.addPage(); }
/** Headings collected for the contents panel; each is also a PDF bookmark. */
let heads: { title: string; page: number }[] = [];
let figure = 0;
let contentsAt: { page: number; y: number } | null = null;
// A heading is kept with roughly its first block of content.
function h1(doc: Doc, t: string) {
    ensure(doc, 120);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(17).fillColor(C.ink).text(t, M);
    doc.moveDown(0.35);
    heads.push({ title: t, page: pageNo(doc) });
    (doc as any).outline?.addItem(winAnsi(t));
}
function h2(doc: Doc, t: string) { ensure(doc, 90); doc.moveDown(0.5).font('Helvetica-Bold').fontSize(12.5).fillColor(C.ink).text(t, M); doc.moveDown(0.25); }
function p(doc: Doc, t: string, o: { color?: string; size?: number } = {}) {
    const size = o.size ?? BODY;
    const h = doc.font('Helvetica').fontSize(size).heightOfString(winAnsi(t), { width: width(doc), lineGap: 2 });
    ensure(doc, Math.min(h, 60));
    doc.font('Helvetica').fontSize(size).fillColor(o.color ?? C.ink).text(t, M, doc.y, { width: width(doc), lineGap: 2 });
    doc.moveDown(0.4);
}
function note(doc: Doc, t: string) { p(doc, t, { color: C.mute, size: 9 }); }
function bullet(doc: Doc, t: string, color = C.ink) {
    const h = doc.font('Helvetica').fontSize(BODY).heightOfString(winAnsi(t), { width: width(doc) - 14, lineGap: 2 });
    ensure(doc, Math.min(h, 60) + 4);
    const y = doc.y;
    doc.circle(M + 3, y + 6, 1.8).fill(color);
    doc.font('Helvetica').fontSize(BODY).fillColor(C.ink).text(t, M + 14, y, { width: width(doc) - 14, lineGap: 2 });
    doc.moveDown(0.3);
}
/** Key/value grid in two columns. */
function kv(doc: Doc, rows: [string, string][]) {
    const colW = width(doc) / 2;
    for (let i = 0; i < rows.length; i += 2) {
        ensure(doc, 16);
        const y = doc.y;
        for (let j = 0; j < 2 && i + j < rows.length; j++) {
            const [k, v] = rows[i + j];
            doc.font('Helvetica').fontSize(9).fillColor(C.mute).text(k, M + j * colW, y, { width: colW - 10 });
            doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.ink).text(v, M + j * colW, y + 12, { width: colW - 10 });
        }
        doc.y = y + 32;
    }
}
/**
 * A table with a header row; column widths as fractions. Tables of up to 10
 * rows are kept on one page (no stranded phase row); longer tables break
 * between rows and repeat the header on the next page.
 */
function table(doc: Doc, head: string[], rows: string[][], widths?: number[]) {
    const w = widths ?? head.map(() => 1 / head.length);
    const W = width(doc), FS = 9;
    const heightOf = (cells: string[], bold: boolean) =>
        Math.max(...cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS).heightOfString(winAnsi(c), { width: w[i] * W - 8 }))) + 8;
    const draw = (cells: string[], bold: boolean, h: number) => {
        const y = doc.y;
        if (bold) doc.rect(M, y, W, h).fill('#f1f5f9');
        let x = M;
        cells.forEach((c, i) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS).fillColor(bold ? C.mute : C.ink).text(c, x + 4, y + 4, { width: w[i] * W - 8 }); x += w[i] * W; });
        doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.4).strokeColor(C.line).stroke();
        doc.y = y + h;
    };
    const hh = heightOf(head, true);
    const hs = rows.map((r) => heightOf(r, false));
    const total = hh + hs.reduce((a, b) => a + b, 0);
    ensure(doc, rows.length <= 10 ? Math.min(total, limit(doc) - M) : hh + (hs[0] ?? 0) + (hs[1] ?? 0));
    draw(head, true, hh);
    rows.forEach((r, i) => {
        if (doc.y + hs[i] > limit(doc)) { doc.addPage(); draw(head, true, hh); }
        draw(r, false, hs[i]);
    });
    doc.moveDown(0.6);
}

/** Line chart: x = index or time, several series; never connects across nulls. */
function lineChart(doc: Doc, o: { title: string; yUnit: string; labels: string[]; series: { name: string; color: string; values: (number | null)[]; dash?: number }[]; refLines?: { y: number; label: string }[]; height?: number; caption?: string }) {
    const H = o.height ?? 180, W = width(doc), left = M + 38, right = M + W - 6, top0 = 32;
    ensure(doc, H + 60);
    figure++;
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(`Figure ${figure}. ${o.title}`, M, y0);
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
        doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(v.toFixed(Math.abs(hi - lo) < 5 ? 2 : 0), M, yy - 4, { width: 34, align: 'right' });
    }
    doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(o.yUnit, M, top - 11, { width: 40 });
    const step = Math.max(1, Math.ceil(o.labels.length / 8));
    o.labels.forEach((l, i) => { if (i % step === 0) doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(l, X(i) - 24, bottom + 3, { width: 48, align: 'center' }); });
    for (const r of o.refLines ?? []) {
        if (r.y < lo || r.y > hi) continue;
        doc.save().dash(3, { space: 2 }).lineWidth(0.7).strokeColor(C.red).moveTo(left, Y(r.y)).lineTo(right, Y(r.y)).stroke().undash().restore();
        doc.font('Helvetica').fontSize(8).fillColor(C.red).text(r.label, right - 160, Y(r.y) - 10, { width: 158, align: 'right' });
    }
    for (const s of o.series) {
        doc.save();
        if (s.dash) doc.dash(s.dash, { space: s.dash * 0.6 });
        doc.lineWidth(1.3).strokeColor(s.color);
        let pen = false;
        s.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) { pen = false; return; }
            if (!pen) { doc.moveTo(X(i), Y(v)); pen = true; } else doc.lineTo(X(i), Y(v));
        });
        doc.stroke();
        doc.undash().restore();
    }
    // Legend: colour and dash, so it also reads in grayscale.
    let lx = left;
    for (const s of o.series) {
        doc.save();
        if (s.dash) doc.dash(s.dash, { space: s.dash * 0.6 });
        doc.lineWidth(1.6).strokeColor(s.color).moveTo(lx, bottom + 22).lineTo(lx + 16, bottom + 22).stroke();
        doc.undash().restore();
        doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(s.name, lx + 20, bottom + 18, { width: 160, lineBreak: false });
        lx += 30 + doc.widthOfString(s.name) + 10;
    }
    doc.y = bottom + 32;
    if (o.caption) note(doc, o.caption);
}
/** Phase styling shared with the website (apps/web lib/summary.ts PHASE): colour and dash. */
const PH = [{ name: 'L1 (A)', color: C.phase[0] }, { name: 'L2 (B)', color: C.phase[1], dash: 5 }, { name: 'L3 (C)', color: C.phase[2], dash: 2 }];

/** Bar chart of one series. */
function barChart(doc: Doc, o: { title: string; yUnit: string; labels: string[]; values: (number | null)[]; color?: string; height?: number }) {
    const H = o.height ?? 150, W = width(doc), left = M + 38, right = M + W - 6;
    ensure(doc, H + 40);
    figure++;
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(`Figure ${figure}. ${o.title}`, M, y0);
    const vals = o.values.filter((v): v is number => v !== null);
    if (!vals.length) { doc.font('Helvetica').fontSize(8.5).fillColor(C.mute).text('No data in this period.', M, y0 + 16); doc.y = y0 + 34; return; }
    const hi = Math.max(...vals) * 1.1 || 1, top = y0 + 30, bottom = y0 + H;
    const bw = (right - left) / o.values.length;
    doc.lineWidth(0.4).strokeColor(C.line);
    for (let k = 0; k <= 4; k++) {
        const v = (hi * k) / 4, yy = bottom - (v / hi) * (bottom - top);
        doc.moveTo(left, yy).lineTo(right, yy).stroke();
        doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(v.toFixed(0), M, yy - 4, { width: 34, align: 'right' });
    }
    doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(o.yUnit, M, top - 11, { width: 40 });
    const step = Math.max(1, Math.ceil(o.labels.length / 10));
    o.values.forEach((v, i) => {
        if (v !== null) { const hh = (v / hi) * (bottom - top); doc.rect(left + i * bw + 1, bottom - hh, Math.max(1, bw - 2), hh).fill(o.color ?? C.blue); }
        if (i % step === 0) doc.font('Helvetica').fontSize(8).fillColor(C.mute).text(o.labels[i], left + i * bw - 14, bottom + 3, { width: bw + 28, align: 'center' });
    });
    doc.y = bottom + 20;
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
    note(doc, 'Prepared by GridIQ from measured data. No engineer’s sign-off is implied unless a named reviewer appears on this page.');
    contentsAt = { page: pageNo(doc), y: doc.y + 12 };
}

/** A compact contents panel on the cover, written once the page numbers are known. */
function contents(doc: Doc) {
    if (!contentsAt || !heads.length) return;
    doc.switchToPage(contentsAt.page);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    let y = contentsAt.y;
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(C.ink).text('Contents', M, y, { lineBreak: false });
    y += 22;
    for (const hd of heads) {
        if (y > doc.page.height - M - 40) break;
        doc.font('Helvetica').fontSize(10.5).fillColor(C.ink).text(hd.title, M, y, { width: width(doc) - 50, lineBreak: false });
        doc.text(String(hd.page + 1), M + width(doc) - 40, y, { width: 40, align: 'right', lineBreak: false });
        doc.moveTo(M, y + 15).lineTo(M + width(doc), y + 15).lineWidth(0.3).strokeColor(C.line).stroke();
        y += 20;
    }
    doc.page.margins.bottom = bottom;
}

/** Executive assessment (brief section 10): main messages, key numbers, priorities, limits. */
function executive(doc: Doc, ds: any) {
    doc.addPage();
    const s = buildSummary(ds);
    h1(doc, 'Executive assessment');
    if (s.context.point) note(doc, `Main measurement point: ${s.context.point.name}. Period ${fmtT(s.context.period_from)} to ${fmtT(s.context.period_to)} SAST.`);
    for (const g of s.glance) p(doc, g, { size: 12 });
    h2(doc, 'Key numbers');
    kv(doc, s.metrics.map((m) => [m.label, m.value === null ? '–' : `${m.key === 'energy' ? m.value.toLocaleString('en-ZA', { maximumFractionDigits: 0 }) : m.value} ${m.unit}`] as [string, string]));
    note(doc, s.metrics.map((m) => `${m.label}: ${m.definition}`).join(' '));
    h2(doc, 'Assessment by area');
    table(doc, ['Area', 'Status', 'Basis'], s.categories.map((c) => [c.title, c.label, c.reason]), [0.24, 0.2, 0.56]);
    h2(doc, 'Immediate priorities');
    if (!s.findings.length) p(doc, 'No observation needs follow-up from the measurements so far.');
    s.findings.forEach((x: any, i: number) => bullet(doc, `${i + 1}. ${x.text} Next: ${x.next} (${x.who}; ${x.confidence} confidence)`, SEV[x.severity][1]));
    h2(doc, 'Important measurement limits');
    for (const l of ds.limitations.filter((x: string) => !/^PROVISIONAL/.test(x)).slice(0, 3)) bullet(doc, l, C.mute);
}

function coverageTable(doc: Doc, ds: any) {
    table(doc, ['Point', 'Coverage', '10-min slots measured', 'Samples', 'Reporting interval', 'Gaps ≥ 30 min'],
        ds.points.map((x: any) => [x.name, x.coverage.fraction === null ? '–' : `${(x.coverage.fraction * 100).toFixed(1)} %`,
            x.coverage.expected_slots !== undefined ? `${f(x.coverage.slots_with_data)} of ${f(x.coverage.expected_slots)}` : f(x.coverage.ten_minute_values),
            f(x.coverage.samples),
            x.coverage.mixed_cadence ? `mixed: ${x.coverage.cadences.map((c: any) => `~${c.approx_interval_s} s`).join(', ')}` : f(x.coverage.median_spacing_s, 's'),
            String(x.coverage.gaps.length)]),
        [0.22, 0.12, 0.18, 0.12, 0.22, 0.14]);
    note(doc, `Coverage: ${ds.points[0]?.coverage.basis ?? 'samples received against the observation window'}. Missing data is never filled or shown as zero.`);
}

const SEV: Record<string, [string, string]> = { act: ['Act', C.red], investigate: ['Investigate', C.amber], note: ['Note', C.mute] };

function overview(doc: Doc, ds: any) {
    h1(doc, '1. Findings by point');
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
        const tw = x.patterns.typical_weekday, te = x.patterns.typical_weekend;
        lineChart(doc, { title: 'Operating fingerprint: typical day (hourly kW, SAST)', yUnit: 'kW', labels: Array.from({ length: 24 }, (_, h) => `${h}:00`),
            series: tw ? [
                { name: `Weekday median (${tw.days} d)`, color: C.blue, values: tw.hours.map((h: any) => h.median) },
                ...(tw.band ? [{ name: 'Weekday P10', color: C.faint, values: tw.hours.map((h: any) => h.p10), dash: 2 }, { name: 'Weekday P90', color: C.faint, values: tw.hours.map((h: any) => h.p90), dash: 2 }] : []),
                ...(te && te.days ? [{ name: `Weekend median (${te.days} d)`, color: C.green, values: te.hours.map((h: any) => h.median), dash: 5 }] : []),
            ] : [{ name: 'Weekday', color: C.blue, values: x.patterns.weekday_kw_by_hour }, { name: 'Weekend', color: C.green, values: x.patterns.weekend_kw_by_hour, dash: 5 }],
            caption: tw ? tw.basis : undefined });
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

    const cases = ds.points.flatMap((x: any) => (x.findings ?? []).filter((g: any) => g.case).map((g: any) => ({ ...g, point: x.name })));
    if (cases.length) {
        h2(doc, 'Follow-up status of findings');
        table(doc, ['Finding', 'Owner', 'Status', 'Next step', 'Verification'],
            cases.map((g: any) => [`${g.title} (${g.point})`, g.case.owner ?? '–', String(g.case.status).replace(/_/g, ' '), g.case.next_step ?? '–', g.case.verification_result ? String(g.case.verification_result).replace(/_/g, ' ') : 'not yet verified']),
            [0.3, 0.14, 0.14, 0.26, 0.16]);
    }
    if ((ds.evidence ?? []).length) {
        h2(doc, 'Evidence references');
        table(doc, ['Reference', 'Point', 'Window (SAST)', 'Note'],
            ds.evidence.map((e: any, i: number) => [`E${i + 1}. ${e.title}`, e.point, `${fmtT(e.from)} → ${fmtT(e.to)}`, e.note ?? '–']), [0.3, 0.16, 0.28, 0.26]);
        note(doc, 'Windows saved in the GridIQ investigation workspace; the same windows can be opened there while the assessment data is retained.');
    }

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
        h1(doc, `2. ${x.name}`);
        p(doc, `Verdict type: ${pq.verdict.type === 'formal' ? 'formal NRS 048-2 assessment' : 'screening only'}. ${pq.verdict.reason}`, { color: pq.verdict.type === 'formal' ? C.green : C.amber });

        h2(doc, 'Voltage (observed)');
        table(doc, ['Phase', 'Min (V)', 'Max (V)', 'P5 (V)', 'P95 (V)', `Outside ±10 % of ${pq.nominal_v} V`, '10-min values'],
            pq.voltage.map((v: any) => [v.phase, f(v.min), f(v.max), f(v.p05), f(v.p95), `${f(v.outside_pct, '%', 1)}`, f(v.values)]));
        const ser = x.hourly_series;
        const lbl = ser.t.map((t: string) => fmtT(t).slice(5, 10));
        lineChart(doc, { title: 'Phase voltage, hourly averages (SAST)', yUnit: 'V', labels: lbl,
            series: [{ ...PH[0], values: ser.v_a }, { ...PH[1], values: ser.v_b }, { ...PH[2], values: ser.v_c }], caption: 'Hourly averages for readability; the table uses 10-minute values, so short excursions look smaller here.',
            refLines: [{ y: pq.nominal_v * 0.9, label: `−10 % (${(pq.nominal_v * 0.9).toFixed(0)} V)` }, { y: pq.nominal_v * 1.1, label: `+10 % (${(pq.nominal_v * 1.1).toFixed(0)} V)` }] });

        // Harmonic section: depth follows the evidence and the meter's capability.
        const thdIssue = (pq.thd_v ?? []).some((t: any) => t.p95 !== null && t.p95 > ds.conventions.screening.thd_v_pct);
        h2(doc, thdIssue ? 'Voltage distortion warrants investigation' : 'Voltage distortion within the screening reference');
        if (!pq.thd_v) p(doc, 'THD of voltage was not measured at this point.');
        else {
            table(doc, ['Phase', 'THD-V P95 (%)', 'THD-V max (%)', `10-min values > ${ds.conventions.screening.thd_v_pct} %`, 'Worst hours (SAST)'],
                pq.thd_v.map((t: any) => [t.phase, f(t.p95, '', 2), f(t.max, '', 2), `${f(t.over_limit_pct, '%', 1)}`, t.worst_hours.map((h: number) => `${h}:00`).join(', ')]));
            if (thdIssue || pq.thd_v.some((t: any) => (t.p95 ?? 0) > 5)) {
                lineChart(doc, { title: 'Voltage THD per phase, hourly averages (SAST)', yUnit: '%', labels: lbl,
                    series: [{ ...PH[0], values: ser.thd_v_a }, { ...PH[1], values: ser.thd_v_b }, { ...PH[2], values: ser.thd_v_c }], caption: 'Hourly averages; the exceedance shares in the table are counted on 10-minute values, not on these hourly points.',
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
