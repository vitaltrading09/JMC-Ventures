"use client";

import { useState, useEffect, useCallback } from "react";
import {
    ShieldCheck, ShieldAlert, ShieldX, Printer, Loader2,
    AlertTriangle, CheckCircle2, XCircle, MinusCircle, Activity,
    TrendingUp, TrendingDown, Minus, History,
} from "lucide-react";

// ── Types (mirror of the backend assessment) ─────────────────────────────────
type Status = "PASS" | "WARN" | "FAIL" | "NO_DATA";
type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

type Trend = "IMPROVING" | "STABLE" | "DEGRADING" | "NO_BASELINE";

interface ComplianceParameter {
    key: string; label: string; measured: number | null; display: string;
    limit: string; status: Status; standard: string; method: string; detail: string;
    previous: number | null; trend: Trend; trend_note: string;
}
interface EquipmentRisk {
    key: string; severity: Severity; title: string;
    finding: string; mechanism: string; action: string; standard: string;
}
interface ComplianceReport {
    meter_id: string; meter_name: string; site_name: string;
    period_days: number; readings: number; from: string; to: string;
    verdict: "COMPLIANT" | "COMPLIANT_WITH_RISK" | "NON_COMPLIANT" | "INSUFFICIENT_DATA";
    verdict_note: string;
    parameters: ComplianceParameter[];
    risks: EquipmentRisk[];
    supply_score: number; install_score: number;
    has_baseline: boolean; trend_summary: string; degrading: string[];
}
interface Meter { id: string; name: string; site_id: string; is_active?: boolean; }
interface Branding { brand_name: string | null; brand_logo_url: string | null; brand_footer: string | null; }

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

const STATUS_STYLE: Record<Status, { cls: string; icon: React.ElementType; label: string }> = {
    PASS:    { cls: "text-emerald-700 bg-emerald-50 border-emerald-200", icon: CheckCircle2,  label: "Pass" },
    WARN:    { cls: "text-amber-700   bg-amber-50   border-amber-200",   icon: AlertTriangle, label: "Watch" },
    FAIL:    { cls: "text-red-700     bg-red-50     border-red-200",     icon: XCircle,       label: "Fail" },
    NO_DATA: { cls: "text-slate-500   bg-slate-50   border-slate-200",   icon: MinusCircle,   label: "No data" },
};

const SEVERITY_STYLE: Record<Severity, { bar: string; chip: string }> = {
    CRITICAL: { bar: "bg-red-600",    chip: "text-red-700   bg-red-50   border-red-200" },
    HIGH:     { bar: "bg-orange-500", chip: "text-orange-700 bg-orange-50 border-orange-200" },
    MEDIUM:   { bar: "bg-amber-500",  chip: "text-amber-700  bg-amber-50  border-amber-200" },
    LOW:      { bar: "bg-slate-400",  chip: "text-slate-600  bg-slate-50  border-slate-200" },
};

const VERDICT: Record<string, { title: string; cls: string; icon: React.ElementType; ring: string }> = {
    COMPLIANT:           { title: "Compliant",              cls: "text-emerald-700", icon: ShieldCheck, ring: "border-emerald-300 bg-emerald-50" },
    COMPLIANT_WITH_RISK: { title: "Compliant — with risk",  cls: "text-amber-700",   icon: ShieldAlert, ring: "border-amber-300 bg-amber-50" },
    NON_COMPLIANT:       { title: "Non-compliant",          cls: "text-red-700",     icon: ShieldX,     ring: "border-red-300 bg-red-50" },
    INSUFFICIENT_DATA:   { title: "Insufficient data",      cls: "text-slate-600",   icon: MinusCircle, ring: "border-slate-300 bg-slate-50" },
};

// Trend direction is about the *metric getting better or worse*, not the number
// going up or down — the backend has already resolved that per parameter.
const TREND_STYLE: Record<Trend, { icon: React.ElementType; cls: string; label: string }> = {
    IMPROVING:   { icon: TrendingUp,   cls: "text-emerald-600", label: "Improving" },
    DEGRADING:   { icon: TrendingDown, cls: "text-red-600",     label: "Degrading" },
    STABLE:      { icon: Minus,        cls: "text-slate-400",   label: "Stable" },
    NO_BASELINE: { icon: History,      cls: "text-slate-300",   label: "Baseline" },
};

function scoreColour(s: number) {
    if (s >= 85) return "text-emerald-600";
    if (s >= 70) return "text-amber-600";
    return "text-red-600";
}
function scoreBar(s: number) {
    if (s >= 85) return "bg-emerald-500";
    if (s >= 70) return "bg-amber-500";
    return "bg-red-500";
}

