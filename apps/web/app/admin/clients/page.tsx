"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import {
    Building2, Database, Briefcase,
    Loader2, RefreshCw, Plus, ChevronDown, Search,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Tenant   { id: string; name: string; site_count?: string; user_count?: string; created_at: string; }
interface Site     { id: string; name: string; address?: string; tenant_id?: string; }
interface Meter    { id: string; name: string; site_id: string; }
interface Lead     { id: string; status: string; site_id: string; site_name: string; rec_title: string; }
interface SiteScore { site_id: string; site_name?: string; score: number; tariff_type: string; calculated_at: string; }

interface TenantPortfolio {
    tenant: Tenant;
    sites:        Site[];
    meterCount:   number;
    openLeadCount: number;
    avgScore:     number | null;
    siteDetails:  Array<{
        site:      Site;
        meters:    number;
        openLeads: number;
        score:     SiteScore | null;
    }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

function scoreColour(s: number | null) {
    if (s === null) return "text-slate-500";
    if (s >= 80) return "text-emerald-400";
    if (s >= 60) return "text-yellow-400";
    if (s >= 40) return "text-orange-400";
    return "text-red-400";
}

function scoreStroke(s: number | null) {
    if (s === null) return "#475569";
    if (s >= 80) return "#34d399";
    if (s >= 60) return "#facc15";
    if (s >= 40) return "#fb923c";
    return "#f87171";
}

function scoreLabel(s: number | null): { text: string; cls: string } {
    if (s === null) return { text: "Not scored", cls: "text-slate-500 bg-slate-800 border-slate-700" };
    if (s >= 80)   return { text: "Excellent",   cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" };
    if (s >= 60)   return { text: "Good",        cls: "text-yellow-400  bg-yellow-500/10  border-yellow-500/20" };
    if (s >= 40)   return { text: "Needs Work",  cls: "text-orange-400  bg-orange-500/10  border-orange-500/20" };
    return               { text: "Critical",     cls: "text-red-400     bg-red-500/10     border-red-500/20" };
}

function scoreBg(s: number) {
    if (s >= 80) return "bg-emerald-500";
    if (s >= 60) return "bg-yellow-500";
    if (s >= 40) return "bg-orange-500";
    return "bg-red-500";
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ClientPortfoliosPage() {
    const [tenants,    setTenants]    = useState<Tenant[]>([]);
    const [sites,      setSites]      = useState<Site[]>([]);
    const [meters,     setMeters]     = useState<Meter[]>([]);
    const [leads,      setLeads]      = useState<Lead[]>([]);
    const [scores,     setScores]     = useState<SiteScore[]>([]);
    const [loading,    setLoading]    = useState(true);
    const [search,     setSearch]     = useState("");
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [showModal,  setShowModal]  = useState(false);
    const [newName,    setNewName]    = useState("");
    const [creating,   setCreating]   = useState(false);
    const [toast,      setToast]      = useState<string | null>(null);

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(null), 3500);
    };

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const [tRes, sRes, mRes, lRes, scRes] = await Promise.all([
                fetch(`${API}/auth/tenants`,           { credentials: 'include' }),
                fetch(`${API}/ingestion/sites`,         { credentials: 'include' }),
                fetch(`${API}/ingestion/meters`,        { credentials: 'include' }),
                fetch(`${API}/ingestion/leads`,         { credentials: 'include' }),
                fetch(`${API}/ingestion/sites/scores`,  { credentials: 'include' }),
            ]);
            if (tRes.status === 401) { window.location.href = "/login"; return; }

            const [t, s, m, l, sc] = await Promise.all([
                tRes.ok  ? tRes.json()  : [],
                sRes.ok  ? sRes.json()  : [],
                mRes.ok  ? mRes.json()  : [],
                lRes.ok  ? lRes.json()  : [],
                scRes.ok ? scRes.json() : [],
            ]);
            setTenants(Array.isArray(t)  ? t  : []);
            setSites  (Array.isArray(s)  ? s  : []);
            setMeters (Array.isArray(m)  ? m  : []);
            setLeads  (Array.isArray(l)  ? l  : []);
            setScores (Array.isArray(sc) ? sc : []);
        } catch { }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        try {
            const res = await fetch(`${API}/auth/tenants`, {
                method:  "POST",
                credentials: 'include',
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ name: newName }),
            });
            if (!res.ok) throw new Error();
            setNewName(""); setShowModal(false);
            showToast("✓ Client created");
            fetchAll();
        } catch { showToast("Failed to create client"); }
        finally { setCreating(false); }
    };

    // ── Build portfolios ───────────────────────────────────────────────────────
    const portfolios: TenantPortfolio[] = tenants.map(tenant => {
        const tSites  = sites.filter(s => s.tenant_id === tenant.id);
        const siteIds = new Set(tSites.map(s => s.id));
        const mCount  = meters.filter(m => siteIds.has(m.site_id)).length;
        const openLeads = leads.filter(
            l => siteIds.has(l.site_id) && (l.status === "NEW" || l.status === "IN_REVIEW")
        );
        const tScores = scores.filter(sc => siteIds.has(sc.site_id));
        const avgScore = tScores.length > 0
            ? tScores.reduce((a, sc) => a + sc.score, 0) / tScores.length
            : null;

        const siteDetails = tSites.map(site => ({
            site,
            meters:    meters.filter(m => m.site_id === site.id).length,
            openLeads: leads.filter(
                l => l.site_id === site.id && (l.status === "NEW" || l.status === "IN_REVIEW")
            ).length,
            score: scores.find(sc => sc.site_id === site.id) ?? null,
        }));

        return {
            tenant,
            sites: tSites,
            meterCount: mCount,
            openLeadCount: openLeads.length,
            avgScore,
            siteDetails,
        };
    });

    const filtered = portfolios.filter(p =>
        p.tenant.name.toLowerCase().includes(search.toLowerCase())
    );

    const totalOpenLeads = leads.filter(l => l.status === "NEW" || l.status === "IN_REVIEW").length;

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-red-500" />
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in duration-500">

            {/* Toast */}
            {toast && (
                <div className="fixed top-4 right-4 z-50 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white shadow-xl animate-in slide-in-from-top-2">
                    {toast}
                </div>
            )}

            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Client Portfolios</h1>
                    <p className="text-slate-400 mt-1">
                        {tenants.length} client{tenants.length !== 1 ? "s" : ""} ·{" "}
                        {sites.length} site{sites.length !== 1 ? "s" : ""} ·{" "}
                        {meters.length} meter{meters.length !== 1 ? "s" : ""}
                    </p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={fetchAll}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <RefreshCw className="h-4 w-4" /> Refresh
                    </button>
                    <button
                        onClick={() => setShowModal(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(239,68,68,0.2)] transition-all"
                    >
                        <Plus className="h-4 w-4" /> New Client
                    </button>
                </div>
            </div>

            {/* ── Platform KPI strip ──────────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                    { label: "Clients",    value: tenants.length,    colour: "text-white"      },
                    { label: "Sites",      value: sites.length,      colour: "text-blue-400"   },
                    { label: "Meters",     value: meters.length,     colour: "text-purple-400" },
                    { label: "Open Leads", value: totalOpenLeads,    colour: totalOpenLeads > 0 ? "text-yellow-400" : "text-white" },
                ].map(({ label, value, colour }) => (
                    <div key={label} className="p-4 rounded-xl border border-slate-800 bg-slate-900/50">
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
                        <p className={`text-2xl font-bold ${colour}`}>{value}</p>
                    </div>
                ))}
            </div>

            {/* ── Search ─────────────────────────────────────────────────── */}
            <div className="relative w-full max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                <input
                    type="text"
                    placeholder="Search clients…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500/50 transition-all"
                />
            </div>

            {/* ── Empty state ─────────────────────────────────────────────── */}
            {filtered.length === 0 && (
                <Card className="p-12 text-center">
                    <Building2 className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                    <p className="text-white font-medium text-lg">
                        {tenants.length === 0 ? "No clients yet" : "No clients match your search"}
                    </p>
                    <p className="text-slate-500 text-sm mt-2">
                        {tenants.length === 0
                            ? `Click "New Client" to onboard your first client.`
                            : "Try a different search term."}
                    </p>
                </Card>
            )}

            {/* ── Client cards ────────────────────────────────────────────── */}
            <div className="space-y-3">
                {filtered.map(({ tenant, sites: tSites, meterCount, openLeadCount, avgScore, siteDetails }) => {
                    const isExpanded           = expandedId === tenant.id;
                    const { text: scoreText, cls: scoreCls } = scoreLabel(avgScore);
                    const rounded              = avgScore !== null ? Math.round(avgScore) : null;

                    return (
                        <Card key={tenant.id} className="overflow-hidden">
                            {/* ── Summary row ──────────────────────────── */}
                            <div
                                className="flex items-center gap-4 cursor-pointer select-none"
                                onClick={() => setExpandedId(isExpanded ? null : tenant.id)}
                            >
                                {/* Score ring */}
                                <div className="relative h-14 w-14 shrink-0">
                                    <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
                                        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#1e293b" strokeWidth="2.5" />
                                        <circle
                                            cx="18" cy="18" r="15.9" fill="none"
                                            stroke={scoreStroke(avgScore)} strokeWidth="2.5"
                                            strokeLinecap="round"
                                            strokeDasharray={`${rounded ?? 0} 100`}
                                            style={{ transition: "stroke-dasharray 1s ease" }}
                                        />
                                    </svg>
                                    <span className={`absolute inset-0 flex items-center justify-center text-xs font-bold ${scoreColour(avgScore)}`}>
                                        {rounded !== null ? rounded : "—"}
                                    </span>
                                </div>

                                {/* Tenant name + badges */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h3 className="text-base font-semibold text-white">{tenant.name}</h3>
                                        <span className={`text-xs px-2 py-0.5 rounded-full border ${scoreCls}`}>
                                            {scoreText}
                                        </span>
                                        {openLeadCount > 0 && (
                                            <span className="text-xs px-2 py-0.5 rounded-full border text-yellow-400 bg-yellow-500/10 border-yellow-500/20">
                                                {openLeadCount} open lead{openLeadCount !== 1 ? "s" : ""}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500 mt-0.5">
                                        {tSites.length} site{tSites.length !== 1 ? "s" : ""} ·{" "}
                                        {meterCount} meter{meterCount !== 1 ? "s" : ""}
                                        {tenant.created_at &&
                                            ` · Onboarded ${new Date(tenant.created_at).toLocaleDateString("en-ZA", {
                                                day: "numeric", month: "short", year: "numeric",
                                            })}`}
                                    </p>
                                </div>

                                {/* Stat pills (desktop) */}
                                <div className="hidden md:flex items-center gap-2 shrink-0">
                                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
                                        <Building2 className="h-3.5 w-3.5 text-slate-500" />
                                        <span className="text-sm font-medium text-white">{tSites.length}</span>
                                        <span className="text-xs text-slate-500">sites</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
                                        <Database className="h-3.5 w-3.5 text-slate-500" />
                                        <span className="text-sm font-medium text-white">{meterCount}</span>
                                        <span className="text-xs text-slate-500">meters</span>
                                    </div>
                                    {openLeadCount > 0 && (
                                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                                            <Briefcase className="h-3.5 w-3.5 text-yellow-400" />
                                            <span className="text-sm font-medium text-yellow-400">{openLeadCount}</span>
                                            <span className="text-xs text-yellow-600">leads</span>
                                        </div>
                                    )}
                                </div>

                                <ChevronDown className={`h-4 w-4 text-slate-500 shrink-0 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
                            </div>

                            {/* ── Expanded: per-site table ──────────────── */}
                            {isExpanded && (
                                <div className="mt-5 pt-5 border-t border-slate-800">
                                    {tSites.length === 0 ? (
                                        <p className="text-sm text-slate-500 text-center py-6">
                                            No sites provisioned for this client yet.
                                        </p>
                                    ) : (
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm text-left">
                                                <thead>
                                                    <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-slate-800">
                                                        <th className="pb-3 pr-6 font-semibold">Site</th>
                                                        <th className="pb-3 pr-6 font-semibold">Address</th>
                                                        <th className="pb-3 pr-6 text-center font-semibold">Meters</th>
                                                        <th className="pb-3 pr-6 font-semibold">Energy Score</th>
                                                        <th className="pb-3 pr-6 text-center font-semibold">Tariff</th>
                                                        <th className="pb-3 text-center font-semibold">Open Leads</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-slate-800/60">
                                                    {siteDetails.map(({ site, meters: mc, openLeads: ol, score: sc }) => (
                                                        <tr key={site.id} className="hover:bg-slate-800/20 transition-colors">
                                                            <td className="py-3 pr-6 font-medium text-white whitespace-nowrap">
                                                                {site.name}
                                                            </td>
                                                            <td className="py-3 pr-6 text-slate-400 text-xs">
                                                                {site.address ?? "—"}
                                                            </td>
                                                            <td className="py-3 pr-6 text-center text-slate-300">
                                                                {mc}
                                                            </td>
                                                            <td className="py-3 pr-6">
                                                                {sc ? (
                                                                    <div className="flex items-center gap-2">
                                                                        <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0">
                                                                            <div
                                                                                className={`h-full rounded-full transition-all duration-700 ${scoreBg(sc.score)}`}
                                                                                style={{ width: `${sc.score}%` }}
                                                                            />
                                                                        </div>
                                                                        <span className={`text-sm font-bold tabular-nums ${scoreColour(sc.score)}`}>
                                                                            {Math.round(sc.score)}
                                                                        </span>
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-slate-600 text-xs">Not scored</span>
                                                                )}
                                                            </td>
                                                            <td className="py-3 pr-6 text-center text-slate-400 text-xs">
                                                                {sc?.tariff_type ?? "—"}
                                                            </td>
                                                            <td className="py-3 text-center">
                                                                {ol > 0
                                                                    ? <span className="text-yellow-400 font-medium">{ol}</span>
                                                                    : <span className="text-slate-600">—</span>}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}
                        </Card>
                    );
                })}
            </div>

            {/* ── New client modal ────────────────────────────────────────── */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl">
                        <h2 className="text-xl font-bold text-white mb-1">Onboard New Client</h2>
                        <p className="text-sm text-slate-500 mb-6">
                            Creates a new tenant workspace. Assign sites after creation.
                        </p>
                        <form onSubmit={handleCreate}>
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-slate-400 mb-2">
                                    Company / Tenant Name
                                </label>
                                <input
                                    type="text" required autoFocus
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500 transition-all"
                                    placeholder="e.g. Acme Manufacturing"
                                />
                            </div>
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => { setShowModal(false); setNewName(""); }}
                                    className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={creating || !newName.trim()}
                                    className="flex items-center gap-2 px-5 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors shadow-[0_0_15px_rgba(239,68,68,0.2)]"
                                >
                                    {creating
                                        ? <Loader2 className="h-4 w-4 animate-spin" />
                                        : <Plus className="h-4 w-4" />}
                                    Create Client
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
