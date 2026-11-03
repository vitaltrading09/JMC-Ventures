"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import {
    Zap, Loader2, RefreshCw, BellRing, CheckCircle2, TrendingUp,
    Lightbulb, Filter, Sun, Activity, AlertTriangle, BarChart2, ChevronDown, ChevronUp,
} from "lucide-react";
import { zar, normalizeRec } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Recommendation {
    id: string;
    site_id: string;
    site_name: string;
    site_address: string;
    meter_id?: string | null;
    meter_name?: string | null;
    type: string;
    priority: number;
    title: string;
    problem: string;
    solution: string;
    estimated_monthly_saving_zar: number;
    estimated_implementation_cost_zar: number;
    payback_months: number;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    standard_reference?: string;
    status: string;
    created_at: string;
}

interface Site  { id: string; name: string; }
interface Meter { id: string; name: string; site_id: string; is_active?: boolean; }

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL;

const TYPE_META: Record<string, { label: string; icon: React.ElementType; colour: string }> = {
    POWER_FACTOR_CORRECTION: { label: "Power Factor",     icon: Zap,           colour: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" },
    HARMONIC_FILTER:         { label: "Harmonic Filter",  icon: Activity,      colour: "text-purple-400 bg-purple-500/10 border-purple-500/20" },
    PV_INSTALL:              { label: "Solar PV",         icon: Sun,           colour: "text-orange-400 bg-orange-500/10 border-orange-500/20" },
    LIGHTING_UPGRADE:        { label: "Lighting",         icon: Lightbulb,     colour: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
    LOAD_SHIFTING:           { label: "Load Shifting",    icon: BarChart2,     colour: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
    VOLTAGE_REGULATION:      { label: "Voltage Reg.",     icon: AlertTriangle, colour: "text-red-400 bg-red-500/10 border-red-500/20" },
    DEMAND_MANAGEMENT:       { label: "Demand Mgmt",      icon: TrendingUp,    colour: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20" },
    ENERGY_AUDIT:            { label: "Energy Audit",     icon: Filter,        colour: "text-slate-400 bg-slate-500/10 border-slate-500/20" },
};

const CONFIDENCE_COLOUR: Record<string, string> = {
    HIGH:   "text-emerald-400 bg-emerald-500/10",
    MEDIUM: "text-yellow-400  bg-yellow-500/10",
    LOW:    "text-slate-400   bg-slate-700",
};

// Currency formatting lives in @/lib/format (zar); alias kept for existing call sites.
const fmt = zar;

// ── Page ──────────────────────────────────────────────────────────────────────
export default function RecommendationsPage() {
    const [recs,          setRecs]          = useState<Recommendation[]>([]);
    const [sites,         setSites]         = useState<Site[]>([]);
    const [meters,        setMeters]        = useState<Meter[]>([]);
    const [loading,       setLoading]       = useState(true);
    const [generating,    setGenerating]    = useState<string | null>(null); // site or meter id being generated
    const [notifying,     setNotifying]     = useState<string | null>(null); // recId being notified
    const [notified,      setNotified]      = useState<Set<string>>(new Set());
    const [filterSite,    setFilterSite]    = useState<string>("all");
    const [filterScope,   setFilterScope]   = useState<"all" | "site" | "meter">("all"); // scope filter
    const [analyseTargetMeter, setAnalyseTargetMeter] = useState<string>(""); // meter chosen for "Analyse This Meter"
    const [expanded,      setExpanded]      = useState<Set<string>>(new Set());
    const [toast,         setToast]         = useState<string | null>(null);

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(null), 3500);
    };

    const fetchData = useCallback(async () => {
        try {
            const [recsRes, sitesRes, metersRes] = await Promise.all([
                fetch(`${API}/ingestion/recommendations`, { credentials: 'include' }),
                fetch(`${API}/ingestion/sites`, { credentials: 'include' }),
                fetch(`${API}/ingestion/meters`, { credentials: 'include' }),
            ]);
            if (recsRes.status === 401) { window.location.href = "/login"; return; }
            const [recsData, sitesData, metersData] = await Promise.all([
                recsRes.json(), sitesRes.json(), metersRes.json()
            ]);
            // NUMERIC columns arrive as strings — coerce so the header total sums correctly.
            setRecs(Array.isArray(recsData) ? recsData.map(normalizeRec) : []);
            setSites(Array.isArray(sitesData) ? sitesData : []);
            setMeters(Array.isArray(metersData) ? metersData : []);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    const handleGenerate = async (siteId: string) => {
        setGenerating(siteId);
        try {
            const res = await fetch(`${API}/ingestion/sites/${siteId}/recommendations/generate`, {
                method: "POST",
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) { showToast(`Error: ${data.error}`); return; }
            showToast(`✓ Generated ${data.generated} recommendation${data.generated !== 1 ? "s" : ""}`);
            await fetchData();
        } catch { showToast("Failed to generate recommendations"); }
        finally { setGenerating(null); }
    };

    const handleGenerateForMeter = async (meterId: string) => {
        setGenerating(meterId);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/recommendations/generate`, {
                method: "POST",
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) { showToast(`Error: ${data.error}`); return; }
            showToast(`✓ Generated ${data.generated} per-meter recommendation${data.generated !== 1 ? "s" : ""}`);
            await fetchData();
        } catch { showToast("Failed to generate per-meter recommendations"); }
        finally { setGenerating(null); }
    };

    const handleNotify = async (recId: string) => {
        setNotifying(recId);
        try {
            const res = await fetch(`${API}/ingestion/recommendations/${recId}/notify`, {
                method: "POST",
                credentials: 'include',
            });
            const data = await res.json();
            if (res.status === 409) { showToast("A lead already exists for this recommendation"); return; }
            if (!res.ok) { showToast(`Error: ${data.error}`); return; }
            setNotified(prev => new Set(prev).add(recId));
            showToast("✓ Team notified — lead created");
        } catch { showToast("Failed to notify team"); }
        finally { setNotifying(null); }
    };

    const toggleExpand = (id: string) =>
        setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

    // Filter + sort
    const filtered = recs
        .filter(r => filterSite === "all" || r.site_id === filterSite)
        .filter(r => filterScope === "all"
            ? true
            : filterScope === "meter" ? !!r.meter_id : !r.meter_id)
        .sort((a, b) => a.priority - b.priority || b.estimated_monthly_saving_zar - a.estimated_monthly_saving_zar);

    // Meters scoped to the currently-filtered site
    const visibleMeters = meters.filter(m =>
        (filterSite === "all" || m.site_id === filterSite) && m.is_active !== false
    );

    const totalSaving = filtered.reduce((s, r) => s + r.estimated_monthly_saving_zar, 0);

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
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

            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Recommendations</h1>
                    <p className="text-slate-400 mt-1">
                        {filtered.length} active · potential saving{" "}
                        <span className="text-emerald-400 font-semibold">{fmt(totalSaving)}/month</span>
                    </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                    {/* Site filter */}
                    <select
                        value={filterSite}
                        onChange={e => { setFilterSite(e.target.value); setAnalyseTargetMeter(""); }}
                        className="bg-slate-900 border border-slate-800 text-slate-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    >
                        <option value="all">All sites</option>
                        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>

                    {/* Scope filter — site-wide vs per-meter recs */}
                    <select
                        value={filterScope}
                        onChange={e => setFilterScope(e.target.value as any)}
                        className="bg-slate-900 border border-slate-800 text-slate-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    >
                        <option value="all">All scopes</option>
                        <option value="site">Site-wide only</option>
                        <option value="meter">Per-meter only</option>
                    </select>

                    <button onClick={fetchData} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <RefreshCw className="h-4 w-4" /> Refresh
                    </button>
                </div>
            </div>

            {/* Generate AI Analysis per SITE */}
            {sites.length > 0 && (
                <Card className="p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                        Site-wide analysis  <span className="font-normal normal-case text-slate-600">— aggregates all active meters on the site</span>
                    </p>
                    <div className="flex flex-wrap gap-3">
                        {sites
                            .filter(s => filterSite === "all" || s.id === filterSite)
                            .map(site => (
                                <button
                                    key={site.id}
                                    onClick={() => handleGenerate(site.id)}
                                    disabled={generating === site.id}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                                >
                                    {generating === site.id
                                        ? <Loader2 className="h-4 w-4 animate-spin" />
                                        : <Zap className="h-4 w-4" />}
                                    {generating === site.id ? "Analysing…" : `Run for ${site.name}`}
                                </button>
                            ))}
                    </div>
                </Card>
            )}

            {/* Generate AI Analysis per METER */}
            {visibleMeters.length > 0 && (
                <Card className="p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                        Per-meter analysis  <span className="font-normal normal-case text-slate-600">— scoped to one meter's 7-day data + its declared loads</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <select
                            value={analyseTargetMeter}
                            onChange={e => setAnalyseTargetMeter(e.target.value)}
                            className="bg-slate-900 border border-slate-800 text-slate-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50 min-w-[260px]"
                        >
                            <option value="">— Pick a meter —</option>
                            {visibleMeters.map(m => {
                                const s = sites.find(s => s.id === m.site_id);
                                return (
                                    <option key={m.id} value={m.id}>
                                        {m.name}{s ? ` — ${s.name}` : ""}
                                    </option>
                                );
                            })}
                        </select>
                        <button
                            onClick={() => analyseTargetMeter && handleGenerateForMeter(analyseTargetMeter)}
                            disabled={!analyseTargetMeter || generating === analyseTargetMeter}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-400 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {generating === analyseTargetMeter
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Activity className="h-4 w-4" />}
                            {generating === analyseTargetMeter ? "Analysing meter…" : "Run for selected meter"}
                        </button>
                    </div>
                </Card>
            )}

            {/* Empty state */}
            {filtered.length === 0 && (
                <Card className="p-12 text-center">
                    <Lightbulb className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                    <p className="text-white font-medium text-lg">No recommendations yet</p>
                    <p className="text-slate-500 text-sm mt-2 max-w-sm mx-auto">
                        Run an AI analysis on a site that has live meter data. As little as a few hours of readings is enough — the engine uses up to the last 7 days for averages and peaks.
                    </p>
                    {sites.length > 0 && (
                        <button
                            onClick={() => handleGenerate(sites[0].id)}
                            disabled={!!generating}
                            className="mt-6 flex items-center gap-2 mx-auto px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
                        >
                            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                            Run First Analysis
                        </button>
                    )}
                </Card>
            )}

            {/* Recommendations list */}
            <div className="space-y-4">
                {filtered.map(rec => {
                    const meta    = TYPE_META[rec.type] ?? { label: rec.type, icon: Lightbulb, colour: "text-slate-400 bg-slate-700" };
                    const Icon    = meta.icon;
                    const isOpen  = expanded.has(rec.id);
                    const isDone  = notified.has(rec.id);

                    return (
                        <Card key={rec.id} className="overflow-hidden">
                            {/* Summary row */}
                            <div
                                className="flex items-start gap-4 cursor-pointer"
                                onClick={() => toggleExpand(rec.id)}
                            >
                                {/* Type badge */}
                                <div className={`p-2.5 rounded-lg border shrink-0 mt-0.5 ${meta.colour}`}>
                                    <Icon className="h-5 w-5" />
                                </div>

                                {/* Main content */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`text-xs px-2 py-0.5 rounded-full border ${meta.colour}`}>
                                            {meta.label}
                                        </span>
                                        <span className={`text-xs px-2 py-0.5 rounded-full ${CONFIDENCE_COLOUR[rec.confidence]}`}>
                                            {rec.confidence} confidence
                                        </span>
                                        {rec.meter_id && rec.meter_name ? (
                                            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 flex items-center gap-1">
                                                <Activity className="h-3 w-3" /> {rec.meter_name}
                                            </span>
                                        ) : (
                                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">
                                                Site-wide
                                            </span>
                                        )}
                                        <span className="text-xs text-slate-500">{rec.site_name}</span>
                                        {rec.standard_reference && (
                                            <span className="text-xs text-slate-600 font-mono">{rec.standard_reference}</span>
                                        )}
                                    </div>
                                    <h3 className="text-base font-semibold text-white mt-1">{rec.title}</h3>
                                    <p className="text-sm text-slate-400 mt-0.5 line-clamp-1">{rec.problem}</p>
                                </div>

                                {/* ROI summary */}
                                <div className="hidden sm:flex flex-col items-end shrink-0 gap-1 ml-4">
                                    <span className="text-lg font-bold text-emerald-400">
                                        {fmt(rec.estimated_monthly_saving_zar)}<span className="text-xs text-slate-500 font-normal">/mo</span>
                                    </span>
                                    {rec.payback_months > 0 && (
                                        <span className="text-xs text-slate-500">{rec.payback_months}mo payback</span>
                                    )}
                                </div>

                                <div className="shrink-0 text-slate-500 mt-1">
                                    {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                </div>
                            </div>

                            {/* Expanded detail */}
                            {isOpen && (
                                <div className="mt-5 pt-5 border-t border-slate-800 space-y-4">
                                    <div className="grid md:grid-cols-2 gap-4">
                                        <div>
                                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Problem</p>
                                            <p className="text-sm text-slate-300">{rec.problem}</p>
                                        </div>
                                        <div>
                                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Recommended Action</p>
                                            <p className="text-sm text-slate-300">{rec.solution}</p>
                                        </div>
                                    </div>

                                    {/* ROI numbers */}
                                    <div className="flex flex-wrap gap-4 p-4 rounded-lg bg-slate-900/50 border border-slate-800">
                                        <div>
                                            <p className="text-xs text-slate-500">Est. Monthly Saving</p>
                                            <p className="text-lg font-bold text-emerald-400">{fmt(rec.estimated_monthly_saving_zar)}</p>
                                        </div>
                                        {rec.estimated_implementation_cost_zar > 0 && (
                                            <div>
                                                <p className="text-xs text-slate-500">Implementation Cost</p>
                                                <p className="text-lg font-bold text-white">{fmt(rec.estimated_implementation_cost_zar)}</p>
                                            </div>
                                        )}
                                        {rec.payback_months > 0 && (
                                            <div>
                                                <p className="text-xs text-slate-500">Payback Period</p>
                                                <p className="text-lg font-bold text-blue-400">{rec.payback_months} months</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Notify team button */}
                                    <div className="flex justify-end">
                                        {isDone ? (
                                            <div className="flex items-center gap-2 px-4 py-2 text-emerald-400 text-sm">
                                                <CheckCircle2 className="h-4 w-4" />
                                                Team notified — lead created
                                            </div>
                                        ) : (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleNotify(rec.id); }}
                                                disabled={notifying === rec.id}
                                                className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all"
                                            >
                                                {notifying === rec.id
                                                    ? <Loader2 className="h-4 w-4 animate-spin" />
                                                    : <BellRing className="h-4 w-4" />}
                                                Notify Team
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </Card>
                    );
                })}
            </div>
        </div>
    );
}
