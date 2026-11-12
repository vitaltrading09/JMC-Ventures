"use client";

import {
    ShieldCheck, ShieldAlert, ShieldX, Loader2,
    AlertTriangle, CheckCircle2, XCircle, MinusCircle,
    TrendingUp, TrendingDown, Minus, History, Sparkles,
    Flame, Cog, PauseCircle, Radio,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// The printable report document, with no data fetching of its own.
//
// Extracted so the owner's dashboard view and a shared read-only link render the
// SAME document. If a recipient's copy could drift from the issuer's, the
// verification code at the foot of the report would be meaningless.
// ─────────────────────────────────────────────────────────────────────────────

export type Status = "PASS" | "WARN" | "FAIL" | "NO_DATA";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Trend = "IMPROVING" | "STABLE" | "DEGRADING" | "NO_BASELINE";

export interface ComplianceParameter {
    key: string; label: string; measured: number | null; display: string;
    limit: string; status: Status; standard: string; method: string; detail: string;
    previous: number | null; trend: Trend; trend_note: string;
}
export interface EquipmentRisk {
    key: string; severity: Severity; title: string;
    finding: string; mechanism: string; action: string; standard: string;
}

export type Peril = "FIRE" | "MACHINERY_BREAKDOWN" | "BUSINESS_INTERRUPTION";
export interface PerilExposure {
    peril: Peril; label: string; status: "OPEN" | "CLEAR";
    findings: string[]; mechanism: string;
}
export interface MonitoringEvidence {
    monitored_since: string | null; assessments_on_record: number;
    days_covered: number; coverage_pct: number | null; continuous: boolean;
    device_clock_pct: number | null;
}
export interface RiskProfile {
    perils: PerilExposure[];
    monitoring: MonitoringEvidence;
    open_findings: number; critical_or_high: number;
    degrading: string[]; standards: string[];
    verification_code: string; statement: string; scope_note: string;
}

export interface ComplianceReport {
    meter_id: string; meter_name: string; site_name: string;
    period_days: number; readings: number; from: string; to: string;
    verdict: "COMPLIANT" | "COMPLIANT_WITH_RISK" | "NON_COMPLIANT" | "INSUFFICIENT_DATA";
    verdict_note: string;
    parameters: ComplianceParameter[];
    risks: EquipmentRisk[];
    supply_score: number; install_score: number;
    has_baseline: boolean; trend_summary: string; degrading: string[];
    risk_profile?: RiskProfile | null;
}
export interface Branding {
    brand_name: string | null; brand_logo_url: string | null; brand_footer: string | null;
}
export interface TrendPoint { week: string; value: number; samples: number; }
export interface MetricTrend {
    key: string; label: string; unit: string; decimals: number;
    threshold: number; threshold_label: string; higher_is_worse: boolean;
    points: TrendPoint[]; current: number | null;
    slope_per_week: number | null; r2: number | null;
    direction: "WORSENING" | "IMPROVING" | "FLAT" | "INSUFFICIENT_DATA";
    weeks_to_threshold: number | null; projected_date: string | null;
    over_threshold: boolean; weeks_over: number; note: string;
}
export interface Forecast {
    meter_name: string; site_name: string; weeks: number;
    metrics: MetricTrend[]; headline: string;
}

const STATUS_STYLE: Record<Status, { cls: string; icon: React.ElementType; label: string }> = {
    PASS:    { cls: "text-emerald-700 bg-emerald-50 border-emerald-200", icon: CheckCircle2,  label: "Pass" },
    WARN:    { cls: "text-amber-700   bg-amber-50   border-amber-200",   icon: AlertTriangle, label: "Watch" },
    FAIL:    { cls: "text-red-700     bg-red-50     border-red-200",     icon: XCircle,       label: "Fail" },
    NO_DATA: { cls: "text-slate-500   bg-slate-50   border-slate-200",   icon: MinusCircle,   label: "No data" },
};

const SEVERITY_STYLE: Record<Severity, { bar: string; chip: string }> = {
    CRITICAL: { bar: "bg-red-600",    chip: "text-red-700    bg-red-50    border-red-200" },
    HIGH:     { bar: "bg-orange-500", chip: "text-orange-700 bg-orange-50 border-orange-200" },
    MEDIUM:   { bar: "bg-amber-500",  chip: "text-amber-700  bg-amber-50  border-amber-200" },
    LOW:      { bar: "bg-slate-400",  chip: "text-slate-600  bg-slate-50  border-slate-200" },
};

const VERDICT: Record<string, { title: string; cls: string; icon: React.ElementType; ring: string }> = {
    COMPLIANT:           { title: "Within screening thresholds", cls: "text-emerald-700", icon: ShieldCheck, ring: "border-emerald-300 bg-emerald-50" },
    COMPLIANT_WITH_RISK: { title: "Within thresholds, with observations", cls: "text-amber-700",   icon: ShieldAlert, ring: "border-amber-300 bg-amber-50" },
    NON_COMPLIANT:       { title: "Outside screening thresholds", cls: "text-red-700",     icon: ShieldX,     ring: "border-red-300 bg-red-50" },
    INSUFFICIENT_DATA:   { title: "Insufficient data",     cls: "text-slate-600",   icon: MinusCircle, ring: "border-slate-300 bg-slate-50" },
};

const TREND_STYLE: Record<Trend, { icon: React.ElementType; cls: string; label: string }> = {
    IMPROVING:   { icon: TrendingUp,   cls: "text-emerald-600", label: "Improving" },
    DEGRADING:   { icon: TrendingDown, cls: "text-red-600",     label: "Degrading" },
    STABLE:      { icon: Minus,        cls: "text-slate-400",   label: "Stable" },
    NO_BASELINE: { icon: History,      cls: "text-slate-300",   label: "Baseline" },
};

const PERIL_ICON: Record<Peril, React.ElementType> = {
    FIRE: Flame,
    MACHINERY_BREAKDOWN: Cog,
    BUSINESS_INTERRUPTION: PauseCircle,
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

interface Props {
    report: ComplianceReport;
    brand: Branding | null;
    forecast: Forecast | null;
    summary: string | null;
    summaryBusy?: boolean;
    /** Rendered inside the document, below the method note. Used for the
     *  owner-only "Ask about this report" panel, which a shared copy omits. */
    children?: React.ReactNode;
}

export default function HealthCheckReport({
    report, brand, forecast, summary, summaryBusy = false, children,
}: Props) {
    const v = VERDICT[report.verdict];
    const VIcon = v?.icon ?? ShieldCheck;

    const showForecast = !!(forecast && forecast.metrics.some(m => m.points.length >= 4));
    const profile = report.risk_profile ?? null;

    // Numbered so the document reads as a report rather than a web page.
    let n = 2; // 1 = compliance, 2 = equipment risk
    const secForecast = showForecast ? ++n : null;
    const secProfile  = profile     ? ++n : null;
    const secMethod   = ++n;

    return (
        <div className="pq-page max-w-4xl mx-auto bg-white shadow-sm my-6 px-10 py-10 text-slate-800">

            {/* ── Letterhead ─────────────────────────────────────────────── */}
            <div className="flex items-start justify-between border-b-2 border-slate-800 pb-5">
                <div>
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
                    {profile && (
                        <p className="mt-1 font-mono text-[10px] text-slate-400">
                            Ref {profile.verification_code}
                        </p>
                    )}
                </div>
            </div>

            {/* ── Subject ────────────────────────────────────────────────── */}
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

            {/* ── Verdict ────────────────────────────────────────────────── */}
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

            {/* ── Executive summary ──────────────────────────────────────── */}
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

            {/* ── What changed since last period ─────────────────────────── */}
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

            {/* ── Two indicative screening scores (not a certification; correlation does not locate a cause) ── */}
            <div className="pq-break grid grid-cols-2 gap-5 mt-6">
                {[
                    { label: "Supply quality",      sub: "Indicative score from voltage, frequency and THD-V at this point; does not establish the cause", score: report.supply_score },
                    { label: "Installation health", sub: "Indicative score from PF, unbalance and load behaviour",    score: report.install_score },
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

            {/* ── 1. Compliance table ────────────────────────────────────── */}
            <div className="pq-break mt-9">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                    1. Compliance against NRS 048-2
                </h3>
                <table className="w-full text-sm mt-4">
                    <thead>
                        <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                            <th className="text-left  pb-2 font-medium">Parameter</th>
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
                            const tr = TREND_STYLE[p.trend];
                            const TIcon = tr.icon;
                            return (
                                <tr key={p.key} className="align-top">
                                    <td className="py-3 pr-3">
                                        <p className="font-semibold text-slate-900">{p.label}</p>
                                        <p className="text-xs text-slate-500 mt-0.5">{p.standard}</p>
                                        <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{p.detail}</p>
                                        {p.trend !== "NO_BASELINE" && (
                                            <p className={`text-xs mt-1 font-medium ${tr.cls}`}>{p.trend_note}</p>
                                        )}
                                        <p className="text-[11px] text-slate-400 mt-1 italic">Method: {p.method}</p>
                                    </td>
                                    <td className="py-3 px-2 text-right font-bold text-slate-900 whitespace-nowrap">{p.display}</td>
                                    <td className="py-3 px-2 text-right whitespace-nowrap">
                                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${tr.cls}`} title={p.trend_note}>
                                            <TIcon className="h-3.5 w-3.5" /> {tr.label}
                                        </span>
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

            {/* ── 2. Equipment risk ──────────────────────────────────────── */}
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
                                            <p className="font-bold text-slate-900">{i + 1}. {risk.title}</p>
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

            {/* ── 3. Trend & forecast ────────────────────────────────────── */}
            {showForecast && forecast && (
                <div className="mt-9">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                        {secForecast}. Trend and forecast
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
                        {forecast.metrics.filter(m => m.points.length >= 4).map(m => {
                            const vals = m.points.map(p => p.value);
                            const lo = Math.min(...vals, m.threshold);
                            const hi = Math.max(...vals, m.threshold);
                            const pad = (hi - lo) * 0.15 || 1;
                            const yMin = lo - pad, yMax = hi + pad;
                            const scaleY = (val: number) => 60 - ((val - yMin) / (yMax - yMin)) * 55;
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
                                        <line x1="0" y1={thresholdY} x2="240" y2={thresholdY}
                                              stroke="#dc2626" strokeWidth="1" strokeDasharray="4 3" />
                                        <text x="240" y={thresholdY - 3} textAnchor="end" fontSize="7" fill="#dc2626">
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

            {/* ── 4. Risk profile — the broker/insurer view ──────────────── */}
            {profile && (
                <div className="mt-9">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                        {secProfile}. Risk profile — for insurer or broker review
                    </h3>

                    {/* The honest framing comes first, deliberately. Overstating what
                        this section is would cost more credibility than it buys. */}
                    <p className="text-xs text-slate-600 mt-3 leading-relaxed">{profile.statement}</p>

                    {/* Peril exposure */}
                    <div className="pq-break mt-5 space-y-3">
                        {profile.perils.map(p => {
                            const PIcon = PERIL_ICON[p.peril];
                            const open = p.status === "OPEN";
                            return (
                                <div key={p.peril}
                                     className={`rounded-lg border p-4 ${open ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
                                    <div className="flex items-start gap-3">
                                        <PIcon className={`h-5 w-5 shrink-0 mt-0.5 ${open ? "text-amber-600" : "text-slate-300"}`} />
                                        <div className="flex-1">
                                            <div className="flex items-center justify-between gap-3">
                                                <p className="font-semibold text-slate-900 text-sm">{p.label}</p>
                                                <span className={`shrink-0 px-2 py-0.5 rounded border text-[11px] font-semibold uppercase tracking-wide ${
                                                    open ? "text-amber-700 bg-amber-50 border-amber-300"
                                                         : "text-emerald-700 bg-emerald-50 border-emerald-200"}`}>
                                                    {open ? "Open finding" : "No finding"}
                                                </span>
                                            </div>
                                            {open && (
                                                <ul className="mt-2 space-y-1">
                                                    {p.findings.map((f, i) => (
                                                        <li key={i} className="text-xs text-slate-700 flex gap-2">
                                                            <span className="text-amber-500">•</span>{f}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                            <p className="text-xs text-slate-600 mt-2 leading-relaxed">{p.mechanism}</p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Monitoring evidence — the part a one-off survey cannot show */}
                    <div className="pq-break mt-5 rounded-lg border border-slate-200 p-4">
                        <div className="flex items-center gap-2">
                            <Radio className="h-4 w-4 text-blue-600" />
                            <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                                Monitoring evidence
                            </p>
                            {profile.monitoring.continuous && (
                                <span className="px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 text-[10px] font-semibold uppercase tracking-wide">
                                    Continuous
                                </span>
                            )}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
                            {[
                                {
                                    label: "Monitored since",
                                    value: profile.monitoring.monitored_since
                                        ? new Date(profile.monitoring.monitored_since)
                                            .toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })
                                        : "—",
                                },
                                { label: "Days with data",   value: profile.monitoring.days_covered.toLocaleString("en-ZA") },
                                {
                                    label: "Coverage",
                                    value: profile.monitoring.coverage_pct !== null
                                        ? `${profile.monitoring.coverage_pct.toFixed(0)}%` : "—",
                                },
                                { label: "Assessments on record", value: String(profile.monitoring.assessments_on_record) },
                            ].map(s => (
                                <div key={s.label}>
                                    <p className="text-[10px] uppercase tracking-wider text-slate-400">{s.label}</p>
                                    <p className="text-lg font-bold text-slate-900 mt-0.5">{s.value}</p>
                                </div>
                            ))}
                        </div>

                        <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-slate-100">
                            <div>
                                <p className="text-[10px] uppercase tracking-wider text-slate-400">Open findings</p>
                                <p className={`text-lg font-bold mt-0.5 ${profile.open_findings > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                                    {profile.open_findings}
                                    {profile.critical_or_high > 0 && (
                                        <span className="text-xs font-normal text-slate-500 ml-2">
                                            ({profile.critical_or_high} critical or high)
                                        </span>
                                    )}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] uppercase tracking-wider text-slate-400">Deteriorating this period</p>
                                <p className={`text-lg font-bold mt-0.5 ${profile.degrading.length > 0 ? "text-red-600" : "text-emerald-600"}`}>
                                    {profile.degrading.length === 0 ? "None" : profile.degrading.length}
                                </p>
                            </div>
                        </div>

                        {/* Timestamp provenance. Stated because a reviewer is entitled
                            to ask whether the timeline behind these figures is the
                            meter's or merely the server's. */}
                        {profile.monitoring.device_clock_pct !== null && (
                            <p className="text-[11px] text-slate-500 mt-4 pt-3 border-t border-slate-100 leading-relaxed">
                                <span className="font-medium text-slate-600">Timestamp integrity:</span>{" "}
                                {profile.monitoring.device_clock_pct.toFixed(0)}% of readings in this period are
                                timestamped by the meter&apos;s own clock rather than by server arrival time. Data
                                buffered by the meter during a connectivity outage is therefore placed on the
                                timeline at the moment it was measured, not the moment it was received.
                            </p>
                        )}
                    </div>

                    {/* Scope limits. An underwriter who discovers an unstated limit
                        themselves discounts everything else in the document. */}
                    <div className="pq-break mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Scope and limits</p>
                        <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{profile.scope_note}</p>
                        {profile.standards.length > 0 && (
                            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                                <span className="font-medium text-slate-600">Assessed against:</span>{" "}
                                {profile.standards.join("; ")}.
                            </p>
                        )}
                        {/* Deliberately does NOT claim the code is stable for a given
                            link: the assessment re-runs against a rolling window, so it
                            changes as new measurements arrive. Claiming otherwise would
                            make an honest difference look like tampering. */}
                        <p className="text-xs text-slate-500 mt-2">
                            <span className="font-medium text-slate-600">Verification code:</span>{" "}
                            <span className="font-mono text-slate-700">{profile.verification_code}</span>
                            {" "}— a fingerprint of the measurements in this assessment. This report is
                            regenerated from live data each time it is opened, so the code advances as new
                            measurements arrive; two copies bearing the same code contain identical figures.
                        </p>
                    </div>
                </div>
            )}

            {/* ── Assessment method ──────────────────────────────────────── */}
            <div className="pq-break mt-9">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-2">
                    {secMethod}. Assessment method
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
                {showForecast && (
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

            {children}

            {/* ── Footer ─────────────────────────────────────────────────── */}
            <div className="mt-10 pt-4 border-t border-slate-300 flex items-end justify-between text-xs text-slate-500">
                <div>
                    <p className="font-semibold text-slate-700">
                        {brand?.brand_name || "GridIQ"} Power Quality Intelligence
                    </p>
                    <p>
                        {brand?.brand_footer || "grid-iq.co.za"} · Confidential — prepared for {report.site_name}
                    </p>
                    {brand?.brand_name && (
                        <p className="text-[10px] text-slate-400 mt-0.5">Analysis powered by GridIQ</p>
                    )}
                </div>
                <p>Continuous monitoring · next assessment in {report.period_days} days</p>
            </div>
        </div>
    );
}
