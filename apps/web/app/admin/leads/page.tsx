"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import {
    Loader2, Briefcase, RefreshCw, CheckCircle2,
    Clock, FileText, XCircle, ChevronDown,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type LeadStatus = "NEW" | "IN_REVIEW" | "QUOTED" | "WON" | "LOST";

interface Lead {
    id: string;
    status: LeadStatus;
    site_id: string;
    site_name: string;
    recommendation_id: string;
    rec_title: string;
    rec_type: string;
    estimated_monthly_saving_zar: number;
    estimated_implementation_cost_zar: number;
    payback_months: number;
    created_at: string;
    updated_at: string;
    notes?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

const STATUS_CONFIG: Record<LeadStatus, { label: string; icon: React.ElementType; cls: string; bg: string }> = {
    NEW:       { label: "New",       icon: Clock,         cls: "text-blue-400   border-blue-500/30",   bg: "bg-blue-500/10" },
    IN_REVIEW: { label: "In Review", icon: FileText,      cls: "text-yellow-400 border-yellow-500/30", bg: "bg-yellow-500/10" },
    QUOTED:    { label: "Quoted",    icon: Briefcase, cls: "text-purple-400 border-purple-500/30", bg: "bg-purple-500/10" },
    WON:       { label: "Won",       icon: CheckCircle2,  cls: "text-emerald-400 border-emerald-500/30", bg: "bg-emerald-500/10" },
    LOST:      { label: "Lost",      icon: XCircle,       cls: "text-slate-400   border-slate-600",     bg: "bg-slate-800" },
};

const NEXT_STATUS: Partial<Record<LeadStatus, LeadStatus>> = {
    NEW:       "IN_REVIEW",
    IN_REVIEW: "QUOTED",
    QUOTED:    "WON",
};

function fmt(n: number) {
    return n > 0 ? `R ${n.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}` : "—";
}

function timeAgo(iso: string) {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
    return new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LeadsQueuePage() {
    const [leads,       setLeads]       = useState<Lead[]>([]);
    const [loading,     setLoading]     = useState(true);
    const [updating,    setUpdating]    = useState<string | null>(null);
    const [filterStatus, setFilterStatus] = useState<LeadStatus | "ALL">("ALL");
    const [toast,       setToast]       = useState<string | null>(null);
    const [expandedId,  setExpandedId]  = useState<string | null>(null);

    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(null), 3500);
    };

    const fetchLeads = useCallback(async () => {
        try {
            const res = await fetch(`${API}/ingestion/leads`, {
                credentials: 'include',
            });
            if (res.status === 401) { window.location.href = "/login"; return; }
            const data = await res.json();
            setLeads(Array.isArray(data) ? data : []);
        } catch { }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchLeads(); }, [fetchLeads]);

