"use client";

import { Card, CardHeader } from "@/components/ui/Card";
import {
    LineChart,
    Line,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend,
    AreaChart,
    Area,
    ComposedChart
} from "recharts";
import { Download, Calendar, DollarSign, TrendingUp, Leaf, ShieldCheck, Zap } from "lucide-react";

// Mock Data: Counterfactual Baseline vs Actual
const savingsData = [
    { day: "Day 1", baseline: 1200, actual: 1050, savings: 150 },
    { day: "Day 2", baseline: 1250, actual: 1100, savings: 150 },
    { day: "Day 3", baseline: 1180, actual: 950, savings: 230 }, // Big dip due to solar/peak shave
    { day: "Day 4", baseline: 1300, actual: 1150, savings: 150 },
    { day: "Day 5", baseline: 1220, actual: 1080, savings: 140 },
    { day: "Day 6", baseline: 900, actual: 850, savings: 50 }, // Weekend
    { day: "Day 7", baseline: 920, actual: 870, savings: 50 }
];

// Mock Data: Savings Attribution
const attributionData = [
    { name: "Solar Self-Consumption", value: 4500, fill: "#3b82f6" },
    { name: "Peak Shaving (Battery)", value: 3200, fill: "#8b5cf6" },
    { name: "Voltage Optimization", value: 1200, fill: "#10b981" },
    { name: "Power Factor Correction", value: 800, fill: "#f59e0b" },
];

const ledgerData = [
    { date: "2024-02-09", event: "Peak Shaving (18:00-20:00)", kwh: 45.2, rate: 3.50, value: 158.20 },
    { date: "2024-02-09", event: "Solar Generation", kwh: 120.5, rate: 1.80, value: 216.90 },
    { date: "2024-02-08", event: "Voltage Optimize", kwh: 12.0, rate: 2.10, value: 25.20 },
    { date: "2024-02-08", event: "Peak Shaving", kwh: 38.0, rate: 3.50, value: 133.00 },
];

