"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { RefreshCw, DollarSign, ArrowRight, X, AlertCircle, CheckCircle2 } from "lucide-react";

export function GridXBridge() {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isConnected, setIsConnected] = useState(false);

    const readinessScore = 85;
    const potentialRevenue = 1250;

    const handleConnect = () => {
        setIsConnecting(true);
        // Simulate API call to register meters on the exchange
        setTimeout(() => {
            setIsConnecting(false);
            setIsConnected(true);
        }, 2000);
    };

    return (
        <>
            {/* Widget Card */}
            <Card className="relative overflow-hidden border-emerald-900/30 bg-gradient-to-br from-slate-900 to-slate-950 group">
                {/* Background glow */}
                <div className="absolute inset-0 bg-emerald-500/5 transition-opacity group-hover:bg-emerald-500/10" />

                <div className="relative p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-emerald-500/10 rounded-lg">
                                <RefreshCw className="h-5 w-5 text-emerald-400" />
                            </div>
                            <h3 className="font-semibold text-white">Unlock Grid-X</h3>
                        </div>
                        {isConnected && (
                            <span className="flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
                                <CheckCircle2 className="h-3 w-3" /> Active
                            </span>
                        )}
                    </div>

                    <div className="space-y-6">
                        {/* Readiness */}
                        <div>
                            <div className="flex items-center justify-between text-sm mb-2">
                                <span className="text-slate-400">Wheeling Readiness</span>
                                <span className="text-emerald-400 font-medium">{readinessScore}%</span>
                            </div>
                            <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-emerald-500 rounded-full transition-all duration-1000"
                                    style={{ width: `${readinessScore}%` }}
                                />
                            </div>
                        </div>

                        {/* Revenue */}
                        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                            <div className="text-sm text-slate-400 mb-1">Potential Monthly Revenue</div>
                            <div className="flex items-end gap-2">
                                <DollarSign className="h-6 w-6 text-emerald-400 mb-0.5" />
                                <span className="text-3xl font-bold text-white">{potentialRevenue}</span>
                            </div>
                        </div>

                        {/* Action */}
                        {!isConnected ? (
                            <button
                                onClick={() => setIsModalOpen(true)}
                                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-all shadow-lg shadow-emerald-900/20"
                            >
                                Connect to Grid-X
                                <ArrowRight className="h-4 w-4" />
                            </button>
                        ) : (
                            <button
                                disabled
                                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-slate-800 text-slate-400 rounded-lg font-medium cursor-not-allowed"
                            >
                                Trading Floor Enabled
                            </button>
                        )}
                    </div>
                </div>
            </Card>

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl animate-in zoom-in-95 duration-200">

                        <div className="flex justify-between items-center p-6 border-b border-slate-800">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-emerald-500/10 rounded-lg">
                                    <RefreshCw className="h-5 w-5 text-emerald-400" />
                                </div>
                                <h2 className="text-xl font-bold text-white">Join Grid-X Exchange</h2>
                            </div>
                            <button
                                onClick={() => !isConnecting && setIsModalOpen(false)}
                                className="text-slate-400 hover:text-white transition-colors"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="flex gap-4 items-start p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                                <AlertCircle className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
                                <p className="text-sm text-slate-300 leading-relaxed">
                                    By connecting, your PowerGuard Acuvim/Billing meters will be listed on the Grid-X exchange for precinct-level wheeling.
                                </p>
                            </div>

                            <div className="space-y-3">
                                <h4 className="text-sm font-medium text-slate-400">Data to be shared:</h4>
                                <ul className="text-sm text-slate-300 space-y-2">
                                    <li className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                        15-minute interval kW/kWh telemetry
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                        Solar PV / Battery export capacity
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                        Precinct location mapping
                                    </li>
                                </ul>
                            </div>

                            <button
                                onClick={handleConnect}
                                disabled={isConnecting}
                                className="w-full flex justify-center items-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white rounded-lg font-medium transition-all"
                            >
                                {isConnecting ? (
                                    <>
                                        <RefreshCw className="h-4 w-4 animate-spin" />
                                        Connecting Meters...
                                    </>
                                ) : (
                                    "Confirm & Connect"
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
