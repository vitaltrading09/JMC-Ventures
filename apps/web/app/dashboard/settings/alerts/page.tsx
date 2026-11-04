"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/Card";
import { Save, AlertCircle, Loader2, Building2 } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL;

export default function AlertsPage() {
    const [sites, setSites] = useState<any[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState<string>("");
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(true);

    const [alerts, setAlerts] = useState({
        maxPeak:        "",
        minVoltage:     "",
        maxVoltage:     "",
        maxThd:         "",
        minFreq:        "",
        maxFreq:        "",
        contractedMdi:  "",
    });


    useEffect(() => {
        fetch(`${API}/ingestion/sites`, { credentials: 'include' })
            .then(r => r.json())
            .then((data: any[]) => {
                if (Array.isArray(data) && data.length > 0) {
                    setSites(data);
                    setSelectedSiteId(data[0].id);
                }
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!selectedSiteId) return;
        fetch(`${API}/ingestion/sites/${selectedSiteId}/settings`, { credentials: 'include' })
            .then(r => r.json())
            .then(data => {
                setAlerts({
                    maxPeak:       data.alert_max_kw        != null ? String(data.alert_max_kw)        : "",
                    minVoltage:    data.alert_min_v         != null ? String(data.alert_min_v)         : "",
                    maxVoltage:    data.alert_max_v         != null ? String(data.alert_max_v)         : "",
                    maxThd:        data.alert_max_thd       != null ? String(data.alert_max_thd)       : "",
                    minFreq:       data.alert_min_freq      != null ? String(data.alert_min_freq)      : "",
                    maxFreq:       data.alert_max_freq      != null ? String(data.alert_max_freq)      : "",
                    contractedMdi: data.contracted_mdi_kva  != null ? String(data.contracted_mdi_kva)  : "",
                });
            })
            .catch(console.error);
    }, [selectedSiteId]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedSiteId) return;
        setSaving(true);
        setSuccess(false);
        try {
            const toNum = (v: string) => v !== "" ? Number(v) : null;
            await fetch(`${API}/ingestion/sites/${selectedSiteId}/settings`, {
                method: "POST",
                credentials: 'include',
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    alert_max_kw:       toNum(alerts.maxPeak),
                    alert_min_v:        toNum(alerts.minVoltage),
                    alert_max_v:        toNum(alerts.maxVoltage),
                    alert_max_thd:      toNum(alerts.maxThd),
                    alert_min_freq:     toNum(alerts.minFreq),
                    alert_max_freq:     toNum(alerts.maxFreq),
                    contracted_mdi_kva: toNum(alerts.contractedMdi),
                }),
            });
            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
        } catch (err) {
            console.error("Failed to save settings", err);
        } finally {
            setSaving(false);
        }
    };

    const field = (
        label: string,
        key: keyof typeof alerts,
        unit: string,
        placeholder: string,
        hint: string,
        color: string,
        step = "1"
    ) => (
        <div>
            <label className={`block text-sm font-medium mb-1 ${color}`}>{label}</label>
            <div className="relative">
                <input
                    type="number"
                    step={step}
                    placeholder={placeholder}
                    value={alerts[key]}
                    onChange={e => setAlerts(a => ({ ...a, [key]: e.target.value }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-500/50 pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">{unit}</span>
            </div>
            <p className="text-xs text-slate-500 mt-1.5">{hint}</p>
        </div>
    );

    if (loading) return <div className="flex h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-red-500" /></div>;

    return (
        <div className="space-y-6 animate-in fade-in duration-500 max-w-4xl">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">Alert Thresholds</h1>
                <p className="text-slate-400 mt-2">
                    NRS 048-2 compliant thresholds for voltage quality, demand, and power quality alerts.
                    Leave a field blank to use the NRS 048 default. Voltage and THD limits are compared with 10-minute values, demand limits with 30-minute averages.
                </p>
            </div>

            {sites.length === 0 ? (
                <Card className="p-6">
                    <p className="text-slate-400 text-center">Please create a Site first before configuring alerts.</p>
                </Card>
            ) : (
                <form onSubmit={handleSave} className="space-y-6">
                    {/* Site selector */}
                    <Card className="p-6 border-red-500/20 bg-red-500/5">
                        <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-red-400" />
                            Select Site to Configure
                        </label>
                        <select
                            value={selectedSiteId}
                            onChange={e => setSelectedSiteId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors"
                        >
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </Card>

                    {/* Demand / MDI */}
                    <Card className="p-6">
                        <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-orange-400" />
                            Demand Limits
                        </h3>
                        <div className="grid gap-6 md:grid-cols-2">
                            {field("Max Peak Demand", "maxPeak", "kW", "e.g. 500",
                                "Alert if active power exceeds this threshold — demand charge risk.", "text-orange-400")}
                            {field("Contracted MDI", "contractedMdi", "kVA", "e.g. 630",
                                "Warning at 90%, CRITICAL at 100% of contracted maximum demand indicator.", "text-red-400")}
                        </div>
                    </Card>

                    {/* Voltage */}
                    <Card className="p-6">
                        <h3 className="text-lg font-medium text-white mb-1 flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-purple-400" />
                            Voltage Limits <span className="text-xs font-normal text-slate-500 ml-2">NRS 048-2 defaults: 207 V / 253 V (230 V ± 10%)</span>
                        </h3>
                        <p className="text-xs text-slate-500 mb-4">These are L-N (phase-to-neutral) voltages. AXM-WEB2 reports V1 as L-N.</p>
                        <div className="grid gap-6 md:grid-cols-2">
                            {field("Min Voltage (Sag)", "minVoltage", "V", "207 (NRS 048 default)",
                                "CRITICAL alert when L1 voltage drops below this.", "text-purple-400")}
                            {field("Max Voltage (Swell)", "maxVoltage", "V", "253 (NRS 048 default)",
                                "CRITICAL alert when L1 voltage rises above this.", "text-violet-400")}
                        </div>
                    </Card>

                    {/* Power quality */}
                    <Card className="p-6">
                        <h3 className="text-lg font-medium text-white mb-1 flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-rose-400" />
                            Power Quality <span className="text-xs font-normal text-slate-500 ml-2">NRS 048-2 defaults: THD 8%, Freq 49–51 Hz</span>
                        </h3>
                        <div className="grid gap-6 md:grid-cols-3 mt-4">
                            {field("Max THD Voltage", "maxThd", "%", "8 (NRS 048 default)",
                                "Harmonic distortion alert. NRS 048-2 limit is 8%.", "text-rose-400", "0.1")}
                            {field("Min Frequency", "minFreq", "Hz", "49 (NRS 048 default)",
                                "Alert on under-frequency (grid instability).", "text-sky-400", "0.1")}
                            {field("Max Frequency", "maxFreq", "Hz", "51 (NRS 048 default)",
                                "Alert on over-frequency (generator runaway).", "text-cyan-400", "0.1")}
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
                            <span className="text-emerald-400 text-sm font-medium animate-in fade-in">
                                Settings saved successfully!
                            </span>
                        )}
                    </div>
                </form>
            )}
        </div>
    );
}
