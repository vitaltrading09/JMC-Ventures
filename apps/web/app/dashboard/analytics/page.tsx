"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import {
    BarChart, Bar, LineChart, Line,
    XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend,
} from "recharts";
import { Zap, TrendingDown, RefreshCw, Loader2, DollarSign, Lightbulb, ChevronRight, Activity } from "lucide-react";
import Link from "next/link";
import { zar, normalizeRec } from "@/lib/format";

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

interface SiteSettings {
    tariff_peak?: number | null;
    tariff_standard?: number | null;
    tariff_offpeak?: number | null;
    tariff_demand?: number | null;
    peak_times?: string | null;
    standard_times?: string | null;
    offpeak_times?: string | null;
    alert_max_kw?: number | null;
    contracted_mdi_kva?: number | null;
}

interface TariffCost {
    peakKwh: number;
    standardKwh: number;
    offpeakKwh: number;
    peakCost: number;
    standardCost: number;
    offpeakCost: number;
    totalCost: number;
    avgRate: number;
}

/** Returns the TOU time-of-use band for a given hour (0-23), using SA commercial defaults */
function getTouBand(hour: number, settings: SiteSettings): "peak" | "standard" | "offpeak" {
    // Default SA peak: 07:00-10:00 and 18:00-20:00 weekdays
    // We simplify to hour-of-day only (no weekday check without date)
    if (hour >= 7 && hour < 10) return "peak";
    if (hour >= 18 && hour < 20) return "peak";
    if (hour >= 6 && hour < 22) return "standard";
    return "offpeak";
}

/** Calculate TOU cost breakdown from readings array */
function calcTariffCost(readings: Reading[], settings: SiteSettings): TariffCost {
    const rPeak     = Number(settings.tariff_peak)     || 5.00;
    const rStd      = Number(settings.tariff_standard) || 2.00;
    const rOffpeak  = Number(settings.tariff_offpeak)  || 1.20;

    // Time-weighted energy: hold each reading's power for the ACTUAL time until
    // the next reading, rather than assuming a fixed interval. The readings API
    // returns dynamically-bucketed data (the bucket width varies with the range),
    // so a hardcoded 5-min step was wrong whenever the bucket wasn't 5 min. This
    // matches the backend /monthly integration, keeping every kWh figure consistent.
    const sorted = readings
        .filter(r => r.power_active_total != null && r.time)
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    // Cap each gap at 1.5x the typical spacing so an offline period (a jump across
    // missing buckets) isn't billed as continuous power, whatever the bucket width.
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
        gaps.push(new Date(sorted[i].time).getTime() - new Date(sorted[i - 1].time).getTime());
    }
    const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
    const capMs = median > 0 ? median * 1.5 : Infinity;

    let peakKwh = 0, standardKwh = 0, offpeakKwh = 0;

    for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        const next = sorted[i + 1];
        // Last reading has no following interval; give it the median step so the
        // final bucket's energy isn't dropped.
        const dtMs = next
            ? Math.min(new Date(next.time).getTime() - new Date(r.time).getTime(), capMs)
            : (median || 0);
        if (dtMs <= 0) continue;
        const kwh = (r.power_active_total as number) * (dtMs / 3_600_000);
        const hour = new Date(r.time).getHours();
        const band = getTouBand(hour, settings);
        if (band === "peak")     peakKwh     += kwh;
        else if (band === "standard") standardKwh += kwh;
        else                    offpeakKwh  += kwh;
    }

    const peakCost    = peakKwh    * rPeak;
    const standardCost = standardKwh * rStd;
    const offpeakCost = offpeakKwh * rOffpeak;
    const totalCost   = peakCost + standardCost + offpeakCost;
    const totalKwh    = peakKwh + standardKwh + offpeakKwh;
    const avgRate     = totalKwh > 0 ? totalCost / totalKwh : 0;

    return { peakKwh, standardKwh, offpeakKwh, peakCost, standardCost, offpeakCost, totalCost, avgRate };
}

