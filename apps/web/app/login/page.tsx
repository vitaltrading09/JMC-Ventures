"use client";

// GridIQ sign-in. Clients sign in with a one-time code emailed to them (no
// password to share or reuse); staff may use a password, followed by an
// authenticator code when MFA is enabled. A session proves who you are; what
// you can see still follows your assessment's dates on every request.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Zap, Lock, Mail, ArrowRight, ShieldCheck, Loader2, AlertCircle, KeyRound, CalendarClock } from "lucide-react";

type Step = "email" | "code" | "password" | "mfa";
const API = process.env.NEXT_PUBLIC_API_URL;
const input = "w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500";

export default function LoginPage() {
    const router = useRouter();
    const [step, setStep] = useState<Step>("email");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [mfaToken, setMfaToken] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [info, setInfo] = useState("");

    const post = async (path: string, body: unknown) => {
        const res = await fetch(`${API}/auth${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    };
    const done = (data: any) => {
        if (data.mfa_required) {
            if (data.mfa_token) { setMfaToken(data.mfa_token); setStep("mfa"); setInfo("Enter the code from your authenticator app."); }
            else setError(data.error ?? "Two-factor authentication must be set up for this account.");
            return;
        }
        localStorage.setItem("user", JSON.stringify(data.user)); // display info only; the session is an HttpOnly cookie
        const role = data.user?.role;
        router.push(role === "super_admin" || role === "engineer" ? "/ops" : "/portal");
    };
    const run = (fn: () => Promise<void>) => async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true); setError("");
        try { await fn(); } catch { setError("Could not reach GridIQ. Check your connection and try again."); } finally { setLoading(false); }
    };

    const requestCode = run(async () => {
        const r = await post("/login/code/request", { email });
        if (!r.ok) { setError(r.data.error ?? "Could not send a code"); return; }
        setInfo(r.data.message); setStep("code");
    });
    const verifyCode = run(async () => {
        const r = await post("/login/code/verify", { email, code });
        if (!r.ok) { setError(r.data.error ?? "That code is not valid"); return; }
        done(r.data);
    });
    const passwordLogin = run(async () => {
        const r = await post("/login", { email, password });
        if (!r.ok) { setError(r.data.error === "Invalid credentials" ? "Invalid email or password" : r.data.error ?? "Sign-in failed"); return; }
        done(r.data);
    });
    const mfa = run(async () => {
        const r = await post("/login/mfa", { mfa_token: mfaToken, code });
        if (!r.ok) { setError(r.data.error ?? "That code is not valid"); return; }
        done(r.data);
    });

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col md:flex-row">
            <div className="md:w-1/2 bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950 p-8 md:p-12 flex flex-col justify-between">
                <Link href="/" className="flex items-center gap-2 mb-8">
                    <Zap className="h-8 w-8 text-blue-500" />
                    <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">GridIQ</span>
                </Link>
                <div className="max-w-md space-y-5">
                    <h1 className="text-4xl font-bold text-white leading-tight">Measured, not guessed.</h1>
                    <p className="text-lg text-slate-400">
                        GridIQ installs a calibrated meter at your site for a fixed assessment period, shows you what it measures while it runs,
                        and hands over reports and clean data at the end.
                    </p>
                    <div className="flex flex-wrap gap-3 text-sm text-slate-300">
                        <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/50 border border-slate-700"><CalendarClock className="h-4 w-4 text-blue-400" />Access for your assessment period</span>
                        <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/50 border border-slate-700"><ShieldCheck className="h-4 w-4 text-emerald-400" />One-time sign-in codes</span>
                    </div>
                </div>
                <p className="text-sm text-slate-500 mt-8">© GridIQ</p>
            </div>

            <div className="md:w-1/2 flex items-center justify-center p-8">
                <div className="w-full max-w-md space-y-6">
                    <div>
                        <h2 className="text-2xl font-bold text-white">Sign in</h2>
                        <p className="mt-2 text-sm text-slate-400">
                            {step === "email" && "Enter the email address GridIQ invited. We email you a one-time code."}
                            {step === "code" && `Enter the 6-digit code sent to ${email}.`}
                            {step === "password" && "Staff sign-in with a password."}
                            {step === "mfa" && "Two-factor authentication."}
                        </p>
                    </div>
                    {error && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2"><AlertCircle className="h-4 w-4" />{error}</div>}
                    {info && !error && step !== "email" && <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-sm">{info}</div>}

                    {step === "email" && (
                        <form onSubmit={requestCode} className="space-y-4">
                            <div className="relative"><Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.co.za" className={input} /></div>
                            <Submit loading={loading} label="Email me a code" />
                            <button type="button" onClick={() => { setStep("password"); setError(""); }} className="text-sm text-slate-400 hover:text-white">Staff: sign in with a password</button>
                        </form>
                    )}
                    {(step === "code" || step === "mfa") && (
                        <form onSubmit={step === "code" ? verifyCode : mfa} className="space-y-4">
                            <div className="relative"><KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code}
                                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" className={input + " tracking-[0.4em] text-lg"} /></div>
                            <Submit loading={loading} label={step === "code" ? "Sign in" : "Verify"} />
                            {step === "code" && <button type="button" onClick={() => { setStep("email"); setCode(""); setError(""); }} className="text-sm text-slate-400 hover:text-white">Use another address or send a new code</button>}
                        </form>
                    )}
                    {step === "password" && (
                        <form onSubmit={passwordLogin} className="space-y-4">
                            <div className="relative"><Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@grid-iq.co.za" className={input} /></div>
                            <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                                <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className={input} /></div>
                            <Submit loading={loading} label="Sign in" />
                            <button type="button" onClick={() => { setStep("email"); setError(""); }} className="text-sm text-slate-400 hover:text-white">Sign in with an email code instead</button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}

function Submit({ loading, label }: { loading: boolean; label: string }) {
    return (
        <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <>{label}<ArrowRight className="h-4 w-4" /></>}
        </button>
    );
}
