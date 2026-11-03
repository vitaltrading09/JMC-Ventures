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

    // SA Megaflex default schedule — what the AI recommendations engine uses
    // when peak_times is empty. Pre-fill the form so the user can either accept
    // them by clicking Save, or edit them. Stops the form from showing only
    // greyed-out placeholder text that looks identical to real values.
    const DEFAULT_TIMES = {
        peak:     "07:00 - 10:00, 18:00 - 20:00",
        standard: "06:00 - 07:00, 10:00 - 18:00, 20:00 - 22:00",
        offPeak:  "22:00 - 06:00",
    };

    const [tariff, setTariff] = useState({
        rates: {
            peak: 0,
            standard: 0,
            offPeak: 0,
            demand: 0,
        },
        times: { ...DEFAULT_TIMES },
    });
    // Track whether the times in the form came from the DB or from defaults —
    // surfaces a "using defaults" banner so the user knows to hit Save.
    const [timesAreDefaults, setTimesAreDefaults] = useState(true);


    // Fetch sites on mount
    useEffect(() => {
        const fetchSites = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/sites`, {
                    credentials: 'include',
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
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/sites/${selectedSiteId}/settings`, {
                    credentials: 'include',
                });
                const data = await res.json();
                // If any time field is filled in the DB, use the DB values verbatim.
                // Otherwise pre-fill SA defaults and flag the form as "unsaved defaults".
                const hasAnySavedTime = !!(data.peak_times || data.standard_times || data.offpeak_times);
                setTariff({
                    rates: {
                        peak:     Number(data.tariff_peak)     || 0,
                        standard: Number(data.tariff_standard) || 0,
                        offPeak:  Number(data.tariff_offpeak)  || 0,
                        demand:   Number(data.tariff_demand)   || 0,
                    },
                    times: hasAnySavedTime ? {
                        peak:     data.peak_times     || DEFAULT_TIMES.peak,
                        standard: data.standard_times || DEFAULT_TIMES.standard,
                        offPeak:  data.offpeak_times  || DEFAULT_TIMES.offPeak,
                    } : { ...DEFAULT_TIMES },
                });
                setTimesAreDefaults(!hasAnySavedTime);
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
            await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/sites/${selectedSiteId}/settings`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tariff_peak:     tariff.rates.peak     || null,
                    tariff_standard: tariff.rates.standard || null,
                    tariff_offpeak:  tariff.rates.offPeak  || null,
                    tariff_demand:   tariff.rates.demand   || null,
                    // Times: always send what's in the form. They're guaranteed
                    // to be populated (DB value or SA default), so the AI engine
                    // always has a valid TOU schedule to reason about.
                    peak_times:      tariff.times.peak     || DEFAULT_TIMES.peak,
                    standard_times:  tariff.times.standard || DEFAULT_TIMES.standard,
                    offpeak_times:   tariff.times.offPeak  || DEFAULT_TIMES.offPeak,
                })
            });
            setSuccess(true);
            setTimesAreDefaults(false); // user has explicitly persisted them now
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
                        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <label className="block text-sm font-medium text-red-400 mb-1">Peak Rate</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        placeholder="5.00"
                                        value={tariff.rates.peak || ""}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, peak: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-500/50"
                                    />
                                </div>
                                <p className="text-xs text-slate-500 mt-1">R/kWh during peak hours</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-yellow-400 mb-1">Standard Rate</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        placeholder="2.00"
                                        value={tariff.rates.standard || ""}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, standard: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                                    />
                                </div>
                                <p className="text-xs text-slate-500 mt-1">R/kWh during standard hours</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-emerald-400 mb-1">Off-Peak Rate</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        placeholder="1.20"
                                        value={tariff.rates.offPeak || ""}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, offPeak: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                                <p className="text-xs text-slate-500 mt-1">R/kWh during off-peak hours</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-blue-400 mb-1">Demand Charge</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">R</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        placeholder="e.g. 80.00"
                                        value={tariff.rates.demand || ""}
                                        onChange={e => setTariff(t => ({ ...t, rates: { ...t.rates, demand: Number(e.target.value) } }))}
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                    />
                                </div>
                                <p className="text-xs text-slate-500 mt-1">R/kVA monthly MDI charge</p>
                            </div>
                        </div>

                        <div className="mt-8">
                            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                                <Zap className="h-5 w-5 text-blue-400" />
                                Time Schedules
                            </h3>
                            <p className="text-sm text-slate-400 mb-3">Define the active hours for each tariff period (e.g. &quot;Weekdays 07:00-10:00, 18:00-20:00&quot;).</p>
                            {timesAreDefaults && (
                                <div className="mb-5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2">
                                    <span className="font-semibold uppercase tracking-wide text-[10px] bg-amber-500/20 px-1.5 py-0.5 rounded text-amber-300 shrink-0 mt-0.5">UNSAVED</span>
                                    <span>
                                        These times are pre-filled with the standard SA Megaflex schedule but have <strong>not been saved</strong> for this site yet.
                                        Edit them if your utility uses different hours, then click <strong>Save Configuration</strong> below so the AI recommendations engine uses them.
                                    </span>
                                </div>
                            )}
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
