"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Plus, Search, MapPin, X, Loader2, Server,
    ChevronDown, ChevronRight, Trash2, BarChart2,
    Activity, Clock, ArrowRight, AlertTriangle,
    Copy, Check, Wifi, PauseCircle, PlayCircle, Settings, Save, Tag
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
    is_active: boolean;
    load_types?: string[] | null;
    load_description?: string | null;
    site_type?: string | null;
    latest_reading?: {
        power_active_total?: number;
        voltage_a?: number;
        current_a?: number;
        power_factor_total?: number;
        time: string;
    };
}

// Load type catalog — what each meter physically measures.
// The AI uses these to scope recommendations (no more guessing about VFDs / LED retrofits).
const LOAD_TYPE_CATALOG: { category: string; options: { value: string; label: string }[] }[] = [
    {
        category: "Lighting",
        options: [
            { value: "lighting_led",          label: "LED Lighting" },
            { value: "lighting_fluorescent",  label: "Fluorescent / T8 / T5" },
            { value: "lighting_hid",          label: "HID / Metal Halide / Sodium" },
            { value: "lighting_incandescent", label: "Incandescent / Halogen" },
        ],
    },
    {
        category: "HVAC",
        options: [
            { value: "hvac_split_ac",   label: "Split Air Conditioners" },
            { value: "hvac_chiller",    label: "Chiller Plant" },
            { value: "hvac_heatpump",   label: "Heat Pump" },
            { value: "hvac_ahu",        label: "AHU / Ventilation Fans" },
        ],
    },
    {
        category: "Motors",
        options: [
            { value: "motors_dol",       label: "Direct-Online (DOL) Motors" },
            { value: "motors_vfd",       label: "Motors with VFD" },
            { value: "motors_softstart", label: "Soft-Starter Motors" },
        ],
    },
    {
        category: "Refrigeration",
        options: [
            { value: "refrig_displays", label: "Refrigerated Display Cases" },
            { value: "refrig_coldroom", label: "Cold Rooms (0–8 °C)" },
            { value: "refrig_freezer",  label: "Freezer Rooms (< -18 °C)" },
            { value: "refrig_icemakers", label: "Ice Makers" },
        ],
    },
    {
        category: "Compressed Air & Pumps",
        options: [
            { value: "compressor_air",        label: "Air Compressors" },
            { value: "compressor_refrigeration", label: "Refrigeration Compressors" },
            { value: "pumps_water",           label: "Water Pumps" },
            { value: "pumps_process",         label: "Process Pumps" },
        ],
    },
    {
        category: "Process / Industrial",
        options: [
            { value: "ovens_baking",     label: "Bakery / Pizza Ovens" },
            { value: "ovens_industrial", label: "Industrial Ovens / Furnaces" },
            { value: "welding",          label: "Welding Equipment" },
            { value: "conveyors",        label: "Conveyors" },
            { value: "machine_tools",    label: "CNC / Machine Tools" },
        ],
    },
    {
        category: "IT & Office",
        options: [
            { value: "it_servers",       label: "Servers / Data Room" },
            { value: "office_equipment", label: "Office Equipment (PCs, printers)" },
            { value: "pos_systems",      label: "POS / Till Systems" },
        ],
    },
    {
        category: "Other",
        options: [
            { value: "ev_charging",     label: "EV Charging" },
            { value: "solar_pv",        label: "Solar PV Generation" },
            { value: "battery_storage", label: "Battery Storage" },
            { value: "water_heating",   label: "Electric Water Heating / Geysers" },
            { value: "kitchen_equip",   label: "Commercial Kitchen Equipment" },
            { value: "general_loads",   label: "General Plug Loads / Sub-mains" },
        ],
    },
];

const SITE_TYPE_OPTIONS = [
    "Retail / Supermarket",
    "Office Building",
    "Warehouse / Distribution",
    "Industrial / Manufacturing",
    "Cold Storage",
    "Restaurant / Food Service",
    "Hotel / Hospitality",
    "Hospital / Medical",
    "School / Educational",
    "Mixed Use",
    "Other",
];

