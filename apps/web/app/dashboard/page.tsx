"use client";

import { Card, CardHeader } from "@/components/ui/Card";
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    AreaChart,
    Area,
    Brush,
} from "recharts";
import { Activity, Zap, DollarSign, TrendingUp, AlertTriangle } from "lucide-react";
import { GridXBridge } from "@/components/dashboard/GridXBridge";

// Mock Data
const powerData = [
    { time: "00:00", kw: 420 },
    { time: "04:00", kw: 380 },
    { time: "08:00", kw: 850 },
    { time: "12:00", kw: 920 },
    { time: "16:00", kw: 890 },
    { time: "20:00", kw: 600 },
    { time: "23:59", kw: 500 },
];

export default function DashboardPage() {
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Dashboard Settings</h1>
                    <p className="text-slate-400 mt-2">
                        Overview of your energy performance and savings.
                    </p>
                </div>
                <div className="flex gap-3">
                    <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        Download Report
                    </button>
                    <button className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all">
                        Add Meter
                    </button>
                </div>
            </div>

            {/* KPI Grid */}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader title="Total Energy" icon={Zap} />
                    <div className="mt-2">
                        <span className="text-3xl font-bold text-white">1,240</span>
                        <span className="text-slate-500 ml-2">kWh</span>
                    </div>
                    <div className="mt-4 flex items-center text-sm text-green-400">
                        <TrendingUp className="mr-1 h-4 w-4" />
                        +12.5% from last month
                    </div>
                </Card>

                <Card>
                    <CardHeader title="Active Power" icon={Activity} />
                    <div className="mt-2">
                        <span className="text-3xl font-bold text-white">45.2</span>
                        <span className="text-slate-500 ml-2">kW</span>
                    </div>
                    <div className="mt-4 flex items-center text-sm text-slate-400">
                        Real-time reading
                    </div>
                </Card>

                <Card>
                    <CardHeader title="Est. Savings" icon={DollarSign} />
                    <div className="mt-2">
                        <span className="text-3xl font-bold text-white">$342.50</span>
                    </div>
                    <div className="mt-4 flex items-center text-sm text-green-400">
                        <TrendingUp className="mr-1 h-4 w-4" />
                        10% fee applied
                    </div>
                </Card>

                <Card>
                    <CardHeader title="Power Quality" icon={AlertTriangle} />
                    <div className="mt-2">
                        <span className="text-3xl font-bold text-emerald-400">98%</span>
                        <span className="text-slate-500 ml-2">Score</span>
                    </div>
                    <div className="mt-4 flex items-center text-sm text-slate-400">
                        Voltage THD &lt; 3%
                    </div>
                </Card>
            </div>

            {/* Main Charts */}
            <div className="grid gap-6 md:grid-cols-10">
                {/* Power Trend Chart */}
                <Card className="md:col-span-4 flex flex-col">
                    <CardHeader title="Power Consumption Trend" subtitle="Active Power (kW) over last 24h" />
                    <div className="flex-1 min-h-[300px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={powerData}>
                                <defs>
                                    <linearGradient id="colorKw" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis
                                    dataKey="time"
                                    stroke="#64748b"
                                    fontSize={12}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <YAxis
                                    stroke="#64748b"
                                    fontSize={12}
                                    tickLine={false}
                                    axisLine={false}
                                    tickFormatter={(value) => `${value} kW`}
                                    width={50}
                                />
                                <Tooltip
                                    contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", borderRadius: "0.5rem", color: "#f8fafc" }}
                                    itemStyle={{ color: "#3b82f6", fontWeight: 500 }}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="kw"
                                    stroke="#3b82f6"
                                    strokeWidth={3}
                                    fillOpacity={1}
                                    fill="url(#colorKw)"
                                />
                                <Brush dataKey="time" height={30} stroke="#475569" fill="#0f172a" tickFormatter={() => ''} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </Card>

                {/* Live Alerts / Feed */}
                <Card className="md:col-span-3 flex flex-col bg-slate-900 border-slate-800">
                    <CardHeader title="Live Insights" subtitle="AI Detection Stream" />
                    <div className="space-y-4 mt-4 flex-1">
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-slate-800/30 border border-slate-800 hover:bg-slate-800/50 transition-colors">
                                <div className="p-2 rounded-full bg-yellow-500/10 text-yellow-500 shrink-0">
                                    <AlertTriangle className="h-4 w-4" />
                                </div>
                                <div className="min-w-0">
                                    <h4 className="text-sm font-medium text-slate-200 truncate">Voltage Sag Detected</h4>
                                    <p className="text-xs text-slate-500 truncate">Site A - Factory Floor 1 • 2 mins ago</p>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-6">
                        <button className="w-full py-2 text-sm text-blue-400 hover:text-blue-300 transition-colors border border-dashed border-slate-700 rounded-lg">
                            View All Alerts
                        </button>
                    </div>
                </Card>

                {/* Grid-X Integration */}
                <div className="md:col-span-3">
                    <GridXBridge />
                </div>
            </div>
        </div>
    );
}
