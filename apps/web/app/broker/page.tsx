"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import {
    Loader2, ShieldCheck, ShieldAlert, ShieldX, MinusCircle,
    TrendingDown, ChevronDown, ChevronRight, WifiOff, Building2, CalendarClock,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Broker portfolio.
//
// A triage queue, not a directory: the server orders by worst verdict, then
// deterioration, then weakest installation, so the client needing attention is
// the first row. A broker with forty clients should not have to hunt.
// ─────────────────────────────────────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

interface Client {
    tenant_id: string;
    client_name: string;
    site_count: number;
    meter_count: number;
    last_reading: string | null;
    assessed_meters: number | null;
    min_supply: number | null;
    min_install: number | null;
    open_findings: number | null;
    degrading_params: number | null;
    last_assessed: string | null;
    worst_rank: number | null;
    renewal_date: string | null;
    renewal_days_out: number | null;
}

interface RenewalReview {
    headline: string;
    has_baseline: boolean;
    total_closed: number;
    total_opened: number;
    total_now_findings: number;
    install_delta: number | null;
    policy_year_from: string;
    policy_year_to: string;
}

interface ClientMeter {
    meter_id: string; meter_name: string;
    site_id: string; site_name: string;
    assessed_at: string | null;
    verdict: string | null;
    supply_score: number | null;
    install_score: number | null;
    open_findings: number;
}

