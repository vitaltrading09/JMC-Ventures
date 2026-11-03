"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import {
    ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, Legend, BarChart, ResponsiveContainer,
} from "recharts";
import {
    Download, Calendar, TrendingUp, Leaf, ShieldCheck, Zap,
    Loader2, BadgeDollarSign, RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { zar, toNum, normalizeRec } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Recommendation {
    id: string;
    site_name: string;
    type: string;
    title: string;
    estimated_monthly_saving_zar: number;
    estimated_implementation_cost_zar: number;
    payback_months: number;
    status: string;
    created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL;

const TYPE_COLOUR: Record<string, string> = {
    POWER_FACTOR_CORRECTION: "#facc15",
    HARMONIC_FILTER:         "#a78bfa",
    PV_INSTALL:              "#fb923c",
    LIGHTING_UPGRADE:        "#34d399",
    LOAD_SHIFTING:           "#60a5fa",
    VOLTAGE_REGULATION:      "#f87171",
    DEMAND_MANAGEMENT:       "#22d3ee",
    ENERGY_AUDIT:            "#94a3b8",
};

const TYPE_LABEL: Record<string, string> = {
    POWER_FACTOR_CORRECTION: "Power Factor",
    HARMONIC_FILTER:         "Harmonic Filter",
    PV_INSTALL:              "Solar PV",
    LIGHTING_UPGRADE:        "Lighting Upgrade",
    LOAD_SHIFTING:           "Load Shifting",
    VOLTAGE_REGULATION:      "Voltage Reg.",
    DEMAND_MANAGEMENT:       "Demand Mgmt",
    ENERGY_AUDIT:            "Energy Audit",
};

// Currency formatting lives in @/lib/format (zar); alias kept for existing call sites.
const fmt = zar;

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SavingsPage() {
    const [recs,     setRecs]     = useState<Recommendation[]>([]);
    const [loading,  setLoading]  = useState(true);

    const fetchRecs = useCallback(async () => {
        try {
            const res = await fetch(`${API}/ingestion/recommendations`, {
                credentials: 'include',
            });
            if (res.status === 401) { window.location.href = "/login"; return; }
            const data = await res.json();
            // NUMERIC columns arrive as strings — coerce so sums add (not concatenate).
            setRecs(Array.isArray(data) ? data.map(normalizeRec) : []);
        } catch { /* API offline — show empty state */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchRecs(); }, [fetchRecs]);

    // ── Derived ───────────────────────────────────────────────────────────────
    const totalMonthly = recs.reduce((s, r) => s + r.estimated_monthly_saving_zar, 0);
    const totalAnnual  = totalMonthly * 12;
    const totalImplCost = recs.reduce((s, r) => s + (r.estimated_implementation_cost_zar || 0), 0);

    // Annualised CO2e: ~0.92 kg CO2/kWh SA grid; avg tariff R2.50/kWh
    const kwhSaved   = totalMonthly / 2.5;
    const co2Avoided = (kwhSaved * 0.92 * 12) / 1000; // tCO2e / year

    // Export the opportunity pipeline as CSV — a client can hand this straight to
    // an installer for quoting. Values are quoted/escaped so commas in titles are safe.
    const exportCsv = () => {
        const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const rows = [
            ["Site", "Recommendation", "Type", "Monthly Saving (ZAR)", "Implementation Cost (ZAR)", "Payback (months)"],
            ...[...recs]
                .sort((a, b) => b.estimated_monthly_saving_zar - a.estimated_monthly_saving_zar)
                .map(r => [
                    r.site_name,
                    r.title,
                    TYPE_LABEL[r.type] ?? r.type,
                    r.estimated_monthly_saving_zar,
                    r.estimated_implementation_cost_zar,
                    r.payback_months || "",
                ]),
            [],
            ["TOTAL", "", "", totalMonthly, totalImplCost, ""],
        ];
        const csv = rows.map(row => row.map(esc).join(",")).join("\r\n");
        // BOM so Excel opens UTF-8 correctly on Windows.
        const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url;
        a.download = `grid-iq-savings-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Attribution chart data — group by type, sum estimated savings
    const attribution = Object.entries(
        recs.reduce<Record<string, number>>((acc, r) => {
            acc[r.type] = (acc[r.type] || 0) + r.estimated_monthly_saving_zar;
            return acc;
        }, {})
    )
        .map(([type, value]) => ({
            name:  TYPE_LABEL[type] ?? type,
            value: Math.round(value),
            fill:  TYPE_COLOUR[type] ?? "#64748b",
        }))
        .sort((a, b) => b.value - a.value);

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in duration-500">

            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Savings Dashboard</h1>
                    <p className="text-slate-400 mt-1">
                        Projected savings from AI-identified opportunities across your sites.
                    </p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={fetchRecs}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <RefreshCw className="h-4 w-4" /> Refresh
                    </button>
                    <button
                        onClick={exportCsv}
                        disabled={recs.length === 0}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <Download className="h-4 w-4" /> Export CSV
                    </button>
                </div>
            </div>

            {/* ── KPI Cards ──────────────────────────────────────────────── */}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">

                <Card className="bg-emerald-500/5 border-emerald-500/20">
                    <div className="flex items-start gap-3">
                        <div className="p-2.5 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                            <TrendingUp className="h-5 w-5 text-emerald-400" />
                        </div>
                        <div>
                            <p className="text-sm text-slate-400">Est. Monthly Savings</p>
                            <p className="text-2xl font-bold text-white mt-1">{fmt(totalMonthly)}</p>
                            <p className="text-xs text-slate-500 mt-1">
                                {recs.length} recommendation{recs.length !== 1 ? "s" : ""} identified
                            </p>
                        </div>
                    </div>
                </Card>

                <Card className="bg-blue-500/5 border-blue-500/20">
                    <div className="flex items-start gap-3">
                        <div className="p-2.5 bg-blue-500/10 rounded-lg border border-blue-500/20">
                            <BadgeDollarSign className="h-5 w-5 text-blue-400" />
                        </div>
                        <div>
                            <p className="text-sm text-slate-400">Annual Saving Potential</p>
                            <p className="text-2xl font-bold text-white mt-1">{fmt(totalAnnual)}</p>
                            <p className="text-xs text-slate-500 mt-1">If all recommendations implemented</p>
                        </div>
                    </div>
                </Card>

                <Card className="bg-purple-500/5 border-purple-500/20">
                    <div className="flex items-start gap-3">
                        <div className="p-2.5 bg-purple-500/10 rounded-lg border border-purple-500/20">
                            <Zap className="h-5 w-5 text-purple-400" />
                        </div>
                        <div>
                            <p className="text-sm text-slate-400">Implementation Cost</p>
                            <p className="text-2xl font-bold text-white mt-1">{fmt(totalImplCost)}</p>
                            <p className="text-xs text-slate-500 mt-1">
                                {totalMonthly > 0 && totalImplCost > 0
                                    ? `~${Math.round(totalImplCost / totalMonthly)}mo payback`
                                    : "No implementations yet"}
                            </p>
                        </div>
                    </div>
                </Card>

                <Card className="bg-green-500/5 border-green-500/20">
                    <div className="flex items-start gap-3">
                        <div className="p-2.5 bg-green-500/10 rounded-lg border border-green-500/20">
                            <Leaf className="h-5 w-5 text-green-400" />
                        </div>
                        <div>
                            <p className="text-sm text-slate-400">Annual CO₂ Avoided</p>
                            <p className="text-2xl font-bold text-white mt-1">
                                {co2Avoided.toFixed(1)}
                                <span className="text-base font-normal text-slate-500 ml-1">tCO₂e</span>
                            </p>
                            <p className="text-xs text-slate-500 mt-1">Based on SA grid factor</p>
                        </div>
                    </div>
                </Card>
            </div>

            {/* ── Empty State ─────────────────────────────────────────────── */}
            {recs.length === 0 && (
                <Card className="p-12 text-center">
                    <ShieldCheck className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                    <p className="text-white font-medium text-lg">No savings data yet</p>
                    <p className="text-slate-500 text-sm mt-2 max-w-sm mx-auto">
                        Run an AI analysis on your sites to generate recommendations and see projected savings here.
                    </p>
                    <Link
                        href="/dashboard/recommendations"
                        className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
                    >
                        <Zap className="h-4 w-4" /> Go to Recommendations
                    </Link>
                </Card>
            )}

            {/* ── Charts ─────────────────────────────────────────────────── */}
            {recs.length > 0 && (
                <>
                    <div className="grid gap-6 lg:grid-cols-3">

                        {/* Savings Attribution */}
                        <Card className="lg:col-span-1">
                            <CardHeader title="Savings by Type" subtitle="Monthly ZAR opportunity" />
                            <div className="h-[280px] w-full mt-4">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart layout="vertical" data={attribution} margin={{ left: 10, right: 40 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                                        <XAxis type="number" hide />
                                        <YAxis
                                            type="category" dataKey="name"
                                            stroke="#64748b" fontSize={11}
                                            width={110} tickLine={false} axisLine={false}
                                        />
                                        <Tooltip
                                            cursor={{ fill: "#1e293b" }}
                                            contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc" }}
                                            formatter={(v: any) => [`R ${v.toLocaleString()}`, "Est. Monthly"]}
                                        />
                                        <Bar
                                            dataKey="value" name="Est. Monthly Saving" radius={[0, 4, 4, 0]}
                                            barSize={18}
                                            label={{ position: "right", fill: "#94a3b8", fontSize: 11, formatter: (v: number) => `R ${v.toLocaleString()}` }}
                                        />
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </Card>

                        {/* Recommendations Table */}
                        <Card className="lg:col-span-2">
                            <CardHeader title="Opportunity Pipeline" subtitle="All identified savings, ranked by priority" />
                            <div className="overflow-x-auto mt-4">
                                <table className="w-full text-sm text-left">
                                    <thead>
                                        <tr className="text-xs text-slate-500 uppercase border-b border-slate-800">
                                            <th className="pb-3 pr-4">Site</th>
                                            <th className="pb-3 pr-4">Recommendation</th>
                                            <th className="pb-3 pr-4 text-right">Monthly Saving</th>
                                            <th className="pb-3 pr-4 text-right">Impl. Cost</th>
                                            <th className="pb-3 text-right">Payback</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/60">
                                        {recs
                                            .sort((a, b) => b.estimated_monthly_saving_zar - a.estimated_monthly_saving_zar)
                                            .map((r) => (
                                                <tr key={r.id} className="hover:bg-slate-800/20 transition-colors">
                                                    <td className="py-3 pr-4 text-slate-400 text-xs whitespace-nowrap">
                                                        {r.site_name}
                                                    </td>
                                                    <td className="py-3 pr-4 text-white text-xs font-medium max-w-[200px] truncate">
                                                        {r.title}
                                                    </td>
                                                    <td className="py-3 pr-4 text-right text-emerald-400 font-bold text-xs whitespace-nowrap">
                                                        {fmt(r.estimated_monthly_saving_zar)}
                                                    </td>
                                                    <td className="py-3 pr-4 text-right text-slate-300 text-xs whitespace-nowrap">
                                                        {r.estimated_implementation_cost_zar > 0
                                                            ? fmt(r.estimated_implementation_cost_zar)
                                                            : "—"}
                                                    </td>
                                                    <td className="py-3 text-right text-blue-400 text-xs whitespace-nowrap">
                                                        {r.payback_months > 0 ? `${r.payback_months}mo` : "—"}
                                                    </td>
                                                </tr>
                                            ))}
                                    </tbody>
                                    <tfoot>
                                        <tr className="border-t border-slate-700">
                                            <td colSpan={2} className="pt-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                                Total
                                            </td>
                                            <td className="pt-3 text-right text-emerald-400 font-bold text-sm">
                                                {fmt(totalMonthly)}/mo
                                            </td>
                                            <td className="pt-3 text-right text-slate-300 font-semibold text-sm">
                                                {fmt(totalImplCost)}
                                            </td>
                                            <td />
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </Card>
                    </div>

                    {/* Subscription Value Banner */}
                    <Card className="bg-gradient-to-r from-blue-600/10 to-emerald-600/10 border-blue-500/20">
                        <div className="flex flex-col md:flex-row md:items-center gap-6 md:gap-10">
                            <div className="flex-1">
                                <h3 className="text-lg font-bold text-white">Your Grid-IQ Subscription</h3>
                                <p className="text-slate-400 text-sm mt-1">
                                    Flat monthly fee · unlimited sites · 24/7 monitoring · AI analysis included
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-8 shrink-0">
                                <div className="text-center">
                                    <p className="text-xs text-slate-500 uppercase tracking-wider">Monthly Savings Potential</p>
                                    <p className="text-2xl font-bold text-emerald-400 mt-1">{fmt(totalMonthly)}</p>
                                </div>
                                <div className="text-center">
                                    <p className="text-xs text-slate-500 uppercase tracking-wider">Annual Potential</p>
                                    <p className="text-2xl font-bold text-white mt-1">{fmt(totalAnnual)}</p>
                                </div>
                            </div>
                            <div className="shrink-0">
                                <Link
                                    href="/dashboard/recommendations"
                                    className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all"
                                >
                                    <Zap className="h-4 w-4" /> Unlock More Savings
                                </Link>
                            </div>
                        </div>
                    </Card>
                </>
            )}
        </div>
    );
}
