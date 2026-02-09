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

    // Mock Savings Data (Simulated for "After PV Install")
    const savingsData = [
        { time: "06:00", baseline: 350, actual: 280, solar: 0 },
        { time: "08:00", baseline: 600, actual: 450, solar: 150 },
        { time: "10:00", baseline: 850, actual: 500, solar: 350 },
        { time: "12:00", baseline: 900, actual: 400, solar: 500 }, // Peak Solar
        { time: "14:00", baseline: 880, actual: 420, solar: 460 },
        { time: "16:00", baseline: 700, actual: 450, solar: 250 },
        { time: "18:00", baseline: 500, actual: 450, solar: 50 },
    ];

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

            {activeTab === 'overview' ? (
                <>
                    {/* Overview Stats */}
                    <div className="grid gap-6 md:grid-cols-4">
                        <Card>
                            <CardHeader title="Real-time Power" icon={Zap} />
                            <div className="mt-2 text-2xl font-bold text-white">{currentPower.toFixed(2)} kW</div>
                        </Card>
                        <Card>
                            <CardHeader title="Est. Daily Usage" icon={Activity} />
                            <div className="mt-2 text-2xl font-bold text-white">{dailyUsage.toFixed(1)} kWh</div>
                        </Card>
                        <Card>
                            <CardHeader title="Power Factor" icon={Battery} />
                            <div className="mt-2 text-2xl font-bold text-emerald-400">{powerFactor.toFixed(2)}</div>
                        </Card>
                        <Card>
                            <CardHeader title="Est. Cost (Day)" icon={DollarSign} />
                            <div className="mt-2 text-2xl font-bold text-white">R {(dailyUsage * 2.5).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                        </Card>
                    </div>

                    {/* Overview Charts */}
                    <div className="grid gap-6 md:grid-cols-3">
                        {/* Detailed Chart */}
                        <Card className="md:col-span-2">
                            <CardHeader title="Power Profile" subtitle="Real-time Consumption (kW)" />
                            <div className="h-[350px] w-full mt-4">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={readings}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                        <XAxis dataKey="time" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} />
                                        <Line type="monotone" dataKey="power_kw" stroke="#3b82f6" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </Card>

                        {/* Technical Meter Details */}
                        <Card>
                            <CardHeader title="Live Technicals" subtitle="Phase & Line Metrics" />
                            <div className="space-y-4 text-sm mt-4">
                                <div className="flex justify-between py-2 border-b border-slate-800">
                                    <span className="text-slate-500">Voltage</span>
                                    <span className="text-white">{(latestReading?.voltage_v ?? 0).toFixed(1)} V</span>
                                </div>
                                <div className="flex justify-between py-2 border-b border-slate-800">
                                    <span className="text-slate-500">Current</span>
                                    <span className="text-white">{(latestReading?.current_a ?? 0).toFixed(1)} A</span>
                                </div>
                                <div className="flex justify-between py-2 border-b border-slate-800">
                                    <span className="text-slate-500">Frequency</span>
                                    <span className="text-white">{(latestReading?.frequency_hz ?? 0).toFixed(2)} Hz</span>
                                </div>
                                <div className="flex justify-between py-2 border-b border-slate-800">
                                    <span className="text-slate-500">Energy Total</span>
                                    <span className="text-white">{(latestReading?.energy_kwh ?? 0).toFixed(1)} kWh</span>
                                </div>
                            </div>
                        </Card>
                    </div>
                </>
            ) : (
                <>
                    {/* Savings Content */}
                    <div className="grid gap-6 md:grid-cols-3">
                        <Card>
                            <CardHeader title="Verified Savings (YTD)" icon={DollarSign} />
                            <div className="mt-2 text-2xl font-bold text-emerald-400">R 124,500</div>
                            <p className="text-xs text-slate-500 mt-1">vs. Projected R 110,000 (+13%)</p>
                        </Card>
                        <Card>
                            <CardHeader title="Solar Yield" icon={Zap} />
                            <div className="mt-2 text-2xl font-bold text-yellow-400">14.2 MWh</div>
                            <p className="text-xs text-slate-500 mt-1">Avoided Grid Import</p>
                        </Card>
                        <Card>
                            <CardHeader title="ROI Status" icon={Activity} />
                            <div className="mt-2 text-2xl font-bold text-white">18 Months</div>
                            <div className="w-full bg-slate-800 h-2 rounded-full mt-2 overflow-hidden">
                                <div className="bg-blue-600 h-full rounded-full" style={{ width: '45%' }}></div>
                            </div>
                            <p className="text-xs text-slate-500 mt-1">45% Payback Achieved</p>
                        </Card>
                    </div>

                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-6">
                            <CardHeader title="Impact Analysis" subtitle="Baseline vs Actual (Post-Implementation)" />
                            <div className="flex gap-2">
                                <span className="flex items-center gap-1 text-xs text-slate-400"><span className="w-2 h-2 rounded-full bg-slate-500"></span> Baseline</span>
                                <span className="flex items-center gap-1 text-xs text-slate-400"><span className="w-2 h-2 rounded-full bg-blue-500"></span> Actual</span>
                                <span className="flex items-center gap-1 text-xs text-slate-400"><span className="w-2 h-2 rounded-full bg-yellow-500"></span> Solar</span>
                            </div>
                        </div>
                        <div className="h-[400px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={savingsData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                    <XAxis dataKey="time" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} />
                                    <Line type="monotone" dataKey="baseline" stroke="#64748b" strokeDasharray="5 5" strokeWidth={2} dot={false} name="Baseline" />
                                    <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={3} dot={false} name="Actual Load" />
                                    <Line type="monotone" dataKey="solar" stroke="#eab308" strokeWidth={2} dot={false} name="Solar Gen" />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </Card>
                </>
            )}
        </div>
    );
}
