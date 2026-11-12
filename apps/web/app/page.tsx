import Link from "next/link";
import { Shield, Zap, ArrowRight, Activity, BarChart3, Gauge } from "lucide-react";

export default function Home() {
    return (
        <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-white overflow-hidden">
            <div className="relative flex flex-col justify-center p-12 lg:p-24 bg-gradient-to-br from-slate-950 to-slate-900 w-full max-w-4xl">
                {/* Background Pattern */}
                <div className="absolute inset-0 opacity-[0.03] bg-[linear-gradient(rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.1)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none" />

                <div className="relative z-10 w-full">
                    <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700 flex items-center justify-center mb-8 shadow-lg shadow-blue-900/20 backdrop-blur-sm">
                        <Shield className="w-8 h-8 text-blue-400" />
                    </div>

                    <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-transparent bg-clip-text bg-gradient-to-r from-slate-100 to-slate-400">
                        GridIQ
                    </h1>

                    <p className="text-xl text-slate-400 mb-8 max-w-2xl font-light leading-relaxed">
                        <strong className="text-slate-200 font-medium">Engineering Intelligence & Asset Management.</strong><br />
                        Monitor power quality, prevent failures, and optimize your electrical infrastructure with sub-second telemetry and AI-driven recommendations.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12 max-w-2xl">
                        <div className="flex items-center gap-3 text-slate-500 text-sm">
                            <Activity className="w-4 h-4 text-blue-500/70" /> Real-time telemetry
                        </div>
                        <div className="flex items-center gap-3 text-slate-500 text-sm">
                            <Gauge className="w-4 h-4 text-emerald-500/70" /> EN 50160 / NRS 048 reports
                        </div>
                        <div className="flex items-center gap-3 text-slate-500 text-sm">
                            <Zap className="w-4 h-4 text-amber-500/70" /> Predictive maintenance AI
                        </div>
                    </div>

                    <Link
                        href="/login"
                        className="inline-flex items-center gap-2 px-8 py-4 bg-slate-800 hover:bg-blue-600 border border-slate-700 hover:border-blue-500 text-white rounded-lg font-medium transition-all duration-300 shadow-lg hover:shadow-blue-600/25"
                    >
                        Sign in
                        <ArrowRight className="w-4 h-4" />
                    </Link>
                </div>
            </div>
        </main>
    );
}