interface MeterOption { id: string; name: string; site_id: string; is_active?: boolean; }
interface Recommendation {
    id: string; type: string; priority: number; title: string;
    problem: string; solution: string; confidence: string;
    estimated_monthly_saving_zar: number; payback_months: number;
    standard_reference?: string;
}

export default function AnalyticsPage() {
    const [readings,        setReadings]        = useState<Reading[]>([]);
    const [loading,         setLoading]         = useState(true);
    const [aiInsight,       setAiInsight]       = useState<string>("");
    const [aiLoading,       setAiLoading]       = useState(false);
    const [meterId,         setMeterId]         = useState<string | null>(null);
    const [siteId,          setSiteId]          = useState<string | null>(null);
    const [meterName,       setMeterName]       = useState<string>("");
    const [settings,        setSettings]        = useState<SiteSettings>({});
    const [availableMeters, setAvailableMeters] = useState<MeterOption[]>([]);
    const [meterRecs,       setMeterRecs]       = useState<Recommendation[]>([]);
    const [recsLoading,     setRecsLoading]     = useState(false);
    const [generating,      setGenerating]      = useState(false);

    // Load meter list once; selecting a meter triggers fetchMeterData below.
    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const metersRes = await fetch(`${API}/ingestion/meters`, { credentials: 'include' });
            if (!metersRes.ok) return;
            const meters = await metersRes.json();
            const active = meters.filter((m: any) => m.is_active !== false);
            setAvailableMeters(active);
            // Default to first meter that has live data, or just first active one.
            const initial = active.find((m: any) => m.latest_reading?.time) ?? active[0];
            if (initial && !meterId) {
                setMeterId(initial.id);
                setSiteId(initial.site_id);
                setMeterName(initial.name);
            }
        } finally {
            setLoading(false);
        }
    }, [meterId]);

    // Re-fetch readings + settings + recs whenever the selected meter changes
    const fetchMeterData = useCallback(async (mid: string, sid: string) => {
        setLoading(true);
        try {
            // Settings
            const settRes = await fetch(`${API}/ingestion/sites/${sid}/settings`, { credentials: 'include' });
            if (settRes.ok) setSettings(await settRes.json());

            // Readings (7d)
            const from = new Date(Date.now() - 7 * 86400000).toISOString();
            const readRes = await fetch(
                `${API}/ingestion/meters/${mid}/readings?from=${from}&limit=2000`,
                { credentials: 'include' }
            );
            if (readRes.ok) setReadings(await readRes.json());

            // Per-meter recommendations
            setRecsLoading(true);
            const recsRes = await fetch(`${API}/ingestion/meters/${mid}/recommendations`, { credentials: 'include' });
            if (recsRes.ok) setMeterRecs((await recsRes.json()).map(normalizeRec));
            setRecsLoading(false);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        if (meterId && siteId) fetchMeterData(meterId, siteId);
    }, [meterId, siteId, fetchMeterData]);

    // Switching meter via dropdown
    const handleMeterChange = (newMeterId: string) => {
        const m = availableMeters.find(x => x.id === newMeterId);
        if (!m) return;
        setMeterId(m.id);
        setSiteId(m.site_id);
        setMeterName(m.name);
        setAiInsight(""); // force regen for new meter
    };

    const handleGenerateRecsForMeter = async () => {
        if (!meterId) return;
        setGenerating(true);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/recommendations/generate`, {
                method: 'POST', credentials: 'include',
            });
            if (res.ok) {
                const recsRes = await fetch(`${API}/ingestion/meters/${meterId}/recommendations`, { credentials: 'include' });
                if (recsRes.ok) setMeterRecs((await recsRes.json()).map(normalizeRec));
            } else {
                const err = await res.json();
                alert(`Could not generate: ${err.error || res.status}`);
            }
        } finally {
            setGenerating(false);
        }
    };

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
            const latI1   = latest.current_a?.toFixed(1) ?? "N/A";
            const latI2   = latest.current_b?.toFixed(1) ?? "N/A";
            const latI3   = latest.current_c?.toFixed(1) ?? "N/A";

            // Tariff rates (real or SA defaults)
            const rPeak    = Number(settings.tariff_peak)     || 5.00;
            const rStd     = Number(settings.tariff_standard) || 2.00;
            const rOffpk   = Number(settings.tariff_offpeak)  || 1.20;
            const rDemand  = settings.tariff_demand ? `R${Number(settings.tariff_demand).toFixed(2)}/kVA` : "not configured";
            const mdi      = settings.contracted_mdi_kva ? `${settings.contracted_mdi_kva} kVA` : "not set";

            // 7-day cost estimate
            const cost7d = calcTariffCost(readings, settings);
            const projMonthly = (cost7d.totalCost / 7 * 30).toFixed(0);

            // 7-day averages are the headline figures shown on the KPI tiles. Send
            // these as primary and mark the instantaneous values clearly as a single
            // snapshot, so the AI doesn't quote a one-off reading as "the" power
            // factor and contradict the dashboard.
            const avg7PF  = readings.filter(r => r.power_factor_total != null)
                .reduce((a, r, _, arr) => a + (r.power_factor_total! / arr.length), 0);
            const avg7THD = readings.filter(r => r.thd_voltage_a != null)
                .reduce((a, r, _, arr) => a + (r.thd_voltage_a! / arr.length), 0);

            const context = `
Site meter: ${meterName}
Analysis period: last 7 days (${readings.length} readings)

HEADLINE METRICS (7-day averages — these are what the client sees on their dashboard;
quote THESE figures, not the instantaneous snapshot below):
  Power factor (7-day avg): ${avg7PF > 0 ? avg7PF.toFixed(3) : "N/A"}
  Voltage THD (7-day avg):  ${avg7THD > 0 ? avg7THD.toFixed(2) + "%" : "N/A"}
  Peak demand (7-day max):  ${peakKw} kW
  Average demand (7-day):   ${avgKw} kW

INSTANTANEOUS SNAPSHOT (most recent single reading only — do not present these as the
site's typical or headline values; use only to comment on current conditions):
  Power factor now: ${latPF}
  Voltage THD now: ${latTHD}
  Voltage L1 now: ${latVolt} V
  Current L1/L2/L3 now: ${latI1} / ${latI2} / ${latI3} A

TARIFF RATES (actual configured):
  Peak (07:00-10:00, 18:00-20:00): R${rPeak.toFixed(2)}/kWh
  Standard: R${rStd.toFixed(2)}/kWh
  Off-peak: R${rOffpk.toFixed(2)}/kWh
  Demand charge: ${rDemand}
  Contracted MDI: ${mdi}

7-DAY ENERGY COST BREAKDOWN:
  Peak energy: ${cost7d.peakKwh.toFixed(0)} kWh → R${cost7d.peakCost.toFixed(0)}
  Standard energy: ${cost7d.standardKwh.toFixed(0)} kWh → R${cost7d.standardCost.toFixed(0)}
  Off-peak energy: ${cost7d.offpeakKwh.toFixed(0)} kWh → R${cost7d.offpeakCost.toFixed(0)}
  Total 7-day cost: R${cost7d.totalCost.toFixed(0)}
  Effective average rate: R${cost7d.avgRate.toFixed(3)}/kWh
  Projected monthly cost: R${projMonthly}
`;

            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    context,
                    messages: [{
                        role: "user",
                        content: "Analyse this site's energy data from the last 7 days. Use the actual tariff rates provided. Identify the top 2-3 specific insights or anomalies, flag any risks, and give one concrete cost-saving recommendation with an estimated rand saving using the real tariff rates. Be specific and use the actual numbers.",
                    }],
                }),
            });
            const data = await res.json();
            setAiInsight(data.text || data.error || "No insight generated.");
        } catch {
            setAiInsight("Failed to generate insight. Check your API key.");
        } finally {
            setAiLoading(false);
        }
    }, [readings, meterName, settings]);

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

    // 3-phase current balance (last 48 readings for visibility)
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
    const latest       = readings.length ? readings[readings.length - 1] : null;
    const avgPF        = readings.filter(r => r.power_factor_total != null).reduce((a, r, _, arr) => a + (r.power_factor_total! / arr.length), 0);
    const avgTHD       = readings.filter(r => r.thd_voltage_a != null).reduce((a, r, _, arr) => a + (r.thd_voltage_a! / arr.length), 0);
    const voltReadings = readings.filter(r => r.voltage_a != null);
    const voltMin      = voltReadings.length ? Math.min(...voltReadings.map(r => r.voltage_a!)) : null;
    const voltMax      = voltReadings.length ? Math.max(...voltReadings.map(r => r.voltage_a!)) : null;

    // Tariff cost breakdown (7 days)
    const cost = calcTariffCost(readings, settings);
    const projMonthly = cost.totalCost / 7 * 30;

    // Daily cost chart data (cost per day by band)
    const costByDay = Object.entries(demandByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day]) => {
            const dayReadings = readings.filter(r => r.time?.slice(0, 10) === day);
            const c = calcTariffCost(dayReadings, settings);
            return {
                day: new Date(day).toLocaleDateString("en-ZA", { month: "short", day: "numeric" }),
                Peak: Math.round(c.peakCost),
                Standard: Math.round(c.standardCost),
                "Off-peak": Math.round(c.offpeakCost),
            };
        });

    const rPeak   = Number(settings.tariff_peak)     || 5.00;
    const rStd    = Number(settings.tariff_standard) || 2.00;
    const rOffpk  = Number(settings.tariff_offpeak)  || 1.20;

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
                <div className="flex items-center gap-2 flex-wrap">
                    {availableMeters.length > 1 && (
                        <select
                            value={meterId ?? ""}
                            onChange={e => handleMeterChange(e.target.value)}
                            className="bg-slate-900 border border-slate-800 text-slate-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                        >
                            {availableMeters.map(m => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                    )}
                    <button onClick={() => { fetchData(); if (meterId && siteId) fetchMeterData(meterId, siteId); }}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                        Refresh
                    </button>
                </div>
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
                                Analysing {readings.length} readings…
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

            {/* Per-Meter Recommendations */}
            <Card className="p-5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-lg bg-emerald-500/15 text-emerald-400">
                            <Lightbulb className="h-5 w-5" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-white">Recommendations for {meterName || "this meter"}</h3>
                            <p className="text-xs text-slate-500 mt-0.5">
                                {recsLoading ? "Loading…" : meterRecs.length > 0
                                    ? `${meterRecs.length} active · sorted by priority`
                                    : "No recommendations yet for this meter"}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleGenerateRecsForMeter}
                            disabled={generating || !meterId}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-400 rounded-lg text-sm font-medium disabled:opacity-50"
                        >
                            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                            {generating ? "Analysing…" : "Run AI Analysis"}
                        </button>
                        <Link
                            href="/dashboard/recommendations"
                            className="flex items-center gap-1 px-3 py-2 text-slate-400 hover:text-white text-sm transition-colors"
                        >
                            View all <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                    </div>
                </div>

                {meterRecs.length > 0 && (
                    <div className="mt-4 space-y-2">
                        {meterRecs.slice(0, 3).map(rec => (
                            <div key={rec.id} className="flex items-start gap-3 p-3 rounded-lg bg-slate-900/40 border border-slate-800">
                                <div className="text-xs font-bold text-slate-500 mt-0.5 shrink-0 w-5">#{rec.priority}</div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-medium text-white">{rec.title}</p>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-300 uppercase tracking-wide">
                                            {rec.type.replace(/_/g, " ").toLowerCase()}
                                        </span>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{rec.problem}</p>
                                </div>
                                {rec.estimated_monthly_saving_zar > 0 && (
                                    <div className="text-right shrink-0">
                                        <p className="text-sm font-bold text-emerald-400">
                                            {zar(rec.estimated_monthly_saving_zar)}
                                        </p>
                                        <p className="text-[10px] text-slate-500">per month</p>
                                    </div>
                                )}
                            </div>
                        ))}
                        {meterRecs.length > 3 && (
                            <Link
                                href="/dashboard/recommendations"
                                className="block text-center py-2 text-xs text-slate-400 hover:text-blue-400 border border-dashed border-slate-700 rounded-lg"
                            >
                                + {meterRecs.length - 3} more — view full list
                            </Link>
                        )}
                    </div>
                )}
            </Card>

            {/* Power Quality Scorecards */}
            {latest && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                        {
                            label: "Power Factor",
                            scope: `${meterName} · 7-day avg`,
                            value: avgPF > 0 ? avgPF.toFixed(3) : "—",
                            sub: avgPF >= 0.95 ? "✓ Excellent" : avgPF >= 0.85 ? "⚠ Acceptable" : "✗ Below 0.85",
                            cls: avgPF >= 0.95 ? "text-emerald-400" : avgPF >= 0.85 ? "text-yellow-400" : "text-red-400",
                        },
                        {
                            label: "THD Voltage",
                            scope: `${meterName} · 7-day avg`,
                            value: avgTHD > 0 ? `${avgTHD.toFixed(2)}%` : "—",
                            sub: avgTHD === 0 ? "No data" : avgTHD < 8 ? "✓ Within NRS 048" : "✗ Above 8% (NRS 048)",
                            cls: avgTHD === 0 ? "text-slate-500" : avgTHD < 8 ? "text-emerald-400" : "text-red-400",
                        },
                        {
                            label: "Voltage Range L1",
                            scope: `${meterName} · 7-day min–max`,
                            value: voltMin != null ? `${voltMin.toFixed(0)}–${voltMax?.toFixed(0)} V` : "—",
                            sub: voltMin != null && voltMin >= 207 && voltMax! <= 253 ? "✓ NRS 048 (207–253 V)" : voltMin != null ? "⚠ Outside NRS 048" : "No data",
                            cls: voltMin != null && voltMin >= 207 && voltMax! <= 253 ? "text-emerald-400" : "text-yellow-400",
                        },
                        {
                            label: "Peak Demand",
                            scope: `${meterName} · 7-day max`,
                            value: demandData.length ? `${Math.max(...demandData.map(d => d.peak))} kW` : "—",
                            sub: demandData.length ? `Avg ${(demandData.reduce((a, d) => a + d.avg, 0) / demandData.length).toFixed(0)} kW` : "No data",
                            cls: "text-white",
                        },
                    ].map(({ label, scope, value, sub, cls }) => (
                        <Card key={label} className="p-4">
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
                            {/* Scope line: which meter and which window this number covers, so
                                figures can't be mistaken for a different aggregation elsewhere. */}
                            <p className="text-[10px] text-slate-600 mt-0.5 truncate">{scope}</p>
                            <p className={`text-2xl font-bold mt-1 ${cls}`}>{value}</p>
                            <p className={`text-xs mt-1 ${cls}`}>{sub}</p>
                        </Card>
                    ))}
                </div>
            )}

            {/* Tariff Cost Summary */}
            {readings.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* 7-day cost breakdown */}
                    <div className="md:col-span-2 p-5 rounded-xl bg-slate-800/60 border border-slate-700">
                        <div className="flex items-center gap-2 mb-4">
                            <DollarSign className="h-5 w-5 text-emerald-400" />
                            <h3 className="text-base font-semibold text-white">7-Day Cost Breakdown</h3>
                            <span className="ml-auto text-xs text-slate-500">
                                Peak R{rPeak.toFixed(2)} · Std R{rStd.toFixed(2)} · Off-peak R{rOffpk.toFixed(2)}/kWh
                            </span>
                        </div>
                        <div className="grid grid-cols-3 gap-3 mb-4">
                            {[
                                { label: "Peak", kwh: cost.peakKwh, cost: cost.peakCost, color: "text-red-400" },
                                { label: "Standard", kwh: cost.standardKwh, cost: cost.standardCost, color: "text-yellow-400" },
                                { label: "Off-peak", kwh: cost.offpeakKwh, cost: cost.offpeakCost, color: "text-emerald-400" },
                            ].map(b => (
                                <div key={b.label} className="text-center p-3 rounded-lg bg-slate-900/50">
                                    <p className={`text-xs font-medium uppercase tracking-wide ${b.color}`}>{b.label}</p>
                                    <p className="text-lg font-bold text-white mt-1">{zar(b.cost)}</p>
                                    <p className="text-xs text-slate-500 mt-0.5">{b.kwh.toFixed(0)} kWh</p>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center justify-between pt-3 border-t border-slate-700">
                            <div>
                                <p className="text-xs text-slate-500">7-day total</p>
                                <p className="text-2xl font-bold text-white">{zar(cost.totalCost)}</p>
                                <p className="text-xs text-slate-500 mt-0.5">Avg rate R{cost.avgRate.toFixed(3)}/kWh</p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs text-slate-500">Projected monthly</p>
                                <p className="text-2xl font-bold text-emerald-400">{zar(projMonthly)}</p>
                                <p className="text-xs text-slate-500 mt-0.5">Based on 7-day trend</p>
                            </div>
                        </div>
                    </div>

                    {/* Tariff config info */}
                    <div className="p-5 rounded-xl bg-slate-800/60 border border-slate-700 flex flex-col justify-between">
                        <div>
                            <h3 className="text-sm font-semibold text-white mb-3">Tariff Config</h3>
                            {[
                                { label: "Peak", value: `R${rPeak.toFixed(2)}/kWh`, sub: settings.peak_times || "07:00–10:00, 18:00–20:00", color: "bg-red-500/20 text-red-400" },
                                { label: "Standard", value: `R${rStd.toFixed(2)}/kWh`, sub: settings.standard_times || "06:00–22:00 excl. peak", color: "bg-yellow-500/20 text-yellow-400" },
                                { label: "Off-peak", value: `R${rOffpk.toFixed(2)}/kWh`, sub: settings.offpeak_times || "22:00–06:00", color: "bg-emerald-500/20 text-emerald-400" },
                            ].map(t => (
                                <div key={t.label} className={`flex items-center justify-between px-3 py-2 rounded-lg mb-2 ${t.color}`}>
                                    <div>
                                        <p className="text-xs font-semibold">{t.label}</p>
                                        <p className="text-xs opacity-70">{t.sub}</p>
                                    </div>
                                    <p className="text-sm font-bold">{t.value}</p>
                                </div>
                            ))}
                        </div>
                        {settings.contracted_mdi_kva && (
                            <div className="mt-3 pt-3 border-t border-slate-700">
                                <p className="text-xs text-slate-500">Contracted MDI</p>
                                <p className="text-base font-bold text-white">{settings.contracted_mdi_kva} kVA</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <div className="grid gap-6 md:grid-cols-2">
                {/* Daily Cost by Band */}
                <Card>
                    <CardHeader title="Daily Energy Cost (R)" subtitle="Peak / Standard / Off-peak — last 7 days" />
                    <div className="h-[300px] w-full mt-4">
                        {loading ? (
                            <div className="flex h-full items-center justify-center">
                                <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                            </div>
                        ) : costByDay.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-slate-500 text-sm">No readings yet</div>
                        ) : (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={costByDay}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                    <XAxis dataKey="day" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} tickFormatter={v => `R${v}`} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc" }}
                                        cursor={{ fill: "#1e293b" }}
                                        formatter={(v: any, name: string) => [`R${v}`, name]}
                                    />
                                    <Legend />
                                    <Bar dataKey="Peak"     stackId="a" fill="#ef4444" radius={[0, 0, 0, 0]} />
                                    <Bar dataKey="Standard" stackId="a" fill="#eab308" radius={[0, 0, 0, 0]} />
                                    <Bar dataKey="Off-peak" stackId="a" fill="#10b981" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        )}
                    </div>
                </Card>

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
                <Card className="md:col-span-2">
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
