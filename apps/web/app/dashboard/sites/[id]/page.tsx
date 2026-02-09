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
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchData() {
            try {
                // 1. Fetch Meter Details (We might need an endpoint for this, or filter from list)
                // For now, assuming we can get list and filter, or a direct endpoint if available.
                // Let's use the list endpoint and filter for simplicity if no direct GET /meters/:id exists yet.
                const metersRes = await fetch('http://localhost:8081/ingestion/meters');
                const metersData = await metersRes.json();
                const foundMeter = metersData.find((m: Meter) => m.id === params.id);
                setMeter(foundMeter || null);

                // 2. Fetch Readings
                const readingsRes = await fetch(`http://localhost:8081/ingestion/meters/${params.id}/readings`);
                const readingsData = await readingsRes.json();

                // Format for Chart (take last 24h or 50 points)
                // The API returns most recent first, so we reverse for chart
                const formattedReadings = readingsData.slice(0, 50).reverse().map((r: any) => ({
                    time: new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    power_kw: r.power_active_total, // Map DB 'power_active_total' to frontend 'power_kw'
                    voltage_v: r.voltage_a,         // Map DB 'voltage_a' to frontend 'voltage_v'
                    current_a: r.current_a,         // Pass through
                    energy_kwh: r.energy_total,     // Assuming energy_total column exists? Or we just ignore for now if not in DB
                    frequency_hz: 50,               // Mock frequency since we don't ingest it yet
                    power_factor: 0.95              // Mock PF
                }));
                setReadings(formattedReadings);

            } catch (err) {
                console.error("Failed to fetch site data:", err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
        const interval = setInterval(fetchData, 5000); // Live poll
        return () => clearInterval(interval);
    }, [params.id]);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
            </div>
        );
    }

    if (!meter) {
        return (
            <div className="text-center py-12 text-slate-500">
                <h2 className="text-xl font-bold text-white mb-2">Meter Not Found</h2>
                <Link href="/dashboard/sites" className="text-blue-400 hover:text-blue-300">Back to Sites</Link>
            </div>
        );
    }

    // Calculate Latest Metrics
    const latestReading = readings.length > 0 ? readings[readings.length - 1] : null;
    const currentPower = latestReading?.power_kw ?? 0;
    const dailyUsage = readings.reduce((acc, curr) => acc + (curr.power_kw * (15 / 60)), 0); // Rough approximation for demo
    const powerFactor = latestReading?.power_factor ?? 0;

    // State for Tabs
    const [activeTab, setActiveTab] = useState<'overview' | 'savings'>('overview');

    // Derived Savings Data (Live Calculation)
    const TARIFF_R_PER_KWH = 2.50; // User Tariff (Mocked)
    const SOLAR_CAPACITY_KW = 800; // Sizing Tool Recommendation

    const savingsReadings = readings.map(r => {
        // Parse time (HH:mm) to decimal for solar curve
        const [hours, minutes] = r.time.split(':').map(Number);
        const timeDecimal = hours + (minutes / 60);

        // Simple Solar Curve: Peak at 12:00
        let solarGeneration = 0;
        if (timeDecimal > 6 && timeDecimal < 18) {
            const curve = (timeDecimal - 6) * (18 - timeDecimal);
            solarGeneration = (curve / 36) * SOLAR_CAPACITY_KW;
        }
        solarGeneration *= (0.8 + Math.random() * 0.2); // Weather noise

        return {
            ...r,
            solar_kw: solarGeneration,
            baseline_kw: r.power_kw + solarGeneration, // Baseline = Adjusted Grid Load + Solar
            savings_r: solarGeneration * (15 / 60) * TARIFF_R_PER_KWH
        };
    });

    const totalSavingsR = savingsReadings.reduce((acc, curr) => acc + curr.savings_r, 0);
    const totalSolarKwh = savingsReadings.reduce((acc, curr) => acc + (curr.solar_kw * 15 / 60), 0);

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
                    <div className="flex gap-3">
                        {/* Tabs Toggle */}
                        <div className="bg-slate-900 p-1 rounded-lg flex text-sm font-medium">
                            <button
                                onClick={() => setActiveTab('overview')}
                                className={`px-4 py-2 rounded-md transition-all ${activeTab === 'overview' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                            >
                                Overview
                            </button>
                            <button
                                onClick={() => setActiveTab('savings')}
                                className={`px-4 py-2 rounded-md transition-all ${activeTab === 'savings' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                            >
                                Savings & ROI
                            </button>
                        </div>
                        <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                            Export Data
                        </button>
                    </div>
                </div>
            </div>

            <>
                {/* Savings Content (Live) */}
                <div className="grid gap-6 md:grid-cols-4">
                    <Card>
                        <CardHeader title="Est. Savings (Today)" icon={DollarSign} />
                        <div className="mt-2 text-2xl font-bold text-emerald-400">R {totalSavingsR.toFixed(2)}</div>
                        <p className="text-xs text-slate-500 mt-1">Based on Recommended Sizing</p>
                    </Card>
                    <Card>
                        <CardHeader title="Solar Yield" icon={Zap} />
                        <div className="mt-2 text-2xl font-bold text-yellow-400">{totalSolarKwh.toFixed(1)} kWh</div>
                        <p className="text-xs text-slate-500 mt-1">Self-Consumption</p>
                    </Card>
                    <Card>
                        <CardHeader title="Grid Independence" icon={Activity} />
                        <div className="mt-2 text-2xl font-bold text-white">
                            {totalSolarKwh > 0 ? (totalSolarKwh / (dailyUsage + totalSolarKwh) * 100).toFixed(1) : 0}%
                        </div>
                        <div className="w-full bg-slate-800 h-2 rounded-full mt-2 overflow-hidden">
                            <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${totalSolarKwh > 0 ? (totalSolarKwh / (dailyUsage + totalSolarKwh) * 100) : 0}%` }}></div>
                        </div>
                    </Card>
                    {/* AI Insights Card */}
                    <Card className="border-indigo-500/30 bg-indigo-950/20">
                        <CardHeader title="AI Optimization" icon={Zap} />
                        <div className="space-y-2 mt-2">
                            <div className="flex items-center gap-2 text-xs text-indigo-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                PFC Correction Recommended
                            </div>
                            <div className="flex items-center gap-2 text-xs text-indigo-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                Harmonic Filtering: 5th Order
                            </div>
                            <div className="flex items-center gap-2 text-xs text-indigo-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                Load Shift: 08:00 - 10:00
                            </div>
                        </div>
                    </Card>
                </div>

                <Card className="p-6">
                    <div className="flex items-center justify-between mb-6">
                        <CardHeader title="Impact Analysis" subtitle="Simulated Baseline vs Live Grid Load" />
                        <div className="flex gap-2">
                            <span className="flex items-center gap-1 text-xs text-slate-400"><span className="w-2 h-2 rounded-full bg-slate-500"></span> Baseline</span>
                            <span className="flex items-center gap-1 text-xs text-slate-400"><span className="w-2 h-2 rounded-full bg-blue-500"></span> Actual (Grid)</span>
                            <span className="flex items-center gap-1 text-xs text-slate-400"><span className="w-2 h-2 rounded-full bg-yellow-500"></span> Solar</span>
                        </div>
                    </div>
                    <div className="h-[400px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={savingsReadings}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis dataKey="time" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} />
                                <Line type="monotone" dataKey="baseline_kw" stroke="#64748b" strokeDasharray="5 5" strokeWidth={2} dot={false} name="Baseline" />
                                <Line type="monotone" dataKey="power_kw" stroke="#3b82f6" strokeWidth={3} dot={false} name="Grid Load" />
                                <Line type="monotone" dataKey="solar_kw" stroke="#eab308" strokeWidth={2} fillOpacity={1} fill="url(#colorSolar)" name="Solar Gen" />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
            </>
            )}
        </div>
    );
}