export default function SitesPage() {
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [meters, setMeters] = useState<Meter[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedSite, setExpandedSite] = useState<string | null>(null);
    const [search, setSearch] = useState("");

    // Modal states
    const [isSiteModalOpen, setIsSiteModalOpen] = useState(false);
    const [isMeterModalOpen, setIsMeterModalOpen] = useState(false);
    const [mqttConfig, setMqttConfig] = useState<{ meterId: string; meterName: string } | null>(null);
    const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    // Meter load-profile modal state
    const [editingMeter, setEditingMeter] = useState<Meter | null>(null);
    const [profileForm, setProfileForm] = useState<{
        load_types: string[];
        load_description: string;
        site_type: string;
    }>({ load_types: [], load_description: "", site_type: "" });
    const [savingProfile, setSavingProfile] = useState(false);

    const openMeterSettings = (meter: Meter) => {
        setEditingMeter(meter);
        setProfileForm({
            load_types: meter.load_types ?? [],
            load_description: meter.load_description ?? "",
            site_type: meter.site_type ?? "",
        });
        setError("");
    };

    const toggleLoadType = (value: string) => {
        setProfileForm(f => ({
            ...f,
            load_types: f.load_types.includes(value)
                ? f.load_types.filter(t => t !== value)
                : [...f.load_types, value],
        }));
    };

    const handleSaveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingMeter) return;
        setSavingProfile(true); setError("");
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/ingestion/meters/${editingMeter.id}/profile`,
                {
                    method: 'PATCH',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        load_types: profileForm.load_types,
                        load_description: profileForm.load_description || null,
                        site_type: profileForm.site_type || null,
                    }),
                }
            );
            if (!res.ok) throw new Error(await res.text());
            setEditingMeter(null);
            fetchData();
        } catch (err: any) {
            setError(err.message || "Failed to save load profile");
        } finally {
            setSavingProfile(false);
        }
    };

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(label);
            setTimeout(() => setCopied(null), 2000);
        });
    };

    const [siteForm, setSiteForm] = useState({ name: "", address: "", timezone: "Africa/Johannesburg" });
    const [meterForm, setMeterForm] = useState({ name: "", serial_number: "", model: "" });

    const fetchData = async () => {
        try {
            const [sitesRes, metersRes] = await Promise.all([
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/sites`, { credentials: 'include' }),
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/meters`, { credentials: 'include' }),
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
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/sites`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
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
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/meters`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...meterForm, site_id: selectedSiteId }),
            });
            if (!res.ok) throw new Error(await res.text());
            const newMeter = await res.json();
            setIsMeterModalOpen(false);
            setMeterForm({ name: "", serial_number: "", model: "" });
            setMqttConfig({ meterId: newMeter.id, meterName: newMeter.name });
            fetchData();
        } catch (err: any) { setError(err.message || "Failed to create meter"); }
        finally { setSubmitting(false); }
    };

    const handleDeleteMeter = async (meterId: string, meterName: string) => {
        if (!confirm(`Delete meter "${meterName}" and ALL its readings ? This cannot be undone.`)) return;
        setDeletingId(meterId);
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/meters/${meterId}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (!res.ok) throw new Error(await res.text());
            fetchData();
        } catch (err: any) { alert(`Delete failed: ${err.message}`); }
        finally { setDeletingId(null); }
    };

    const handleToggleMeter = async (e: React.MouseEvent, meter: Meter) => {
        e.stopPropagation();
        setTogglingId(meter.id);
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/ingestion/meters/${meter.id}/active`,
                { method: 'PATCH', credentials: 'include' }
            );
            if (!res.ok) throw new Error(await res.text());
            fetchData();
        } catch (err: any) { alert(`Toggle failed: ${err.message}`); }
        finally { setTogglingId(null); }
    };

    const handleDeleteSite = async (siteId: string, siteName: string) => {
        if (!confirm(`WARNING: Are you sure you want to delete the site "${siteName}"? This will permanently delete ALL its meters and data.`)) return;
        setDeletingId(siteId);
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/sites/${siteId}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (!res.ok) throw new Error(await res.text());
            fetchData();
        } catch (err: any) { alert(`Site delete failed: ${err.message}`); }
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
                                <div
                                    onClick={() => setExpandedSite(isExpanded ? null : site.id)}
                                    className="w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-800/40 transition-colors text-left cursor-pointer">
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
                                    <div className="flex items-center gap-2 ml-2">
                                        <button
                                            onClick={e => { e.stopPropagation(); setSelectedSiteId(site.id); setIsMeterModalOpen(true); setError(""); }}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors border border-slate-700">
                                            <Plus className="w-3 h-3" /> Add Meter
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteSite(site.id, site.name); }}
                                            disabled={deletingId === site.id}
                                            className="p-1.5 text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent">
                                            {deletingId === site.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>

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
                                                    <div key={meter.id}
                                                        onClick={() => router.push(`/dashboard/sites/${meter.id}`)}
                                                        className={`flex items-center gap-4 px-8 py-3.5 hover:bg-slate-800/30 transition-colors group cursor-pointer ${!meter.is_active ? 'opacity-50' : ''}`}>
                                                        <div className="p-1.5 rounded-md bg-slate-800 text-slate-400">
                                                            <Activity className="w-4 h-4" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <p className="text-sm font-medium text-white truncate">{meter.name}</p>
                                                                {!meter.is_active && (
                                                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-400 border border-amber-500/20">Paused</span>
                                                                )}
                                                                {(meter.load_types && meter.load_types.length > 0) ? (
                                                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-blue-500/10 text-blue-300 border border-blue-500/20 flex items-center gap-1">
                                                                        <Tag className="w-2.5 h-2.5" />
                                                                        {meter.load_types.length} load{meter.load_types.length !== 1 ? 's' : ''} declared
                                                                    </span>
                                                                ) : (
                                                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-slate-700/40 text-slate-400 border border-slate-700">
                                                                        loads not declared
                                                                    </span>
                                                                )}
                                                            </div>
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
                                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                                                                !meter.is_active
                                                                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                                                    : hasLive
                                                                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                                        : r ? 'bg-slate-700 text-slate-400 border-slate-600' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                                                }`}>
                                                                {!meter.is_active ? '⏸ Paused' : hasLive ? '● Live' : r ? 'Imported' : 'No data'}
                                                            </span>
                                                        </div>

                                                        {/* Actions */}
                                                        <div className="flex items-center gap-1 ml-2">
                                                            <Link href={`/dashboard/sites/${meter.id}`}
                                                                onClick={e => e.stopPropagation()}
                                                                className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors">
                                                                <BarChart2 className="w-3.5 h-3.5" /> Chart
                                                            </Link>
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); openMeterSettings(meter); }}
                                                                title="Configure loads measured by this meter"
                                                                className="p-1.5 text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors">
                                                                <Settings className="w-3.5 h-3.5" />
                                                            </button>
                                                            <button
                                                                onClick={(e) => handleToggleMeter(e, meter)}
                                                                disabled={togglingId === meter.id}
                                                                title={meter.is_active ? 'Pause meter (exclude from AI/scoring)' : 'Resume meter'}
                                                                className={`p-1.5 rounded-lg transition-colors ${meter.is_active ? 'text-slate-500 hover:text-amber-400 hover:bg-amber-500/10' : 'text-amber-400 hover:text-emerald-400 hover:bg-emerald-500/10'}`}>
                                                                {togglingId === meter.id
                                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                    : meter.is_active
                                                                        ? <PauseCircle className="w-3.5 h-3.5" />
                                                                        : <PlayCircle className="w-3.5 h-3.5" />}
                                                            </button>
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); handleDeleteMeter(meter.id, meter.name); }}
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
                                )
                                }
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

            {/* MQTT Config Modal — shown after meter creation */}
            {mqttConfig && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
                    <Card className="w-full max-w-lg p-6 bg-slate-900 border-slate-800 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                                <div className="p-2 rounded-lg bg-emerald-500/10">
                                    <Wifi className="w-5 h-5 text-emerald-400" />
                                </div>
                                <div>
                                    <h2 className="text-xl font-semibold text-white">Meter Created ✓</h2>
                                    <p className="text-xs text-slate-400 mt-0.5">Configure your Acuvim II with these MQTT settings</p>
                                </div>
                            </div>
                            <button onClick={() => setMqttConfig(null)} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
                        </div>

                        <div className="mt-5 space-y-3">
                            {[
                                { label: "Broker IP / Host",  value: window.location.hostname === 'localhost' ? '(your PC IP on local network)' : window.location.hostname, note: "Your Grid-IQ server IP — use ifconfig/ipconfig to find it on local network" },
                                { label: "Port",              value: "1883",                        note: "Plain TCP — no TLS for local setup" },
                                { label: "Username",          value: "acuvim_meter",                note: "MQTT client username" },
                                { label: "Password",          value: "change_me_in_production",     note: "From mosquitto passwd file — update before going live" },
                                { label: "Topic",             value: `acuvim/${mqttConfig.meterId}/telemetry`, note: "This is unique to this meter — copy exactly" },
                            ].map(({ label, value, note }) => (
                                <div key={label} className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">{label}</p>
                                            <p className="text-sm font-mono text-white break-all">{value}</p>
                                            <p className="text-xs text-slate-600 mt-1">{note}</p>
                                        </div>
                                        <button
                                            onClick={() => copyToClipboard(value, label)}
                                            className="flex-shrink-0 p-2 text-slate-500 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
                                            {copied === label ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                            <p className="text-xs text-blue-300">
                                <span className="font-semibold">On the Acuvim II:</span> Go to <span className="font-mono">Communication → MQTT</span>, enter these values, then set the telemetry interval to 60s. Once connected, this meter will appear live in your dashboard.
                            </p>
                        </div>

                        <div className="mt-4 flex justify-end">
                            <button onClick={() => setMqttConfig(null)}
                                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium">
                                Done
                            </button>
                        </div>
                    </Card>
                </div>
            )}

            {/* Meter Load Profile Modal — declare what this meter measures so the AI knows your site */}
            {editingMeter && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
                    <Card className="w-full max-w-2xl p-6 bg-slate-900 border-slate-800 animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                                <div className="p-2 rounded-lg bg-blue-500/10">
                                    <Tag className="w-5 h-5 text-blue-400" />
                                </div>
                                <div>
                                    <h2 className="text-xl font-semibold text-white">Configure Loads — {editingMeter.name}</h2>
                                    <p className="text-xs text-slate-400 mt-0.5">
                                        Tell the AI exactly what this meter measures — no more guessing about VFDs, lighting type, or refrigeration.
                                    </p>
                                </div>
                            </div>
                            <button onClick={() => setEditingMeter(null)} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
                        </div>
                        {error && <div className="mt-3 p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}

                        <form onSubmit={handleSaveProfile} className="mt-4 space-y-5">
                            {/* Site type — overall classification */}
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-2">Site Type</label>
                                <select
                                    value={profileForm.site_type}
                                    onChange={e => setProfileForm(f => ({ ...f, site_type: e.target.value }))}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 text-sm"
                                >
                                    <option value="">— Select site type —</option>
                                    {SITE_TYPE_OPTIONS.map(s => (
                                        <option key={s} value={s}>{s}</option>
                                    ))}
                                </select>
                                <p className="text-[11px] text-slate-500 mt-1">Helps the AI benchmark your consumption against similar facilities.</p>
                            </div>

                            {/* Load type checklist — grouped by category */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="block text-sm font-medium text-slate-300">Loads Measured by This Meter</label>
                                    <span className="text-xs text-slate-500">
                                        {profileForm.load_types.length} selected
                                    </span>
                                </div>
                                <div className="space-y-3">
                                    {LOAD_TYPE_CATALOG.map(group => (
                                        <div key={group.category} className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                                            <p className="text-xs font-semibold text-blue-300 uppercase tracking-wider mb-2">{group.category}</p>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                                {group.options.map(opt => {
                                                    const checked = profileForm.load_types.includes(opt.value);
                                                    return (
                                                        <label
                                                            key={opt.value}
                                                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
                                                                checked
                                                                    ? 'bg-blue-500/15 border border-blue-500/30 text-blue-200'
                                                                    : 'bg-slate-900 border border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                                                            }`}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={checked}
                                                                onChange={() => toggleLoadType(opt.value)}
                                                                className="w-3.5 h-3.5 rounded accent-blue-500"
                                                            />
                                                            <span className="truncate">{opt.label}</span>
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Free-text description for anything not in the catalog */}
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-2">Additional Notes</label>
                                <textarea
                                    value={profileForm.load_description}
                                    onChange={e => setProfileForm(f => ({ ...f, load_description: e.target.value }))}
                                    rows={3}
                                    placeholder="e.g. 'Main incomer feeds 2 × 11 kW DOL motors driving conveyors, 6 × 4 kW VFD-controlled fans, plus 80 kW of LED lighting. Bakery oven runs 04:00–11:00.'"
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                                />
                                <p className="text-[11px] text-slate-500 mt-1">
                                    Anything not in the catalog above — load sizes, operating hours, recent changes.
                                    The more you tell the AI, the more specific the recommendations.
                                </p>
                            </div>

                            <div className="flex justify-end gap-3 pt-2 border-t border-slate-800">
                                <button type="button" onClick={() => setEditingMeter(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white">
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={savingProfile}
                                    className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
                                >
                                    {savingProfile
                                        ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
                                        : <><Save className="h-4 w-4" /> Save Load Profile</>
                                    }
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