export default function HealthCheckPage() {
    const [meters,   setMeters]   = useState<Meter[]>([]);
    const [meterId,  setMeterId]  = useState<string>("");
    const [days,     setDays]     = useState(7);
    const [report,   setReport]   = useState<ComplianceReport | null>(null);
    const [brand,    setBrand]    = useState<Branding | null>(null);
    const [loading,  setLoading]  = useState(true);
    const [busy,     setBusy]     = useState(false);

    // Print stylesheet — the report must come out of a printer looking like a
    // document an engineer would sign, not a screenshot of a web page.
    useEffect(() => {
        const el = document.createElement("style");
        el.id = "pq-print";
        el.innerHTML = `
            @media print {
                [data-noprint="true"] { display: none !important; }
                body { background: #fff !important; }
                .pq-page { box-shadow: none !important; margin: 0 !important; }
                .pq-break { break-inside: avoid; page-break-inside: avoid; }
                @page { margin: 14mm; size: A4 portrait; }
            }
        `;
        document.head.appendChild(el);
        return () => { el.remove(); };
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/ingestion/meters`, { credentials: "include" });
                if (res.status === 401) { window.location.href = "/login"; return; }
                const data = await res.json();
                const list: Meter[] = Array.isArray(data) ? data.filter(m => m.is_active !== false) : [];
                setMeters(list);
                if (list.length > 0) setMeterId(list[0].id);

                // Optional white-label identity for resellers/installers.
                fetch(`${API}/ingestion/branding`, { credentials: "include" })
                    .then(r => r.ok ? r.json() : null)
                    .then(b => { if (b) setBrand(b); })
                    .catch(() => { /* falls back to Grid-IQ branding */ });
            } catch { /* offline — empty state */ }
            finally { setLoading(false); }
        })();
    }, []);

    const runCheck = useCallback(async () => {
        if (!meterId) return;
        setBusy(true);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/compliance?days=${days}`, {
                credentials: "include",
            });
            setReport(res.ok ? await res.json() : null);
        } catch { setReport(null); }
        finally { setBusy(false); }
    }, [meterId, days]);

    useEffect(() => { if (meterId) runCheck(); }, [meterId, days, runCheck]);

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    const v = report ? VERDICT[report.verdict] : null;
    const VIcon = v?.icon ?? ShieldCheck;

    return (
        // Escape the dark dashboard chrome — this is a printable white document.
        <div className="-m-4 sm:-m-6 lg:-m-8 bg-slate-100 min-h-screen">

            {/* ── Controls (never printed) ──────────────────────────────── */}
            <div data-noprint="true" className="bg-slate-900 border-b border-slate-800 px-6 py-4">
                <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-3">
                    <div className="mr-auto">
                        <h1 className="text-lg font-bold text-white">Power Quality Health Check</h1>
                        <p className="text-xs text-slate-400">
                            NRS 048-2 compliance assessment and equipment risk report
                        </p>
                    </div>
                    <select
                        value={meterId}
                        onChange={e => setMeterId(e.target.value)}
                        className="bg-slate-800 border border-slate-700 text-white text-sm rounded-lg px-3 py-2"
                    >
                        {meters.length === 0
                            ? <option value="">No meters</option>
                            : meters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <select
                        value={days}
                        onChange={e => setDays(Number(e.target.value))}
                        className="bg-slate-800 border border-slate-700 text-white text-sm rounded-lg px-3 py-2"
                    >
                        <option value={7}>7 days</option>
                        <option value={14}>14 days</option>
                        <option value={30}>30 days</option>
                    </select>
                    <button
                        onClick={() => window.print()}
                        disabled={!report}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
                    >
                        <Printer className="h-4 w-4" /> Print / PDF
                    </button>
                </div>
            </div>

            {busy && (
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                </div>
            )}

            {!busy && !report && (
                <div className="max-w-4xl mx-auto px-6 py-24 text-center">
                    <Activity className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                    <p className="text-slate-700 font-medium text-lg">No assessment available</p>
                    <p className="text-slate-500 text-sm mt-2">
                        Select a meter with recent telemetry to generate a health check.
                    </p>
                </div>
            )}

            {!busy && report && (
                <div className="pq-page max-w-4xl mx-auto bg-white shadow-sm my-6 px-10 py-10 text-slate-800">

                    {/* ── Letterhead ─────────────────────────────────────── */}
                    <div className="flex items-start justify-between border-b-2 border-slate-800 pb-5">
                        <div>
                            {/* White-label: a reseller's logo/name replaces ours on the
                                document they hand to their own client. */}
                            {brand?.brand_logo_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={brand.brand_logo_url}
                                    alt={brand.brand_name || "Report logo"}
                                    className="h-10 max-w-[220px] object-contain object-left"
                                />
                            ) : (
                                <p className="text-2xl font-bold tracking-tight text-slate-900">
                                    {brand?.brand_name || "GRID-IQ"}
                                </p>
                            )}
                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mt-0.5">
                                Power Quality Engineering Report
                            </p>
                        </div>
                        <div className="text-right text-xs text-slate-500 leading-relaxed">
                            <p>Report issued {new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}</p>
                            <p>Assessment period: {report.period_days} days</p>
                            <p>{report.readings.toLocaleString("en-ZA")} measurements analysed</p>
                        </div>
                    </div>

                    {/* ── Subject ────────────────────────────────────────── */}
                    <div className="mt-6">
                        <p className="text-[11px] uppercase tracking-wider text-slate-500">Site / Point of measurement</p>
                        <h2 className="text-xl font-bold text-slate-900 mt-1">
                            {report.site_name} — {report.meter_name}
                        </h2>
                        {report.from && report.to && (
                            <p className="text-xs text-slate-500 mt-1">
                                Observation window: {new Date(report.from).toLocaleString("en-ZA")} to {new Date(report.to).toLocaleString("en-ZA")}
                            </p>
                        )}
                    </div>

                    {/* ── Verdict ────────────────────────────────────────── */}
                    {v && (
                        <div className={`pq-break mt-6 rounded-xl border-2 p-5 ${v.ring}`}>
                            <div className="flex items-start gap-4">
                                <VIcon className={`h-9 w-9 shrink-0 ${v.cls}`} />
                                <div className="flex-1">
                                    <p className="text-[11px] uppercase tracking-wider text-slate-500">Overall finding</p>
                                    <p className={`text-2xl font-bold ${v.cls}`}>{v.title}</p>
                                    <p className="text-sm text-slate-700 mt-2 leading-relaxed">{report.verdict_note}</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── What changed since last period ─────────────────── */}
                    {/* This is the value a one-off survey cannot deliver: movement. */}
                    <div className={`pq-break mt-5 rounded-xl border p-5 ${
                        report.degrading.length > 0
                            ? "border-red-200 bg-red-50"
                            : report.has_baseline ? "border-slate-200 bg-slate-50" : "border-blue-200 bg-blue-50"
                    }`}>
                        <div className="flex items-start gap-3">
                            {report.degrading.length > 0
                                ? <TrendingDown className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                                : <History className="h-5 w-5 text-slate-500 shrink-0 mt-0.5" />}
                            <div>
                                <p className="text-[11px] uppercase tracking-wider text-slate-500">
                                    Change since previous {report.period_days} days
                                </p>
                                <p className="text-sm text-slate-800 mt-1 leading-relaxed">{report.trend_summary}</p>
                            </div>
                        </div>
                    </div>

                    {/* ── The two scores: whose problem is it? ───────────── */}
                    <div className="pq-break grid grid-cols-2 gap-5 mt-6">
                        {[
                            { label: "Supply quality", sub: "Your utility's responsibility", score: report.supply_score },
                            { label: "Installation health", sub: "Within your control to fix", score: report.install_score },
                        ].map(s => (
                            <div key={s.label} className="rounded-xl border border-slate-200 p-5">
                                <p className="text-[11px] uppercase tracking-wider text-slate-500">{s.label}</p>
                                <p className="text-xs text-slate-400">{s.sub}</p>
                                <p className={`text-4xl font-bold mt-2 ${scoreColour(s.score)}`}>
                                    {s.score}<span className="text-lg text-slate-400 font-normal">/100</span>
                                </p>
                                <div className="h-2 bg-slate-100 rounded-full mt-3 overflow-hidden">
                                    <div className={`h-full rounded-full ${scoreBar(s.score)}`} style={{ width: `${s.score}%` }} />
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* ── Compliance table ───────────────────────────────── */}
                    <div className="pq-break mt-9">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                            1. Compliance against NRS 048-2
                        </h3>
                        <table className="w-full text-sm mt-4">
                            <thead>
                                <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                                    <th className="text-left pb-2 font-medium">Parameter</th>
                                    <th className="text-right pb-2 font-medium">Measured</th>
                                    <th className="text-right pb-2 font-medium">Trend</th>
                                    <th className="text-right pb-2 font-medium">Limit</th>
                                    <th className="text-right pb-2 font-medium">Result</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {report.parameters.map(p => {
                                    const st = STATUS_STYLE[p.status];
                                    const SIcon = st.icon;
                                    return (
                                        <tr key={p.key} className="align-top">
                                            <td className="py-3 pr-3">
                                                <p className="font-semibold text-slate-900">{p.label}</p>
                                                <p className="text-xs text-slate-500 mt-0.5">{p.standard}</p>
                                                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{p.detail}</p>
                                                {/* Printed inline as well as the icon column — tooltips don't survive a PDF. */}
                                                {p.trend !== "NO_BASELINE" && (
                                                    <p className={`text-xs mt-1 font-medium ${TREND_STYLE[p.trend].cls}`}>
                                                        {p.trend_note}
                                                    </p>
                                                )}
                                                <p className="text-[11px] text-slate-400 mt-1 italic">Method: {p.method}</p>
                                            </td>
                                            <td className="py-3 px-2 text-right font-bold text-slate-900 whitespace-nowrap">{p.display}</td>
                                            <td className="py-3 px-2 text-right whitespace-nowrap">
                                                {(() => {
                                                    const tr = TREND_STYLE[p.trend];
                                                    const TIcon = tr.icon;
                                                    return (
                                                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${tr.cls}`} title={p.trend_note}>
                                                            <TIcon className="h-3.5 w-3.5" /> {tr.label}
                                                        </span>
                                                    );
                                                })()}
                                            </td>
                                            <td className="py-3 px-2 text-right text-slate-600 whitespace-nowrap text-xs">{p.limit}</td>
                                            <td className="py-3 pl-2 text-right">
                                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-semibold ${st.cls}`}>
                                                    <SIcon className="h-3 w-3" /> {st.label}
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* ── Equipment risk — the money section ─────────────── */}
                    <div className="mt-9">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                            2. Equipment risk findings
                        </h3>

                        {report.risks.length === 0 ? (
                            <p className="text-sm text-slate-600 mt-4">
                                No equipment risks were identified from the measured data during this observation period.
                            </p>
                        ) : (
                            <div className="mt-4 space-y-5">
                                {report.risks.map((risk, i) => {
                                    const sev = SEVERITY_STYLE[risk.severity];
                                    return (
                                        <div key={risk.key} className="pq-break flex gap-4">
                                            <div className={`w-1 rounded-full shrink-0 ${sev.bar}`} />
                                            <div className="flex-1">
                                                <div className="flex items-start justify-between gap-3">
                                                    <p className="font-bold text-slate-900">
                                                        {i + 1}. {risk.title}
                                                    </p>
                                                    <span className={`shrink-0 px-2 py-0.5 rounded border text-[11px] font-semibold uppercase tracking-wide ${sev.chip}`}>
                                                        {risk.severity}
                                                    </span>
                                                </div>

                                                <dl className="mt-2.5 space-y-2 text-sm">
                                                    <div>
                                                        <dt className="text-[11px] uppercase tracking-wider text-slate-500">Finding</dt>
                                                        <dd className="text-slate-800 leading-relaxed">{risk.finding}</dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-[11px] uppercase tracking-wider text-slate-500">Why it matters</dt>
                                                        <dd className="text-slate-700 leading-relaxed">{risk.mechanism}</dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-[11px] uppercase tracking-wider text-slate-500">Recommended action</dt>
                                                        <dd className="text-slate-800 leading-relaxed font-medium">{risk.action}</dd>
                                                    </div>
                                                </dl>
                                                <p className="text-[11px] text-slate-400 mt-2 italic">Reference: {risk.standard}</p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* ── Method note — what makes this defensible ───────── */}
                    <div className="pq-break mt-9">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                            3. Assessment method
                        </h3>
                        <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                            Measurements were taken continuously at the point of supply over the stated observation
                            window ({report.readings.toLocaleString("en-ZA")} samples). Compliance parameters are
                            assessed on the 95th percentile of recorded values, in line with the statistical
                            convention used by NRS 048-2, rather than on instantaneous worst-case excursions.
                            Voltage and current unbalance are calculated using the NEMA definition — maximum
                            deviation from the three-phase mean, expressed as a percentage of that mean. Motor
                            derating and winding temperature effects are taken from NEMA MG-1. Nominal supply is
                            taken as 230 V phase-to-neutral with a statutory tolerance of ±10%.
                        </p>
                        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
                            All figures in this report are derived directly from measured data. Cost and equipment-life
                            implications are engineering estimates based on the cited standards and should be confirmed
                            on site before capital expenditure is committed.
                        </p>
                    </div>

                    {/* ── Footer ─────────────────────────────────────────── */}
                    <div className="mt-10 pt-4 border-t border-slate-300 flex items-end justify-between text-xs text-slate-500">
                        <div>
                            <p className="font-semibold text-slate-700">
                                {brand?.brand_name || "Grid-IQ"} Power Quality Intelligence
                            </p>
                            <p>
                                {brand?.brand_footer || "grid-iq.co.za"} · Confidential — prepared for {report.site_name}
                            </p>
                            {brand?.brand_name && (
                                <p className="text-[10px] text-slate-400 mt-0.5">Analysis powered by Grid-IQ</p>
                            )}
                        </div>
                        <p>Continuous monitoring · next assessment in {report.period_days} days</p>
                    </div>
                </div>
            )}
        </div>
    );
}
