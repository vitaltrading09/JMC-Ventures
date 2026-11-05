"use client";

// A project tile on the portal overview: what each meter is doing right now,
// the top open alerts and findings, today's energy. Every row links to the
// detail behind it; a finding can go straight to the AI consultant.

import Link from "next/link";
import { MessageSquare, ChevronRight } from "lucide-react";
import { fmtAgo, fmtDate } from "@/lib/api";
import { num, zar } from "@/lib/format";
import { askConsultant, isDraftFinding, findingSource, type PortalProject, type PortalTiles } from "@/lib/portal";
import { Badge } from "@/components/ops/ui";

type Meter = PortalTiles["meters"][number];

const STATE: Record<Meter["state"], { dot: string; label: string }> = {
    live: { dot: "bg-emerald-400", label: "Live" },
    delayed: { dot: "bg-amber-400", label: "Delayed" },
    silent: { dot: "bg-red-500", label: "No data" },
};

function ago(s: number | null) {
    if (s === null) return "no data in 24 h";
    if (s < 90) return `${s} s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
}

function MeterRow({ projectId, m }: { projectId: string; m: Meter }) {
    const st = STATE[m.state];
    return (
        <Link href={`/portal/projects/${projectId}/points/${m.point_id}`}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 -mx-2 hover:bg-slate-800/60 group">
            <span className="relative flex h-2.5 w-2.5 shrink-0" title={st.label}>
                {m.state === "live" && <span className={`absolute inline-flex h-full w-full rounded-full ${st.dot} opacity-60 animate-ping`} />}
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${st.dot}`} />
            </span>
            <span className="text-sm text-slate-200 truncate flex-1">{m.name}</span>
            <span className="text-xs text-slate-300 tabular-nums whitespace-nowrap">
                {m.kw === null ? "–" : `${num(m.kw, 1)} kW`}
                <span className="text-slate-500"> · {m.v === null ? "–" : `${num(m.v)} V`} · PF {m.pf === null ? "–" : num(m.pf, 2)}</span>
            </span>
            <span className={`text-[11px] whitespace-nowrap w-20 text-right ${m.state === "live" ? "text-emerald-300" : m.state === "delayed" ? "text-amber-300" : "text-red-300"}`}>
                {ago(m.seconds_ago)}
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-600 group-hover:text-slate-300" />
        </Link>
    );
}

const sevTone = (s: string) => (s === "CRITICAL" || s === "HIGH" ? "red" : s === "WARNING" || s === "MEDIUM" ? "amber" : "grey") as "red" | "amber" | "grey";

