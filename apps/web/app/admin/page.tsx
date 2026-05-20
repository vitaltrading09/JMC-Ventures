"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import {
    Building2, Users, Database, Zap, Loader2, RefreshCw,
    TrendingUp, Briefcase, AlertCircle, CheckCircle2,
    ChevronRight, Activity,
} from "lucide-react";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Site  { id: string; name: string; address?: string; tenant_id?: string; }
interface Meter { id: string; name: string; site_id: string; }
interface Lead  {
    id: string;
    status: "NEW" | "IN_REVIEW" | "QUOTED" | "WON" | "LOST";
    site_name: string;
    rec_title: string;
    created_at: string;
}
interface SiteScore {
    site_id: string;
    site_name?: string;
    score: number;
    tariff_type: string;
    calculated_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

function scoreColour(s: number) {
    if (s >= 80) return "text-emerald-400";
    if (s >= 60) return "text-yellow-400";
    if (s >= 40) return "text-orange-400";
    return "text-red-400";
}

function statusBadge(status: string) {
    const map: Record<string, string> = {
        NEW:       "text-blue-400   bg-blue-500/10   border-blue-500/20",
        IN_REVIEW: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
        QUOTED:    "text-purple-400 bg-purple-500/10 border-purple-500/20",
        WON:       "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
        LOST:      "text-slate-400  bg-slate-700     border-slate-600",
    };
    return map[status] ?? "text-slate-400 bg-slate-700";
}

function timeAgo(iso: string) {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AdminOverviewPage() {
    const [sites,   setSites]   = useState<Site[]>([]);
    const [meters,  setMeters]  = useState<Meter[]>([]);
    const [leads,   setLeads]   = useState<Lead[]>([]);
    const [scores,  setScores]  = useState<SiteScore[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchAll = useCallback(async () => {
        try {
            const [sitesRes, metersRes, leadsRes, scoresRes] = await Promise.all([
                fetch(`${API}/ingestion/sites`,        { credentials: 'include' }),
                fetch(`${API}/ingestion/meters`,       { credentials: 'include' }),
                fetch(`${API}/ingestion/leads`,        { credentials: 'include' }),
                fetch(`${API}/ingestion/sites/scores`, { credentials: 'include' }),
            ]);
            if (sitesRes.status === 401) { window.location.href = "/login"; return; }

            const [s, m, l, sc] = await Promise.all([
                sitesRes.ok  ? sitesRes.json()  : [],
                metersRes.ok ? metersRes.json() : [],
                leadsRes.ok  ? leadsRes.json()  : [],
                scoresRes.ok ? scoresRes.json() : [],
            ]);
            setSites(Array.isArray(s)  ? s  : []);
            setMeters(Array.isArray(m) ? m  : []);
            setLeads(Array.isArray(l)  ? l  : []);
            setScores(Array.isArray(sc) ? sc : []);
        } catch { }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ── Derived ───────────────────────────────────────────────────────────────
    const openLeads   = leads.filter(l => l.status === "NEW" || l.status === "IN_REVIEW");
    const wonLeads    = leads.filter(l => l.status === "WON");
    const pipeline: Record<string, number> = {
        NEW:       leads.filter(l => l.status === "NEW").length,
        IN_REVIEW: leads.filter(l => l.status === "IN_REVIEW").length,
        QUOTED:    leads.filter(l => l.status === "QUOTED").length,
        WON:       wonLeads.length,
    };

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-red-500" />
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in duration-500">

            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Operator Overview</h1>
                    <p className="text-slate-400 mt-1">
                        Platform health · client portfolio · leads pipeline
                    </p>
                </div>
                <button
                    onClick={fetchAll}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors w-max"
                >
                    <RefreshCw className="h-4 w-4" /> Refresh
                </button>
            </div>

            {/* ── Platform KPIs ───────────────────────────────────────────── */}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader title="Active Sites" icon={Building2} />
                    <div className="mt-2 text-3xl font-bold text-white">{sites.length}</div>
                    <p className="text-sm text-slate-500 mt-1">Monitored locations</p>
                </Card>
                <Card>
                    <CardHeader title="Connected Meters" icon={Database} />
                    <div className="mt-2 text-3xl font-bold text-blue-400">{meters.length}</div>
                    <p className="text-sm text-emerald-400 mt-1 flex items-center gap-1">
                        <Activity className="h-3 w-3" /> Sending telemetry
                    </p>
                </Card>
                <Card className="border-yellow-500/20">
                    <CardHeader title="Open Leads" icon={Briefcase} />
                    <div className={`mt-2 text-3xl font-bold ${openLeads.length > 0 ? "text-yellow-400" : "text-white"}`}>
                        {openLeads.length}
                    </div>
                    <p className="text-sm text-slate-500 mt-1">{wonLeads.length} won all time</p>
                </Card>
                <Card className="border-emerald-500/20">
                    <CardHeader title="Sites Scored" icon={TrendingUp} />
                    <div className="mt-2 text-3xl font-bold text-emerald-400">{scores.length}</div>
                    <p className="text-sm text-slate-500 mt-1">
                        {scores.length > 0
                            ? `Avg score: ${Math.round(scores.reduce((s, r) => s + r.score, 0) / scores.length)}`
                            : "Run AI analysis to score"}
                    </p>
                </Card>
            </div>

            {/* ── Leads Pipeline ──────────────────────────────────────────── */}
            <Card>
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h3 className="text-base font-semibold text-white">Leads Pipeline</h3>
                        <p className="text-xs text-slate-500 mt-0.5">Client-initiated opportunities</p>
                    </div>
                    <Link
                        href="/admin/leads"
                        className="flex items-center gap-1 text-sm text-red-400 hover:text-red-300 transition-colors"
                    >
                        View all <ChevronRight className="h-3 w-3" />
                    </Link>
                </div>

                {/* Pipeline funnel */}
                <div className="grid grid-cols-4 gap-3 mb-6">
                    {(["NEW", "IN_REVIEW", "QUOTED", "WON"] as const).map((s, i) => {
                        const colours: Record<string, string> = {
                            NEW:       "border-blue-500/30   bg-blue-500/5",
                            IN_REVIEW: "border-yellow-500/30 bg-yellow-500/5",
                            QUOTED:    "border-purple-500/30 bg-purple-500/5",
                            WON:       "border-emerald-500/30 bg-emerald-500/5",
                        };
                        const textColours: Record<string, string> = {
                            NEW: "text-blue-400", IN_REVIEW: "text-yellow-400",
                            QUOTED: "text-purple-400", WON: "text-emerald-400",
                        };
                        const labels: Record<string, string> = {
                            NEW: "New", IN_REVIEW: "In Review", QUOTED: "Quoted", WON: "Won",
                        };
                        return (
                            <div key={s} className={`p-4 rounded-lg border ${colours[s]} text-center`}>
                                <p className={`text-2xl font-bold ${textColours[s]}`}>{pipeline[s]}</p>
                                <p className="text-xs text-slate-500 mt-1">{labels[s]}</p>
                            </div>
                        );
                    })}
                </div>

                {/* Recent leads */}
                {leads.length === 0 ? (
                    <div className="text-center py-8 text-slate-600">
                        <Briefcase className="h-10 w-10 mx-auto mb-3 opacity-40" />
                        <p className="text-sm text-slate-500">No leads yet</p>
                        <p className="text-xs mt-1">Clients click "Notify Team" on a recommendation to create a lead</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {leads.slice(0, 5).map(lead => (
                            <div key={lead.id} className="flex items-center gap-4 p-3 rounded-lg bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-colors">
                                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border ${statusBadge(lead.status)}`}>
                                    {lead.status.replace("_", " ")}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-white truncate">{lead.rec_title}</p>
                                    <p className="text-xs text-slate-500 truncate">{lead.site_name}</p>
                                </div>
                                <span className="text-xs text-slate-600 shrink-0">{timeAgo(lead.created_at)}</span>
                            </div>
                        ))}
                        {leads.length > 5 && (
                            <Link href="/admin/leads" className="block text-center text-xs text-slate-500 hover:text-slate-300 pt-2 transition-colors">
                                +{leads.length - 5} more · View all leads →
                            </Link>
                        )}
                    </div>
                )}
            </Card>

            {/* ── Site Energy Scores ──────────────────────────────────────── */}
            <Card>
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h3 className="text-base font-semibold text-white">Site Energy Scores</h3>
                        <p className="text-xs text-slate-500 mt-0.5">AI-calculated composite score per site</p>
                    </div>
                    <Link
                        href="/admin/clients"
                        className="flex items-center gap-1 text-sm text-red-400 hover:text-red-300 transition-colors"
                    >
                        All clients <ChevronRight className="h-3 w-3" />
                    </Link>
                </div>

                {scores.length === 0 ? (
                    <div className="text-center py-8 text-slate-600">
                        <TrendingUp className="h-10 w-10 mx-auto mb-3 opacity-40" />
                        <p className="text-sm text-slate-500">No scores calculated yet</p>
                        <p className="text-xs mt-1">Go to Recommendations and run AI analysis on a site</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {scores
                            .sort((a, b) => a.score - b.score) // worst first
                            .slice(0, 8)
                            .map(sc => (
                                <div key={sc.site_id} className="flex items-center gap-4">
                                    <div className="w-32 shrink-0">
                                        <p className="text-sm font-medium text-white truncate">
                                            {sc.site_name ?? sc.site_id.slice(0, 8) + "..."}
                                        </p>
                                        <p className="text-xs text-slate-500">{sc.tariff_type}</p>
                                    </div>
                                    <div className="flex-1">
                                        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                            <div
                                                className={`h-full rounded-full transition-all duration-700 ${
                                                    sc.score >= 80 ? "bg-emerald-500"
                                                    : sc.score >= 60 ? "bg-yellow-500"
                                                    : sc.score >= 40 ? "bg-orange-500"
                                                    : "bg-red-500"
                                                }`}
                                                style={{ width: `${sc.score}%` }}
                                            />
                                        </div>
                                    </div>
                                    <span className={`text-sm font-bold w-8 text-right shrink-0 ${scoreColour(sc.score)}`}>
                                        {Math.round(sc.score)}
                                    </span>
                                </div>
                            ))}
                    </div>
                )}
            </Card>

            {/* ── Active Sites Table ──────────────────────────────────────── */}
            {sites.length > 0 && (
                <Card>
                    <CardHeader title="Active Sites" subtitle="All monitored locations" />
                    <div className="overflow-x-auto mt-4">
                        <table className="w-full text-sm text-left">
                            <thead>
                                <tr className="text-xs text-slate-500 uppercase border-b border-slate-800">
                                    <th className="pb-3 pr-6">Site Name</th>
                                    <th className="pb-3 pr-6">Address</th>
                                    <th className="pb-3 pr-6 text-center">Meters</th>
                                    <th className="pb-3 pr-6 text-center">Energy Score</th>
                                    <th className="pb-3 text-right">Open Leads</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                                {sites.map(site => {
                                    const mCount  = meters.filter(m => m.site_id === site.id).length;
                                    const sc      = scores.find(s => s.site_id === site.id);
                                    const sLeads  = leads.filter(l => l.status === "NEW" || l.status === "IN_REVIEW");
                                    return (
                                        <tr key={site.id} className="hover:bg-slate-800/20 transition-colors">
                                            <td className="py-3 pr-6 font-medium text-white">{site.name}</td>
                                            <td className="py-3 pr-6 text-slate-400 text-xs">{site.address ?? "—"}</td>
                                            <td className="py-3 pr-6 text-center text-slate-300">{mCount}</td>
                                            <td className="py-3 pr-6 text-center">
                                                {sc
                                                    ? <span className={`font-bold ${scoreColour(sc.score)}`}>{Math.round(sc.score)}</span>
                                                    : <span className="text-slate-600 text-xs">No data</span>}
                                            </td>
                                            <td className="py-3 text-right">
                                                {sLeads.length > 0
                                                    ? <span className="text-yellow-400 font-medium">{sLeads.length}</span>
                                                    : <span className="text-slate-600">—</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}
        </div>
    );
}