    const updateStatus = async (lead: Lead, newStatus: LeadStatus) => {
        setUpdating(lead.id);
        try {
            const res = await fetch(`${API}/ingestion/leads/${lead.id}`, {
                method: "PATCH",
                credentials: 'include',
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) { showToast("Failed to update status"); return; }
            setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: newStatus } : l));
            showToast(`✓ Lead moved to ${STATUS_CONFIG[newStatus].label}`);
        } catch { showToast("Failed to update status"); }
        finally { setUpdating(null); }
    };

    const filtered = leads.filter(l => filterStatus === "ALL" || l.status === filterStatus);

    const counts: Record<string, number> = {
        ALL: leads.length,
        NEW: leads.filter(l => l.status === "NEW").length,
        IN_REVIEW: leads.filter(l => l.status === "IN_REVIEW").length,
        QUOTED: leads.filter(l => l.status === "QUOTED").length,
        WON: leads.filter(l => l.status === "WON").length,
        LOST: leads.filter(l => l.status === "LOST").length,
    };

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
                    <h1 className="text-3xl font-bold tracking-tight text-white">Leads Queue</h1>
                    <p className="text-slate-400 mt-1">
                        Client-initiated opportunities from "Notify Team" actions
                    </p>
                </div>
                <button
                    onClick={fetchLeads}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors w-max"
                >
                    <RefreshCw className="h-4 w-4" /> Refresh
                </button>
            </div>

            {/* ── Status Filter Tabs ──────────────────────────────────────── */}
            <div className="flex flex-wrap gap-2">
                {(["ALL", "NEW", "IN_REVIEW", "QUOTED", "WON", "LOST"] as const).map(s => {
                    const isActive = filterStatus === s;
                    const cfg = s === "ALL" ? null : STATUS_CONFIG[s];
                    return (
                        <button
                            key={s}
                            onClick={() => setFilterStatus(s)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
                                isActive
                                    ? "bg-slate-700 text-white border-slate-600"
                                    : "text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300"
                            }`}
                        >
                            {s === "ALL" ? "All" : STATUS_CONFIG[s as LeadStatus].label}
                            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                                isActive ? "bg-slate-600 text-slate-200" : "bg-slate-800 text-slate-500"
                            }`}>
                                {counts[s]}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* ── Empty State ─────────────────────────────────────────────── */}
            {filtered.length === 0 && (
                <Card className="p-12 text-center">
                    <Briefcase className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                    <p className="text-white font-medium text-lg">
                        {leads.length === 0 ? "No leads yet" : "No leads match this filter"}
                    </p>
                    <p className="text-slate-500 text-sm mt-2 max-w-sm mx-auto">
                        {leads.length === 0
                            ? "When a client clicks \"Notify Team\" on a recommendation, it appears here."
                            : "Try selecting a different status filter above."}
                    </p>
                </Card>
            )}

            {/* ── Leads List ──────────────────────────────────────────────── */}
            <div className="space-y-3">
                {filtered
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                    .map(lead => {
                        const cfg  = STATUS_CONFIG[lead.status];
                        const Icon = cfg.icon;
                        const next = NEXT_STATUS[lead.status];
                        const isExpanded = expandedId === lead.id;

                        return (
                            <Card key={lead.id} className="overflow-hidden">
                                {/* Summary row */}
                                <div
                                    className="flex items-start gap-4 cursor-pointer"
                                    onClick={() => setExpandedId(isExpanded ? null : lead.id)}
                                >
                                    {/* Status icon */}
                                    <div className={`p-2.5 rounded-lg border shrink-0 mt-0.5 ${cfg.cls} ${cfg.bg}`}>
                                        <Icon className="h-4 w-4" />
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`text-xs px-2 py-0.5 rounded-full border ${cfg.cls} ${cfg.bg}`}>
                                                {cfg.label}
                                            </span>
                                            <span className="text-xs text-slate-500">{lead.site_name}</span>
                                            <span className="text-xs text-slate-600">{timeAgo(lead.created_at)}</span>
                                        </div>
                                        <p className="text-sm font-semibold text-white mt-1">{lead.rec_title}</p>
                                    </div>

                                    {/* ROI summary */}
                                    <div className="hidden sm:flex flex-col items-end shrink-0 gap-1 ml-4">
                                        <span className="text-base font-bold text-emerald-400">
                                            {fmt(lead.estimated_monthly_saving_zar)}
                                            <span className="text-xs text-slate-500 font-normal">/mo</span>
                                        </span>
                                        {lead.payback_months > 0 && (
                                            <span className="text-xs text-slate-500">{lead.payback_months}mo payback</span>
                                        )}
                                    </div>

                                    <ChevronDown className={`h-4 w-4 text-slate-500 shrink-0 mt-1 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                </div>

                                {/* Expanded detail */}
                                {isExpanded && (
                                    <div className="mt-5 pt-5 border-t border-slate-800 space-y-4">
                                        {/* ROI numbers */}
                                        <div className="flex flex-wrap gap-4 p-4 rounded-lg bg-slate-900/50 border border-slate-800">
                                            <div>
                                                <p className="text-xs text-slate-500">Est. Monthly Saving</p>
                                                <p className="text-lg font-bold text-emerald-400">{fmt(lead.estimated_monthly_saving_zar)}</p>
                                            </div>
                                            {lead.estimated_implementation_cost_zar > 0 && (
                                                <div>
                                                    <p className="text-xs text-slate-500">Implementation Cost</p>
                                                    <p className="text-lg font-bold text-white">{fmt(lead.estimated_implementation_cost_zar)}</p>
                                                </div>
                                            )}
                                            {lead.payback_months > 0 && (
                                                <div>
                                                    <p className="text-xs text-slate-500">Payback Period</p>
                                                    <p className="text-lg font-bold text-blue-400">{lead.payback_months} months</p>
                                                </div>
                                            )}
                                            <div>
                                                <p className="text-xs text-slate-500">Rec. Type</p>
                                                <p className="text-sm font-medium text-slate-300">
                                                    {lead.rec_type?.replace(/_/g, " ") ?? "—"}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex gap-2">
                                                {next && (
                                                    <button
                                                        onClick={e => { e.stopPropagation(); updateStatus(lead, next); }}
                                                        disabled={updating === lead.id}
                                                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-all"
                                                    >
                                                        {updating === lead.id
                                                            ? <Loader2 className="h-4 w-4 animate-spin" />
                                                            : <CheckCircle2 className="h-4 w-4" />}
                                                        Move to {STATUS_CONFIG[next].label}
                                                    </button>
                                                )}
                                                {lead.status !== "LOST" && lead.status !== "WON" && (
                                                    <button
                                                        onClick={e => { e.stopPropagation(); updateStatus(lead, "LOST"); }}
                                                        disabled={updating === lead.id}
                                                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-400 hover:text-red-400 rounded-lg text-sm font-medium transition-all"
                                                    >
                                                        <XCircle className="h-4 w-4" /> Mark Lost
                                                    </button>
                                                )}
                                            </div>
                                            <span className="text-xs text-slate-600">
                                                Updated {timeAgo(lead.updated_at)}
                                            </span>
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
