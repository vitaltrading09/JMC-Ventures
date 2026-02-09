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
                    time: new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    kwh: r.power_kw, // Using Power (kW) for the profile chart
                    ...r
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
                        <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                            Export Data
                        </button>
                    </div>
                </div>
            </div>

            {/* Stats Grid */}
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

            {/* Main Content Area */}
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
                            <span className="text-white">{latestReading?.voltage_v.toFixed(1)} V</span>
                        </div>
                        <div className="flex justify-between py-2 border-b border-slate-800">
                            <span className="text-slate-500">Current</span>
                            <span className="text-white">{latestReading?.current_a.toFixed(1)} A</span>
                        </div>
                        <div className="flex justify-between py-2 border-b border-slate-800">
                            <span className="text-slate-500">Frequency</span>
                            <span className="text-white">{latestReading?.frequency_hz.toFixed(2)} Hz</span>
                        </div>
                        <div className="flex justify-between py-2 border-b border-slate-800">
                            <span className="text-slate-500">Energy Total</span>
                            <span className="text-white">{latestReading?.energy_kwh.toFixed(1)} kWh</span>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
