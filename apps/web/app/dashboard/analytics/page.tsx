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
    Area
} from "recharts";
import { Download, Calendar, Zap, TrendingDown } from "lucide-react";

const harmonicsData = [
    { order: "1st", mag: 100 },
    { order: "3rd", mag: 12 },
    { order: "5th", mag: 8 },
    { order: "7th", mag: 5 },
    { order: "9th", mag: 2 },
    { order: "11th", mag: 1 },
];

const peakDemandData = [
    { month: "Jan", peak: 450, avg: 320 },
    { month: "Feb", peak: 480, avg: 340 },
    { month: "Mar", peak: 420, avg: 310 },
    { month: "Apr", peak: 510, avg: 360 },
    { month: "May", peak: 550, avg: 390 },
    { month: "Jun", peak: 580, avg: 410 },
];

export default function AnalyticsPage() {
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Advanced Analytics</h1>
                    <p className="text-slate-400 mt-2">
                        Deep dive into power quality and demand analysis.
                    </p>
                </div>
                <div className="flex gap-3">
                    <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <Calendar className="h-4 w-4" />
                        Last 30 Days
                    </button>
                    <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <Download className="h-4 w-4" />
                        Export CSV
                    </button>
                </div>
            </div>

            {/* AI Insight Card */}
            <div className="p-4 rounded-xl bg-gradient-to-r from-blue-900/40 to-purple-900/40 border border-blue-500/20 flex items-start gap-4">
                <div className="p-3 rounded-full bg-blue-500/20 text-blue-400">
                    <Zap className="h-6 w-6" />
                </div>
                <div>
                    <h3 className="text-lg font-medium text-white">AI Optimization Insight</h3>
                    <p className="text-slate-300 mt-1 text-sm">
                        Based on your usage patterns, we detected a consistent 15% peak demand surge between 14:00 and 16:00.
                        Shifting this load could save an estimated <span className="text-emerald-400 font-bold">R 12,500</span> per month on demand charges.
                    </p>
                    <button className="mt-3 text-sm text-blue-400 hover:text-blue-300 font-medium">
                        View Simulation &rarr;
                    </button>
                </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
                {/* Peak Demand Analysis */}
                <Card>
                    <CardHeader title="Peak Demand Analysis (kVA)" subtitle="Comparing monthly peak vs. average load" />
                    <div className="h-[300px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={peakDemandData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis dataKey="month" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} cursor={{ fill: '#1e293b' }} />
                                <Legend />
                                <Bar dataKey="peak" name="Peak Load" fill="#ef4444" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="avg" name="Average Load" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </Card>

                {/* Harmonics Spectrum */}
                <Card>
                    <CardHeader title="Current Harmonics" subtitle="THD Analysis on Main Incomer" />
                    <div className="h-[300px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={harmonicsData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis dataKey="order" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} cursor={{ fill: '#1e293b' }} />
                                <Bar dataKey="mag" name="Magnitude %" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-sm">
                        <span className="text-slate-400">Total Harmonic Distortion (THD):</span>
                        <span className="text-emerald-400 font-bold">2.4% (Healthy)</span>
                    </div>
                </Card>
            </div>
        </div>
    );
}
