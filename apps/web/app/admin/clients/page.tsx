"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Plus, Building2, Users, HardDrive, MoreHorizontal, AlertCircle } from "lucide-react";

interface Tenant {
    id: string;
    name: string;
    site_count: string;
    user_count: string;
    created_at: string;
}

export default function ClientsPage() {
    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [loading, setLoading] = useState(true);
    const [showNewModal, setShowNewModal] = useState(false);
    const [newTenantName, setNewTenantName] = useState("");
    const [error, setError] = useState("");

    const fetchTenants = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/auth/tenants", {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error("Failed to fetch clients");
            const data = await res.json();
            setTenants(data);
        } catch (err: any) {
            console.error(err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTenants();
    }, []);

    const handleCreateTenant = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/auth/tenants", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ name: newTenantName })
            });
            if (!res.ok) throw new Error("Failed to create client");
            await fetchTenants();
            setShowNewModal(false);
            setNewTenantName("");
        } catch (err: any) {
            setError(err.message);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Client Management</h1>
                    <p className="text-slate-400 mt-2">
                        Provision new tenants and manage their access to PowerGuard.
                    </p>
                </div>
                <button
                    onClick={() => setShowNewModal(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium shadow-[0_0_15px_rgba(239,68,68,0.3)] transition-all"
                >
                    <Plus className="h-4 w-4" />
                    New Client / Tenant
                </button>
            </div>

            {error && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg flex items-center gap-2">
                    <AlertCircle className="h-5 w-5" />
                    {error}
                </div>
            )}

            <div className="grid gap-4">
                {loading ? (
                    <div className="text-center text-slate-500 py-8">Loading clients...</div>
                ) : tenants.length === 0 ? (
                    <div className="text-center text-slate-500 py-8">No clients found. Click "New Client" to start.</div>
                ) : (
                    tenants.map(tenant => (
                        <Card key={tenant.id} className="p-4 hover:border-slate-700 transition-colors">
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col md:flex-row md:items-center gap-6">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-lg bg-red-500/10 text-red-400 flex items-center justify-center">
                                            <Building2 className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <h3 className="font-semibold text-white text-lg">{tenant.name}</h3>
                                            <p className="text-xs text-slate-500">ID: {tenant.id.split('-')[0]}... • Created {new Date(tenant.created_at).toLocaleDateString()}</p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-6 pl-4 md:border-l border-slate-800">
                                        <div className="text-center">
                                            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1 justify-center"><HardDrive className="h-3 w-3" /> Sites</div>
                                            <div className="font-mono text-slate-300">{tenant.site_count}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1 justify-center"><Users className="h-3 w-3" /> Users</div>
                                            <div className="font-mono text-slate-300">{tenant.user_count}</div>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button className="px-3 py-1.5 text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded transition-colors">
                                        Manage Users
                                    </button>
                                    <button className="p-1.5 text-slate-500 hover:text-white rounded hover:bg-slate-800 transition-colors">
                                        <MoreHorizontal className="h-5 w-5" />
                                    </button>
                                </div>
                            </div>
                        </Card>
                    ))
                )}
            </div>

            {/* Modal */}
            {showNewModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl">
                        <h2 className="text-xl font-bold text-white mb-4">Create New Client</h2>
                        <form onSubmit={handleCreateTenant}>
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-slate-400 mb-2">Company / Tenant Name</label>
                                <input
                                    type="text"
                                    required
                                    value={newTenantName}
                                    onChange={e => setNewTenantName(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500 transition-all"
                                    placeholder="e.g. Acme Corp"
                                />
                            </div>
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setShowNewModal(false)}
                                    className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors"
                                >
                                    Create Tenant
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
