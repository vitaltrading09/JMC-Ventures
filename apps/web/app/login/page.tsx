"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Zap, Lock, Mail, ArrowRight, ShieldCheck, Building2, Loader2, AlertCircle } from "lucide-react";

export default function LoginPage() {
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
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
                method: "POST",
                credentials: "include",  // receive the HTTPOnly session cookie
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Login failed");
            }

            // Token is now in an HTTPOnly cookie set by the server (not readable by JS).
            // Only store non-sensitive display info in localStorage.
            localStorage.setItem("user", JSON.stringify(data.user));

            // Grid-IQ staff to the ops console, everyone else to the client portal.
            const role = data.user?.role;
            router.push(role === "super_admin" || role === "engineer" ? "/ops" : "/portal");

        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col md:flex-row">
            {/* Brand Side (Left/Top) */}
            <div className="md:w-1/2 bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950 p-8 md:p-12 flex flex-col justify-between relative overflow-hidden">
                {/* Background Accents */}
                <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
                <div className="absolute bottom-0 left-0 w-64 h-64 bg-purple-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2"></div>

                {/* Logo */}
                <div className="relative z-10">
                    <Link href="/" className="flex items-center gap-2 mb-8">
                        <Zap className="h-8 w-8 text-blue-500" />
                        <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                            Grid-IQ
                        </span>
                    </Link>
                </div>

                {/* Content */}
                <div className="relative z-10 max-w-md space-y-6">
                    <h1 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                        Energy Clarity for the <br />
                        <span className="text-blue-400">Modern Enterprise</span>.
                    </h1>
                    <p className="text-lg text-slate-400">
                        AI-driven power quality monitoring and recommendations for industrial and commercial sites.
                        Monitor, diagnose, and optimize your electrical infrastructure.
                    </p>
                    <div className="flex flex-wrap gap-4 pt-4">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/50 border border-slate-700 text-sm text-slate-300">
                            <ShieldCheck className="h-4 w-4 text-emerald-400" />
                            Enterprise Secure
                        </div>
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/50 border border-slate-700 text-sm text-slate-300">
                            <Building2 className="h-4 w-4 text-blue-400" />
                            Multi-Tenant Ready
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="relative z-10 text-sm text-slate-500 mt-8 md:mt-0">
                    &copy; 2024 Grid-IQ Intelligence. All rights reserved.
                </div>
            </div>

            {/* Form Side (Right/Bottom) */}
            <div className="md:w-1/2 bg-slate-950 flex items-center justify-center p-8">
                <div className="w-full max-w-md space-y-8">
                    <div className="text-center md:text-left">
                        <h2 className="text-2xl font-bold text-white">Sign in</h2>
                        <p className="mt-2 text-sm text-slate-400">
                            Welcome back. Please enter your credentials.
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
                                        placeholder="name@company.com"
                                        required
                                        className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
                                    />
                                </div>
                            </div>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label htmlFor="password" className="block text-sm font-medium text-slate-300">Password</label>
                                    <a href="#" className="text-sm font-medium text-blue-400 hover:text-blue-300">Forgot password?</a>
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
                                        className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center">
                            <input
                                id="remember-me"
                                name="remember-me"
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-slate-900"
                            />
                            <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-400">
                                Remember me for 30 days
                            </label>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white rounded-lg py-2.5 font-medium shadow-[0_0_20px_rgba(37,99,235,0.3)] transition-all group"
                        >
                            {loading ? (
                                <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                                <>
                                    Sign In
                                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                                </>
                            )}
                        </button>

                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-slate-800"></div>
                            </div>
                            <div className="relative flex justify-center text-sm">
                                <span className="px-2 bg-slate-950 text-slate-500">Or continue with</span>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <button type="button" className="flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg py-2.5 text-sm font-medium text-white transition-colors">
                                <span className="text-[#EA4335]">G</span> Google
                            </button>
                            <button type="button" className="flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg py-2.5 text-sm font-medium text-white transition-colors">
                                <span className="text-[#0078D4]">M</span> Microsoft
                            </button>
                        </div>
                    </form>

                    <p className="text-center text-sm text-slate-500">
                        Don't have an account?{" "}
                        <a href="#" className="font-medium text-blue-400 hover:text-blue-300">Contact Sales</a>
                    </p>
                </div>
            </div>
        </div>
    );
}
