"use client";

import { useEffect, useState, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import { ArrowLeft, Zap, Loader2, BarChart2 } from "lucide-react";
import Link from "next/link";
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Brush, Legend,
} from "recharts";
import { MeasurementChart } from "@/components/charts/MeasurementChart";

interface Meter {
    id: string; name: string; model: string; serial_number: string; site_id: string;
}

export default function SiteDetailsPage({ params }: { params: { id: string } }) {
    const [meter,       setMeter]       = useState<Meter | null>(null);
    const [readings,    setReadings]    = useState<any[]>([]);
    const [loading,     setLoading]     = useState(true);
    const [activeTab,   setActiveTab]   = useState<'chart' | 'simulation'>('chart');

    // Simulation state
    const [systemConfig, setSystemConfig] = useState({ solarKw: 0, batteryKwh: 0, batteryPowerKw: 0 });

    const API   = process.env.NEXT_PUBLIC_API_URL;

    // Fetch meter info once
    useEffect(() => {
        fetch(`${API}/ingestion/meters`, { credentials: 'include' })
            .then(r => r.json())
            .then((all: Meter[]) => { setMeter(all.find(m => m.id === params.id) || null); setLoading(false); })
            .catch(() => setLoading(false));
    }, [params.id]);

    // The chart (components/charts/MeasurementChart.tsx) loads by meter here.
    const load = useCallback(async (fromDate: string, toDate: string) => {
        const url = `${API}/ingestion/meters/${params.id}/readings?from=${fromDate}T00:00:00&to=${toDate}T23:59:59&limit=2000`;
        const res = await fetch(url, { credentials: 'include' });
        return { rows: res.ok ? await res.json() : [], basis: res.headers.get('X-Readings-Source') };
    }, [params.id]);

    const latest  = readings.length ? readings[readings.length - 1] : null;

    // Simulation helpers
    const getTariff = (h: number) => ((h >= 7 && h < 10) || (h >= 18 && h < 20)) ? 5.80 : (h >= 6 && h < 22) ? 2.20 : 1.40;
    const runSim = () => {
        const base = latest?.power_active_total || 500;
        let soc = 0.5; const out: any[] = []; let savings = 0; let solar = 0;
        for (let h = 0; h < 24; h++) {
            const load = base * (0.8 + 0.4 * Math.sin((h - 10) * Math.PI / 12)) * (h >= 18 && h <= 20 ? 1.3 : 1);
            const pv   = h > 6 && h < 18 ? systemConfig.solarKw * Math.sin((h - 6) * Math.PI / 12) * 0.8 : 0;
            const net  = load - pv;
            const t    = getTariff(h);
            let grid   = net;
            if (net > 0 && systemConfig.batteryKwh > 0 && soc > 0.2) {
                const d = Math.min(net, systemConfig.batteryPowerKw, (soc - 0.2) * systemConfig.batteryKwh);
                soc -= d / systemConfig.batteryKwh; grid = net - d;
            } else if (net < 0 && systemConfig.batteryKwh > 0 && soc < 1) {
                const c = Math.min(-net, systemConfig.batteryPowerKw, (1 - soc) * systemConfig.batteryKwh);
                soc += c / systemConfig.batteryKwh; grid = 0;
            }
            savings += (load - grid) * t; solar += pv;
            out.push({ time: `${h}:00`, baseline_kw: load, grid_load_kw: Math.max(0, grid), solar_kw: pv, battery_soc: soc * 100 });
        }
        return { simData: out, totalSavings: savings, totalSolarGen: solar };
    };
    const { simData, totalSavings, totalSolarGen } = runSim();

    if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>;
    if (!meter)  return <div className="text-slate-400 text-center py-20">Meter not found.</div>;

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div>
                <Link href="/portal/projects" className="inline-flex items-center text-sm text-slate-400 hover:text-white mb-4 transition-colors">
                    <ArrowLeft className="mr-2 h-4 w-4" /> Back to projects
                </Link>
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                            {meter.name}
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${readings.length > 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-700 text-slate-400 border-slate-600'}`}>
                                {readings.length > 0 ? `${readings.length} readings` : 'No data'}
                            </span>
                        </h1>
                        <p className="text-slate-400 text-sm mt-1">{meter.model} · SN: {meter.serial_number}</p>
                    </div>
                    <div className="bg-slate-900 p-1 rounded-lg flex text-sm font-medium border border-slate-800">
                        <button onClick={() => setActiveTab('chart')} className={`px-4 py-1.5 rounded-md transition-all ${activeTab === 'chart' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                            <span className="flex items-center gap-1.5"><BarChart2 className="w-3.5 h-3.5" /> Chart</span>
                        </button>
                        <button onClick={() => setActiveTab('simulation')} className={`px-4 py-1.5 rounded-md transition-all ${activeTab === 'simulation' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>
                            <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Simulation</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Kept mounted on the simulation tab, so the range and readings stay. */}
            <div className={activeTab === 'chart' ? '' : 'hidden'}>
                <MeasurementChart title={meter.name} load={load} onReadings={setReadings} />
            </div>

            {activeTab === 'simulation' && (
                <div className="space-y-6">
                    <Card className="p-6">
                        <div className="flex flex-col md:flex-row justify-between gap-6 items-end">
                            <div className="flex gap-6 flex-wrap">
                                <div><label className="text-xs text-slate-400 mb-1 block">PV Size (kWp)</label>
                                    <input type="number" className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white w-32"
                                        value={systemConfig.solarKw} onChange={e => setSystemConfig(p => ({ ...p, solarKw: Number(e.target.value) }))} /></div>
                                <div><label className="text-xs text-slate-400 mb-1 block">Battery (kWh)</label>
                                    <input type="number" className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white w-32"
                                        value={systemConfig.batteryKwh} onChange={e => setSystemConfig(p => ({ ...p, batteryKwh: Number(e.target.value) }))} /></div>
                                <div><label className="text-xs text-slate-400 mb-1 block">Battery Power (kW)</label>
                                    <input type="number" className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white w-32"
                                        value={systemConfig.batteryPowerKw} onChange={e => setSystemConfig(p => ({ ...p, batteryPowerKw: Number(e.target.value) }))} /></div>
                            </div>
                            <div className="text-right">
                                <p className="text-xs text-slate-400">Est. Daily Savings</p>
                                <p className="text-3xl font-bold text-emerald-400">R {totalSavings.toFixed(0)}</p>
                                <button onClick={() => {
                                    const peak = Math.max(...readings.map(r => r.power_active_total || 0), 100);
                                    const avg  = readings.reduce((a: number, r: any) => a + (r.power_active_total || 0), 0) / (readings.length || 1);
                                    setSystemConfig({ solarKw: Math.ceil(peak * 1.2), batteryKwh: Math.ceil(avg * 4), batteryPowerKw: Math.ceil(peak) });
                                }} className="mt-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg flex items-center gap-1.5 ml-auto">
                                    <Zap className="w-3 h-3" /> Auto-size from data
                                </button>
                            </div>
                        </div>
                    </Card>

                    <div className="grid gap-4 md:grid-cols-3">
                        <Card className="p-4"><p className="text-xs text-slate-500">Solar Yield</p><p className="text-2xl font-bold text-yellow-400 mt-1">{totalSolarGen.toFixed(0)} kWh/day</p></Card>
                        <Card className="p-4"><p className="text-xs text-slate-500">Monthly Est. Savings</p><p className="text-2xl font-bold text-emerald-400 mt-1">R {(totalSavings * 30).toLocaleString()}</p></Card>
                        <Card className="p-4"><p className="text-xs text-slate-500">Base Load (latest)</p><p className="text-2xl font-bold text-white mt-1">{(latest?.power_active_total || 0).toFixed(0)} kW</p></Card>
                    </div>

                    <Card className="p-5 h-96">
                        <h3 className="font-semibold text-white mb-4">24h Simulation — {meter.name}</h3>
                        <ResponsiveContainer width="100%" height="90%">
                            <LineChart data={simData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis dataKey="time" stroke="#475569" fontSize={11} tickLine={false} />
                                <YAxis yAxisId="l" stroke="#475569" fontSize={11} tickLine={false} unit=" kW" />
                                <YAxis yAxisId="r" orientation="right" stroke="#10b981" fontSize={11} tickLine={false} unit="%" />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '0.5rem' }} />
                                <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }} />
                                <Line yAxisId="l" type="monotone" dataKey="baseline_kw" stroke="#64748b" strokeWidth={2} strokeDasharray="5 5" name="Baseline" dot={false} />
                                <Line yAxisId="l" type="monotone" dataKey="grid_load_kw" stroke="#3b82f6" strokeWidth={2} name="Grid Import" dot={false} />
                                <Line yAxisId="l" type="monotone" dataKey="solar_kw" stroke="#eab308" strokeWidth={2} name="Solar" dot={false} />
                                <Line yAxisId="r" type="monotone" dataKey="battery_soc" stroke="#10b981" strokeWidth={2} name="Battery SoC %" dot={false} />
                                <Brush dataKey="time" height={24} stroke="#334155" fill="#0f172a" tickFormatter={() => ''} />
                            </LineChart>
                        </ResponsiveContainer>
                    </Card>
                </div>
            )}
        </div>
    );
}
