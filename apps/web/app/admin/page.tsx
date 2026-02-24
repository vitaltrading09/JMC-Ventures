"use client";

import { Building2, Users, Database, Zap, Activity } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";

export default function AdminOverviewPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                    Global Platform Overview
                </h1>
                <p className="text-slate-400 mt-2">
                    Super Admin dashboard. View all clients and platform health.
                </p>
            </div>

            {/* KPI Stats */}
            <div className="grid gap-6 md:grid-cols-4">
                <Card className="border-red-500/20">
                    <CardHeader title="Total Active Clients" icon={Users} />
                    <div className="mt-2 text-3xl font-bold text-white">4</div>
                    <p className="text-sm text-slate-500 mt-1 flex items-center gap-1">
                        <span className="text-emerald-400">+1</span> this month
                    </p>
                </Card>
                <Card>
                    <CardHeader title="Total Sites Managed" icon={Building2} />
                    <div className="mt-2 text-3xl font-bold text-white">24</div>
                    <p className="text-sm text-slate-500 mt-1">Across all tenants</p>
                </Card>
                <Card>
                    <CardHeader title="Total Active Meters" icon={Database} />
                    <div className="mt-2 text-3xl font-bold text-blue-400">82</div>
                    <p className="text-sm text-slate-500 mt-1 text-emerald-400">All online</p>
                </Card>
                <Card>
                    <CardHeader title="Global Peak Load (Managed)" icon={Zap} />
                    <div className="mt-2 text-3xl font-bold text-red-400">12.4 MW</div>
                    <p className="text-sm text-slate-500 mt-1">Sum of all client peaks</p>
                </Card>
            </div>

            {/* Client List Quick View */}
            <Card className="p-6">
                <CardHeader title="Active Clients" subtitle="Overview of platform tenants" />
                <div className="mt-4 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/50">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-800/50 text-slate-400 border-b border-slate-800">
                            <tr>
                                <th className="px-6 py-3 font-medium">Client Name</th>
                                <th className="px-6 py-3 font-medium">Sites</th>
                                <th className="px-6 py-3 font-medium">Meters</th>
                                <th className="px-6 py-3 font-medium">Status</th>
                                <th className="px-6 py-3 font-medium text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            <tr className="hover:bg-slate-800/50 transition-colors">
                                <td className="px-6 py-4 font-medium text-white flex items-center gap-2">
                                    <div className="w-8 h-8 rounded bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold">DC</div>
                                    Demo Corporation
                                </td>
                                <td className="px-6 py-4 text-slate-300">5</td>
                                <td className="px-6 py-4 text-slate-300">5</td>
                                <td className="px-6 py-4">
                                    <span className="px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium flex items-center gap-1 w-max">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Active
                                    </span>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <button className="text-blue-400 hover:text-blue-300 font-medium">View As Client</button>
                                </td>
                            </tr>
                            <tr className="hover:bg-slate-800/50 transition-colors">
                                <td className="px-6 py-4 font-medium text-white flex items-center gap-2">
                                    <div className="w-8 h-8 rounded bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold">IG</div>
                                    Industrial Group SA
                                </td>
                                <td className="px-6 py-4 text-slate-300">12</td>
                                <td className="px-6 py-4 text-slate-300">45</td>
                                <td className="px-6 py-4">
                                    <span className="px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium flex items-center gap-1 w-max">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Active
                                    </span>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <button className="text-blue-400 hover:text-blue-300 font-medium">View As Client</button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}
