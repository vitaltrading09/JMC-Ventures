"use client";

// The watch on a finding (services/ingestion-service/src/finding-watch.ts):
// "Start investigating" starts it; GridIQ notes each day what the measurements
// show for this finding, then writes a conclusion with a suggested next step.
// The conclusion shows at once, labelled as automated until GridIQ staff review
// it. Client admins and staff may stop a running watch; staff may conclude it
// early and add a review note.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, CheckCircle2 } from "lucide-react";
import { apiSend, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { canEdit } from "@/lib/portal";
import { Answer } from "@/components/dashboard/ChatWidget";
import { Button, ErrorBox, inputClass } from "@/components/ops/ui";

export interface Watch {
    id: string; status: "watching" | "concluded"; kind: string; started_at: string; until_at: string; point: string;
    notes: { day: string; from: string; to: string; seen: boolean; headline: string; values: number; expected: number }[];
    conclusion: { text: string; verdict: string; provider: string; model: string | null; generated_at: string } | null;
    concluded_at: string | null; reviewed_at: string | null; staff_note: string | null;
}

const VERDICT: Record<string, { label: string; cls: string }> = {
    persists: { label: "Still happening", cls: "bg-amber-500/15 text-warn" },
    intermittent: { label: "Happens at times", cls: "bg-amber-500/10 text-warn" },
    not_seen: { label: "Not seen during the watch", cls: "bg-emerald-500/15 text-ok" },
    insufficient: { label: "Not enough data", cls: "bg-surface-3 text-muted" },
};
const isStaff = (role: string | null) => role === "super_admin" || role === "engineer";

function Notes({ notes }: { notes: Watch["notes"] }) {
    if (!notes.length) return <p className="text-sm text-muted">The first daily note appears after the first full day.</p>;
    return (
        <ol className="space-y-1.5">
            {notes.map((n) => (
                <li key={n.day} className="flex gap-3 text-sm">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.values < 0.5 * n.expected ? "bg-surface-3" : n.seen ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden />
                    <span className="w-24 shrink-0 tabular-nums text-faint">{fmtDate(n.from)}</span>
                    <span className="text-ink-2">{n.headline}{n.values < 0.5 * n.expected ? " (little data this day)" : ""}</span>
                </li>
            ))}
        </ol>
    );
}

export function WatchPanel({ f, w, role, assessmentId }: { f: any; w: Watch | null | undefined; role: string | null; assessmentId: string | null }) {
    const qc = useQueryClient();
    const [note, setNote] = useState(w?.staff_note ?? "");
    const act = useMutation({
        mutationFn: ({ path, body }: { path: string; body?: any }) => apiSend("POST", `/ingestion/recommendations/${f.id}/watch/${path}`, body ?? {}),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["cases", assessmentId] }),
    });
    if (!w) return null;

    if (w.status === "watching") {
        const start = new Date(w.started_at).getTime(), end = new Date(w.until_at).getTime();
        const pct = Math.max(2, Math.min(100, ((Date.now() - start) / (end - start)) * 100));
        return (
            <section className="rounded-2xl bg-surface p-5 ring-1 ring-line" aria-labelledby="watch-h">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent"><Eye className="h-4 w-4" aria-hidden />GridIQ is watching this finding</p>
                        <h3 id="watch-h" className="mt-1 text-lg font-semibold text-ink">A conclusion follows on {fmtDateTime(w.until_at)} {TZ_LABEL}</h3>
                        <p className="mt-1 text-sm text-muted">Each day we note what the {w.point} measurements show for this finding. At the end you get a conclusion and a suggested next step, by email too.</p>
                    </div>
                    <div className="flex items-center gap-3">
                        {isStaff(role) && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: "conclude" })}>Conclude now</Button>}
                        {canEdit(role) && <button type="button" className="text-sm text-muted hover:text-ink" disabled={act.isPending} onClick={() => act.mutate({ path: "stop" })}>Stop watching</button>}
                    </div>
                </div>
                <div className="mt-4 h-1.5 rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Watch progress">
                    <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-4"><Notes notes={w.notes ?? []} /></div>
                <ErrorBox error={act.error} />
            </section>
        );
    }

    const c = w.conclusion;
    if (!c) return null;
    const v = VERDICT[c.verdict] ?? VERDICT.insufficient;
    return (
        <section className="rounded-2xl bg-surface p-5 ring-1 ring-line" aria-labelledby="watch-h">
            <div className="flex flex-wrap items-center gap-2">
                <h3 id="watch-h" className="text-lg font-semibold text-ink">What the watch found</h3>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${v.cls}`}>{v.label}</span>
            </div>
            <p className="mt-1 text-sm text-muted">
                {fmtDate(w.started_at)} – {fmtDate(w.concluded_at ?? w.until_at)} · {w.point} · {c.provider === "none" ? "Measured-data summary" : "Written by the AI consultant from the measured data"}
                {" · "}{w.reviewed_at
                    ? <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Reviewed by GridIQ {fmtDate(w.reviewed_at)}</span>
                    : <span>Automated conclusion · not yet reviewed by GridIQ</span>}
            </p>
            {w.staff_note && <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-[15px] text-ink-2"><b className="font-medium">GridIQ:</b> {w.staff_note}</p>}
            <div className="mt-4 text-[15px]"><Answer text={c.text} /></div>
            {(w.notes ?? []).length > 0 && (
                <details className="mt-4 border-t border-line pt-3">
                    <summary className="cursor-pointer select-none text-sm text-muted">Daily observations ({w.notes.length})</summary>
                    <div className="mt-3"><Notes notes={w.notes} /></div>
                </details>
            )}
            {isStaff(role) && (
                <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: "review", body: { note: note || null } }); }}>
                    <label className="flex-1 min-w-[16rem] text-sm text-muted">Review note for the client (optional)
                        <input className={`${inputClass} mt-1 w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Agreed; we will confirm the motor starts with the site" />
                    </label>
                    <Button type="submit" disabled={act.isPending}>{w.reviewed_at ? "Update review" : "Mark reviewed"}</Button>
                </form>
            )}
            <ErrorBox error={act.error} />
        </section>
    );
}
