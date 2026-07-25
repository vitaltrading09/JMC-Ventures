"use client";

import { useState, useEffect, useCallback } from "react";
import {
    ShieldCheck, ShieldAlert, ShieldX, Printer, Loader2,
    AlertTriangle, CheckCircle2, XCircle, MinusCircle, Activity,
    TrendingUp, TrendingDown, Minus, History, Sparkles, Send,
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

interface TrendPoint { week: string; value: number; samples: number; }
interface MetricTrend {
    key: string; label: string; unit: string; decimals: number;
    threshold: number; threshold_label: string; higher_is_worse: boolean;
    points: TrendPoint[]; current: number | null;
    slope_per_week: number | null; r2: number | null;
    direction: "WORSENING" | "IMPROVING" | "FLAT" | "INSUFFICIENT_DATA";
    weeks_to_threshold: number | null; projected_date: string | null;
    over_threshold: boolean; weeks_over: number; note: string;
}
interface Forecast {
    meter_name: string; site_name: string; weeks: number;
    metrics: MetricTrend[]; headline: string;
}

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
    const [forecast, setForecast] = useState<Forecast | null>(null);
    const [summary,     setSummary]     = useState<string | null>(null);
    const [summaryBusy, setSummaryBusy] = useState(false);
    const [question,    setQuestion]    = useState("");
    const [qaLog,       setQaLog]       = useState<{ role: "user" | "assistant"; content: string }[]>([]);
    const [asking,      setAsking]      = useState(false);
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

    // Long-run trend and threshold projection.
    useEffect(() => {
        if (!meterId) return;
        setForecast(null);
        fetch(`${API}/ingestion/meters/${meterId}/forecast?weeks=12`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(f => setForecast(f))
            .catch(() => setForecast(null));
    }, [meterId]);

    // Executive summary is fetched separately so a slow (or unavailable) AI call
    // never delays or blocks the engineering report, which stands on its own.
    useEffect(() => {
        if (!meterId) return;
        setSummary(null);
        setQaLog([]);
        setSummaryBusy(true);
        fetch(`${API}/ingestion/meters/${meterId}/compliance/summary?days=${days}`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => setSummary(d?.summary ?? null))
            .catch(() => setSummary(null))
            .finally(() => setSummaryBusy(false));
    }, [meterId, days]);

    const askQuestion = async (q: string) => {
        const text = q.trim();
        if (!text || asking || !meterId) return;
        setQuestion("");
        const history = qaLog.slice(-6);
        setQaLog(prev => [...prev, { role: "user", content: text }]);
        setAsking(true);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/compliance/ask`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: text, days, history }),
            });
            const data = res.ok ? await res.json() : null;
            setQaLog(prev => [...prev, {
                role: "assistant",
                content: data?.answer ?? "I couldn't answer that just now — the analysis service is unavailable.",
            }]);
        } catch {
            setQaLog(prev => [...prev, { role: "assistant", content: "Connection failed. Please try again." }]);
        } finally {
            setAsking(false);
        }
    };

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

                    {/* ── Executive summary ──────────────────────────────── */}
                    {/* Plain-language interpretation of the measured findings. The
                        engineering below stands on its own if this is unavailable. */}
                    {(summaryBusy || summary) && (
                        <div className="pq-break mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
                            <div className="flex items-center gap-2 mb-3">
                                <Sparkles className="h-4 w-4 text-blue-600" />
                                <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                                    Executive summary
                                </p>
                            </div>
                            {summaryBusy ? (
                                <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Interpreting the findings…
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {summary!.split(/\n\s*\n/).map((para, i) => (
                                        <p key={i} className="text-sm text-slate-800 leading-relaxed">{para}</p>
                                    ))}
                                </div>
                            )}
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

                    {/* ── Trend & forecast ───────────────────────────────── */}
                    {forecast && forecast.metrics.some(m => m.points.length >= 4) && (
                        <div className="mt-9">
                            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                                3. Trend and forecast
                            </h3>

                            <div className={`mt-4 rounded-lg border p-4 ${
                                forecast.metrics.some(m => m.over_threshold) ? "border-red-200 bg-red-50"
                                : forecast.metrics.some(m => m.direction === "WORSENING") ? "border-amber-200 bg-amber-50"
                                : "border-slate-200 bg-slate-50"
                            }`}>
                                <p className="text-sm font-semibold text-slate-900">{forecast.headline}</p>
                                <p className="text-xs text-slate-500 mt-1">
                                    Based on weekly measurements over the last {forecast.weeks} weeks.
                                </p>
                            </div>

                            <div className="grid sm:grid-cols-2 gap-5 mt-5">
                                {forecast.metrics
                                    .filter(m => m.points.length >= 4)
                                    .map(m => {
                                        const vals = m.points.map(p => p.value);
                                        // Keep the limit line inside the plotted range so
                                        // "how far over/under" is readable at a glance.
                                        const lo = Math.min(...vals, m.threshold);
                                        const hi = Math.max(...vals, m.threshold);
                                        const pad = (hi - lo) * 0.15 || 1;
                                        const yMin = lo - pad, yMax = hi + pad;
                                        const scaleY = (v: number) => 60 - ((v - yMin) / (yMax - yMin)) * 55;
                                        const stepX = m.points.length > 1 ? 240 / (m.points.length - 1) : 0;
                                        const path = m.points
                                            .map((p, i) => `${i === 0 ? "M" : "L"} ${(i * stepX).toFixed(1)} ${scaleY(p.value).toFixed(1)}`)
                                            .join(" ");
                                        const thresholdY = scaleY(m.threshold);
                                        const bad = m.over_threshold || m.direction === "WORSENING";

                                        return (
                                            <div key={m.key} className="pq-break rounded-lg border border-slate-200 p-4">
                                                <div className="flex items-baseline justify-between gap-2">
                                                    <p className="text-sm font-semibold text-slate-900">{m.label}</p>
                                                    <p className={`text-lg font-bold ${bad ? "text-red-600" : "text-emerald-600"}`}>
                                                        {m.current?.toFixed(m.decimals)}{m.unit}
                                                    </p>
                                                </div>

                                                <svg viewBox="0 0 240 65" className="w-full h-[70px] mt-2 overflow-visible">
                                                    {/* Published limit */}
                                                    <line x1="0" y1={thresholdY} x2="240" y2={thresholdY}
                                                          stroke="#dc2626" strokeWidth="1" strokeDasharray="4 3" />
                                                    <text x="240" y={thresholdY - 3} textAnchor="end"
                                                          fontSize="7" fill="#dc2626">
                                                        limit {m.threshold}{m.unit}
                                                    </text>
                                                    <path d={path} fill="none"
                                                          stroke={bad ? "#dc2626" : "#059669"} strokeWidth="1.8"
                                                          strokeLinejoin="round" strokeLinecap="round" />
                                                    {m.points.map((p, i) => (
                                                        <circle key={i} cx={i * stepX} cy={scaleY(p.value)} r="1.8"
                                                                fill={bad ? "#dc2626" : "#059669"} />
                                                    ))}
                                                </svg>

                                                <div className="flex justify-between text-[10px] text-slate-400 -mt-1">
                                                    <span>{m.points[0].week}</span>
                                                    <span>{m.points[m.points.length - 1].week}</span>
                                                </div>

                                                <p className="text-xs text-slate-700 mt-2 leading-relaxed">{m.note}</p>
                                                <p className="text-[10px] text-slate-400 mt-1.5 italic">
                                                    Limit: {m.threshold_label}
                                                    {m.r2 !== null && m.direction !== "FLAT" && m.direction !== "INSUFFICIENT_DATA"
                                                        ? ` · trend fit R²=${m.r2.toFixed(2)}` : ""}
                                                </p>
                                            </div>
                                        );
                                    })}
                            </div>
                        </div>
                    )}

                    {/* ── Method note — what makes this defensible ───────── */}
                    <div className="pq-break mt-9">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                            {forecast && forecast.metrics.some(m => m.points.length >= 4) ? "4" : "3"}. Assessment method
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
                        {forecast && forecast.metrics.some(m => m.points.length >= 4) && (
                            <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                                Trends are calculated by ordinary least-squares regression on weekly values. A direction
                                is only reported where the fit is strong enough to distinguish a real trend from normal
                                variation (R² ≥ 0.35); otherwise the parameter is reported as steady. Projected threshold
                                crossings assume the present rate of change continues, are limited to a 26-week horizon,
                                and are indicative rather than a prediction of failure on a specific date.
                            </p>
                        )}
                        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
                            All figures in this report are derived directly from measured data. Cost and equipment-life
                            implications are engineering estimates based on the cited standards and should be confirmed
                            on site before capital expenditure is committed.
                        </p>
                    </div>

                    {/* ── Ask about this report (screen only) ────────────── */}
                    <div data-noprint="true" className="mt-9 rounded-xl border border-slate-200 bg-slate-50 p-5">
                        <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-blue-600" />
                            <p className="text-sm font-semibold text-slate-900">Ask about this report</p>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                            Answers come only from the measurements above — if something wasn&apos;t measured, it will say so.
                        </p>

                        {qaLog.length === 0 && !asking && (
                            <div className="flex flex-wrap gap-2 mt-4">
                                {[
                                    "Is this the municipality's fault or mine?",
                                    "What should I fix first?",
                                    "What is this costing me?",
                                    "Is my equipment in danger?",
                                ].map(s => (
                                    <button
                                        key={s}
                                        onClick={() => askQuestion(s)}
                                        className="px-3 py-1.5 rounded-full border border-slate-300 bg-white text-xs text-slate-700 hover:border-blue-400 hover:text-blue-700 transition-colors"
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        )}

                        {qaLog.length > 0 && (
                            <div className="mt-4 space-y-3 max-h-[420px] overflow-y-auto">
                                {qaLog.map((m, i) => (
                                    <div
                                        key={i}
                                        className={m.role === "user"
                                            ? "ml-auto max-w-[85%] rounded-lg bg-blue-600 text-white px-3 py-2 text-sm"
                                            : "mr-auto max-w-[92%] rounded-lg bg-white border border-slate-200 px-3 py-2 text-sm text-slate-800 whitespace-pre-wrap"}
                                    >
                                        {/* The model uses ** for emphasis; render it as bold rather
                                            than leaking raw markdown into a client-facing document. */}
                                        {m.role === "assistant"
                                            ? m.content.split(/(\*\*[^*]+\*\*)/g).map((chunk, j) =>
                                                chunk.startsWith("**") && chunk.endsWith("**")
                                                    ? <strong key={j}>{chunk.slice(2, -2)}</strong>
                                                    : <span key={j}>{chunk}</span>)
                                            : m.content}
                                    </div>
                                ))}
                                {asking && (
                                    <div className="mr-auto flex items-center gap-2 text-sm text-slate-500 px-3 py-2">
                                        <Loader2 className="h-4 w-4 animate-spin" /> Checking the measurements…
                                    </div>
                                )}
                            </div>
                        )}

                        <form
                            onSubmit={e => { e.preventDefault(); askQuestion(question); }}
                            className="flex gap-2 mt-4"
                        >
                            <input
                                value={question}
                                onChange={e => setQuestion(e.target.value)}
                                placeholder="Ask anything about these findings…"
                                className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <button
                                type="submit"
                                disabled={asking || !question.trim()}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
                            >
                                <Send className="h-4 w-4" /> Ask
                            </button>
                        </form>
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
