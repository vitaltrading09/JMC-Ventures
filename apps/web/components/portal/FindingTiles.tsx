"use client";

// Findings as tiles: one look shows what kind of issue, how serious, and
// whether it is being followed up. A tile opens the finding page.

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { kindOf, severityOf, CASE_STATUS } from "@/lib/findings";
import { isDraftFinding } from "@/lib/portal";
import { siteHref } from "@/lib/siteNav";

export function FindingTiles({ projectId, findings, cases, emptyText }: {
    projectId: string; findings: any[]; cases?: any[]; emptyText?: string;
}) {
    if (!findings.length) {
        return (
            <div className="rounded-2xl border border-line bg-surface p-6 flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6 text-ok shrink-0" aria-hidden />
                <p className="text-ink-2">{emptyText ?? "No findings so far. The measurements have not shown anything that needs follow-up."}</p>
            </div>
        );
    }
    const byId = new Map((cases ?? []).map((c) => [c.recommendation_id, c]));
    const sorted = [...findings].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
    return (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sorted.map((f) => {
                const k = kindOf(f.type), sev = severityOf(f.priority), c = byId.get(f.id);
                return (
                    <li key={f.id}>
                        <Link href={siteHref(projectId, "finding", { f: f.id })}
                            className="group relative flex h-full min-h-[180px] flex-col overflow-hidden rounded-2xl border border-line bg-surface p-5 pl-6 shadow-sm transition hover:border-blue-400/60 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
                            <span className={`absolute left-0 top-0 h-full w-1.5 ${sev.stripe}`} aria-hidden />
                            <div className="flex items-center gap-2 text-sm">
                                <k.icon className="h-4 w-4 text-muted" aria-hidden />
                                <span className="text-muted">{k.label}</span>
                                <span className={`ml-auto font-medium ${sev.text}`}>{sev.label}</span>
                            </div>
                            <h3 className="mt-2 font-semibold text-ink leading-snug">{f.title}</h3>
                            {f.meter_name && <p className="text-xs text-faint mt-0.5">{f.meter_name}</p>}
                            <div className="mt-auto pt-4 flex items-center gap-2 text-xs">
                                <span className="rounded-full border border-line-strong px-2 py-0.5 text-ink-3">{CASE_STATUS[c?.status ?? "open"]}</span>
                                {isDraftFinding(f.review_status) && <span className="text-faint">not yet reviewed by GridIQ</span>}
                                <ArrowRight className="ml-auto h-4 w-4 text-accent transition group-hover:translate-x-0.5" aria-hidden />
                            </div>
                        </Link>
                    </li>
                );
            })}
        </ul>
    );
}