export default function SavingsPage() {
    const totalVerifiedSavings = 15800; // ZAR
    const powerGuardFee = totalVerifiedSavings * 0.10;
    const clientNetSavings = totalVerifiedSavings * 0.90;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Trust Center</h1>
                    <p className="text-slate-400 mt-2">
                        Verified savings ledger and performance attribution.
                    </p>
                </div>
                <div className="flex gap-3">
                    <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <Calendar className="h-4 w-4" />
                        This Month
                    </button>
                    <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <Download className="h-4 w-4" />
                        Audit Report
                    </button>
                </div>
            </div>

            {/* Hero Metrics */}
            <div className="grid gap-6 md:grid-cols-4">
                <Card className="bg-emerald-500/10 border-emerald-500/20">
                    <div className="p-6">
                        <div className="flex items-center gap-2 text-emerald-400 mb-2">
                            <ShieldCheck className="h-5 w-5" />
                            <span className="font-medium">Total Verified Savings</span>
                        </div>
                        <div className="text-3xl font-bold text-white">R {totalVerifiedSavings.toLocaleString()}</div>
                        <div className="text-sm text-slate-400 mt-1">MTD (Month to Date)</div>
                    </div>
                </Card>

                <Card className="bg-blue-500/10 border-blue-500/20">
                    <div className="p-6">
                        <div className="flex items-center gap-2 text-blue-400 mb-2">
                            <DollarSign className="h-5 w-5" />
                            <span className="font-medium">Net Client Benefit</span>
                        </div>
                        <div className="text-3xl font-bold text-white">R {clientNetSavings.toLocaleString()}</div>
                        <div className="text-sm text-slate-400 mt-1">90% Share</div>
                    </div>
                </Card>

                <Card className="bg-purple-500/10 border-purple-500/20">
                    <div className="p-6">
                        <div className="flex items-center gap-2 text-purple-400 mb-2">
                            <Zap className="h-5 w-5" />
                            <span className="font-medium">PowerGuard Fee</span>
                        </div>
                        <div className="text-3xl font-bold text-white">R {powerGuardFee.toLocaleString()}</div>
                        <div className="text-sm text-slate-400 mt-1">10% Performance Fee</div>
                    </div>
                </Card>

                <Card>
                    <div className="p-6">
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                            <Leaf className="h-5 w-5 text-green-500" />
                            <span className="font-medium">ESG Impact</span>
                        </div>
                        <div className="text-3xl font-bold text-white">4.2 <span className="text-lg font-normal text-slate-500">tCO2e</span></div>
                        <div className="text-sm text-slate-400 mt-1">Avoided Emissions</div>
                    </div>
                </Card>
            </div>

            <div className="grid gap-6 md:grid-cols-3">
                {/* Counterfactual Chart */}
                <Card className="md:col-span-2">
                    <CardHeader title="Performance Verification" subtitle="Baseline (Counterfactual) vs Actual Usage" />
                    <div className="h-[350px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={savingsData}>
                                <defs>
                                    <linearGradient id="colorBaseline" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.1} />
                                        <stop offset="95%" stopColor="#94a3b8" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="colorActual" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis dataKey="day" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} label={{ value: 'kWh', angle: -90, position: 'insideLeft', fill: '#64748b' }} />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} />
                                <Legend />
                                <Area type="monotone" dataKey="baseline" name="Expected Baseline" stroke="#94a3b8" fill="url(#colorBaseline)" strokeDasharray="5 5" />
                                <Area type="monotone" dataKey="actual" name="Actual Usage" stroke="#3b82f6" fill="url(#colorActual)" strokeWidth={2} />
                                <Bar dataKey="savings" name="Verified Savings" fill="#10b981" radius={[4, 4, 0, 0]} opacity={0.8} />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                </Card>

                {/* Savings Attribution */}
                <Card>
                    <CardHeader title="Value Attribution" subtitle="Savings Source Breakdown" />
                    <div className="h-[350px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart layout="vertical" data={attributionData} margin={{ left: 40 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                                <XAxis type="number" stroke="#64748b" fontSize={12} hide />
                                <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={11} width={100} tickLine={false} axisLine={false} />
                                <Tooltip cursor={{ fill: '#1e293b' }} contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} />
                                <Bar dataKey="value" name="Savings (ZAR)" radius={[0, 4, 4, 0]} barSize={20} label={{ position: 'right', fill: '#94a3b8', fontSize: 12, formatter: (val: number) => `R ${val}` }} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
            </div>

            {/* Ledger Table */}
            <Card>
                <CardHeader title="Savings Ledger" subtitle="AUDIT LOG: Verified Intervention Events" />
                <div className="overflow-x-auto mt-4">
                    <table className="w-full text-sm text-left text-slate-400">
                        <thead className="text-xs text-slate-500 uppercase bg-slate-900/50">
                            <tr>
                                <th className="px-6 py-3">Date</th>
                                <th className="px-6 py-3">Event Type</th>
                                <th className="px-6 py-3 text-right">Energy Saved</th>
                                <th className="px-6 py-3 text-right">Rate</th>
                                <th className="px-6 py-3 text-right text-emerald-400">Value Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ledgerData.map((entry, idx) => (
                                <tr key={idx} className="border-b border-slate-800 hover:bg-slate-800/20 transition-colors">
                                    <td className="px-6 py-4 font-mono">{entry.date}</td>
                                    <td className="px-6 py-4 font-medium text-white">{entry.event}</td>
                                    <td className="px-6 py-4 text-right">{entry.kwh.toFixed(1)} kWh</td>
                                    <td className="px-6 py-4 text-right">R {entry.rate.toFixed(2)}</td>
                                    <td className="px-6 py-4 text-right text-emerald-400 font-bold">R {entry.value.toFixed(2)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}
