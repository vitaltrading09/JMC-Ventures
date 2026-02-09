"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import Link from "next/link";
import { Plus, Search, MapPin, MoreHorizontal } from "lucide-react";

interface Site {
    id: string;
    name: string;
    address: string; // Using 'model' mapped to address for now, or just name
    status: string;
    serial_number: string;
    model: string;
    latest_reading?: {
        power_active_total?: number;
        power_kw?: number;
        current_a?: number;
        voltage_a?: number;
        time: string;
    };
}

export default function SitesPage() {
    const [sites, setSites] = useState<Site[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchSites() {
            try {
                // Fetch from Ingestion Service via API Gateway
                const res = await fetch('http://localhost:8081/ingestion/meters');
                const data = await res.json();
                setSites(data);
            } catch (err) {
                console.error("Failed to fetch sites:", err);
            } finally {
                setLoading(false);
            }
        }
        fetchSites();

        // Poll every 5 seconds for updates
        const interval = setInterval(fetchSites, 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Sites Management</h1>
                    <p className="text-slate-400 mt-2">
                        Monitor and manage your connected facilities.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                        <input
                            type="text"
                            placeholder="Search sites..."
                            className="pl-10 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 w-full sm:w-64"
                        />
                    </div>
                    <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all">
                        <Plus className="h-4 w-4" />
                        Add Site
                    </button>
                </div>
            </div>

            {/* Sites Listing */}
            <div className="grid gap-4">
                {loading ? (
                    <div className="text-center text-slate-500 py-12">Loading live site data...</div>
                ) : (
                    sites.map((site) => (
                        <Link href={`/dashboard/sites/${site.id}`} key={site.id} className="block">
                            <Card className="group hover:border-blue-500/30 transition-all cursor-pointer">
                                <div className="grid md:grid-cols-12 gap-4 items-center p-4">
                                    {/* Name & Model */}
                                    <div className="col-span-4 flex items-start gap-3">
                                        <div className="p-2 rounded-lg bg-slate-800 text-slate-400 group-hover:text-blue-400 group-hover:bg-blue-500/10 transition-colors">
                                            <MapPin className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <h3 className="font-medium text-white group-hover:text-blue-400 transition-colors">{site.name}</h3>
                                            <p className="text-sm text-slate-500 truncate">SN: {site.serial_number} • {site.model}</p>
                                        </div>
                                    </div>

                                    {/* Status (Mocked based on ID for now) */}
                                    <div className="col-span-2 flex justify-center">
                                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border bg-emerald-500/10 text-emerald-400 border-emerald-500/20`}>
                                            <span className={`h-1.5 w-1.5 rounded-full bg-emerald-500`} />
                                            Online
                                        </span>
                                    </div>

                                    {/* Usage */}
                                    <div className="col-span-2 text-right flex flex-col items-end">
                                        <span className="text-white font-mono">
                                            {site.latest_reading ? (
                                                <>
                                                    {site.latest_reading.power_active_total?.toFixed(1) ?? site.latest_reading.power_kw?.toFixed(1) ?? '--'} <span className="text-slate-500 text-xs">kW</span>
                                                </>
                                            ) : (
                                                <span className="text-slate-500">--</span>
                                            )}
                                        </span>
                                        {site.latest_reading && (
                                            <div className="w-16 h-1 mt-1 bg-slate-800 rounded-full overflow-hidden">
                                                {/* Visual bar capped at 1000kW for demo */}
                                                <div className="h-full bg-blue-500" style={{ width: `${Math.min(((site.latest_reading.power_active_total || site.latest_reading.power_kw || 0) / 1000) * 100, 100)}%` }} />
                                            </div>
                                        )}
                                    </div>

                                    {/* Savings (Placeholder - using Energy Total as a proxy for activity) */}
                                    <div className="col-span-2 text-right">
                                        {site.latest_reading ? (
                                            <span className="text-slate-400 font-mono text-xs">
                                                {(site.latest_reading.current_a || 0).toFixed(0)} <span className="text-slate-600">Amps</span>
                                            </span>
                                        ) : (
                                            <span className="text-slate-600">--</span>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="col-span-2 flex justify-end">
                                        <button className="p-2 text-slate-500 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
                                            <MoreHorizontal className="h-4 w-4" />
                                        </button>
                                    </div>
                                </div>
                            </Card>
                        </Link>
                    ))
                )}
            </div>
        </div>
    );
}
