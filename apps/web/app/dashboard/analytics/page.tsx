"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import {
    BarChart, Bar, LineChart, Line,
    XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend,
} from "recharts";
import { Zap, TrendingDown, RefreshCw, Loader2 } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

interface Reading {
    time: string;
    power_active_total?: number | null;
    power_factor_total?: number | null;
    thd_voltage_a?: number | null;
    voltage_a?: number | null;
    current_a?: number | null;
    current_b?: number | null;
    current_c?: number | null;
}

export default function AnalyticsPage() {
    const [readings,    setReadings]    = useState<Reading[]>([]);
    const [loading,     setLoading]     = useState(true);
    const [aiInsight,   setAiInsight]   = useState<string>("");
    const [aiLoading,   setAiLoading]   = useState(false);
    const [meterId,     setMeterId]     = useState<string | null>(null);
    const [meterName,   setMeterName]   = useState<string>("");

    const token = () => (typeof window !== "undefined" ? localStorage.getItem("token") ?? "" : "");

    // Load meter + last 7 days of readings
    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const headers = { Authorization: `Bearer ${token()}` };
            const metersRes = await fetch(`${API}/ingestion/meters`, { headers });
            if (!metersRes.ok) return;
            const meters = await metersRes.json();
            const activeMeter = meters.find((m: any) => m.latest_reading?.time);
            if (!activeMeter) return;

            setMeterId(activeMeter.id);
            setMeterName(activeMeter.name);

            const from = new Date(Date.now() - 7 * 86400000).toISOString();
            const readRes = await fetch(
                `${API}/ingestion/meters/${activeMeter.id}/readings?from=${from}&limit=2000`,
                { headers }
            );
            if (readRes.ok) setReadings(await readRes.json());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Trigger AI insight
    const generateInsight = useCallback(async () => {
        if (!readings.length) return;
        setAiLoading(true);
        setAiInsight("");
        try {
            const latest  = readings[readings.length - 1];
            const powers  = readings.map(r => r.power_active_total ?? 0).filter(Boolean);
            const peakKw  = Math.max(...powers).toFixed(1);
            const avgKw   = (powers.reduce((a, b) => a + b, 0) / powers.length).toFixed(1);
            const latPF   = latest.power_factor_total?.toFixed(3) ?? "N/A";
            const latTHD  = latest.thd_voltage_a != null ? `${latest.thd_voltage_a.toFixed(2)}%` : "N/A";
            const latVolt = latest.voltage_a?.toFixed(1) ?? "N/A";

            // Phase imbalance
            const latI1 = latest.current_a?.toFixed(1) ?? "N/A";
            const latI2 = latest.current_b?.toFixed(1) ?? "N/A";
            const latI3 = latest.current_c?.toFixed(1) ?? "N/A";

            const context = `
Site meter: ${meterName}
Analysis period: last 7 days (${readings.length} readings)
Peak demand: ${peakKw} kW
Average demand: ${avgKw} kW
Latest power factor: ${latPF}
Latest voltage THD: ${latTHD}
Latest voltage L1: ${latVolt} V
Latest current L1/L2/L3: ${latI1} / ${latI2} / ${latI3} A
Tariff: South African commercial (R2.50/kWh avg, demand charges apply above contracted MDI)
`;

            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    context,
                    messages: [{
                        role: "user",
                        content: "Analyse this site's energy data from the last 7 days. Identify the top 2-3 specific insights or anomalies, flag any risks, and give one concrete cost-saving recommendation with an estimated rand value. Be specific and use the actual numbers.",
                    }],
                }),
            });
            const data = await res.json();
            setAiInsight(data.text || data.error || "No insight generated.");
        } catch (e: any) {
            setAiInsight("Failed to generate insight. Check your API key.");
        } finally {
            setAiLoading(false);
        }
    }, [readings, meterName]);

    // Auto-generate when data loads
    useEffect(() => {
        if (!loading && readings.length > 0 && !aiInsight) generateInsight();
    }, [loading, readings.length]);

    // ── Derived chart data ──────────────────────────────────────────────────────

    // Daily peak vs average kW (last 7 days)
    const demandByDay = readings.reduce((acc: Record<string, number[]>, r) => {
        const day = r.time?.slice(0, 10);
        if (!day || r.power_active_total == null) return acc;
        if (!acc[day]) acc[day] = [];
        acc[day].push(r.power_active_total);
        return acc;
    }, {});

    const demandData = Object.entries(demandByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, vals]) => ({
            day: new Date(day).toLocaleDateString("en-ZA", { month: "short", day: "numeric" }),
            peak: Math.round(Math.max(...vals) * 10) / 10,
            avg:  Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
        }));

    // 3-phase current balance (last 24 readings for visibility)
    const phaseData = readings
        .filter(r => r.current_a != null)
        .slice(-48)
        .map(r => ({
            time: new Date(r.time).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
            L1: r.current_a != null ? Math.round(r.current_a * 10) / 10 : null,
            L2: r.current_b != null ? Math.round(r.current_b * 10) / 10 : null,
            L3: r.current_c != null ? Math.round(r.current_c * 10) / 10 : null,
        }));

    // Latest values for quality cards
    const latest     = readings.length ? readings[readings.length - 1] : null;
    const avgPF      = readings.filter(r => r.power_factor_total != null).reduce((a, r, _, arr) => a + (r.power_factor_total! / arr.length), 0);
    const avgTHD     = readings.filter(r => r.thd_voltage_a != null).reduce((a, r, _, arr) => a + (r.thd_voltage_a! / arr.length), 0);
    const voltReadings = readings.filter(r => r.voltage_a != null);
    const voltMin    = voltReadings.length ? Math.min(...voltReadings.map(r => r.voltage_a!)) : null;
    const voltMax    = voltReadings.length ? Math.max(...voltReadings.map(r => r.voltage_a!)) : null;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Advanced Analytics</h1>
                    <p className="text-slate-400 mt-2">
                        {meterName ? `Live data — ${meterName} · last 7 days` : "Loading meter data…"}
                    </p>
                </div>
                <button onClick={fetchData} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                    <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    Refresh
                </button>
            </div>

            {/* AI Insight Card */}
            <div className="p-5 rounded-xl bg-gradient-to-r from-blue-900/40 to-purple-900/40 border border-blue-500/20">
                <div className="flex items-start gap-4">
                    <div className="p-3 rounded-full bg-blue-500/20 text-blue-400 shrink-0">
                        <Zap className="h-6 w-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <h3 className="text-lg font-semibold text-white">AI Energy Insight</h3>
                            <button
                                onClick={generateInsight}
                                disabled={aiLoading || loading}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/30 text-blue-300 rounded-lg transition-colors disabled:opacity-50">
                                <RefreshCw className={`w-3 h-3 ${aiLoading ? "animate-spin" : ""}`} />
                                {aiLoading ? "Analysing…" : "Regenerate"}
                            </button>
                        </div>
                        {aiLoading ? (
                            <div className="flex items-center gap-2 mt-3 text-slate-400 text-sm">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Analysing {readings.length} readings with GPT-4o-mini…
                            </div>
                        ) : aiInsight ? (
                            <div className="mt-2 text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                                {aiInsight}
                            </div>
                        ) : (
                            <p className="mt-2 text-sm text-slate-500">
                                {loading ? "Loading data…" : "No data available yet."}
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Power Quality Scorecards */}
            {latest && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                        {
                            label: "Power Factor",
                            value: avgPF > 0 ? avgPF.toFixed(3) : "—",
                            sub: avgPF >= 0.95 ? "✓ Excellent" : avgPF >= 0.85 ? "⚠ Acceptable" : "✗ Below 0.85",
                            cls: avgPF >= 0.95 ? "text-emerald-400" : avgPF >= 0.85 ? "text-yellow-400" : "text-red-400",
                        },
                        {
                            label: "Avg THD Voltage",
                            value: avgTHD > 0 ? `${avgTHD.toFixed(2)}%` : "—",
                            sub: avgTHD === 0 ? "No data" : avgTHD < 5 ? "✓ Within limits" : "✗ Above 5% limit",
                            cls: avgTHD === 0 ? "text-slate-500" : avgTHD < 5 ? "text-emerald-400" : "text-red-400",
                        },
                        {
                            label: "Voltage Range L1",
                            value: voltMin != null ? `${voltMin.toFixed(0)}–${voltMax?.toFixed(0)} V` : "—",
                            sub: voltMin != null && voltMin >= 380 && voltMax! <= 420 ? "✓ Within 380–420 V" : voltMin != null ? "⚠ Outside range" : "No data",
                            cls: voltMin != null && voltMin >= 380 && voltMax! <= 420 ? "text-emerald-400" : "text-yellow-400",
                        },
                        {
                            label: "Peak Demand (7d)",
                            value: demandData.length ? `${Math.max(...demandData.map(d => d.peak))} kW` : "—",
                            sub: demandData.length ? `Avg ${(demandData.reduce((a, d) => a + d.avg, 0) / demandData.length).toFixed(0)} kW` : "No data",
                            cls: "text-white",
                        },
                    ].map(({ label, value, sub, cls }) => (
                        <Card key={label} className="p-4">
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
                            <p className={`text-2xl font-bold mt-1 ${cls}`}>{value}</p>
                            <p className={`text-xs mt-1 ${cls}`}>{sub}</p>
                        </Card>
                    ))}
                </div>
            )}

            <div className="grid gap-6 md:grid-cols-2">
                {/* Daily Peak vs Average Demand */}
                <Card>
                    <CardHeader title="Daily Demand (kW)" subtitle="Peak vs average — last 7 days · live data" />
                    <div className="h-[300px] w-full mt-4">
                        {loading ? (
                            <div className="flex h-full items-center justify-center">
                                <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                            </div>
                        ) : demandData.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-slate-500 text-sm">No readings yet</div>
                        ) : (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={demandData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                    <XAxis dataKey="day" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} unit=" kW" />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc" }}
                                        cursor={{ fill: "#1e293b" }}
                                        formatter={(v: any, name: string) => [`${v} kW`, name]}
                                    />
                                    <Legend />
                                    <Bar dataKey="peak" name="Peak" fill="#ef4444" radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="avg"  name="Average" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        )}
                    </div>
                </Card>

                {/* 3-Phase Current Balance */}
                <Card>
                    <CardHeader title="3-Phase Current Balance" subtitle="L1 / L2 / L3 (A) — last 48 readings · live data" />
                    <div className="h-[300px] w-full mt-4">
                        {loading ? (
                            <div className="flex h-full items-center justify-center">
                                <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                            </div>
                        ) : phaseData.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-slate-500 text-sm">No 3-phase data yet</div>
                        ) : (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={phaseData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                    <XAxis dataKey="time" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                                    <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} unit=" A" />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: "12px" }}
                                        formatter={(v: any, name: string) => [`${v} A`, name]}
                                    />
                                    <Legend wrapperStyle={{ fontSize: 12 }} />
                                    <Line type="monotone" dataKey="L1" stroke="#f97316" strokeWidth={2} dot={false} connectNulls />
                                    <Line type="monotone" dataKey="L2" stroke="#f59e0b" strokeWidth={2} dot={false} connectNulls />
                                    <Line type="monotone" dataKey="L3" stroke="#10b981" strokeWidth={2} dot={false} connectNulls />
                                </LineChart>
                            </ResponsiveContainer>
                        )}
                    </div>
                </Card>
            </div>
        </div>
    );
}
