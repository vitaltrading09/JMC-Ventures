"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/Card";
import { Save, AlertCircle, Loader2, Building2 } from "lucide-react";

export default function AlertsPage() {
    const [sites, setSites] = useState<any[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState<string>("");

    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(true);

    const [alerts, setAlerts] = useState({
        maxPeak: 0,
        minVoltage: 0,
        maxThd: 0,
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
                setAlerts({
                    maxPeak: Number(data.alert_max_kw) || 0,
                    minVoltage: Number(data.alert_min_v) || 0,
                    maxThd: Number(data.alert_max_thd) || 0,
                });
            } catch (err) {
                console.error("Failed to load alert settings", err);
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
                    alert_max_kw: alerts.maxPeak,
                    alert_min_v: alerts.minVoltage,
                    alert_max_thd: alerts.maxThd
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
        return <div className="flex h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-red-500" /></div>;
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-500 max-w-4xl">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">Alert Thresholds</h1>
                <p className="text-slate-400 mt-2">
                    Set up custom threshold limits for each site to trigger predictive maintenance alerts.
                </p>
            </div>

            {sites.length === 0 ? (
                <Card className="p-6">
                    <p className="text-slate-400 text-center">Please create a Site first before configuring alerts.</p>
                </Card>
            ) : (
                <form onSubmit={handleSave} className="space-y-6">
                    <Card className="p-6 border-red-500/20 bg-red-500/5">
                        <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-red-400" />
                            Select Site to Configure
                        </label>
                        <select
                            value={selectedSiteId}
                            onChange={(e) => setSelectedSiteId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors"
                        >
                            {sites.map(site => (
                                <option key={site.id} value={site.id}>{site.name}</option>
                            ))}
                        </select>
                    </Card>

                    <Card className="p-6">
                        <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-red-500" />
                            Threshold Limits
                        </h3>
                        <div className="grid gap-6 md:grid-cols-3">
                            <div>
                                <label className="block text-sm font-medium text-orange-400 mb-1 flex items-center gap-2">Max Peak Demand (kW)</label>
                                <input
                                    type="number"
                                    step="1"
                                    value={alerts.maxPeak}
                                    onChange={e => setAlerts(t => ({ ...t, maxPeak: Number(e.target.value) }))}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                                />
                                <p className="text-xs text-slate-500 mt-2">Triggers if site total power exceeds limit.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-purple-400 mb-1">Min Voltage Sag (V)</label>
                                <input
                                    type="number"
                                    step="1"
                                    value={alerts.minVoltage}
                                    onChange={e => setAlerts(t => ({ ...t, minVoltage: Number(e.target.value) }))}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                                />
                                <p className="text-xs text-slate-500 mt-2">Triggers grid instability warnings.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-rose-400 mb-1">Max THD (%)</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={alerts.maxThd}
                                    onChange={e => setAlerts(t => ({ ...t, maxThd: Number(e.target.value) }))}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                                />
                                <p className="text-xs text-slate-500 mt-2">Total Harmonic Distortion alerts.</p>
                            </div>
                        </div>
                    </Card>

                    <div className="flex items-center gap-4">
                        <button
                            type="submit"
                            disabled={saving}
                            className="flex items-center gap-2 px-6 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-red-600/50 text-white rounded-lg font-medium shadow-[0_0_15px_rgba(220,38,38,0.3)] transition-all"
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save Thresholds
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
