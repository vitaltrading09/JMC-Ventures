"use client";

import { useState, useEffect, useCallback } from "react";
import {
    PieChart, Pie, Cell, BarChart, Bar,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Zap, Printer, ChevronDown, Loader2, Leaf, AlertTriangle } from "lucide-react";
import { zar, normalizeRec } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Site { id: string; name: string; address?: string; }
interface Meter { id: string; site_id: string; name: string; }
interface SiteScore {
    site_id: string;
    score: number;
    pf_score?: number;
    thd_score?: number;
    voltage_unbalance_score?: number;
    voltage_quality_score?: number;
    tariff_type: string;
    calculated_at: string;
}
interface Recommendation {
    id: string;
    site_id?: string;
    site_name: string;
    type: string;
    title: string;
    estimated_monthly_saving_zar: number;
    estimated_implementation_cost_zar: number;
    payback_months: number;
    status: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL;

const TYPE_COLOUR: Record<string, string> = {
    POWER_FACTOR_CORRECTION: "#f59e0b",
    HARMONIC_FILTER:         "#8b5cf6",
    PV_INSTALL:              "#f97316",
    LIGHTING_UPGRADE:        "#10b981",
    LOAD_SHIFTING:           "#3b82f6",
    VOLTAGE_REGULATION:      "#ef4444",
    DEMAND_MANAGEMENT:       "#06b6d4",
    ENERGY_AUDIT:            "#94a3b8",
};

const TYPE_LABEL: Record<string, string> = {
    POWER_FACTOR_CORRECTION: "Power Factor",
    HARMONIC_FILTER:         "Harmonic Filter",
    PV_INSTALL:              "Solar PV",
    LIGHTING_UPGRADE:        "Lighting",
    LOAD_SHIFTING:           "Load Shifting",
    VOLTAGE_REGULATION:      "Voltage Reg.",
    DEMAND_MANAGEMENT:       "Demand Mgmt",
    ENERGY_AUDIT:            "Energy Audit",
};


// ── Helpers ───────────────────────────────────────────────────────────────────
// Currency formatting lives in @/lib/format (zar); alias kept for existing call sites.
const fmtZAR = zar;

function scoreStroke(s: number | null) {
    if (s === null) return "#cbd5e1";
    if (s >= 80) return "#059669";
    if (s >= 60) return "#d97706";
    if (s >= 40) return "#ea580c";
    return "#dc2626";
}

function scoreTextCls(s: number | null) {
    if (s === null) return "text-slate-400";
    if (s >= 80) return "text-emerald-600";
    if (s >= 60) return "text-amber-600";
    if (s >= 40) return "text-orange-600";
    return "text-red-600";
}

function scoreBadge(s: number | null) {
    if (s === null) return { text: "Not scored",  cls: "text-slate-500  bg-slate-100  border-slate-200"  };
    if (s >= 80)   return { text: "Excellent",    cls: "text-emerald-700 bg-emerald-50 border-emerald-200" };
    if (s >= 60)   return { text: "Good",         cls: "text-amber-700  bg-amber-50   border-amber-200"   };
    if (s >= 40)   return { text: "Needs Work",   cls: "text-orange-700 bg-orange-50  border-orange-200"  };
    return               { text: "Critical",      cls: "text-red-700    bg-red-50     border-red-200"     };
}

function scoreFill(s: number) {
    if (s >= 80) return "bg-emerald-500";
    if (s >= 60) return "bg-amber-500";
    if (s >= 40) return "bg-orange-500";
    return "bg-red-500";
}

// Auto-generated "Looking Ahead" text based on weakest component
function getLookingAhead(sc: SiteScore | null) {
    if (!sc) return null;
    const items = [
        {
            key: "pf",
            score: sc.pf_score ?? 100,
            component: "Power Factor",
            title: "Power factor correction can cut your monthly tariff costs",
            body: `Your power factor score suggests reactive power penalties on your current Eskom bill. A correctly-sized capacitor bank eliminates these charges entirely and typically improves your overall energy score by 8–12 points. At current commercial tariff rates in South Africa, payback on a PF correction unit is commonly 10–16 months.`,
        },
        {
            key: "thd",
            score: sc.thd_score ?? 100,
            component: "Harmonic Distortion",
            title: "Harmonic distortion is your highest-impact priority this month",
            body: `Elevated THD increases transformer losses, generates excess heat in cabling, and can void equipment warranties on drives and motors. A passive harmonic filter (R 35–80k depending on kVA) typically recovers 12–18 score points and reduces running costs through lower transformer losses — payback within 18–24 months.`,
        },
        {
            key: "unbalance",
            score: sc.voltage_unbalance_score ?? 100,
            component: "Voltage Unbalance",
            title: "Voltage unbalance is shortening the life of your motors and drives",
            body: `Phase voltages drifting apart force motors to draw extra current on the deficient phase, causing winding heating disproportionate to the unbalance. A 2% unbalance (the NRS 048-2 limit) causes roughly 8% increase in motor losses and noticeably reduced bearing/insulation life. Rebalancing single-phase loads across phases, identifying a high-impedance neutral, or correcting a phase-down condition typically resolves this and improves both reliability and energy efficiency.`,
        },
        {
            key: "voltage",
            score: sc.voltage_quality_score ?? 100,
            component: "Voltage Quality",
            title: "Voltage quality issues may be causing hidden equipment losses",
            body: `Voltage sags, swells, or transients in your supply profile cause equipment trips, data loss, and accelerated wear on motors and drives. An automatic voltage regulator (AVR) on your main incomer, or UPS protection on critical circuits, addresses this directly — and typically improves your overall score by protecting the assets you already have installed.`,
        },
    ].sort((a, b) => a.score - b.score);
    return items[0];
}

const TOOLTIP_STYLE = {
    contentStyle: {
        backgroundColor: "#ffffff",
        borderColor: "#e2e8f0",
        color: "#1e293b",
        borderRadius: "8px",
        fontSize: 12,
        boxShadow: "0 4px 6px -1px rgba(0,0,0,0.07)",
    },
    cursor: { fill: "#f8fafc" },
};

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ReportsPage() {
    const [sites,       setSites]       = useState<Site[]>([]);
    const [meters,      setMeters]      = useState<Meter[]>([]);
    const [scores,      setScores]      = useState<SiteScore[]>([]);
    const [recs,        setRecs]        = useState<Recommendation[]>([]);
    const [consumption, setConsumption] = useState<{ month: string; kwh: number }[]>([]);
    const [loading,     setLoading]     = useState(true);
    const [selectedId,  setSelectedId]  = useState<string | null>(null);

    // Inject print CSS while this page is mounted
    useEffect(() => {
        const el = document.createElement("style");
        el.id = "pg-report-print";
        el.textContent = `
            @media print {
                [data-noprint] { display: none !important; }
                body { background: white !important; }
                #report-card {
                    box-shadow: none !important;
                    border: none !important;
                    border-radius: 0 !important;
                    max-width: 100% !important;
                }
                @page { margin: 10mm; size: A4 portrait; }
            }
        `;
        document.head.appendChild(el);
        return () => el.remove();
    }, []);

    const fetchAll = useCallback(async () => {
        // credentials:'include' is a top-level fetch option — NOT a header.
        // (Nesting it in { headers } sends the auth cookie nowhere → 401/CORS fail.)
        const opts = { credentials: 'include' as const };
        try {
            const [sRes, scRes, rRes, mRes] = await Promise.all([
                fetch(`${API}/ingestion/sites`,           opts),
                fetch(`${API}/ingestion/sites/scores`,    opts),
                fetch(`${API}/ingestion/recommendations`, opts),
                fetch(`${API}/ingestion/meters`,          opts),
            ]);
            if (sRes.status === 401) { window.location.href = "/login"; return; }
            const [s, sc, r, m] = await Promise.all([
                sRes.ok  ? sRes.json()  : [],
                scRes.ok ? scRes.json() : [],
                rRes.ok  ? rRes.json()  : [],
                mRes.ok  ? mRes.json()  : [],
            ]);
            setSites  (Array.isArray(s)  ? s  : []);
            setScores (Array.isArray(sc) ? sc : []);
            setRecs   (Array.isArray(r)  ? r.map(normalizeRec)  : []);
            setMeters (Array.isArray(m)  ? m  : []);
        } catch { }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // Set default site once data loads
    useEffect(() => {
        if (selectedId || sites.length === 0) return;
        const firstScored = sites.find(s => scores.some(sc => sc.site_id === s.id));
        setSelectedId(firstScored?.id ?? sites[0].id);
    }, [sites, scores, selectedId]);

    // Fetch monthly consumption when selected site changes
    useEffect(() => {
        if (!selectedId || meters.length === 0) return;
        const meter = meters.find(m => m.site_id === selectedId);
        if (!meter) { setConsumption([]); return; }
        const opts = { credentials: 'include' as const };
        fetch(`${API}/ingestion/meters/${meter.id}/monthly?months=6`, opts)
            .then(r => r.ok ? r.json() : [])
            .then((rows: { month: string; kwh: string | number }[]) => {
                setConsumption(rows.map(r => ({ month: r.month, kwh: Number(r.kwh) })));
            })
            .catch(() => setConsumption([]));
    }, [selectedId, meters]);

    // ── Derived ───────────────────────────────────────────────────────────────
    const selectedSite  = sites.find(s => s.id === selectedId) ?? null;
    const selectedScore = scores.find(sc => sc.site_id === selectedId) ?? null;
    const siteRecs      = recs.filter(r =>
        r.site_id === selectedId || r.site_name === selectedSite?.name
    );
    const totalMonthly  = siteRecs.reduce((a, r) => a + r.estimated_monthly_saving_zar, 0);
    const totalAnnual   = totalMonthly * 12;
    const co2Avoided    = (totalMonthly / 2.5 * 0.92 * 12) / 1000;

    const topRecs = [...siteRecs]
        .sort((a, b) => b.estimated_monthly_saving_zar - a.estimated_monthly_saving_zar)
        .slice(0, 3);

    const pieData = Object.entries(
        siteRecs.reduce<Record<string, number>>((acc, r) => {
            acc[r.type] = (acc[r.type] || 0) + r.estimated_monthly_saving_zar;
            return acc;
        }, {})
    )
        .map(([type, value]) => ({
            name:  TYPE_LABEL[type] ?? type,
            value: Math.round(value),
            fill:  TYPE_COLOUR[type] ?? "#94a3b8",
        }))
        .filter(d => d.value > 0)
        .sort((a, b) => b.value - a.value);

    const components = selectedScore ? [
        { label: "Power Factor",      score: selectedScore.pf_score                ?? null, key: "pf"        },
        { label: "Harmonic (THD)",    score: selectedScore.thd_score               ?? null, key: "thd"       },
        { label: "Voltage Unbalance", score: selectedScore.voltage_unbalance_score ?? null, key: "unbalance" },
        { label: "Voltage Quality",   score: selectedScore.voltage_quality_score   ?? null, key: "volt"      },
    ] : [];

    const lookingAhead = getLookingAhead(selectedScore);

    const period    = new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
    const generated = new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
    const nextMonth = new Date(new Date().setMonth(new Date().getMonth() + 1))
        .toLocaleDateString("en-ZA", { month: "long", year: "numeric" });

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    return (
        // Escape parent padding, fill with light bg
        <div className="bg-slate-100 -m-4 sm:-m-6 lg:-m-8 min-h-screen">

            {/* ── Controls bar (hidden on print) ─────────────────────────── */}
            <div
                data-noprint="true"
                className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between gap-4 flex-wrap"
            >
                <div className="flex items-center gap-3 flex-wrap">
                    {/* Site selector */}
                    <div className="relative">
                        <select
                            value={selectedId ?? ""}
                            onChange={e => setSelectedId(e.target.value)}
                            className="appearance-none bg-slate-50 border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 cursor-pointer"
                        >
                            {sites.length === 0
                                ? <option value="">No sites available</option>
                                : sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                            }
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                    </div>
                    <span className="text-slate-300">·</span>
                    <span className="text-sm font-medium text-slate-500">{period}</span>
                </div>

                <button
                    onClick={() => window.print()}
                    className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
                >
                    <Printer className="h-4 w-4" /> Download PDF
                </button>
            </div>

            {/* ── Report card ────────────────────────────────────────────── */}
            <div className="p-4 sm:p-8">
                <div
                    id="report-card"
                    className="max-w-4xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden"
                >
                    {/* ── Header stripe ──────────────────────────────────── */}
                    <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-8 py-5 flex items-start justify-between gap-4">
                        <div className="flex items-center gap-2.5">
                            <Zap className="h-6 w-6 text-blue-400 shrink-0" />
                            <div>
                                <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                                    Grid-IQ
                                </p>
                                <p className="text-base font-bold text-white leading-tight">
                                    Monthly Energy Report
                                </p>
                            </div>
                        </div>
                        <div className="text-right shrink-0">
                            <p className="text-sm font-semibold text-white">
                                {selectedSite?.name ?? "—"}
                            </p>
                            {selectedSite?.address && (
                                <p className="text-xs text-slate-400 mt-0.5">{selectedSite.address}</p>
                            )}
                            <p className="text-xs text-slate-400 mt-1">
                                {period} · Generated {generated}
                            </p>
                        </div>
                    </div>

                    <div className="p-6 sm:p-8 space-y-10">

                        {/* ── Hero: Score ring + KPIs ────────────────────── */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">

                            {/* Score ring */}
                            <div className="flex flex-col items-center gap-3">
                                <div className="relative h-36 w-36">
                                    <svg viewBox="0 0 36 36" className="h-36 w-36 -rotate-90">
                                        <circle
                                            cx="18" cy="18" r="15.9"
                                            fill="none" stroke="#e2e8f0" strokeWidth="2"
                                        />
                                        <circle
                                            cx="18" cy="18" r="15.9"
                                            fill="none"
                                            stroke={scoreStroke(selectedScore?.score ?? null)}
                                            strokeWidth="2" strokeLinecap="round"
                                            strokeDasharray={`${selectedScore?.score ?? 0} 100`}
                                            style={{ transition: "stroke-dasharray 1.2s ease" }}
                                        />
                                    </svg>
                                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                                        <span className={`text-4xl font-bold tabular-nums leading-none ${scoreTextCls(selectedScore?.score ?? null)}`}>
                                            {selectedScore ? Math.round(selectedScore.score) : "—"}
                                        </span>
                                        <span className="text-xs text-slate-400 mt-1">/ 100</span>
                                    </div>
                                </div>
                                <div className="text-center">
                                    {(() => {
                                        const { text, cls } = scoreBadge(selectedScore?.score ?? null);
                                        return (
                                            <span className={`text-xs px-2.5 py-1 rounded-full border font-semibold ${cls}`}>
                                                {text}
                                            </span>
                                        );
                                    })()}
                                    <p className="text-xs text-slate-400 mt-2">Energy Score</p>
                                </div>
                            </div>

                            {/* Monthly savings */}
                            <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-emerald-50 border border-emerald-100 text-center">
                                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-2">
                                    Savings Opportunity
                                </p>
                                <p className="text-4xl font-bold text-emerald-700 leading-none">
                                    {fmtZAR(totalMonthly)}
                                </p>
                                <p className="text-sm text-emerald-600 mt-1">per month</p>
                                <p className="text-xs text-slate-400 mt-3">
                                    {siteRecs.length} recommendation{siteRecs.length !== 1 ? "s" : ""} identified
                                </p>
                            </div>

                            {/* Annual + CO₂ */}
                            <div className="flex flex-col gap-3">
                                <div className="p-4 rounded-xl bg-blue-50 border border-blue-100">
                                    <p className="text-[10px] font-bold text-blue-500 uppercase tracking-widest mb-1">
                                        Annual Potential
                                    </p>
                                    <p className="text-2xl font-bold text-blue-700">{fmtZAR(totalAnnual)}</p>
                                    <p className="text-xs text-slate-400 mt-0.5">if all implemented</p>
                                </div>
                                <div className="p-4 rounded-xl bg-green-50 border border-green-100 flex items-center gap-3">
                                    <Leaf className="h-5 w-5 text-green-500 shrink-0" />
                                    <div>
                                        <p className="text-[10px] font-bold text-green-600 uppercase tracking-widest">
                                            CO₂ Avoided
                                        </p>
                                        <p className="text-xl font-bold text-green-700 leading-tight">
                                            {co2Avoided.toFixed(1)}
                                            <span className="text-sm font-normal text-green-600 ml-1">tCO₂e/yr</span>
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ── Score breakdown ────────────────────────────── */}
                        {components.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
                                    Score Breakdown
                                </p>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    {components.map(({ label, score, key }) => {
                                        const isWorst = score !== null
                                            && score < 70
                                            && components.every(c => c.key === key || (c.score ?? 999) >= score);
                                        return (
                                            <div
                                                key={key}
                                                className={`p-4 rounded-xl border ${
                                                    isWorst
                                                        ? "border-orange-200 bg-orange-50"
                                                        : "border-slate-100 bg-slate-50"
                                                }`}
                                            >
                                                <div className="flex items-center justify-between mb-2">
                                                    <p className="text-xs text-slate-500 font-medium leading-tight">
                                                        {label}
                                                    </p>
                                                    {isWorst && (
                                                        <AlertTriangle className="h-3.5 w-3.5 text-orange-400 shrink-0 ml-1" />
                                                    )}
                                                </div>
                                                <p className={`text-3xl font-bold tabular-nums mb-3 ${scoreTextCls(score)}`}>
                                                    {score !== null ? Math.round(score) : "—"}
                                                </p>
                                                <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                                    {score !== null && (
                                                        <div
                                                            className={`h-full rounded-full transition-all duration-700 ${scoreFill(score)}`}
                                                            style={{ width: `${score}%` }}
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* ── Charts ─────────────────────────────────────── */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                            {/* Savings breakdown donut */}
                            <div className="p-5 rounded-xl border border-slate-100 bg-slate-50">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
                                    Savings by Category
                                </p>
                                {pieData.length > 0 ? (
                                    <>
                                        <div className="relative">
                                            <ResponsiveContainer width="100%" height={200}>
                                                <PieChart>
                                                    <Pie
                                                        data={pieData}
                                                        cx="50%" cy="50%"
                                                        innerRadius={58} outerRadius={84}
                                                        dataKey="value"
                                                        paddingAngle={2}
                                                        startAngle={90} endAngle={-270}
                                                    >
                                                        {pieData.map((entry, i) => (
                                                            <Cell key={i} fill={entry.fill} strokeWidth={0} />
                                                        ))}
                                                    </Pie>
                                                    <Tooltip
                                                        {...TOOLTIP_STYLE}
                                                        formatter={(v: any) => [fmtZAR(Number(v)), "Monthly Saving"]}
                                                    />
                                                </PieChart>
                                            </ResponsiveContainer>
                                            {/* Centre label */}
                                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                <div className="text-center">
                                                    <p className="text-[10px] text-slate-400 font-medium">Total</p>
                                                    <p className="text-lg font-bold text-slate-700">
                                                        R {(totalMonthly / 1000).toFixed(0)}k
                                                    </p>
                                                    <p className="text-[10px] text-slate-400">/mo</p>
                                                </div>
                                            </div>
                                        </div>
                                        {/* Legend */}
                                        <div className="mt-3 space-y-1.5">
                                            {pieData.slice(0, 5).map(d => (
                                                <div key={d.name} className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <div
                                                            className="h-2.5 w-2.5 rounded-full shrink-0"
                                                            style={{ backgroundColor: d.fill }}
                                                        />
                                                        <span className="text-xs text-slate-600">{d.name}</span>
                                                    </div>
                                                    <span className="text-xs font-semibold text-slate-700">
                                                        {fmtZAR(d.value)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <div className="h-[220px] flex items-center justify-center text-slate-400 text-sm">
                                        No recommendation data yet
                                    </div>
                                )}
                            </div>

                            {/* 6-month consumption chart */}
                            <div className="p-5 rounded-xl border border-slate-100 bg-slate-50">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
                                    6-Month Consumption
                                </p>
                                {consumption.length > 0 ? (
                                    <ResponsiveContainer width="100%" height={200}>
                                        <BarChart
                                            data={consumption}
                                            margin={{ top: 0, right: 4, left: -20, bottom: 0 }}
                                        >
                                            <CartesianGrid
                                                strokeDasharray="3 3"
                                                stroke="#e2e8f0"
                                                vertical={false}
                                            />
                                            <XAxis
                                                dataKey="month"
                                                stroke="#94a3b8" fontSize={11}
                                                axisLine={false} tickLine={false}
                                            />
                                            <YAxis
                                                stroke="#94a3b8" fontSize={11}
                                                axisLine={false} tickLine={false}
                                                tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
                                            />
                                            <Tooltip
                                                {...TOOLTIP_STYLE}
                                                formatter={(v: any) => [
                                                    `${Number(v).toLocaleString()} kWh`,
                                                    "Consumption",
                                                ]}
                                            />
                                            <Bar dataKey="kwh" radius={[3, 3, 0, 0]}>
                                                {consumption.map((_, i) => (
                                                    <Cell
                                                        key={i}
                                                        fill={i === consumption.length - 1 ? "#059669" : "#3b82f6"}
                                                        fillOpacity={i === consumption.length - 1 ? 1 : 0.65}
                                                    />
                                                ))}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <div className="h-[200px] flex items-center justify-center text-slate-400 text-sm">
                                        No consumption data yet
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── Top Recommendations ────────────────────────── */}
                        {topRecs.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
                                    Top Recommendations
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    {topRecs.map(rec => (
                                        <div
                                            key={rec.id}
                                            className="rounded-xl border-t-4 border border-slate-200 bg-white overflow-hidden"
                                            style={{ borderTopColor: TYPE_COLOUR[rec.type] ?? "#94a3b8" }}
                                        >
                                            <div className="p-4">
                                                <span
                                                    className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full text-white mb-2"
                                                    style={{ backgroundColor: TYPE_COLOUR[rec.type] ?? "#94a3b8" }}
                                                >
                                                    {TYPE_LABEL[rec.type] ?? rec.type}
                                                </span>
                                                <p className="text-sm font-semibold text-slate-800 mb-3 line-clamp-2 leading-snug">
                                                    {rec.title}
                                                </p>
                                                <div className="space-y-2 pt-2 border-t border-slate-100">
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-xs text-slate-400">Monthly Saving</span>
                                                        <span className="text-sm font-bold text-emerald-600">
                                                            {fmtZAR(rec.estimated_monthly_saving_zar)}
                                                        </span>
                                                    </div>
                                                    {rec.estimated_implementation_cost_zar > 0 && (
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-xs text-slate-400">Impl. Cost</span>
                                                            <span className="text-xs font-semibold text-slate-600">
                                                                {fmtZAR(rec.estimated_implementation_cost_zar)}
                                                            </span>
                                                        </div>
                                                    )}
                                                    {rec.payback_months > 0 && (
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-xs text-slate-400">Payback</span>
                                                            <span className="text-xs font-semibold text-blue-600">
                                                                {rec.payback_months} months
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* ── Looking Ahead ──────────────────────────────── */}
                        {lookingAhead && (
                            <div className="rounded-xl bg-blue-50 border border-blue-100 p-6">
                                <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-1">
                                    Looking Ahead · {lookingAhead.component}
                                </p>
                                <h3 className="text-base font-bold text-slate-800 mb-2">
                                    {lookingAhead.title}
                                </h3>
                                <p className="text-sm text-slate-600 leading-relaxed">
                                    {lookingAhead.body}
                                </p>
                            </div>
                        )}

                        {/* ── No-data state ──────────────────────────────── */}
                        {!selectedScore && siteRecs.length === 0 && (
                            <div className="text-center py-10 text-slate-400">
                                <p className="text-sm font-semibold text-slate-600">No data for this site yet</p>
                                <p className="text-xs mt-1 text-slate-400">
                                    Run an AI analysis on this site to populate the report.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* ── Footer ─────────────────────────────────────────── */}
                    <div className="px-8 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                            <Zap className="h-4 w-4 text-blue-500 shrink-0" />
                            <span className="text-xs font-semibold text-slate-500">
                                Grid-IQ Energy Intelligence
                            </span>
                        </div>
                        <div className="text-right">
                            <p className="text-xs text-slate-400">
                                Next report: <span className="font-medium text-slate-600">{nextMonth}</span>
                            </p>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                                grid-iq.co.za · Confidential
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
