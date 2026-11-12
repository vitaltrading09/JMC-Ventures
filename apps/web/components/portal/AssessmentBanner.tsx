"use client";

// The client's assessment(s): exact start and end (site time), time left, and
// what happens after the end. Access itself is enforced by the server on
// every request; this only explains it.

import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Lock } from "lucide-react";
import { apiGet, fmtDateTime, fmtDate, TZ_LABEL } from "@/lib/api";
import { Assessment, elapsedFraction } from "@/lib/assessments";

export function usePortalAssessments() {
    return useQuery({ queryKey: ["portal-assessments"], queryFn: () => apiGet<Assessment[]>("/ingestion/portal/assessments"), refetchInterval: 60_000 });
}

export function AssessmentBanner({ projectId }: { projectId?: string }) {
    const q = usePortalAssessments();
    if (!q.data) return null;
    const mine = q.data.filter((a) => !projectId || a.project_id === projectId);
    if (mine.length === 0) {
        return projectId ? (
            <div className="rounded-xl border border-line-strong bg-surface/60 p-4 text-sm text-ink-3 flex gap-3">
                <Lock className="h-5 w-5 text-muted shrink-0" />
                <span>You have no assessment for this site. Live data, history and the consultant are available only during an assessment you have been given access to.</span>
            </div>
        ) : null;
    }
    return (
        <div className="space-y-3">
            {mine.map((a) => <One key={a.id} a={a} showSite={!projectId} />)}
        </div>
    );
}

function One({ a, showSite }: { a: Assessment; showSite: boolean }) {
    const site = showSite ? `${a.project_name} · ` : "";
    if (a.live) {
        const pct = Math.round(elapsedFraction(a) * 100);
        return (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <CalendarClock className="h-5 w-5 text-ok" />
                    <span className="text-ink font-medium">{site}{a.package_name ?? `${a.duration_days}-day assessment`} · {a.reference}</span>
                    <span className="text-ink-3">{fmtDateTime(a.start_at)} → <b>{fmtDateTime(a.effective_end_at)}</b> {TZ_LABEL}</span>
                    <span className="ml-auto text-ok font-semibold">{a.remaining} left</span>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-surface-2 overflow-hidden" title={`${pct} % of the assessment elapsed`}>
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-muted mt-2">
                    Live data, history, exports and the consultant end exactly at the end time. Reports and the data package follow;
                    the data is kept until {a.retention_until ? fmtDate(a.retention_until) : `${a.retention_months} months after the end`}, then deleted.
                </p>
            </div>
        );
    }
    if (a.effective_status === "scheduled" || a.effective_status === "draft") {
        return (
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 text-sm text-ink-3">
                <b className="text-ink">{site}{a.reference}</b>: not started yet. The {a.duration_days}-day clock starts when GridIQ confirms the meter is commissioned.
            </div>
        );
    }
    return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-ink-3 flex gap-3">
            <Lock className="h-5 w-5 text-warn shrink-0" />
            <div>
                <b className="text-ink">{site}{a.reference} ended {fmtDateTime(a.effective_end_at)} {TZ_LABEL}.</b>{" "}
                Live data, history, exports and the consultant are closed for this assessment.
                {a.delivery_open && a.delivery_until
                    ? <> Your final reports stay downloadable (Reports tab) until {fmtDateTime(a.delivery_until)}.</>
                    : <> The final deliverables were sent to the named recipients.</>}
                {" "}Data deletion: {a.retention_until ? fmtDate(a.retention_until) : `${a.retention_months} months after the end`}.
            </div>
        </div>
    );
}
