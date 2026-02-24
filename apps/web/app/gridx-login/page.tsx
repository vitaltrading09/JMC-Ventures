"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw, Lock, Mail, ArrowRight, ShieldCheck, TrendingUp, Loader2, AlertCircle } from "lucide-react";

export default function GridXLoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            const res = await fetch("http://localhost:8081/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Login failed");
            }

            // Success
            // Store token in localStorage for API calls
            localStorage.setItem("token", data.token);
            localStorage.setItem("user", JSON.stringify(data.user));

            // Set cookie for middleware
            document.cookie = `token=${data.token}; path=/; max-age=86400; SameSite=Strict`;

            // Redirect to dashboard (Grid-X users still use the core dashboard for now, 
            // but we could route them to a specific /gridx-dashboard later)
            router.push("/dashboard");

        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col md:flex-row">
            {/* Brand Side (Left/Top) */}
            <div className="md:w-1/2 bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-950 p-8 md:p-12 flex flex-col justify-between relative overflow-hidden">
                {/* Background Accents */}
                <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
                <div className="absolute bottom-0 left-0 w-64 h-64 bg-teal-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2"></div>
                <div className="absolute inset-0 opacity-[0.03] bg-[linear-gradient(rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.1)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none" />

                {/* Logo */}
                <div className="relative z-10 w-fit">
                    <Link href="/" className="flex items-center gap-2 mb-8 group p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 backdrop-blur-sm transition-colors hover:bg-emerald-500/20">
                        <RefreshCw className="h-8 w-8 text-emerald-400 group-hover:rotate-180 transition-transform duration-700 ease-in-out" />
                        <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-300 to-teal-100 pr-2">
                            Grid-X
                        </span>
                    </Link>
                </div>

                {/* Content */}
                <div className="relative z-10 max-w-md space-y-6">
                    <h1 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                        The Future of <br />
                        <span className="text-emerald-400">Energy Trading</span>.
                    </h1>
                    <p className="text-lg text-emerald-100/70">
                        Monetize your precinct surplus and access peer-to-peer wheeling.
                        Powered by the PowerGuard network.
                    </p>
                    <div className="flex flex-wrap gap-4 pt-4">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-900/40 border border-emerald-800/50 text-sm text-emerald-100/80">
                            <TrendingUp className="h-4 w-4 text-emerald-400" />
                            Automated Settlement
                        </div>
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-900/40 border border-emerald-800/50 text-sm text-emerald-100/80">
                            <ShieldCheck className="h-4 w-4 text-emerald-400" />
                            PowerGuard Verified credentials
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="relative z-10 text-sm text-slate-500 mt-8 md:mt-0">
                    &copy; 2024 Grid-X Exchange. All rights reserved.
                </div>
            </div>

            {/* Form Side (Right/Bottom) */}
            <div className="md:w-1/2 bg-slate-950 flex items-center justify-center p-8">
                <div className="w-full max-w-md space-y-8">
                    <div className="text-center md:text-left">
                        <h2 className="text-2xl font-bold text-white">Trading Floor Access</h2>
                        <p className="mt-2 text-sm text-slate-400">
                            Enter your Grid-X or PowerGuard credentials.
                        </p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-6">
                        {error && (
                            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
                                <AlertCircle className="h-4 w-4" />
                                {error}
                            </div>
                        )}

                        <div className="space-y-4">
                            <div>
                                <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1">Email Address</label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                    <input
                                        id="email"
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="trader@company.com"
                                        required
                                        className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all"
                                    />
                                </div>
                            </div>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label htmlFor="password" className="block text-sm font-medium text-slate-300">Password</label>
                                    <a href="#" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">Forgot password?</a>
                                </div>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                    <input
                                        id="password"
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center">
                            <input
                                id="remember-me"
                                name="remember-me"
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500 focus:ring-offset-slate-900"
                            />
                            <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-400">
                                Remember me for 30 days
                            </label>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-emerald-800/50 disabled:cursor-not-allowed text-white rounded-lg py-2.5 font-medium shadow-[0_0_20px_rgba(5,150,105,0.3)] transition-all group"
                        >
                            {loading ? (
                                <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                                <>
                                    Enter Trading Floor
                                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                                </>
                            )}
                        </button>

                    </form>

                    {/* Demo Credentials */}
                    <div className="mt-4 p-3 rounded-lg bg-emerald-950/30 border border-emerald-800/30">
                        <p className="text-xs text-emerald-400 font-medium mb-2">⚡ Shared Auth — you can use PowerGuard accounts:</p>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => { setEmail("demo@powerguard.com"); setPassword("password123"); }}
                                className="text-left p-2 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-700 transition-colors"
                            >
                                <p className="text-[10px] text-slate-400">Client View</p>
                                <p className="text-xs text-white font-mono truncate">demo@powerguard.com</p>
                            </button>
                            <button
                                type="button"
                                onClick={() => { setEmail("admin@powerguard.com"); setPassword("password123"); }}
                                className="text-left p-2 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-700 transition-colors"
                            >
                                <p className="text-[10px] text-slate-400">Super Admin</p>
                                <p className="text-xs text-white font-mono truncate">admin@powerguard.com</p>
                            </button>
                        </div>
                    </div>

                    <p className="text-center text-sm text-slate-500">
                        Want to list your assets?{" "}
                        <a href="#" className="font-medium text-emerald-400 hover:text-emerald-300">Join the Network</a>
                    </p>
                </div>
            </div>
        </div>
    );
}
