"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/Card";
import { Save, Zap, Loader2, Building2 } from "lucide-react";

export default function TariffsPage() {
    const [sites, setSites] = useState<any[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState<string>("");

    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(true);

    const [tariff, setTariff] = useState({
        rates: {
            peak: 0,
            standard: 0,
            offPeak: 0,
        },
        times: {
            peak: "",
            standard: "",
            offPeak: "",
        }
    });

    const token = () => localStorage.getItem('token') || '';

    // Fetch sites on mount
    useEffect(() => {
        const fetchSites = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/sites', {
                    headers: { Authorization: `Bearer ${token()}` }
                });
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) {
                    setSites(data);
                    setSelectedSiteId(data[0].id);
                }
            } catch (err) {
                console.error("Failed to load sites", err);
            } finally {
                setLoading(false);
            }
        };
        fetchSites();
    }, []);

    // Fetch settings when site changes
    useEffect(() => {
        if (!selectedSiteId) return;

        const fetchSettings = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/sites/${selectedSiteId}/settings`, {
                    headers: { Authorization: `Bearer ${token()}` }
                });
                const data = await res.json();
                setTariff({
                    rates: {
                        peak: Number(data.tariff_peak) || 0,
                        standard: Number(data.tariff_standard) || 0,
                        offPeak: Number(data.tariff_offpeak) || 0,
                    },
                    times: {
                        peak: data.peak_times || "",
                        standard: data.standard_times || "",
                        offPeak: data.offpeak_times || "",
                    }
                });
            } catch (err) {
                console.error("Failed to load tariff settings", err);
            }
        };

        fetchSettings();
    }, [selectedSiteId]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedSiteId) return;

        setSaving(true);
        setSuccess(false);
        try {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/ingestion/sites/${selectedSiteId}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token()}`
                },
                body: JSON.stringify({
                    tariff_peak: tariff.rates.peak,
                    tariff_standard: tariff.rates.standard,
                    tariff_offpeak: tariff.rates.offPeak,
                    peak_times: tariff.times.peak,
                    standard_times: tariff.times.standard,
                    offpeak_times: tariff.times.offPeak
                })
            });
            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
        } catch (err) {
            console.error("Failed to save settings", err);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div className="flex h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-500" /></div>;
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-500 max-w-4xl">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">Tariff Configuration</h1>
                <p className="text-slate-400 mt-2">
                    Set your local energy rates per site to ensure accurate savings calculations across the platform.
                </p>
            </div>

            {sites.length === 0 ? (
                <Card className="p-6">
                    <p className="text-slate-400 text-center">Please create a Site first before configuring tariffs.</p>
                </Card>
            ) : (
                <form onSubmit={handleSave} className="space-y-6">
                    <Card className="p-6 border-blue-500/20 bg-blue-500/5">
                        <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-blue-400" />
                            Select Site to Configure
                        </label>
                        <select
                            value={selectedSiteId}
                            onChange={(e) => setSelectedSiteId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                        >
                            {sites.map(site => (
                                <option key={site.id} value={site.id}>{site.name}</option>
                            ))}
                        </select>
                    </Card>

                    <Card className="p-6">
                        <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                            <Zap className="h-5 w-5 text-yellow-500" />
                            Energy Rates (R/kWh)
                        </h3>
                        <div className="grid gap-6 md:grid-cols-3">
                            <div>
                                <label className="block text-sm font-medium text-red-400 mb-1">Peak Rate</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={tariff.rates.peak}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, peak: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-500/50"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-yellow-400 mb-1">Standard Rate</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={tariff.rates.standard}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, standard: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-emerald-400 mb-1">Off-Peak Rate</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={tariff.rates.offPeak}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, offPeak: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="mt-8">
                            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                                <Zap className="h-5 w-5 text-blue-400" />
                                Time Schedules
                            </h3>
                            <p className="text-sm text-slate-400 mb-6">Define the active hours for each tariff period (e.g. &quot;Weekdays 07:00-10:00, 18:00-20:00&quot;).</p>
                            <div className="grid gap-6 md:grid-cols-3">
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-1">Peak Times</label>
                                    <input
                                        type="text"
                                        placeholder="06:00 - 09:00, 17:00 - 19:00"
                                        value={tariff.times.peak}
                                        onChange={e => setTariff(t => ({ ...t, times: { ...t.times, peak: e.target.value } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-1">Standard Times</label>
                                    <input
                                        type="text"
                                        placeholder="09:00 - 17:00, 19:00 - 22:00"
                                        value={tariff.times.standard}
                                        onChange={e => setTariff(t => ({ ...t, times: { ...t.times, standard: e.target.value } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-1">Off-Peak Times</label>
                                    <input
                                        type="text"
                                        placeholder="22:00 - 06:00"
                                        value={tariff.times.offPeak}
                                        onChange={e => setTariff(t => ({ ...t, times: { ...t.times, offPeak: e.target.value } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    />
                                </div>
                            </div>
                        </div>
                    </Card>

                    <div className="flex items-center gap-4">
                        <button
                            type="submit"
                            disabled={saving}
                            className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all"
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save Configuration
                        </button>
                        {success && (
                            <span className="text-emerald-400 text-sm font-medium animate-in fade-in flex items-center gap-2">
                                Settings saved successfully!
                            </span>
                        )}
                    </div>
                </form>
            )}
        </div>
    );
}
