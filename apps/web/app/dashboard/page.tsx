"use client";

import { useState, useEffect, useCallback } from "react";
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Brush,
} from "recharts";
import {
    Activity, Zap, AlertTriangle, Loader2, RefreshCw, Server, Gauge, Plus,
    TrendingUp, ChevronRight, Info, ShieldAlert, XCircle,
} from "lucide-react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { toNum } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Meter {
    id: string;
    name: string;
    site_id: string;
    latest_reading?: {
        power_active_total?: number;
        voltage_a?: number;
        current_a?: number;
        power_factor_total?: number;
        time: string;
    } | null;
}

interface Alert {
    id: string;
    type: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
    message: string;
    meter_name: string;
    created_at: string;
    is_read: boolean;
}

interface Reading {
    time: string;
    power_active_total?: number | null;
}

interface SiteScore {
    site_id: string;
    site_name?: string;
    score: number;
    pf_score: number;
    thd_score: number;
    voltage_unbalance_score: number;
    voltage_quality_score: number;
    tariff_type: string;
    calculated_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)     return `${Math.floor(diff / 1_000)}s ago`;
    if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

function severityClasses(sev: string): string {
    if (sev === "CRITICAL") return "text-red-400 bg-red-500/10 border-red-500/20";
    if (sev === "WARNING")  return "text-yellow-400 bg-yellow-500/10 border-yellow-500/20";
    return "text-blue-400 bg-blue-500/10 border-blue-500/20";
}

function scoreColour(score: number | null): string {
    if (score === null) return "text-slate-500";
    if (score >= 80)   return "text-emerald-400";
    if (score >= 60)   return "text-yellow-400";
    if (score >= 40)   return "text-orange-400";
    return "text-red-400";
}

function scoreStroke(score: number | null): string {
    if (score === null) return "#475569";
    if (score >= 80)   return "#34d399";
    if (score >= 60)   return "#facc15";
    if (score >= 40)   return "#fb923c";
    return "#f87171";
}