const VERDICT_BY_RANK: Record<number, { label: string; cls: string; icon: React.ElementType }> = {
    1: { label: "Non-compliant",   cls: "text-red-400 bg-red-500/10 border-red-500/30",       icon: ShieldX },
    2: { label: "Compliant — risk", cls: "text-amber-400 bg-amber-500/10 border-amber-500/30", icon: ShieldAlert },
    3: { label: "Compliant",       cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30", icon: ShieldCheck },
    4: { label: "Not assessed",    cls: "text-slate-400 bg-slate-500/10 border-slate-500/30",  icon: MinusCircle },
};

function scoreCls(s: number | null) {
    if (s === null) return "text-slate-500";
    if (s >= 85) return "text-emerald-400";
    if (s >= 70) return "text-amber-400";
    return "text-red-400";
}

/** Telemetry older than a day means the site has gone quiet — itself a finding. */
function freshness(last: string | null): { text: string; stale: boolean } {
    if (!last) return { text: "No data", stale: true };
    const hours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (hours < 1)  return { text: "Live", stale: false };
    if (hours < 24) return { text: `${Math.floor(hours)}h ago`, stale: false };
    return { text: `${Math.floor(hours / 24)}d ago`, stale: true };
}

export default function BrokerPortfolioPage() {
    const [clients, setClients] = useState<Client[]>([]);
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [meters,  setMeters]  = useState<Record<string, ClientMeter[]>>({});
    const [reviews, setReviews] = useState<Record<string, RenewalReview | null>>({});
    const [savingDate, setSavingDate] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/ingestion/broker/clients`, { credentials: "include" });
                if (res.status === 401) { window.location.href = "/login"; return; }
                if (res.status === 403) { setError("This account is not set up as a broker."); return; }
                if (!res.ok) { setError("Could not load your portfolio."); return; }
                setClients(await res.json());
            } catch {
                setError("Could not reach the server.");
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const toggle = useCallback(async (tenantId: string) => {
        if (expanded === tenantId) { setExpanded(null); return; }
        setExpanded(tenantId);
        if (meters[tenantId]) return;
        try {
            const res = await fetch(`${API}/ingestion/broker/clients/${tenantId}/meters`, {
                credentials: "include",
            });
            if (res.ok) {
                const data: ClientMeter[] = await res.json();
                setMeters(prev => ({ ...prev, [tenantId]: data }));
            }
        } catch { /* row simply stays empty */ }

        // Year-on-year comparison, fetched on demand rather than for every row.
        try {
            const rv = await fetch(`${API}/ingestion/broker/clients/${tenantId}/renewal-review`,
                { credentials: "include" });
            const review: RenewalReview | null = rv.ok ? await rv.json() : null;
            setReviews(prev => ({ ...prev, [tenantId]: review }));
        } catch {
            setReviews(prev => ({ ...prev, [tenantId]: null }));
        }
    }, [expanded, meters]);

    const saveRenewal = async (tenantId: string, value: string) => {
        setSavingDate(tenantId);
        try {
            const res = await fetch(`${API}/ingestion/broker/clients/${tenantId}/renewal`, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ renewal_date: value || null }),
            });
            if (res.ok) {
                const days = value
                    ? Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000)
                    : null;
                setClients(prev => prev.map(c => c.tenant_id === tenantId
                    ? { ...c, renewal_date: value || null, renewal_days_out: days }
                    : c));
            }
        } catch { /* leave the previous value in place */ }
        finally { setSavingDate(null); }
    };

    if (loading) return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    const needAttention = clients.filter(c => (c.worst_rank ?? 4) <= 2).length;
    const deteriorating = clients.filter(c => (c.degrading_params ?? 0) > 0).length;
    const quiet = clients.filter(c => freshness(c.last_reading).stale).length;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200">
            <header className="border-b border-slate-800 px-6 py-5">
                <div className="max-w-7xl mx-auto">
                    <h1 className="text-xl font-bold text-white">Portfolio</h1>
                    <p className="text-xs text-slate-400 mt-0.5">
                        Ordered by what needs attention first — worst finding, then deterioration, then weakest installation.
                    </p>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-6 py-6">
                {error && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
                        {error}
                    </div>
                )}

                {!error && clients.length === 0 && (
                    <div className="text-center py-24">
                        <Building2 className="h-12 w-12 text-slate-600 mx-auto mb-4" />
                        <p className="text-slate-300 font-medium">No clients yet</p>
                        <p className="text-sm text-slate-500 mt-1">
                            Client access is granted by the Grid-IQ team. Once granted, they appear here.
                        </p>
                    </div>
                )}

                {!error && clients.length > 0 && (
                    <>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                            {[
                                { label: "Clients",       value: clients.length,  cls: "text-white" },
                                { label: "Need attention", value: needAttention,  cls: needAttention ? "text-amber-400" : "text-emerald-400" },
                                { label: "Deteriorating",  value: deteriorating,  cls: deteriorating ? "text-red-400" : "text-emerald-400" },
                                { label: "Gone quiet",     value: quiet,          cls: quiet ? "text-amber-400" : "text-emerald-400" },
                            ].map(s => (
                                <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                                    <p className="text-[11px] uppercase tracking-wider text-slate-500">{s.label}</p>
                                    <p className={`text-3xl font-bold mt-1 ${s.cls}`}>{s.value}</p>
                                </div>
                            ))}
                        </div>

                        <div className="rounded-xl border border-slate-800 overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-slate-900/60">
                                    <tr className="text-[11px] uppercase tracking-wider text-slate-500">
                                        <th className="text-left  px-4 py-3 font-medium">Client</th>
                                        <th className="text-left  px-3 py-3 font-medium">Status</th>
                                        <th className="text-right px-3 py-3 font-medium">Supply</th>
                                        <th className="text-right px-3 py-3 font-medium">Install</th>
                                        <th className="text-right px-3 py-3 font-medium">Findings</th>
                                        <th className="text-right px-3 py-3 font-medium">Worsening</th>
                                        <th className="text-right px-3 py-3 font-medium">Renewal</th>
                                        <th className="text-right px-4 py-3 font-medium">Telemetry</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                    {clients.map(c => {
                                        const v = VERDICT_BY_RANK[c.worst_rank ?? 4];
                                        const VIcon = v.icon;
                                        const fresh = freshness(c.last_reading);
                                        const isOpen = expanded === c.tenant_id;
                                        return (
                                            <Fragment key={c.tenant_id}>
                                                <tr
                                                    onClick={() => toggle(c.tenant_id)}
                                                    className="hover:bg-slate-900/40 cursor-pointer"
                                                >
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center gap-2">
                                                            {isOpen
                                                                ? <ChevronDown className="h-4 w-4 text-slate-500 shrink-0" />
                                                                : <ChevronRight className="h-4 w-4 text-slate-500 shrink-0" />}
                                                            <div>
                                                                <p className="font-medium text-white">{c.client_name}</p>
                                                                <p className="text-xs text-slate-500">
                                                                    {c.site_count} site{c.site_count === 1 ? "" : "s"} · {c.meter_count} meter{c.meter_count === 1 ? "" : "s"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs font-medium ${v.cls}`}>
                                                            <VIcon className="h-3.5 w-3.5" /> {v.label}
                                                        </span>
                                                    </td>
                                                    <td className={`px-3 py-3 text-right font-semibold ${scoreCls(c.min_supply)}`}>
                                                        {c.min_supply ?? "—"}
                                                    </td>
                                                    <td className={`px-3 py-3 text-right font-semibold ${scoreCls(c.min_install)}`}>
                                                        {c.min_install ?? "—"}
                                                    </td>
                                                    <td className="px-3 py-3 text-right">
                                                        <span className={(c.open_findings ?? 0) > 0 ? "text-amber-400 font-semibold" : "text-slate-500"}>
                                                            {c.open_findings ?? 0}
                                                        </span>
                                                    </td>
                                                    <td className="px-3 py-3 text-right">
                                                        {(c.degrading_params ?? 0) > 0 ? (
                                                            <span className="inline-flex items-center gap-1 text-red-400 font-semibold">
                                                                <TrendingDown className="h-3.5 w-3.5" />{c.degrading_params}
                                                            </span>
                                                        ) : <span className="text-slate-600">—</span>}
                                                    </td>
                                                    <td className="px-3 py-3 text-right">
                                                        {c.renewal_days_out === null ? (
                                                            <span className="text-slate-600 text-xs">Not set</span>
                                                        ) : (
                                                            <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                                                                c.renewal_days_out <= 30 ? "text-red-400"
                                                                : c.renewal_days_out <= 60 ? "text-amber-400"
                                                                : "text-slate-400"}`}>
                                                                <CalendarClock className="h-3.5 w-3.5" />
                                                                {c.renewal_days_out < 0 ? "Passed" : `${c.renewal_days_out}d`}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3 text-right">
                                                        <span className={`inline-flex items-center gap-1 text-xs ${fresh.stale ? "text-amber-400" : "text-slate-400"}`}>
                                                            {fresh.stale && <WifiOff className="h-3.5 w-3.5" />}{fresh.text}
                                                        </span>
                                                    </td>
                                                </tr>

                                                {isOpen && (
                                                    <tr className="bg-slate-900/30">
                                                        <td colSpan={8} className="px-4 py-3">
                                                            {!meters[c.tenant_id] ? (
                                                                <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading meters…
                                                                </div>
                                                            ) : meters[c.tenant_id].length === 0 ? (
                                                                <p className="text-xs text-slate-500 py-2">No active meters.</p>
                                                            ) : (
                                                                <div className="space-y-1.5">
                                                                    {meters[c.tenant_id].map(m => (
                                                                        <div key={m.meter_id}
                                                                             className="flex items-center gap-3 text-xs py-1.5 border-b border-slate-800/60 last:border-0">
                                                                            <span className="text-slate-300 flex-1">
                                                                                {m.site_name} — <span className="text-slate-400">{m.meter_name}</span>
                                                                            </span>
                                                                            <span className={scoreCls(m.supply_score)}>supply {m.supply_score ?? "—"}</span>
                                                                            <span className={scoreCls(m.install_score)}>install {m.install_score ?? "—"}</span>
                                                                            <span className={m.open_findings > 0 ? "text-amber-400" : "text-slate-600"}>
                                                                                {m.open_findings} finding{m.open_findings === 1 ? "" : "s"}
                                                                            </span>
                                                                            <span className="text-slate-600">
                                                                                {m.assessed_at
                                                                                    ? new Date(m.assessed_at).toLocaleDateString("en-ZA")
                                                                                    : "not assessed"}
                                                                            </span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}

                                                            {/* Renewal: the date the broker supplies, and what the
                                                                policy year did to this account. */}
                                                            <div className="mt-3 pt-3 border-t border-slate-800/60 flex flex-wrap items-start gap-4">
                                                                <div onClick={e => e.stopPropagation()}>
                                                                    <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                                                                        Insurance renewal
                                                                    </label>
                                                                    <input
                                                                        type="date"
                                                                        defaultValue={c.renewal_date ? c.renewal_date.slice(0, 10) : ""}
                                                                        onChange={e => saveRenewal(c.tenant_id, e.target.value)}
                                                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                                                                    />
                                                                    {savingDate === c.tenant_id && (
                                                                        <span className="ml-2 text-[10px] text-slate-500">saving...</span>
                                                                    )}
                                                                </div>
                                                                <div className="flex-1 min-w-[240px]">
                                                                    <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                                                                        Policy year in review
                                                                    </p>
                                                                    {reviews[c.tenant_id] === undefined ? (
                                                                        <p className="text-xs text-slate-600">Loading...</p>
                                                                    ) : reviews[c.tenant_id] === null ? (
                                                                        <p className="text-xs text-slate-600">No comparison available.</p>
                                                                    ) : (
                                                                        <>
                                                                            <p className="text-xs text-slate-300 leading-relaxed">
                                                                                {reviews[c.tenant_id]!.headline}
                                                                            </p>
                                                                            {reviews[c.tenant_id]!.has_baseline && (
                                                                                <p className="text-[10px] text-slate-500 mt-1">
                                                                                    {reviews[c.tenant_id]!.total_closed} closed{" · "}
                                                                                    {reviews[c.tenant_id]!.total_opened} opened{" · "}
                                                                                    compared against {reviews[c.tenant_id]!.policy_year_from}
                                                                                </p>
                                                                            )}
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <p className="text-[11px] text-slate-600 mt-4">
                            Scores shown are the weakest across each client&apos;s meters, so a single struggling site is
                            never averaged away by healthy ones.
                        </p>
                    </>
                )}
            </main>
        </div>
    );
}
