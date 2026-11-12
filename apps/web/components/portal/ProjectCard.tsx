"use client";

// A site on the portal overview (engineering UI brief §1): a compact summary
// with the current load, whether the meters are reporting, ONE main issue and
// one clear next action. The detail lives on the site's Summary view.
// "Reporting" is shown in a neutral style: a meter talking to the server says
// nothing about whether the site is healthy.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmtAgo, fmtDate } from "@/lib/api";
import { num } from "@/lib/format";
import { isDraftFinding, type PortalProject } from "@/lib/portal";
import { Badge } from "@/components/ops/ui";

export function ProjectCard({ p }: { p: PortalProject }) {
    const t = p.tiles;
    const meters = t?.meters ?? [];
    const reporting = meters.filter((m) => m.state === "live").length;
    const silent = meters.filter((m) => m.state === "silent").length;
    const issue = t?.findings?.[0] ?? null;
    const alert = t?.top_alerts?.[0] ?? null;
    return (
        <article className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 flex flex-col gap-4 hover:border-slate-700 transition-colors">
            <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="font-semibold text-white truncate">{p.name}</h3>
                    <p className="text-xs text-slate-500 truncate">{[p.end_client_name, p.address].filter(Boolean).join(" · ") || " "}</p>
                </div>
                {t ? <Badge tone="blue">Assessment live</Badge> : <Badge>No live assessment</Badge>}
            </header>

            {!t ? (
                <p className="text-sm text-slate-400">Live data, history and the consultant are available only during an assessment. Final reports stay under Reports and data.</p>
            ) : (
                <>
                    <dl className="grid grid-cols-3 gap-3">
                        <div>
                            <dt className="text-xs text-slate-500">Load now</dt>
                            <dd className="text-lg font-semibold text-white tabular-nums">{t.incomer_kw === null ? "–" : `${num(t.incomer_kw, 1)} kW`}</dd>
                            <dd className="text-[11px] text-slate-500">{t.incomer_at ? `incomer, ${fmtAgo(t.incomer_at)}` : "no live value"}</dd>
                        </div>
                        <div>
                            <dt className="text-xs text-slate-500">Today (SAST)</dt>
                            <dd className="text-lg font-semibold text-white tabular-nums">{t.today_kwh === null ? "–" : `${num(t.today_kwh)} kWh`}</dd>
                            <dd className="text-[11px] text-slate-500">grid import</dd>
                        </div>
                        <div>
                            <dt className="text-xs text-slate-500">Meters</dt>
                            <dd className={`text-lg font-semibold tabular-nums ${silent ? "text-amber-300" : "text-white"}`}>{meters.length ? `${reporting}/${meters.length}` : "–"}</dd>
                            <dd className="text-[11px] text-slate-500">{silent ? `${silent} not reporting` : "reporting"}{t.coverage_24h !== null ? ` · ${Math.round(t.coverage_24h * 100)} % in 24 h` : ""}</dd>
                        </div>
                    </dl>

                    <div className="rounded-lg bg-slate-950/50 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500">Main issue</p>
                        {issue ? (
                            <p className="text-sm text-slate-100 mt-0.5">{issue.title}{isDraftFinding(issue.review_status) && <span className="ml-2 text-[11px] text-blue-300">draft, not yet reviewed</span>}</p>
                        ) : alert ? (
                            <p className="text-sm text-slate-100 mt-0.5 line-clamp-2">{alert.message}</p>
                        ) : <p className="text-sm text-slate-400 mt-0.5">No open issue so far.</p>}
                        {(t.findings.length > 1 || t.open_alerts > 0) && (
                            <p className="text-[11px] text-slate-500 mt-1">{t.findings.length > 1 ? `${t.findings.length - 1} more finding(s)` : ""}{t.findings.length > 1 && t.open_alerts > 0 ? " · " : ""}{t.open_alerts > 0 ? `${t.open_alerts} alert(s) in 7 days` : ""}</p>
                        )}
                    </div>
                </>
            )}

            <footer className="flex items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs mt-auto">
                <span className="text-slate-500 truncate">
                    {p.latest_report ? <>Latest report: {fmtDate(p.latest_report.period_start)} – {fmtDate(new Date(new Date(p.latest_report.period_end).getTime() - 1))}</> : "No issued report yet"}
                </span>
                <Link href={`/portal/projects/${p.id}`} className="inline-flex items-center gap-1 text-sm text-blue-300 hover:underline whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">
                    {t ? "Open site summary" : "Open site"}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
            </footer>
        </article>
    );
}
