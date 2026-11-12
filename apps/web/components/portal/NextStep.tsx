"use client";

// The one thing to do next with a finding, under its progress track:
//   Found          → "Start investigating" (who looks into it, first check, by when)
//   Investigating  → "Decide on an action" (what will be done, by whom, by when)
//   Action planned → "Action done"
//   Action done    → "Verify improvement" (before/after comparison → Verified)
// "No action needed" closes it with a reason; a closed finding can be reopened.
// Client admins and GridIQ staff move a finding on; everyone else sees who owns it.
// Every change goes through PATCH /recommendations/:id/case (audited).

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { apiSend, fmtDate } from "@/lib/api";
import { canEdit, type PortalProjectDetail } from "@/lib/portal";
import { VerifyPanel } from "@/components/portal/ProjectTabs";
import { Button, Field, inputClass, ErrorBox } from "@/components/ops/ui";

/** Defined outside NextStep so its form inputs keep focus while typing. */
function Card({ title, error, children }: { title: string; error: unknown; children: React.ReactNode }) {
    return (
        <section className="rounded-2xl bg-blue-500/5 p-5 ring-1 ring-blue-500/25" aria-live="polite">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">Next step</p>
            <h3 className="mt-1 text-lg font-semibold text-ink">{title}</h3>
            <div className="mt-3">{children}</div>
            <ErrorBox error={error} />
        </section>
    );
}

const firstSentence = (t: string | null | undefined) => (t ?? "").split(/(?<=\.)\s/)[0] ?? "";

export function NextStep({ f, c, assessmentId, project, role }: { f: any; c: any; assessmentId: string | null; project: PortalProjectDetail; role: string | null }) {
    const qc = useQueryClient();
    const status = c?.status ?? "open";
    const [form, setForm] = useState({ owner: c?.owner ?? "", next_step: c?.next_step ?? firstSentence(f.solution), due_on: c?.due_on?.slice(0, 10) ?? "" });
    // Each step asks its own question: the action is not the first check again.
    useEffect(() => { if (status === "investigating") setForm((x) => ({ ...x, next_step: "" })); }, [status]);
    const [closing, setClosing] = useState(false);
    const [reason, setReason] = useState("");
    const save = useMutation({
        mutationFn: (body: any) => apiSend("PATCH", `/ingestion/recommendations/${f.id}/case`, body),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["cases", assessmentId] }); setClosing(false); },
    });
    const editable = canEdit(role) && !!assessmentId;

    if (!editable) {
        return (
            <section className="rounded-2xl bg-surface p-5 ring-1 ring-line text-[15px] text-ink-3">
                {c?.owner ? <>Being followed up by <b className="text-ink">{c.owner}</b>{c.due_on ? `, due ${fmtDate(c.due_on)}` : ""}.</> : "Your team's admin or GridIQ moves this finding forward."}
            </section>
        );
    }
    const closeLink = !closing && (
        <button type="button" className="text-sm text-muted hover:text-ink" onClick={() => setClosing(true)}>No action needed…</button>
    );
    const closeForm = closing && (
        <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); save.mutate({ status: "not_needed", next_step: reason || "Closed: no action needed" }); }}>
            <Field label="Why is no action needed?"><input className={`${inputClass} w-80`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 24/7 operation, the load is expected" required /></Field>
            <Button type="submit" variant="secondary" disabled={save.isPending}>Close the finding</Button>
            <button type="button" className="text-sm text-muted hover:text-ink" onClick={() => setClosing(false)}>Cancel</button>
        </form>
    );

    if (status === "open" || status === "investigating") {
        const starting = status === "open";
        return (
            <Card error={save.error} title={starting ? "Start investigating: who looks into this, and by when?" : "Decide on an action"}>
                <form className="grid gap-3 md:grid-cols-[1fr_2fr_auto_auto] items-end"
                    onSubmit={(e) => { e.preventDefault(); save.mutate({ status: starting ? "investigating" : "action_planned", owner: form.owner || null, next_step: form.next_step || null, due_on: form.due_on || null }); }}>
                    <Field label="Who"><input className={inputClass} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="e.g. Facilities manager" required /></Field>
                    <Field label={starting ? "First check" : "The action"}><input className={inputClass} value={form.next_step} onChange={(e) => setForm({ ...form, next_step: e.target.value })} required /></Field>
                    <Field label="By"><input type="date" className={inputClass} value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} /></Field>
                    <Button type="submit" disabled={save.isPending}>{starting ? "Start investigating" : "Plan this action"}<ArrowRight className="h-4 w-4" /></Button>
                </form>
                <div className="mt-3">{closeLink}</div>
                {closeForm}
            </Card>
        );
    }
    if (status === "action_planned") {
        return (
            <Card error={save.error} title={`When "${c?.next_step ?? "the action"}" is done, mark it here`}>
                <p className="text-[15px] text-ink-3">{c?.owner ?? "The owner"}{c?.due_on ? `, due ${fmtDate(c.due_on)}` : ""}. After that, compare a week before with a week after to see whether it worked.</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button onClick={() => save.mutate({ status: "action_done" })} disabled={save.isPending}>Action done<ArrowRight className="h-4 w-4" /></Button>
                    {closeLink}
                </div>
                {closeForm}
            </Card>
        );
    }
    if (status === "action_done") {
        return (
            <Card error={save.error} title="Verify the improvement: compare before and after">
                <p className="text-[15px] text-ink-3">Pick a period before the change and one after it with similar operation. The result is recorded with the finding and in the report.</p>
                <VerifyPanel f={f} project={project} saving={save.isPending} error={save.error} onSave={(v) => save.mutate({ status: "verified", verification: v })} />
            </Card>
        );
    }
    if (status === "verified") {
        return (
            <section className="rounded-2xl bg-emerald-500/10 p-5 ring-1 ring-emerald-500/30">
                <p className="flex items-center gap-2 text-lg font-semibold text-ink"><CheckCircle2 className="h-5 w-5 text-ok" aria-hidden />Verified: {String(c?.verification?.result ?? "").replace(/_/g, " ")}</p>
                {c?.verification?.note && <p className="mt-1 text-[15px] text-ink-3">{c.verification.note}</p>}
            </section>
        );
    }
    return (
        <section className="rounded-2xl bg-surface p-5 ring-1 ring-line">
            <p className="text-[15px] text-ink-3">Closed{c?.next_step ? `: ${c.next_step}` : "."}</p>
            <button type="button" className="mt-2 text-sm text-accent hover:underline" onClick={() => save.mutate({ status: "open" })}>Reopen</button>
        </section>
    );
}
