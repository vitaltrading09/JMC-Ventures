"use client";

// A site tile on the client home page: the whole tile opens the site. It shows
// only what a first look needs: the assessment state, time left, and how many
// findings need attention (with the main one). Details live inside the site.

import Link from "next/link";
import { ArrowRight, CheckCircle2, AlertTriangle, Lock, Clock } from "lucide-react";
import { fmtDate } from "@/lib/api";
import type { PortalProject } from "@/lib/portal";
import type { Assessment } from "@/lib/assessments";
import { elapsedFraction } from "@/lib/assessments";

export function ProjectCard({ p, a }: { p: PortalProject; a: Assessment | null }) {
    const t = p.tiles;
    const findings = t?.findings ?? [];
    const attention = findings.filter((f) => f.priority <= 2).length;
    const pct = a?.live ? Math.round(elapsedFraction(a) * 100) : null;
    return (
        <Link href={`/portal/projects/${p.id}`}
            className="group flex flex-col min-h-[230px] rounded-2xl border border-line bg-surface p-5 shadow-sm transition hover:border-blue-400/60 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
            <div className="min-w-0">
                <h3 className="text-lg font-semibold text-ink truncate">{p.name}</h3>
                <p className="text-sm text-faint truncate">{p.address || p.end_client_name || " "}</p>
            </div>

            <div className="mt-4 text-sm">
                {a?.live ? (
                    <>
                        <p className="flex items-center gap-1.5 text-ink-3"><Clock className="h-4 w-4 text-faint" aria-hidden />Assessment running · <span className="tabular-nums">{a.remaining} left</span></p>
                        <div className="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden" aria-label={`${pct} % of the assessment elapsed`}>
                            <div className="h-full bg-blue-500/80" style={{ width: `${pct}%` }} />
                        </div>
                    </>
                ) : a?.effective_status === "ended" ? (
                    <p className="flex items-center gap-1.5 text-muted"><Lock className="h-4 w-4" aria-hidden />Assessment ended{a.delivery_open && a.delivery_until ? ` · reports until ${fmtDate(a.delivery_until)}` : ""}</p>
                ) : a ? (
                    <p className="text-muted">Assessment starts when the meter is commissioned.</p>
                ) : <p className="text-muted">No assessment for this site.</p>}
            </div>

            <div className="mt-auto pt-5">
                {t ? attention > 0 ? (
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="h-5 w-5 text-warn shrink-0 mt-0.5" aria-hidden />
                        <div className="min-w-0">
                            <p className="font-semibold text-ink">{attention} finding{attention === 1 ? "" : "s"} to look at</p>
                            <p className="text-sm text-muted line-clamp-2">{findings[0]?.title}</p>
                        </div>
                    </div>
                ) : (
                    <p className="flex items-center gap-2 font-semibold text-ink"><CheckCircle2 className="h-5 w-5 text-ok" aria-hidden />No issues found so far</p>
                ) : <p className="text-sm text-muted">{p.latest_report ? "Final reports available" : "Nothing to show yet"}</p>}
                <p className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent">Open site<ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden /></p>
            </div>
        </Link>
    );
}