function scoreLabel(score: number | null): { text: string; cls: string } {
    if (score === null) return { text: "No data yet",  cls: "text-slate-500 bg-slate-800" };
    if (score >= 80)   return { text: "Excellent",     cls: "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20" };
    if (score >= 60)   return { text: "Good",          cls: "text-yellow-400  bg-yellow-500/10  border border-yellow-500/20" };
    if (score >= 40)   return { text: "Fair",          cls: "text-orange-400  bg-orange-500/10  border border-orange-500/20" };
    return                    { text: "Needs Attention", cls: "text-red-400   bg-red-500/10     border border-red-500/20" };
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
    const [meters,              setMeters]              = useState<Meter[]>([]);
    const [alerts,              setAlerts]              = useState<Alert[]>([]);
    const [scores,              setScores]              = useState<SiteScore[]>([]);
    const [chartData,           setChartData]           = useState<{ time: string; kw: number }[]>([]);
    const [loading,             setLoading]             = useState(true);
    const [chartLoading,        setChartLoading]        = useState(false);
    const [refreshedAt,         setRefreshedAt]         = useState<Date>(new Date());
    const [selectedChartMeter,  setSelectedChartMeter]  = useState<string | null>("all");

    // Fetch chart data — "all" fetches site-wide aggregate, otherwise per-meter
    const fetchChartData = useCallback(async (meterId: string) => {
        setChartLoading(true);
        try {
            const from = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
            const url = meterId === "all"
                ? `${API}/ingestion/readings/aggregate?from=${from}&limit=500`
                : `${API}/ingestion/meters/${meterId}/readings?from=${from}&limit=500`;
            const res = await fetch(url, { credentials: 'include' });
            if (res.ok) {
                const readings: Reading[] = await res.json();
                setChartData(
                    readings
                        .filter((r) => r.power_active_total != null)
                        .map((r) => ({
                            time: new Date(r.time).toLocaleTimeString("en-ZA", {
                                hour: "2-digit", minute: "2-digit",
                            }),
                            kw: Math.round((r.power_active_total ?? 0) * 10) / 10,
                        }))
                );
            }
        } catch (err) {
            console.error("Chart fetch error:", err);
        } finally {
            setChartLoading(false);
        }
    }, []);

    const fetchDashboard = useCallback(async () => {
        try {
            const [metersRes, alertsRes, scoresRes] = await Promise.all([
                fetch(`${API}/ingestion/meters`,       { credentials: 'include' }),
                fetch(`${API}/ingestion/alerts`,       { credentials: 'include' }),
                fetch(`${API}/ingestion/sites/scores`, { credentials: 'include' }),
            ]);

            if (metersRes.status === 401) { window.location.href = "/login"; return; }

            const metersData: Meter[]     = metersRes.ok ? await metersRes.json() : [];
            const alertsData: Alert[]     = alertsRes.ok ? await alertsRes.json() : [];
            const scoresData: SiteScore[] = scoresRes.ok ? await scoresRes.json() : [];

            setMeters(Array.isArray(metersData) ? metersData : []);
            setAlerts(Array.isArray(alertsData) ? alertsData : []);
            setScores(Array.isArray(scoresData) ? scoresData : []);

            // Default to site-wide aggregate view; preserve user's manual selection
            setSelectedChartMeter(prev => prev ?? "all");

            setRefreshedAt(new Date());
        } catch (err) {
            console.error("Dashboard fetch error:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchDashboard();
        const iv = setInterval(fetchDashboard, 15_000);
        return () => clearInterval(iv);
    }, [fetchDashboard]);

    // Re-fetch chart when selected meter changes
    useEffect(() => {
        if (selectedChartMeter) fetchChartData(selectedChartMeter);
    }, [selectedChartMeter, fetchChartData]);

    // ── Derived KPIs ──────────────────────────────────────────────────────────
    const totalPowerKw = meters.reduce(
        (sum, m) => sum + (m.latest_reading?.power_active_total ?? 0), 0
    );

    const liveMeters = meters.filter((m) => {
        if (!m.latest_reading?.time) return false;
        return Date.now() - new Date(m.latest_reading.time).getTime() < 300_000;
    });

    const unreadAlerts = alerts.filter((a) => !a.is_read);

    const avgPf = (() => {
        const pfs = meters
            .map((m) => m.latest_reading?.power_factor_total)
            .filter((v): v is number => v != null);
        return pfs.length > 0 ? pfs.reduce((a, b) => a + b, 0) / pfs.length : null;
    })();

    // Energy score: average across all sites with a score.
    // toNum() guards against NUMERIC columns arriving as strings (otherwise the
    // reduce concatenates and only "works" by luck when there is a single site).
    const avgScore = scores.length > 0
        ? Math.round(scores.reduce((s, r) => s + toNum(r.score), 0) / scores.length)
        : null;

    const [expandedHint, setExpandedHint] = useState<string | null>(null);

    const avgComponents = scores.length > 0 ? {
        pf:        Math.round(scores.reduce((s, r) => s + toNum(r.pf_score),                0) / scores.length),
        thd:       Math.round(scores.reduce((s, r) => s + toNum(r.thd_score),               0) / scores.length),
        unbalance: Math.round(scores.reduce((s, r) => s + toNum(r.voltage_unbalance_score), 0) / scores.length),
        voltage:   Math.round(scores.reduce((s, r) => s + toNum(r.voltage_quality_score),   0) / scores.length),
    } : null;

    const { text: statusText, cls: statusCls } = scoreLabel(avgScore);

    // ── Render ────────────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in duration-500">

            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Energy Overview</h1>
                    <p className="text-slate-400 mt-1">
                        {meters.length} meter{meters.length !== 1 ? "s" : ""} monitored ·{" "}
                        updated {timeAgo(refreshedAt.toISOString())}
                    </p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={fetchDashboard}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <RefreshCw className="h-4 w-4" /> Refresh
                    </button>
                    <Link
                        href="/dashboard/sites"
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all"
                    >
                        <Plus className="h-4 w-4" /> Add Meter
                    </Link>
                </div>
            </div>

            {/* ── Energy Score Banner ─────────────────────────────────────── */}
            <Card className="overflow-hidden">
                <div className="flex flex-col md:flex-row md:items-center gap-6 md:gap-8">

                    {/* Score Ring */}
                    <div className="shrink-0 flex flex-col items-center gap-2">
                        <div className="relative w-28 h-28">
                            <svg viewBox="0 0 36 36" className="w-28 h-28 -rotate-90">
                                {/* Track */}
                                <circle cx="18" cy="18" r="15.9"
                                    fill="none" stroke="#1e293b" strokeWidth="2.5" />
                                {/* Progress */}
                                <circle cx="18" cy="18" r="15.9"
                                    fill="none"
                                    stroke={scoreStroke(avgScore)}
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeDasharray={`${avgScore ?? 0} 100`}
                                    style={{ transition: "stroke-dasharray 1.2s ease" }}
                                />
                            </svg>
                            <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <span className={`text-2xl font-bold leading-none ${scoreColour(avgScore)}`}>
                                    {avgScore !== null ? avgScore : "—"}
                                </span>
                                <span className="text-[10px] text-slate-500 mt-0.5">/100</span>
                            </div>
                        </div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                            Energy Score
                        </p>
                    </div>

                    {/* Component Breakdown */}
                    <div className="flex-1">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-base font-semibold text-white">Site Performance Breakdown</h3>
                            <span className={`hidden sm:inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusCls}`}>
                                {statusText}
                            </span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            {[
                                {
                                    label: "Power Factor",
                                    value: avgComponents?.pf,
                                    hint: "Measures how efficiently the site uses electrical power. Based on average PF from your meter over the last 7 days. A PF below 0.85 triggers Eskom reactive energy penalties on your bill. Target is ≥0.95.",
                                    noData: false,
                                },
                                {
                                    label: "Harmonics (THD)",
                                    value: avgComponents?.thd,
                                    hint: "Total Harmonic Distortion in the voltage waveform. High THD damages sensitive equipment and overheats cables. NRS 048-2 limit is 8%. Note: your AXM-WEB2 is not currently sending THD readings — this score uses a neutral default of 70/100.",
                                    noData: scores.some(s => s.thd_score === 70),
                                },
                                {
                                    label: "Voltage Unbalance",
                                    value: avgComponents?.unbalance,
                                    hint: "Maximum deviation of any phase voltage from the 3-phase average, as a percentage. NRS 048-2 allows up to 2%. Above that, motors and VSDs overheat — a 2% unbalance can cause >25% extra winding heating, shortening motor life by years. Rebalance single-phase loads or investigate a faulty neutral if this is high. Single-phase sites show a neutral score (no unbalance is possible).",
                                    noData: false,
                                },
                                {
                                    label: "Voltage Quality",
                                    value: avgComponents?.voltage,
                                    hint: "How close your voltage stays to the South African nominal of 230V L-N (phase to neutral). Also penalises large swings between minimum and maximum readings. NRS 048 allows ±10% (207–253V). Persistent deviation accelerates motor and transformer ageing.",
                                    noData: false,
                                },
                            ].map(({ label, value, hint, noData }) => {
                                const isOpen = expandedHint === label;
                                const barColour = value == null ? "bg-slate-700"
                                    : value >= 75 ? "bg-emerald-500"
                                    : value >= 50 ? "bg-yellow-500"
                                    : "bg-red-500";
                                return (
                                    <div key={label}>
                                        <div className="flex justify-between items-center mb-1.5">
                                            <span className="text-xs text-slate-500 flex items-center gap-1">
                                                {label}
                                                <button
                                                    onClick={() => setExpandedHint(isOpen ? null : label)}
                                                    className="cursor-pointer hover:text-blue-400 transition-colors"
                                                    title="Click for explanation"
                                                >
                                                    <Info className={`w-3 h-3 ${isOpen ? "text-blue-400" : noData ? "text-yellow-600" : "text-slate-600"}`} />
                                                </button>
                                            </span>
                                            <span className={`text-xs font-semibold ${noData ? "text-slate-500" : "text-slate-300"}`}>
                                                {value != null ? value : "—"}
                                                {noData && <span className="text-[9px] text-slate-600 ml-1">est.</span>}
                                            </span>
                                        </div>
                                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                            <div
                                                className={`h-full rounded-full transition-all duration-700 ${noData ? "opacity-50" : ""} ${barColour}`}
                                                style={{ width: value != null ? `${value}%` : "0%" }}
                                            />
                                        </div>
                                        {isOpen && (
                                            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed bg-slate-900/60 rounded-lg px-2.5 py-2 border border-slate-800">
                                                {hint}
                                            </p>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {avgScore === null && (
                            <p className="mt-4 text-xs text-slate-500">
                                Energy score calculates automatically from meter readings (needs ≥10 readings).{" "}
                                <Link href="/dashboard/recommendations" className="text-blue-400 hover:underline">
                                    Run AI analysis →
                                </Link>
                            </p>
                        )}
                    </div>

                    {/* CTA */}
                    <div className="shrink-0 hidden lg:flex flex-col items-end gap-3 min-w-[160px]">
                        {scores.length > 0 && (
                            <p className="text-xs text-slate-500 text-right">
                                {scores.length} site{scores.length !== 1 ? "s" : ""} analysed
                            </p>
                        )}
                        <Link
                            href="/dashboard/recommendations"
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 rounded-lg text-sm font-medium transition-all whitespace-nowrap"
                        >
                            <TrendingUp className="h-4 w-4" />
                            Recommendations
                            <ChevronRight className="h-3 w-3" />
                        </Link>
                    </div>
                </div>
            </Card>

            {/* ── KPI Grid ───────────────────────────────────────────────── */}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">

                <Card>
                    <CardHeader title="Total Active Power" icon={Zap} />
                    <div className="mt-2">
                        <span className="text-3xl font-bold text-white">
                            {totalPowerKw >= 1_000
                                ? `${(totalPowerKw / 1_000).toFixed(2)}`
                                : totalPowerKw.toFixed(1)}
                        </span>
                        <span className="text-slate-500 ml-2">
                            {totalPowerKw >= 1_000 ? "MW" : "kW"}
                        </span>
                    </div>
                    <div className="mt-4 text-sm text-slate-400">
                        Across {meters.length} meter{meters.length !== 1 ? "s" : ""}
                    </div>
                </Card>

                <Card>
                    <CardHeader title="Live Meters" icon={Activity} />
                    <div className="mt-2">
                        <span className="text-3xl font-bold text-white">{liveMeters.length}</span>
                        <span className="text-slate-500 ml-2">/ {meters.length}</span>
                    </div>
                    <div className={`mt-4 flex items-center gap-1.5 text-sm ${liveMeters.length > 0 ? "text-emerald-400" : "text-slate-500"}`}>
                        <span className={`inline-block w-2 h-2 rounded-full ${liveMeters.length > 0 ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
                        {liveMeters.length > 0 ? "Receiving MQTT telemetry" : "No live meters"}
                    </div>
                </Card>

                <Card>
                    <CardHeader title="Active Alerts" icon={AlertTriangle} />
                    <div className="mt-2">
                        <span className={`text-3xl font-bold ${unreadAlerts.length > 0 ? "text-yellow-400" : "text-white"}`}>
                            {unreadAlerts.length}
                        </span>
                        <span className="text-slate-500 ml-2">unread</span>
                    </div>
                    <div className="mt-4 text-sm text-slate-400">
                        {alerts.length} total · {alerts.length - unreadAlerts.length} acknowledged
                    </div>
                </Card>

                <Card>
                    <CardHeader title="Avg Power Factor" icon={Gauge} />
                    <div className="mt-2">
                        <span className={`text-3xl font-bold ${
                            avgPf === null   ? "text-slate-500"
                            : avgPf >= 0.95 ? "text-emerald-400"
                            : avgPf >= 0.85 ? "text-yellow-400"
                            : "text-red-400"
                        }`}>
                            {avgPf !== null ? avgPf.toFixed(3) : "—"}
                        </span>
                    </div>
                    <div className="mt-4 text-sm text-slate-400">
                        {avgPf === null   ? "No readings yet"
                         : avgPf >= 0.95 ? "✓ Excellent"
                         : avgPf >= 0.85 ? "⚠ Acceptable — consider PF correction"
                         : "✗ Below 0.85 — penalty risk"}
                    </div>
                </Card>
            </div>

            {/* ── Charts Row ─────────────────────────────────────────────── */}
            <div className="grid gap-6 lg:grid-cols-10">

                {/* Power Trend Chart */}
                <Card className="lg:col-span-7 flex flex-col">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                        <CardHeader
                            title="Power Consumption Trend"
                            subtitle={
                                chartData.length > 0
                                    ? `${selectedChartMeter === "all" ? "All meters combined" : (meters.find(m => m.id === selectedChartMeter)?.name ?? "Meter")} · Active Power (kW) · last 24 h · ${chartData.length} points`
                                    : "No readings yet"
                            }
                        />
                        {/* Site total + per-meter selector */}
                        {meters.length > 0 && (
                            <select
                                value={selectedChartMeter ?? "all"}
                                onChange={e => setSelectedChartMeter(e.target.value)}
                                className="text-xs bg-slate-800 border border-slate-700 text-slate-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer"
                            >
                                <option value="all">All Meters (Site Total)</option>
                                {meters.map(m => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        )}
                        {chartLoading && <Loader2 className="w-4 h-4 animate-spin text-blue-400 mt-1" />}
                    </div>
                    <div className="flex-1 min-h-[300px] w-full mt-4">
                        {chartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="colorKw" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                    <XAxis
                                        dataKey="time"
                                        stroke="#64748b" fontSize={11} tickLine={false} axisLine={false}
                                        interval="preserveStartEnd"
                                    />
                                    <YAxis
                                        stroke="#64748b" fontSize={11} tickLine={false} axisLine={false}
                                        tickFormatter={(v) => `${v} kW`} width={58}
                                    />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: "#0f172a", borderColor: "#334155",
                                            borderRadius: "0.5rem", color: "#f8fafc", fontSize: "12px",
                                        }}
                                        itemStyle={{ color: "#3b82f6" }}
                                        formatter={(v: any) => [`${v} kW`, "Active Power"]}
                                    />
                                    <Area
                                        type="monotone" dataKey="kw"
                                        stroke="#3b82f6" strokeWidth={2}
                                        fillOpacity={1} fill="url(#colorKw)"
                                        dot={false} activeDot={{ r: 4, fill: "#3b82f6" }}
                                    />
                                    <Brush
                                        dataKey="time" height={24}
                                        stroke="#475569" fill="#0f172a" tickFormatter={() => ""}
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-2">
                                <Server className="w-10 h-10 opacity-40" />
                                <p className="text-sm text-slate-500">No meter readings yet</p>
                                <p className="text-xs text-slate-600">
                                    Connect an Acuvim II via MQTT or import a CSV to see data here
                                </p>
                                <div className="flex gap-3 mt-3">
                                    <Link
                                        href="/dashboard/settings/data"
                                        className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
                                    >
                                        Import CSV
                                    </Link>
                                    <Link
                                        href="/dashboard/sites"
                                        className="px-3 py-1.5 text-xs bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/20 rounded-lg transition-colors"
                                    >
                                        Add Meter
                                    </Link>
                                </div>
                            </div>
                        )}
                    </div>
                </Card>

                {/* Live Alerts Feed */}
                <Card className="lg:col-span-3 flex flex-col">
                    <CardHeader
                        title="Live Alerts"
                        subtitle={unreadAlerts.length > 0 ? `${unreadAlerts.length} unacknowledged` : "All clear"}
                    />
                    <div className="flex-1 space-y-2 mt-4 overflow-y-auto max-h-80">
                        {unreadAlerts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-10 gap-2">
                                <AlertTriangle className="w-8 h-8 text-slate-700 opacity-50" />
                                <p className="text-sm text-slate-500">No active alerts</p>
                                <p className="text-xs text-slate-600">All systems nominal</p>
                            </div>
                        ) : (
                            unreadAlerts.slice(0, 10).map((alert) => {
                                const Icon = alert.severity === "CRITICAL" ? XCircle
                                           : alert.severity === "WARNING"  ? ShieldAlert
                                           : Info;
                                // Human-readable type label
                                const typeLabel = alert.type
                                    .replace("PREDICTIVE_WARNING", "Predictive")
                                    .replace("MDI_EXCEEDED", "MDI Exceeded")
                                    .replace("MDI_WARNING", "MDI Warning")
                                    .replace("VOLTAGE_SAG", "Voltage Sag")
                                    .replace("OVERVOLTAGE", "Overvoltage")
                                    .replace("HIGH_THD", "High THD")
                                    .replace("FREQUENCY_DEVIATION", "Freq Deviation")
                                    .replace("PEAK_DEMAND", "Peak Demand")
                                    .replace(/_/g, " ");

                                return (
                                    <div
                                        key={alert.id}
                                        className={`flex items-start gap-2.5 p-3 rounded-lg border ${severityClasses(alert.severity)}`}
                                    >
                                        <Icon className="h-4 w-4 shrink-0 mt-0.5" />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-1.5 min-w-0 truncate">
                                                    <p className="text-xs font-semibold text-slate-200 shrink-0">{typeLabel}</p>
                                                    <span className="text-[11px] text-blue-300 font-medium truncate">· {alert.meter_name}</span>
                                                </div>
                                                <span className="text-[10px] text-slate-600 shrink-0">{timeAgo(alert.created_at)}</span>
                                            </div>
                                            <p className="text-[11px] text-slate-400 mt-0.5 leading-snug line-clamp-3">
                                                {alert.message}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                    <div className="mt-3 pt-3 border-t border-slate-800">
                        <Link
                            href="/dashboard/alerts"
                            className="block w-full py-2 text-sm text-center text-blue-400 hover:text-blue-300 transition-colors border border-dashed border-slate-700 rounded-lg"
                        >
                            View All Alerts
                        </Link>
                    </div>
                </Card>
            </div>

        </div>
    );
}
