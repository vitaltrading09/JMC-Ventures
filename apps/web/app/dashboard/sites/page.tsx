"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import Link from "next/link";
import {
    Plus, Search, MapPin, X, Loader2, Server,
    ChevronDown, ChevronRight, Trash2, BarChart2,
    Activity, Clock, ArrowRight, AlertTriangle
} from "lucide-react";

interface Site {
    id: string;
    name: string;
    address: string;
    timezone: string;
    created_at: string;
}

interface Meter {
    id: string;
    name: string;
    serial_number: string;
    model: string;
    site_id: string;
    latest_reading?: {
        power_active_total?: number;
        voltage_a?: number;
        current_a?: number;
        power_factor_total?: number;
        time: string;
    };
}

export default function SitesPage() {
    const [sites, setSites] = useState<Site[]>([]);
    const [meters, setMeters] = useState<Meter[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedSite, setExpandedSite] = useState<string | null>(null);
    const [search, setSearch] = useState("");

    // Modal states
    const [isSiteModalOpen, setIsSiteModalOpen] = useState(false);
    const [isMeterModalOpen, setIsMeterModalOpen] = useState(false);
    const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const [siteForm, setSiteForm] = useState({ name: "", address: "", timezone: "Africa/Johannesburg" });
    const [meterForm, setMeterForm] = useState({ name: "", serial_number: "", model: "" });

    const token = () => localStorage.getItem('token') || '';

    const fetchData = async () => {
        try {
            const headers = { Authorization: `Bearer ${token()}` };
            const [sitesRes, metersRes] = await Promise.all([
                fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/sites`, { headers }),
                fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/meters`, { headers }),
            ]);
            if (sitesRes.status === 401 || metersRes.status === 401) {
                window.location.href = '/login'; return;
            }
            const [sitesData, metersData] = await Promise.all([sitesRes.json(), metersRes.json()]);
            setSites(Array.isArray(sitesData) ? sitesData : []);
            setMeters(Array.isArray(metersData) ? metersData : []);
        } catch (err) { console.error('Fetch error:', err); }
        finally { setLoading(false); }
    };

    useEffect(() => {
        fetchData();
        const iv = setInterval(fetchData, 8000);
        return () => clearInterval(iv);
    }, []);

    const handleCreateSite = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true); setError("");
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/sites`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify(siteForm),
            });
            if (!res.ok) throw new Error(await res.text());
            const newSite = await res.json();
            setIsSiteModalOpen(false);
            setSiteForm({ name: "", address: "", timezone: "Africa/Johannesburg" });
            setSelectedSiteId(newSite.id);
            setExpandedSite(newSite.id);
            setIsMeterModalOpen(true);
            fetchData();
        } catch (err: any) { setError(err.message || "Failed to create site"); }
        finally { setSubmitting(false); }
    };

    const handleCreateMeter = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true); setError("");
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/meters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ ...meterForm, site_id: selectedSiteId }),
            });
            if (!res.ok) throw new Error(await res.text());
            setIsMeterModalOpen(false);
            setMeterForm({ name: "", serial_number: "", model: "" });
            fetchData();
        } catch (err: any) { setError(err.message || "Failed to create meter"); }
        finally { setSubmitting(false); }
    };

    const handleDeleteMeter = async (meterId: string, meterName: string) => {
        if (!confirm(`Delete meter "${meterName}" and ALL its readings ? This cannot be undone.`)) return;
        setDeletingId(meterId);
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/meters/${meterId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token()}` },
            });
            if (!res.ok) throw new Error(await res.text());
            fetchData();
        } catch (err: any) { alert(`Delete failed: ${err.message}`); }
        finally { setDeletingId(null); }
    };

    const filteredSites = sites.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        (s.address || '').toLowerCase().includes(search.toLowerCase())
    );

    const getMetersForSite = (siteId: string) => meters.filter(m => m.site_id === siteId);

    const timeAgo = (isoStr: string) => {
        const diff = Date.now() - new Date(isoStr).getTime();
        if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return `${Math.floor(diff / 86400000)}d ago`;
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Sites</h1>
                    <p className="text-slate-400 mt-1">
                        {sites.length} site{sites.length !== 1 ? 's' : ''} · {meters.length} meter{meters.length !== 1 ? 's' : ''}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                        <input type="text" placeholder="Search sites..." value={search} onChange={e => setSearch(e.target.value)}
                            className="pl-10 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 w-56" />
                    </div>
                    <button onClick={() => setIsSiteModalOpen(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all">
                        <Plus className="h-4 w-4" /> Add Site
                    </button>
                </div>
            </div>

            {/* Sites List */}
            <div className="space-y-3">
                {loading ? (
                    <div className="text-center py-16 text-slate-500">
                        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading sites...
                    </div>
                ) : filteredSites.length === 0 ? (
                    <Card className="p-12 text-center">
                        <MapPin className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                        <p className="text-slate-400 font-medium">No sites yet</p>
                        <p className="text-slate-600 text-sm mt-1">Create your first site to start managing meters</p>
                        <button onClick={() => setIsSiteModalOpen(true)} className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium">
                            Create Site
                        </button>
                    </Card>
                ) : (
                    filteredSites.map(site => {
                        const siteMeters = getMetersForSite(site.id);
                        const isExpanded = expandedSite === site.id;
                        const totalPower = siteMeters.reduce((sum, m) => sum + (m.latest_reading?.power_active_total || 0), 0);

                        return (
                            <div key={site.id} className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden transition-all">
                                {/* Site header row */}
                                <button
                                    onClick={() => setExpandedSite(isExpanded ? null : site.id)}
                                    className="w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-800/40 transition-colors text-left">
                                    <div className={`transition - transform duration - 200 ${isExpanded ? 'rotate-90' : ''}`}>
                                        <ChevronRight className="w-4 h-4 text-slate-500" />
                                    </div>
                                    <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                                        <MapPin className="h-5 w-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-semibold text-white">{site.name}</h3>
                                        <p className="text-xs text-slate-500 truncate">{site.address || 'No address'}</p>
                                    </div>
                                    <div className="hidden md:flex items-center gap-6 text-sm">
                                        <div className="text-right">
                                            <p className="text-xs text-slate-500">Meters</p>
                                            <p className="text-white font-medium">{siteMeters.length}</p>
                                        </div>
                                        {totalPower > 0 && (
                                            <div className="text-right">
                                                <p className="text-xs text-slate-500">Total Power</p>
                                                <p className="text-blue-400 font-mono font-medium">{totalPower.toFixed(1)} kW</p>
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        onClick={e => { e.stopPropagation(); setSelectedSiteId(site.id); setIsMeterModalOpen(true); setError(""); }}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors border border-slate-700 ml-2">
                                        <Plus className="w-3 h-3" /> Add Meter
                                    </button>
                                </button>

                                {/* Expanded meters */}
                                {isExpanded && (
                                    <div className="border-t border-slate-800 divide-y divide-slate-800/60">
                                        {siteMeters.length === 0 ? (
                                            <div className="px-8 py-5 text-slate-500 text-sm flex items-center gap-3">
                                                <Server className="w-4 h-4" />
                                                No meters yet —{' '}
                                                <button onClick={() => { setSelectedSiteId(site.id); setIsMeterModalOpen(true); setError(""); }}
                                                    className="text-blue-400 hover:underline">add one</button>
                                                {' '}or{' '}
                                                <Link href="/dashboard/settings/data" className="text-blue-400 hover:underline">import data</Link>
                                            </div>
                                        ) : (
                                            siteMeters.map(meter => {
                                                const r = meter.latest_reading;
                                                const hasLive = r && r.time && (Date.now() - new Date(r.time).getTime()) < 120000;
                                                return (
                                                    <div key={meter.id} className="flex items-center gap-4 px-8 py-3.5 hover:bg-slate-800/30 transition-colors group">
                                                        <div className="p-1.5 rounded-md bg-slate-800 text-slate-400">
                                                            <Activity className="w-4 h-4" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-white truncate">{meter.name}</p>
                                                            <p className="text-xs text-slate-500">{meter.model} · SN: {meter.serial_number}</p>
                                                        </div>

                                                        {/* Live stats */}
                                                        <div className="hidden md:flex items-center gap-5 text-xs">
                                                            {r?.power_active_total != null && (
                                                                <div className="text-right">
                                                                    <p className="text-slate-500">P</p>
                                                                    <p className="text-blue-400 font-mono font-medium">{r.power_active_total.toFixed(1)} kW</p>
                                                                </div>
                                                            )}
                                                            {r?.voltage_a != null && (
                                                                <div className="text-right">
                                                                    <p className="text-slate-500">V</p>
                                                                    <p className="text-yellow-400 font-mono">{r.voltage_a.toFixed(1)} V</p>
                                                                </div>
                                                            )}
                                                            {r?.power_factor_total != null && (
                                                                <div className="text-right">
                                                                    <p className="text-slate-500">PF</p>
                                                                    <p className={`font - mono ${r.power_factor_total < 0.85 ? 'text-red-400' : 'text-emerald-400'}`}>
                                                                        {r.power_factor_total.toFixed(3)}
                                                                    </p>
                                                                </div>
                                                            )}
                                                            {r?.time && (
                                                                <div className="flex items-center gap-1 text-slate-500">
                                                                    <Clock className="w-3 h-3" />
                                                                    {timeAgo(r.time)}
                                                                </div>
                                                            )}
                                                            {/* Status badge */}
                                                            <span className={`px - 2 py - 0.5 rounded - full text - [10px] font - medium border ${hasLive
                                                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                                    : r ? 'bg-slate-700 text-slate-400 border-slate-600' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                                                }`}>
                                                                {hasLive ? '● Live' : r ? 'Imported' : 'No data'}
                                                            </span>
                                                        </div>

                                                        {/* Actions */}
                                                        <div className="flex items-center gap-1 ml-2">
                                                            <Link href={`/ dashboard / sites / ${meter.id}`}
                                                                className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors">
                                                                <BarChart2 className="w-3.5 h-3.5" /> Chart
                                                            </Link>
                                                            <button
                                                                onClick={() => handleDeleteMeter(meter.id, meter.name)}
                                                                disabled={deletingId === meter.id}
                                                                className="p-1.5 text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
                                                                {deletingId === meter.id
                                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                    : <Trash2 className="w-3.5 h-3.5" />}
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            {/* Create Site Modal */}
            {isSiteModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
                    <Card className="w-full max-w-md p-6 bg-slate-900 border-slate-800 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-xl font-semibold text-white">Create New Site</h2>
                            <button onClick={() => setIsSiteModalOpen(false)} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
                        </div>
                        {error && <div className="mb-4 p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}
                        <form onSubmit={handleCreateSite} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Site Name *</label>
                                <input type="text" required value={siteForm.name} onChange={e => setSiteForm({ ...siteForm, name: e.target.value })}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    placeholder="e.g. Main Factory — Sandton" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Address / Location</label>
                                <input type="text" value={siteForm.address} onChange={e => setSiteForm({ ...siteForm, address: e.target.value })}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    placeholder="e.g. 123 Industrial Rd, Sandton, GP" />
                            </div>
                            <div className="pt-4 flex justify-end gap-3">
                                <button type="button" onClick={() => setIsSiteModalOpen(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                                <button type="submit" disabled={submitting}
                                    className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <> Create & Add Meter <ArrowRight className="h-4 w-4" /></>}
                                </button>
                            </div>
                        </form>
                    </Card>
                </div>
            )}

            {/* Create Meter Modal */}
            {isMeterModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
                    <Card className="w-full max-w-md p-6 bg-slate-900 border-slate-800 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h2 className="text-xl font-semibold text-white">Add Meter</h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Site: {sites.find(s => s.id === selectedSiteId)?.name || selectedSiteId}
                                </p>
                            </div>
                            <button onClick={() => setIsMeterModalOpen(false)} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
                        </div>
                        {error && <div className="mb-4 p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}
                        <form onSubmit={handleCreateMeter} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Meter Name / Tag *</label>
                                <input type="text" required value={meterForm.name} onChange={e => setMeterForm({ ...meterForm, name: e.target.value })}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    placeholder="e.g. Main Incomer A" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Serial Number</label>
                                <input type="text" value={meterForm.serial_number} onChange={e => setMeterForm({ ...meterForm, serial_number: e.target.value })}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    placeholder="e.g. SN-1002345 (or leave blank for CSV import)" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Hardware Model</label>
                                <input type="text" value={meterForm.model} onChange={e => setMeterForm({ ...meterForm, model: e.target.value })}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    placeholder="e.g. Acuvim II (or 'CSV Import')" />
                            </div>
                            <div className="pt-4 flex justify-between items-center">
                                <Link href="/dashboard/settings/data"
                                    className="text-xs text-blue-400 hover:underline flex items-center gap-1">
                                    <Plus className="w-3 h-3" /> Import data instead →
                                </Link>
                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setIsMeterModalOpen(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Skip</button>
                                    <button type="submit" disabled={submitting}
                                        className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Server className="h-4 w-4" /> Add Meter</>}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </Card>
                </div>
            )}
        </div>
    );
}
