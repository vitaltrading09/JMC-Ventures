import Link from "next/link";
import { Shield, RefreshCw, Zap, ArrowRight, Activity, BarChart3, Globe } from "lucide-react";

export default function Home() {
    return (
        <main className="flex min-h-screen flex-col lg:flex-row items-stretch justify-center bg-slate-950 text-white overflow-hidden">

            {/* Left Side: PowerGuard */}
            <div className="flex-1 relative flex flex-col justify-center p-12 lg:p-24 bg-gradient-to-br from-slate-950 to-slate-900 border-b lg:border-b-0 lg:border-r border-slate-800 transition-all duration-500 hover:bg-slate-900 group">
                {/* Background Pattern */}
                <div className="absolute inset-0 opacity-[0.03] bg-[linear-gradient(rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.1)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none" />

                <div className="relative z-10 max-w-xl mx-auto lg:mr-0 w-full transform transition-transform duration-500 group-hover:translate-x-2">
                    <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700 flex items-center justify-center mb-8 shadow-lg shadow-blue-900/20 backdrop-blur-sm">
                        <Shield className="w-8 h-8 text-blue-400 group-hover:text-blue-300 transition-colors" />
                    </div>

                    <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-transparent bg-clip-text bg-gradient-to-r from-slate-100 to-slate-400">
                        PowerGuard
                    </h1>

                    <p className="text-xl text-slate-400 mb-8 max-w-md font-light leading-relaxed">
                        <strong className="text-slate-200 font-medium">Engineering Intelligence & Asset Management.</strong><br />
                        Monitor power quality, prevent failures, and optimize your electrical infrastructure with sub-second telemetry.
                    </p>

                    <div className="flex flex-col gap-4 mb-12">
                        <div className="flex items-center gap-3 text-slate-500 text-sm">
                            <Activity className="w-4 h-4 text-blue-500/70" /> Real-time active power monitoring
                        </div>
                        <div className="flex items-center gap-3 text-slate-500 text-sm">
                            <Zap className="w-4 h-4 text-amber-500/70" /> Predictive maintenance AI
                        </div>
                    </div>

                    <Link
                        href="/login?mode=powerguard"
                        className="inline-flex items-center gap-2 px-8 py-4 bg-slate-800 hover:bg-blue-600 border border-slate-700 hover:border-blue-500 text-white rounded-lg font-medium transition-all duration-300 shadow-lg hover:shadow-blue-600/25"
                    >
                        Enter Management Suite
                        <ArrowRight className="w-4 h-4" />
                    </Link>
                </div>
            </div>

            {/* Right Side: Grid-X */}
            <div className="flex-1 relative flex flex-col justify-center p-12 lg:p-24 bg-gradient-to-bl from-emerald-950/40 to-slate-950 transition-all duration-500 hover:bg-emerald-950/60 group">
                {/* Background Glow */}
                <div className="absolute inset-0 bg-emerald-500/5 blur-[120px] rounded-full mix-blend-screen pointer-events-none transform group-hover:bg-emerald-500/10 transition-colors duration-700" />

                <div className="relative z-10 max-w-xl mx-auto lg:ml-0 w-full transform transition-transform duration-500 group-hover:-translate-x-2">
                    <div className="w-16 h-16 rounded-2xl bg-emerald-900/30 border border-emerald-800/50 flex items-center justify-center mb-8 shadow-lg shadow-emerald-900/20 backdrop-blur-sm">
                        <RefreshCw className="w-8 h-8 text-emerald-400 group-hover:text-emerald-300 transition-colors" />
                    </div>

                    <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 to-teal-100">
                        Grid-X
                    </h1>

                    <p className="text-xl text-emerald-100/70 mb-8 max-w-md font-light leading-relaxed">
                        <strong className="text-emerald-50 font-medium">The Energy Exchange. Monetize your Surplus.</strong><br />
                        Turn your unused solar and battery capacity into automated revenue via precinct-level wheeling.
                    </p>

                    <div className="flex flex-col gap-4 mb-12">
                        <div className="flex items-center gap-3 text-emerald-500/70 text-sm">
                            <BarChart3 className="w-4 h-4 text-emerald-400" /> Automated trading & settlement
                        </div>
                        <div className="flex items-center gap-3 text-emerald-500/70 text-sm">
                            <Globe className="w-4 h-4 text-teal-400" /> Peer-to-peer precinct wheeling
                        </div>
                    </div>

                    <Link
                        href="/gridx-login"
                        className="inline-flex items-center gap-2 px-8 py-4 bg-emerald-900/40 hover:bg-emerald-600 border border-emerald-800/50 hover:border-emerald-500 text-emerald-50 hover:text-white rounded-lg font-medium transition-all duration-300 shadow-lg hover:shadow-emerald-600/25"
                    >
                        Enter Trading Floor
                        <ArrowRight className="w-4 h-4" />
                    </Link>
                </div>
            </div>

        </main>
    );
}