export function ProjectCard({ p }: { p: PortalProject }) {
    const t = p.tiles;
    const meters = t?.meters ?? [];
    const liveCount = meters.filter((m) => m.state === "live").length;
    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 flex flex-col gap-4 hover:border-slate-700 transition-colors">
            <div className="flex items-start justify-between gap-3">
                <Link href={`/portal/projects/${p.id}`} className="min-w-0 group">
                    <h3 className="font-semibold text-white truncate group-hover:underline">{p.name}</h3>
                    <p className="text-xs text-slate-500 truncate">{[p.end_client_name, p.address].filter(Boolean).join(" · ") || " "}</p>
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                    {t && meters.length > 0 && (
                        <Badge tone={liveCount === meters.length ? "green" : liveCount > 0 ? "amber" : "red"}>
                            {liveCount}/{meters.length} live
                        </Badge>
                    )}
                    <Badge tone={p.status === "active" ? "green" : p.status === "planned" ? "blue" : "grey"}>{p.status}</Badge>
                </div>
            </div>

            {!t ? (
                <p className="text-sm text-slate-400">Live data for this project is shared through published reports.</p>
            ) : (
                <>
                    <div className="grid grid-cols-3 gap-3">
                        <div>
                            <p className="text-xs text-slate-500">Incomer now</p>
                            <p className="text-lg font-semibold text-white tabular-nums">{t.incomer_kw === null ? "–" : `${num(t.incomer_kw, 1)} kW`}</p>
                            <p className="text-[11px] text-slate-500">{t.incomer_at ? `${fmtAgo(t.incomer_at)}, 1-min avg` : "no live value"}</p>
                        </div>
                        <div>
                            <p className="text-xs text-slate-500">Today (SAST)</p>
                            <p className="text-lg font-semibold text-white tabular-nums">{t.today_kwh === null ? "–" : `${num(t.today_kwh)} kWh`}</p>
                            <p className="text-[11px] text-slate-500">grid import</p>
                        </div>
                        <div>
                            <p className="text-xs text-slate-500">Data coverage</p>
                            <p className={`text-lg font-semibold tabular-nums ${t.coverage_24h !== null && t.coverage_24h < 0.95 ? "text-amber-300" : "text-white"}`}>
                                {t.coverage_24h === null ? "–" : `${Math.round(t.coverage_24h * 100)} %`}</p>
                            <p className="text-[11px] text-slate-500">last 24 h</p>
                        </div>
                    </div>

                    {meters.length > 0 && (
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Meters · 1-minute values</p>
                            {meters.map((m) => <MeterRow key={m.point_id} projectId={p.id} m={m} />)}
                        </div>
                    )}

                    <div>
                        <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                            Open alerts{t.open_alerts > 0 ? ` · ${t.open_alerts} in 7 days` : ""}
                        </p>
                        {t.top_alerts.length === 0 ? <p className="text-xs text-slate-500">None open.</p> : t.top_alerts.map((a) => (
                            <Link key={a.id} href={a.point_id ? `/portal/projects/${p.id}/points/${a.point_id}` : "/portal/alerts"}
                                className="flex items-start gap-2 rounded-lg px-2 py-1 -mx-2 hover:bg-slate-800/60">
                                <Badge tone={sevTone(a.severity)}>{a.severity}</Badge>
                                <span className="text-xs text-slate-300 flex-1 line-clamp-2">{a.message}</span>
                                <span className="text-[11px] text-slate-500 whitespace-nowrap">{fmtAgo(a.created_at)}</span>
                            </Link>
                        ))}
                    </div>
                </>
            )}

            <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Findings</p>
                {(t?.findings ?? []).length === 0 ? <p className="text-xs text-slate-500">No findings yet.</p> : t!.findings.map((f) => (
                    <div key={f.id} className="flex items-start gap-2 rounded-lg px-2 py-1 -mx-2 hover:bg-slate-800/60">
                        <Link href={`/portal/projects/${p.id}?tab=findings#finding-${f.id}`} className="flex-1 min-w-0">
                            <span className="flex items-center gap-1.5 flex-wrap">
                                <Badge tone={f.priority === 1 ? "red" : f.priority === 2 ? "amber" : "grey"}>{f.priority === 1 ? "Act" : f.priority === 2 ? "Plan" : "Note"}</Badge>
                                {isDraftFinding(f.review_status) && <Badge tone="blue">Draft · not yet reviewed</Badge>}
                                <span className="text-[11px] text-slate-500">{findingSource(f.type)}</span>
                            </span>
                            <span className="block text-xs text-slate-200 mt-0.5">{f.title}</span>
                            {f.saving_zar ? <span className="text-[11px] text-emerald-300">~{zar(f.saving_zar)}/month</span> : null}
                        </Link>
                        <button type="button" title="Ask the AI consultant about this finding"
                            onClick={() => askConsultant(`Explain this finding for ${p.name} and what we should do first: "${f.title}".`)}
                            className="mt-0.5 rounded-md p-1 text-slate-400 hover:text-white hover:bg-slate-700">
                            <MessageSquare className="h-4 w-4" />
                        </button>
                    </div>
                ))}
            </div>

            <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs mt-auto">
                <span className="text-slate-400 truncate">
                    {p.latest_report ? <>Latest report: {p.latest_report.title ?? "Report"} ({fmtDate(p.latest_report.period_start)} – {fmtDate(new Date(new Date(p.latest_report.period_end).getTime() - 1))})</> : "No published report yet"}
                </span>
                <Link href={`/portal/projects/${p.id}`} className="text-blue-300 hover:underline whitespace-nowrap">Open project</Link>
            </div>
        </div>
    );
}
