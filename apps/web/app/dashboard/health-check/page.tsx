"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Printer, Loader2, Activity, Sparkles, Send,
    Share2, X, Copy, Check, Trash2, Link as LinkIcon, Eye,
} from "lucide-react";
import HealthCheckReport, {
    ComplianceReport, Branding, Forecast,
} from "@/components/report/HealthCheckReport";

interface Meter { id: string; name: string; site_id: string; is_active?: boolean; }

interface ShareLink {
    id: string; label: string | null; period_days: number;
    expires_at: string; revoked_at: string | null;
    view_count: number; last_viewed_at: string | null;
    created_at: string; is_live: boolean;
}

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

export default function HealthCheckPage() {
    const [meters,   setMeters]   = useState<Meter[]>([]);
    const [meterId,  setMeterId]  = useState<string>("");
    const [days,     setDays]     = useState(7);
    const [report,   setReport]   = useState<ComplianceReport | null>(null);
    const [brand,    setBrand]    = useState<Branding | null>(null);
    const [forecast, setForecast] = useState<Forecast | null>(null);
    const [summary,     setSummary]     = useState<string | null>(null);
    const [summaryBusy, setSummaryBusy] = useState(false);
    const [question,    setQuestion]    = useState("");
    const [qaLog,       setQaLog]       = useState<{ role: "user" | "assistant"; content: string }[]>([]);
    const [asking,      setAsking]      = useState(false);
    const [loading,  setLoading]  = useState(true);
    const [busy,     setBusy]     = useState(false);

    // Share state
    const [shareOpen,   setShareOpen]   = useState(false);
    const [shares,      setShares]      = useState<ShareLink[]>([]);
    const [shareLabel,  setShareLabel]  = useState("");
    const [shareDays,   setShareDays]   = useState(30);
    const [issuing,     setIssuing]     = useState(false);
    const [freshLink,   setFreshLink]   = useState<string | null>(null);
    const [copied,      setCopied]      = useState(false);

    // Print stylesheet — the report must come out of a printer looking like a
    // document an engineer would sign, not a screenshot of a web page.
    useEffect(() => {
        const el = document.createElement("style");
        el.id = "pq-print";
        el.innerHTML = `
            @media print {
                [data-noprint="true"] { display: none !important; }
                body { background: #fff !important; }
                .pq-page { box-shadow: none !important; margin: 0 !important; }
                .pq-break { break-inside: avoid; page-break-inside: avoid; }
                @page { margin: 14mm; size: A4 portrait; }
            }
        `;
        document.head.appendChild(el);
        return () => { el.remove(); };
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/ingestion/meters`, { credentials: "include" });
                if (res.status === 401) { window.location.href = "/login"; return; }
                const data = await res.json();
                const list: Meter[] = Array.isArray(data) ? data.filter(m => m.is_active !== false) : [];
                setMeters(list);
                if (list.length > 0) setMeterId(list[0].id);

                fetch(`${API}/ingestion/branding`, { credentials: "include" })
                    .then(r => r.ok ? r.json() : null)
                    .then(b => { if (b) setBrand(b); })
                    .catch(() => { /* falls back to Grid-IQ branding */ });
            } catch { /* offline — empty state */ }
            finally { setLoading(false); }
        })();
    }, []);

    const runCheck = useCallback(async () => {
        if (!meterId) return;
        setBusy(true);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/compliance?days=${days}`, {
                credentials: "include",
            });
            setReport(res.ok ? await res.json() : null);
        } catch { setReport(null); }
        finally { setBusy(false); }
    }, [meterId, days]);

    useEffect(() => { if (meterId) runCheck(); }, [meterId, days, runCheck]);

    // Long-run trend and threshold projection.
    useEffect(() => {
        if (!meterId) return;
        setForecast(null);
        fetch(`${API}/ingestion/meters/${meterId}/forecast?weeks=12`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(f => setForecast(f))
            .catch(() => setForecast(null));
    }, [meterId]);

    // Executive summary is fetched separately so a slow (or unavailable) AI call
    // never delays or blocks the engineering report, which stands on its own.
    useEffect(() => {
        if (!meterId) return;
        setSummary(null);
        setQaLog([]);
        setSummaryBusy(true);
        fetch(`${API}/ingestion/meters/${meterId}/compliance/summary?days=${days}`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => setSummary(d?.summary ?? null))
            .catch(() => setSummary(null))
            .finally(() => setSummaryBusy(false));
    }, [meterId, days]);

    // ── Sharing ──────────────────────────────────────────────────────────────
    const loadShares = useCallback(async () => {
        if (!meterId) return;
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/shares`, { credentials: "include" });
            setShares(res.ok ? await res.json() : []);
        } catch { setShares([]); }
    }, [meterId]);

    useEffect(() => { if (shareOpen) loadShares(); }, [shareOpen, loadShares]);

    const issueLink = async () => {
        if (!meterId || issuing) return;
        setIssuing(true);
        setFreshLink(null);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/shares`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label: shareLabel, days_valid: shareDays, period_days: days }),
            });
            if (res.ok) {
                const data = await res.json();
                setFreshLink(`${window.location.origin}${data.path}`);
                setShareLabel("");
                loadShares();
            }
        } catch { /* modal stays open; user can retry */ }
        finally { setIssuing(false); }
    };

    const revokeLink = async (id: string) => {
        try {
            const res = await fetch(`${API}/ingestion/shares/${id}`, {
                method: "DELETE", credentials: "include",
            });
            if (res.ok) loadShares();
        } catch { /* no-op */ }
    };

    const copyLink = async () => {
        if (!freshLink) return;
        try {
            await navigator.clipboard.writeText(freshLink);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard blocked — the input is selectable */ }
    };

    const askQuestion = async (q: string) => {
        const text = q.trim();
        if (!text || asking || !meterId) return;
        setQuestion("");
        const history = qaLog.slice(-6);
        setQaLog(prev => [...prev, { role: "user", content: text }]);
        setAsking(true);
        try {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/compliance/ask`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: text, days, history }),
            });
            const data = res.ok ? await res.json() : null;
            setQaLog(prev => [...prev, {
                role: "assistant",
                content: data?.answer ?? "I couldn't answer that just now — the analysis service is unavailable.",
            }]);
        } catch {
            setQaLog(prev => [...prev, { role: "assistant", content: "Connection failed. Please try again." }]);
        } finally {
            setAsking(false);
        }
    };

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    return (
        // Escape the dark dashboard chrome — this is a printable white document.
        <div className="-m-4 sm:-m-6 lg:-m-8 bg-slate-100 min-h-screen">

            {/* ── Controls (never printed) ──────────────────────────────── */}
            <div data-noprint="true" className="bg-slate-900 border-b border-slate-800 px-6 py-4">
                <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-3">
                    <div className="mr-auto">
                        <h1 className="text-lg font-bold text-white">Power Quality Health Check</h1>
                        <p className="text-xs text-slate-400">
                            NRS 048-2 compliance assessment and equipment risk report
                        </p>
                    </div>
                    <select
                        value={meterId}
                        onChange={e => setMeterId(e.target.value)}
                        className="bg-slate-800 border border-slate-700 text-white text-sm rounded-lg px-3 py-2"
                    >
                        {meters.length === 0
                            ? <option value="">No meters</option>
                            : meters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <select
                        value={days}
                        onChange={e => setDays(Number(e.target.value))}
                        className="bg-slate-800 border border-slate-700 text-white text-sm rounded-lg px-3 py-2"
                    >
                        <option value={7}>7 days</option>
                        <option value={14}>14 days</option>
                        <option value={30}>30 days</option>
                    </select>
                    <button
                        onClick={() => { setShareOpen(true); setFreshLink(null); }}
                        disabled={!report}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
                    >
                        <Share2 className="h-4 w-4" /> Share
                    </button>
                    <button
                        onClick={() => window.print()}
                        disabled={!report}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
                    >
                        <Printer className="h-4 w-4" /> Print / PDF
                    </button>
                </div>
            </div>

            {busy && (
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                </div>
            )}

            {!busy && !report && (
                <div className="max-w-4xl mx-auto px-6 py-24 text-center">
                    <Activity className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                    <p className="text-slate-700 font-medium text-lg">No assessment available</p>
                    <p className="text-slate-500 text-sm mt-2">
                        Select a meter with recent telemetry to generate a health check.
                    </p>
                </div>
            )}

            {!busy && report && (
                <HealthCheckReport
                    report={report}
                    brand={brand}
                    forecast={forecast}
                    summary={summary}
                    summaryBusy={summaryBusy}
                >
                    {/* ── Ask about this report (owner only, screen only) ── */}
                    <div data-noprint="true" className="mt-9 rounded-xl border border-slate-200 bg-slate-50 p-5">
                        <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-blue-600" />
                            <p className="text-sm font-semibold text-slate-900">Ask about this report</p>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                            Answers come only from the measurements above — if something wasn&apos;t measured, it will say so.
                        </p>

                        {qaLog.length === 0 && !asking && (
                            <div className="flex flex-wrap gap-2 mt-4">
                                {[
                                    "Is this the municipality's fault or mine?",
                                    "What should I fix first?",
                                    "What is this costing me?",
                                    "Is my equipment in danger?",
                                ].map(s => (
                                    <button
                                        key={s}
                                        onClick={() => askQuestion(s)}
                                        className="px-3 py-1.5 rounded-full border border-slate-300 bg-white text-xs text-slate-700 hover:border-blue-400 hover:text-blue-700 transition-colors"
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        )}

                        {qaLog.length > 0 && (
                            <div className="mt-4 space-y-3 max-h-[420px] overflow-y-auto">
                                {qaLog.map((m, i) => (
                                    <div
                                        key={i}
                                        className={m.role === "user"
                                            ? "ml-auto max-w-[85%] rounded-lg bg-blue-600 text-white px-3 py-2 text-sm"
                                            : "mr-auto max-w-[92%] rounded-lg bg-white border border-slate-200 px-3 py-2 text-sm text-slate-800 whitespace-pre-wrap"}
                                    >
                                        {/* The model uses ** for emphasis; render it as bold rather
                                            than leaking raw markdown into a client-facing document. */}
                                        {m.role === "assistant"
                                            ? m.content.split(/(\*\*[^*]+\*\*)/g).map((chunk, j) =>
                                                chunk.startsWith("**") && chunk.endsWith("**")
                                                    ? <strong key={j}>{chunk.slice(2, -2)}</strong>
                                                    : <span key={j}>{chunk}</span>)
                                            : m.content}
                                    </div>
                                ))}
                                {asking && (
                                    <div className="mr-auto flex items-center gap-2 text-sm text-slate-500 px-3 py-2">
                                        <Loader2 className="h-4 w-4 animate-spin" /> Checking the measurements…
                                    </div>
                                )}
                            </div>
                        )}

                        <form
                            onSubmit={e => { e.preventDefault(); askQuestion(question); }}
                            className="flex gap-2 mt-4"
                        >
                            <input
                                value={question}
                                onChange={e => setQuestion(e.target.value)}
                                placeholder="Ask anything about these findings…"
                                className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <button
                                type="submit"
                                disabled={asking || !question.trim()}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
                            >
                                <Send className="h-4 w-4" /> Ask
                            </button>
                        </form>
                    </div>
                </HealthCheckReport>
            )}

            {/* ── Share modal ────────────────────────────────────────────── */}
            {shareOpen && (
                <div
                    data-noprint="true"
                    className="fixed inset-0 z-50 bg-slate-900/60 flex items-start justify-center p-4 overflow-y-auto"
                    onClick={() => setShareOpen(false)}
                >
                    <div
                        className="bg-white rounded-xl shadow-xl w-full max-w-lg my-12"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between p-5 border-b border-slate-200">
                            <div>
                                <h2 className="font-bold text-slate-900">Share this report</h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Creates a read-only link. Anyone with it can view this one report — no login, no
                                    access to anything else in your account.
                                </p>
                            </div>
                            <button onClick={() => setShareOpen(false)} className="text-slate-400 hover:text-slate-600">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            {freshLink ? (
                                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                                    <p className="text-sm font-semibold text-emerald-800">Link created</p>
                                    <p className="text-xs text-emerald-700 mt-1">
                                        Copy it now — for security it is not stored and cannot be shown again.
                                        You can always issue another.
                                    </p>
                                    <div className="flex gap-2 mt-3">
                                        <input
                                            readOnly
                                            value={freshLink}
                                            onFocus={e => e.currentTarget.select()}
                                            className="flex-1 bg-white border border-emerald-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-700"
                                        />
                                        <button
                                            onClick={copyLink}
                                            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium shrink-0"
                                        >
                                            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                            {copied ? "Copied" : "Copy"}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <label className="block text-xs font-medium text-slate-600 mb-1">
                                            Who is this for? <span className="text-slate-400">(optional, for your records)</span>
                                        </label>
                                        <input
                                            value={shareLabel}
                                            onChange={e => setShareLabel(e.target.value)}
                                            placeholder="e.g. Broker — renewal review"
                                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-slate-600 mb-1">Link expires after</label>
                                        <select
                                            value={shareDays}
                                            onChange={e => setShareDays(Number(e.target.value))}
                                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900"
                                        >
                                            <option value={7}>7 days</option>
                                            <option value={30}>30 days</option>
                                            <option value={90}>90 days</option>
                                            <option value={365}>1 year</option>
                                        </select>
                                    </div>
                                    <button
                                        onClick={issueLink}
                                        disabled={issuing}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
                                    >
                                        {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <LinkIcon className="h-4 w-4" />}
                                        Create link
                                    </button>
                                </>
                            )}

                            {/* Existing links */}
                            {shares.length > 0 && (
                                <div className="pt-2">
                                    <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                                        Existing links
                                    </p>
                                    <div className="space-y-2 max-h-64 overflow-y-auto">
                                        {shares.map(s => (
                                            <div
                                                key={s.id}
                                                className={`flex items-center gap-3 rounded-lg border p-3 ${
                                                    s.is_live ? "border-slate-200" : "border-slate-100 bg-slate-50 opacity-60"
                                                }`}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium text-slate-800 truncate">
                                                        {s.label || "Untitled link"}
                                                    </p>
                                                    <p className="text-[11px] text-slate-500">
                                                        {s.revoked_at
                                                            ? "Revoked"
                                                            : new Date(s.expires_at) < new Date()
                                                                ? "Expired"
                                                                : `Expires ${new Date(s.expires_at).toLocaleDateString("en-ZA")}`}
                                                        {" · "}
                                                        <span className="inline-flex items-center gap-1">
                                                            <Eye className="h-3 w-3" />{s.view_count} view{s.view_count === 1 ? "" : "s"}
                                                        </span>
                                                    </p>
                                                </div>
                                                {s.is_live && (
                                                    <button
                                                        onClick={() => revokeLink(s.id)}
                                                        title="Revoke this link"
                                                        className="text-slate-400 hover:text-red-600 shrink-0"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
