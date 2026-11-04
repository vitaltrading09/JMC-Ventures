"use client";

import Link from "next/link";
import { fmtAgo, fmtDate } from "@/lib/api";
import { num } from "@/lib/format";
import type { PortalProject } from "@/lib/portal";
import { Badge } from "@/components/ops/ui";

/** A project with its live tiles: incomer kW now, today's kWh, coverage, alerts, latest report. */
export function ProjectCard({ p }: { p: PortalProject }) {
    const t = p.tiles;
    return (
        <Link href={`/portal/projects/${p.id}`}
            className="block rounded-xl border border-slate-800 bg-slate-900/50 p-5 hover:border-slate-600 transition-colors">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="font-semibold text-white truncate">{p.name}</h3>
                    <p className="text-xs text-slate-500 truncate">{[p.end_client_name, p.address].filter(Boolean).join(" · ") || " "}</p>
                </div>
                <Badge tone={p.status === "active" ? "green" : p.status === "planned" ? "blue" : "grey"}>{p.status}</Badge>
            </div>
            {t ? (
                <div className="grid grid-cols-3 gap-3 mt-4">
                    <div>
                        <p className="text-xs text-slate-500">Incomer now</p>
                        <p className="text-lg font-semibold text-white">{t.incomer_kw === null ? "–" : `${num(t.incomer_kw, 1)} kW`}</p>
                        {t.incomer_at && <p className="text-[11px] text-slate-500">{fmtAgo(t.incomer_at)}, 1-min avg</p>}
                    </div>
                    <div>
                        <p className="text-xs text-slate-500">Today (SAST)</p>
                        <p className="text-lg font-semibold text-white">{t.today_kwh === null ? "–" : `${num(t.today_kwh)} kWh`}</p>
                        <p className="text-[11px] text-slate-500">grid import</p>
                    </div>
                    <div>
                        <p className="text-xs text-slate-500">Data coverage</p>
                        <p className={`text-lg font-semibold ${t.coverage_24h !== null && t.coverage_24h < 0.95 ? "text-amber-300" : "text-white"}`}>
                            {t.coverage_24h === null ? "–" : `${Math.round(t.coverage_24h * 100)} %`}</p>
                        <p className="text-[11px] text-slate-500">last 24 h</p>
                    </div>
                </div>
            ) : (
                <p className="text-sm text-slate-400 mt-4">Live data for this project is shared through published reports.</p>
            )}
            <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-slate-800 text-xs">
                <span className="text-slate-400">
                    {p.latest_report ? <>Latest report: {p.latest_report.title ?? "Report"} ({fmtDate(p.latest_report.period_start)} – {fmtDate(new Date(new Date(p.latest_report.period_end).getTime() - 1))})</> : "No published report yet"}
                </span>
                {t && t.open_alerts > 0 && <Badge tone="amber">{t.open_alerts} open alert{t.open_alerts === 1 ? "" : "s"}</Badge>}
            </div>
        </Link>
    );
}
