"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import {
    Loader2, Activity, ShieldAlert, BellRing, ClipboardCheck,
    Gauge, CalendarClock,
} from "lucide-react";
import { num } from "@/lib/format";

interface Finding {
    key: string; title: string; severity: string; meter_name: string | null;
    times_seen: number; first_seen: string; last_seen: string;
}
interface Ledger {
    readings_analysed: number;
    monitoring_since: string | null;
    meters_monitored: number;
    assessments_run: number;
    alerts_raised: number;
    serious_alerts: number;
    findings: Finding[];
}

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

const SEV_CLS: Record<string, string> = {
    CRITICAL: "text-red-400 bg-red-500/10 border-red-500/30",
    HIGH:     "text-orange-400 bg-orange-500/10 border-orange-500/30",
    MEDIUM:   "text-amber-400 bg-amber-500/10 border-amber-500/30",
    LOW:      "text-slate-400 bg-slate-700/40 border-slate-600",
};

function daysSince(iso: string | null) {
    if (!iso) return 0;
    return Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

export default function ValueLedgerPage() {
    const [data, setData]       = useState<Ledger | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/ingestion/value-ledger`, { credentials: "include" });
                if (res.status === 401) { window.location.href = "/login"; return; }
                if (res.ok) setData(await res.json());
            } catch { /* offline */ }
            finally { setLoading(false); }
        })();
    }, []);

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    const days = daysSince(data?.monitoring_since ?? null);
    // Readings per day gives an honest sense of surveillance density without
    // implying a saving figure we have not actually measured.
    const perDay = data && days > 0 ? Math.round(data.readings_analysed / days) : 0;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">What Grid-IQ Has Caught</h1>
                <p className="text-slate-400 mt-1">
                    The running record of what continuous monitoring has found on your sites.
                </p>
            </div>

            {!data ? (
                <Card className="p-12 text-center">
                    <Activity className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                    <p className="text-white font-medium text-lg">Nothing recorded yet</p>
                    <p className="text-slate-500 text-sm mt-2">
                        Findings appear here as assessments run against your meter data.
                    </p>
                </Card>
            ) : (
                <>
                    {/* ── Headline coverage ───────────────────────────────── */}
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                        {[
                            {
                                icon: Gauge, label: "Measurements analysed",
                                value: num(data.readings_analysed),
                                sub: perDay > 0 ? `${num(perDay)} per day` : "—",
                                cls: "text-blue-400",
                            },
                            {
                                icon: CalendarClock, label: "Days under watch",
                                value: num(days),
                                sub: data.monitoring_since
                                    ? `Since ${new Date(data.monitoring_since).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}`
                                    : "—",
                                cls: "text-emerald-400",
                            },
                            {
                                icon: ClipboardCheck, label: "Assessments run",
                                value: num(data.assessments_run),
                                sub: `${data.meters_monitored} meter${data.meters_monitored !== 1 ? "s" : ""} monitored`,
                                cls: "text-purple-400",
                            },
                            {
                                icon: BellRing, label: "Alerts raised",
                                value: num(data.alerts_raised),
                                sub: `${data.serious_alerts} high severity`,
                                cls: data.alerts_raised > 0 ? "text-amber-400" : "text-slate-400",
                            },
                        ].map(k => {
                            const Icon = k.icon;
                            return (
                                <Card key={k.label}>
                                    <div className="flex items-start gap-3">
                                        <div className="p-2.5 rounded-lg bg-slate-800/60 border border-slate-700">
                                            <Icon className={`h-5 w-5 ${k.cls}`} />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm text-slate-400">{k.label}</p>
                                            <p className={`text-2xl font-bold mt-1 ${k.cls}`}>{k.value}</p>
                                            <p className="text-xs text-slate-500 mt-1 truncate">{k.sub}</p>
                                        </div>
                                    </div>
                                </Card>
                            );
                        })}
                    </div>

                    {/* ── Findings ────────────────────────────────────────── */}
                    <Card>
                        <div className="flex items-center justify-between mb-5">
                            <div>
                                <h3 className="text-base font-semibold text-white">Issues identified</h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Distinct findings raised by the power quality engine, most recent first
                                </p>
                            </div>
                            <ShieldAlert className="h-5 w-5 text-slate-600" />
                        </div>

                        {data.findings.length === 0 ? (
                            <div className="text-center py-10">
                                <p className="text-slate-400 text-sm">
                                    No issues found so far — your installation has been clean for the whole monitoring period.
                                </p>
                                <p className="text-slate-600 text-xs mt-2">
                                    That is itself the result: a documented, continuous record of compliance.
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {data.findings.map(f => (
                                    <div
                                        key={`${f.key}-${f.meter_name ?? ""}`}
                                        className="flex items-start gap-4 p-4 rounded-lg bg-slate-900/50 border border-slate-800"
                                    >
                                        <span className={`shrink-0 px-2 py-0.5 rounded border text-[11px] font-semibold uppercase tracking-wide ${SEV_CLS[f.severity] ?? SEV_CLS.LOW}`}>
                                            {f.severity}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-white">{f.title}</p>
                                            {/* Naming the meter is what distinguishes the same finding
                                                on two different meters — without it they read as duplicates. */}
                                            {f.meter_name && (
                                                <p className="text-xs text-blue-400 mt-0.5">{f.meter_name}</p>
                                            )}
                                            <p className="text-xs text-slate-500 mt-1">
                                                Detected in {f.times_seen} assessment{f.times_seen !== 1 ? "s" : ""}
                                                {" · first seen "}
                                                {new Date(f.first_seen).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}
                                                {" · last seen "}
                                                {new Date(f.last_seen).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>

                    <p className="text-xs text-slate-600">
                        Findings are generated from measured data against NRS 048-2, SANS 10142-1 and NEMA MG-1.
                        Full detail for each finding is in the Power Quality Health Check report.
                    </p>
                </>
            )}
        </div>
    );
}
