"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import {
    ArrowLeft,
    Activity,
    Zap,
    DollarSign,
    Battery,
    Loader2
} from "lucide-react";
import Link from "next/link";
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";

interface Meter {
    id: string;
    name: string;
    model: string;
    serial_number: string;
    site_id: string;
    created_at: string;
}

interface Reading {
    timestamp: string;
    time: string; // Added for frontend mapping
    energy_kwh: number;
    power_kw: number;
    voltage_v: number;
    current_a: number;
    frequency_hz: number;
    power_factor: number;
}

export default function SiteDetailsPage({ params }: { params: { id: string } }) {
    const [meter, setMeter] = useState<Meter | null>(null);
    const [readings, setReadings] = useState<Reading[]>([]);
    const [activeTab, setActiveTab] = useState<'overview' | 'savings'>('overview');
    const [loading, setLoading] = useState(true);

    // System Configuration State
    const [systemConfig, setSystemConfig] = useState({
        solarKw: 0,
        batteryKwh: 0,
        batteryPowerKw: 0,
        isAutosized: false
    });

    useEffect(() => {
        async function fetchData() {
            try {
                // 1. Fetch Meter Details
                const metersRes = await fetch('http://localhost:8081/ingestion/meters');
                const metersData = await metersRes.json();
                const foundMeter = metersData.find((m: Meter) => m.id === params.id);
                setMeter(foundMeter || null);

                // 2. Fetch Readings
                const readingsRes = await fetch(`http://localhost:8081/ingestion/meters/${params.id}/readings`);
                const readingsData = await readingsRes.json();

                // Format for Chart
                const formattedReadings = readingsData.slice(0, 50).reverse().map((r: any) => ({
                    time: new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    power_kw: r.power_active_total,
                    voltage_v: r.voltage_a,
                    current_a: r.current_a,
                    energy_kwh: r.energy_total,
                    frequency_hz: 50,
                    power_factor: 0.95
                }));
                setReadings(formattedReadings);
                setLoading(false); // Move setLoading here to prevent flash

            } catch (err) {
                console.error("Failed to fetch site data:", err);
                setLoading(false);
            }
        }

        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
    }, [params.id]);

    // --- Sizing & Simulation Logic ---

    // 1. Tariff Structure (Ekurhuleni TOU Mock)
    const getTariff = (hour: number) => {
        // Peak: 07-10, 18-20 (High Rate)
        if ((hour >= 7 && hour < 10) || (hour >= 18 && hour < 20)) return 5.80;
        // Standard: 06-07, 10-18, 20-22 (Std Rate)
        if ((hour >= 6 && hour < 7) || (hour >= 10 && hour < 18) || (hour >= 20 && hour < 22)) return 2.20;
        // Off-Peak: 22-06 (Low Rate)
        return 1.40;
    };

    // 2. Auto-Size Recommendation
    const handleAutoSize = () => {
        if (readings.length === 0) return;

        // Find Peak Load from recent history to size Inverter/Solar
        const peakLoadKw = Math.max(...readings.map(r => r.power_kw));
        const avgLoadKw = readings.reduce((a, b) => a + b.power_kw, 0) / readings.length;

        // Simple Heuristics:
        // Solar: 1.2x Peak Load (to cover load + charge battery)
        // Battery: 4 hours of Average Load (to cover the 18-20 peak + some night)

        setSystemConfig({
            solarKw: Math.ceil(peakLoadKw * 1.2),
            batteryKwh: Math.ceil(avgLoadKw * 4),
            batteryPowerKw: Math.ceil(peakLoadKw), // 1C discharge ideally
            isAutosized: true
        });
    };

    // 3. Run Simulation (24h Profile based on Avg Load)
    // We create a synthetic 24h profile because 'readings' might only be a few minutes.
    const runSimulation = () => {
        const hasData = readings.length > 0;
        const baseLoad = hasData ? readings[readings.length - 1].power_kw : 500; // Use latest or default

        let batterySoC = 0.5; // Start at 50%
        const simData = [];
        let totalSavings = 0;
        let totalSolarGen = 0;

        for (let hour = 0; hour < 24; hour++) {
            // Mock Load Profile (Bell curve peaking in day + evening spike)
            let hourlyLoad = baseLoad * (0.8 + 0.4 * Math.sin((hour - 10) * Math.PI / 12));
            if (hour >= 18 && hour <= 20) hourlyLoad *= 1.3; // Evening Peak

            // Solar Curve (Parabolic 6am-6pm)
            let solarGen = 0;
            if (hour > 6 && hour < 18) {
                const efficiency = 0.8; // System losses
                solarGen = systemConfig.solarKw * Math.sin((hour - 6) * Math.PI / 12) * efficiency;
            }

            // Battery Logic
            let gridImport = 0;
            let batteryAction = 0; // +Charge, -Discharge
            const tariff = getTariff(hour);

            const netLoad = hourlyLoad - solarGen;

            if (netLoad > 0) {
                // Deficit: Try discharge batter (if tariff is high or always?)
                // Strategy: Arbitrage. Discharge during PEAK (High Tariff).
                const isHighTariff = tariff > 3.0; // Simple check

                if (systemConfig.batteryKwh > 0 && batterySoC > 0.2) { // Min 20% SoC
                    // Discharge allowed
                    const maxDischarge = systemConfig.batteryPowerKw;
                    const needed = netLoad;
                    const available = (batterySoC - 0.2) * systemConfig.batteryKwh;

                    const actualDischarge = Math.min(needed, maxDischarge, available);
                    batteryAction = -actualDischarge;
                    batterySoC -= actualDischarge / systemConfig.batteryKwh;
                    gridImport = netLoad - actualDischarge;
                } else {
                    gridImport = netLoad;
                }
            } else {
                // Surplus: Charge battery
                const surplus = -netLoad;
                if (systemConfig.batteryKwh > 0 && batterySoC < 1.0) {
                    const maxCharge = systemConfig.batteryPowerKw;
                    const space = (1.0 - batterySoC) * systemConfig.batteryKwh;
                    const actualCharge = Math.min(surplus, maxCharge, space);

                    batteryAction = actualCharge;
                    batterySoC += actualCharge / systemConfig.batteryKwh;
                    gridImport = 0; // Export? Assuming 0 export for now or net metering 0
                }
            }

            // Financials
            const baselineCost = hourlyLoad * tariff;
            const newCost = gridImport * tariff;
            const savings = baselineCost - newCost;

            totalSavings += savings;
            totalSolarGen += solarGen;

            simData.push({
                time: `${hour}:00`,
                baseline_kw: hourlyLoad,
                grid_load_kw: gridImport,
                solar_kw: solarGen,
                battery_soc: batterySoC * 100,
                tariff_r: tariff,
                savings_r: savings
            });
        }

        return { simData, totalSavings, totalSolarGen };
    };

    const { simData, totalSavings, totalSolarGen } = runSimulation();

    // Latest Metrics for Header (Overview)
    const latestReading = readings.length > 0 ? readings[readings.length - 1] : null;

    if (loading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin text-blue-500" /></div>;
    if (!meter) return <div>Meter not found</div>;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div>
                <Link href="/dashboard/sites" className="inline-flex items-center text-sm text-slate-400 hover:text-white mb-4 transition-colors">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back to Sites
                </Link>
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
                            {meter.name}
                            <span className="text-sm font-medium px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                Online
                            </span>
                        </h1>
                        <p className="text-slate-400 mt-2">{meter.model} • SN: {meter.serial_number}</p>
                    </div>
                    <div className="bg-slate-900 p-1 rounded-lg flex text-sm font-medium">
                        <button onClick={() => setActiveTab('overview')} className={`px-4 py-2 rounded-md transition-all ${activeTab === 'overview' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`}>Overview</button>
                        <button onClick={() => setActiveTab('savings')} className={`px-4 py-2 rounded-md transition-all ${activeTab === 'savings' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>Simulation & ROI</button>
                    </div>
                </div>
            </div>

            {activeTab === 'overview' ? (
                // Reuse existing Overview UI (simplified for brevity in this replacement, keeping core stats)
                <div className="grid gap-6 md:grid-cols-4">
                    <Card>
                        <CardHeader title="Real-time Power" icon={Zap} />
                        <div className="mt-2 text-2xl font-bold text-white">{latestReading?.power_kw.toFixed(2) ?? 0} kW</div>
                    </Card>
                    <Card>
                        <CardHeader title="Voltage" icon={Activity} />
                        <div className="mt-2 text-2xl font-bold text-white">{latestReading?.voltage_v.toFixed(1) ?? 0} V</div>
                    </Card>
                    {/* Add charts back if needed, focusing on Sizing part mostly now */}
                    <Card className="md:col-span-4 h-[400px]">
                        <CardHeader title="Live Power Trace" />
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={readings}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                                <XAxis dataKey="time" stroke="#64748b" />
                                <YAxis stroke="#64748b" />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a' }} />
                                <Line type="monotone" dataKey="power_kw" stroke="#3b82f6" strokeWidth={2} />
                            </LineChart>
                        </ResponsiveContainer>
                    </Card>
                </div>
            ) : (
                <div className="space-y-6">
                    {/* Simulation Controls */}
                    <Card className="p-6 border-blue-500/20 bg-blue-950/10">
                        <div className="flex flex-col md:flex-row justify-between gap-6 items-end">
                            <div className="flex gap-6 w-full md:w-auto">
                                <div>
                                    <label className="text-xs text-slate-400 mb-1 block">PV Size (kWp)</label>
                                    <input
                                        type="number"
                                        className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white w-32"
                                        value={systemConfig.solarKw}
                                        onChange={(e) => setSystemConfig(p => ({ ...p, solarKw: Number(e.target.value) }))}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-400 mb-1 block">Battery Capacity (kWh)</label>
                                    <input
                                        type="number"
                                        className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white w-32"
                                        value={systemConfig.batteryKwh}
                                        onChange={(e) => setSystemConfig(p => ({ ...p, batteryKwh: Number(e.target.value) }))}
                                    />
                                </div>
                            </div>

                            <div className="flex items-center gap-4">
                                <div className="text-right">
                                    <p className="text-xs text-slate-400">Est. Daily Savings</p>
                                    <p className="text-2xl font-bold text-emerald-400">R {totalSavings.toFixed(0)}</p>
                                </div>
                                <button
                                    onClick={handleAutoSize}
                                    className="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg flex items-center gap-2 font-medium shadow-lg shadow-blue-900/20"
                                >
                                    <Zap className="h-4 w-4" />
                                    Auto-Size System
                                </button>
                            </div>
                        </div>
                    </Card>

                    {/* Simulation Metrics */}
                    <div className="grid gap-6 md:grid-cols-3">
                        <Card>
                            <CardHeader title="Projected Solar Yield" icon={Zap} />
                            <div className="mt-2 text-3xl font-bold text-yellow-400">{(totalSolarGen).toFixed(0)} kWh</div>
                            <p className="text-xs text-slate-500 mt-1">Daily Production</p>
                        </Card>
                        <Card>
                            <CardHeader title="Grid Reliance" icon={Activity} />
                            <div className="mt-2 text-3xl font-bold text-white">
                                {((simData.reduce((a, b) => a + b.grid_load_kw, 0) / simData.reduce((a, b) => a + b.baseline_kw, 0)) * 100).toFixed(0)}%
                            </div>
                            <p className="text-xs text-slate-500 mt-1">Reduced from 100%</p>
                        </Card>
                        <Card>
                            <CardHeader title="Monthly ROI Est." icon={DollarSign} />
                            <div className="mt-2 text-3xl font-bold text-emerald-400">R {(totalSavings * 30).toLocaleString()}</div>
                            <p className="text-xs text-slate-500 mt-1">Net Savings (approx)</p>
                        </Card>
                    </div>

                    {/* Simulation Chart */}
                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h3 className="text-lg font-medium text-white">24h Simulation: {meter.name}</h3>
                                <p className="text-sm text-slate-400">Ekurhuleni Tariff • {systemConfig.solarKw}kWp Solar • {systemConfig.batteryKwh}kWh Storage</p>
                            </div>
                            <div className="flex gap-3 text-xs">
                                <span className="flex items-center gap-1 text-slate-400"><div className="w-2 h-2 rounded-full bg-slate-500"></div> Baseline</span>
                                <span className="flex items-center gap-1 text-slate-400"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Grid (New)</span>
                                <span className="flex items-center gap-1 text-slate-400"><div className="w-2 h-2 rounded-full bg-yellow-400"></div> Solar</span>
                                <span className="flex items-center gap-1 text-slate-400"><div className="w-2 h-2 rounded-full bg-green-500"></div> Battery SoC</span>
                            </div>
                        </div>
                        <div className="h-[400px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={simData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                    <XAxis dataKey="time" stroke="#64748b" fontSize={12} tickLine={false} />
                                    <YAxis yAxisId="left" stroke="#64748b" fontSize={12} tickLine={false} unit=" kW" />
                                    <YAxis yAxisId="right" orientation="right" stroke="#10b981" fontSize={12} tickLine={false} unit="%" />
                                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b' }} />

                                    <Line yAxisId="left" type="monotone" dataKey="baseline_kw" stroke="#64748b" strokeWidth={2} strokeDasharray="5 5" name="Baseline Load" dot={false} />
                                    <Line yAxisId="left" type="monotone" dataKey="grid_load_kw" stroke="#3b82f6" strokeWidth={2} name="Grid Import" dot={false} />
                                    <Line yAxisId="left" type="monotone" dataKey="solar_kw" stroke="#eab308" strokeWidth={2} fillOpacity={1} name="Solar Gen" dot={false} />
                                    <Line yAxisId="right" type="monotone" dataKey="battery_soc" stroke="#10b981" strokeWidth={2} name="Battery SoC" dot={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </Card>
                </div>
            )}
        </div>
    );
}
