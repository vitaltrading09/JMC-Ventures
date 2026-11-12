"use client";

// Reports and data (client-experience plan, step 5): the report as something
// to be proud of and to share, then the data, then the next step.
//   - While running: the provisional report as a cover card; open it, or share
//     a link once there is useful data (24 h). Links stop at the assessment's end.
//   - After the end: "Your assessment is complete" and the final files.
//   - Always: book a follow-up assessment (booking form → GridIQ).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Link2, Copy, Check, CalendarPlus, PartyPopper } from "lucide-react";
import { apiGet, apiSend, apiUrl, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { canEdit, type PortalProjectDetail } from "@/lib/portal";
import type { Assessment } from "@/lib/assessments";
import type { Summary } from "@/lib/summary";
import { ReportsTab } from "@/components/portal/ProjectTabs";
import { Button, Field, inputClass, ErrorBox } from "@/components/ops/ui";

const DAY = 86_400_000;

export function ReportsView({ project, a, ended, s, role }: { project: PortalProjectDetail; a: Assessment | null; ended: Assessment | null; s: Summary | undefined; role: string | null }) {
    return (
        <div className="space-y-8">
            {a && <ProvisionalCard a={a} s={s} role={role} project={project} />}
            {!a && ended && (
                <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
                    <div className="flex items-start gap-4">
                        <span className="rounded-xl bg-emerald-500/10 p-3"><PartyPopper className="h-6 w-6 text-ok" aria-hidden /></span>
                        <div>
                            <h3 className="text-lg font-semibold text-ink">Your assessment is complete</h3>
                            <p className="mt-1 text-[15px] text-ink-3">{ended.reference} ran from {fmtDate(ended.start_at)} to {fmtDate(ended.effective_end_at)}.
                                {ended.delivery_open && ended.delivery_until ? ` Your final reports and data package can be downloaded until ${fmtDate(ended.delivery_until)}.` : " The final reports were sent to the named recipients."}</p>
                        </div>
                    </div>
                </section>
            )}
            <ReportsTab project={project} role={role} />
            <BookingCard project={project} from={a ?? ended} />
        </div>
    );
}

function ProvisionalCard({ a, s, role, project }: { a: Assessment; s: Summary | undefined; role: string | null; project: PortalProjectDetail }) {
    const useful = !!a.start_at && Date.now() - new Date(a.start_at).getTime() >= DAY;
    const days = s?.context.observed_days ?? 0;
    return (
        <section className="grid gap-6 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line lg:grid-cols-[260px_minmax(0,1fr)]">
            {/* A cover-style card: what the reader will receive. */}
            <div className="relative aspect-[1/1.32] w-full max-w-[260px] overflow-hidden rounded-lg bg-white p-5 shadow-md ring-1 ring-slate-200 text-slate-900">
                <div className="absolute inset-x-0 top-0 h-1.5 bg-blue-600" />
                <p className="text-[10px] font-bold text-blue-700">GridIQ</p>
                <p className="mt-4 text-sm font-bold leading-tight">Site assessment: overview</p>
                <p className="mt-1 text-[11px] text-slate-500">{project.name}</p>
                <span className="mt-3 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800">PROVISIONAL</span>
                <dl className="mt-4 space-y-1.5 text-[10px]">
                    <div><dt className="text-slate-400">Assessment</dt><dd className="font-semibold">{a.reference}</dd></div>
                    <div><dt className="text-slate-400">Measured so far</dt><dd className="font-semibold">{days < 1 ? `${Math.round(days * 24)} hours` : `${days.toFixed(1)} days`}</dd></div>
                    <div><dt className="text-slate-400">Final report</dt><dd className="font-semibold">after {fmtDate(a.effective_end_at)}</dd></div>
                </dl>
                <div className="absolute bottom-4 left-5 right-5 space-y-1">{[0, 1, 2].map((i) => <div key={i} className="h-1 rounded bg-slate-100" />)}</div>
            </div>
            <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-faint">Your report so far</p>
                <h3 className="mt-1 text-lg font-semibold text-ink">A provisional report of the {days < 1 ? "first hours" : `first ${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"}`}, built from the same data as the final one.</h3>
                <p className="mt-2 text-[15px] text-ink-3">It is marked provisional and changes as more data arrives. The final, reviewed report follows the end of the assessment on {fmtDateTime(a.effective_end_at)} {TZ_LABEL}.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                    <a className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500" href={apiUrl(`/ingestion/assessments/${a.id}/preview.pdf?kind=overview`)} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" aria-hidden />Open the report</a>
                    <a className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-ink-2 ring-1 ring-line-strong hover:bg-surface-2" href={apiUrl(`/ingestion/assessments/${a.id}/preview.pdf?kind=power_quality`)} target="_blank" rel="noreferrer">Power-quality report</a>
                </div>
                {canEdit(role) && (useful ? <ShareLinks a={a} /> : <p className="mt-5 text-sm text-faint">You can share a link to this report once the first 24 hours have been measured.</p>)}
            </div>
        </section>
    );
}

function ShareLinks({ a }: { a: Assessment }) {
    const qc = useQueryClient();
    const list = useQuery({ queryKey: ["preview-shares", a.id], queryFn: () => apiGet<any[]>(`/ingestion/assessments/${a.id}/preview-shares`) });
    const [label, setLabel] = useState("");
    const [made, setMade] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const create = useMutation({
        mutationFn: () => apiSend<{ path: string }>("POST", `/ingestion/assessments/${a.id}/preview-shares`, { kind: "overview", label: label || undefined }),
        onSuccess: (r) => { setMade(`${window.location.origin}${r.path}`); setLabel(""); qc.invalidateQueries({ queryKey: ["preview-shares", a.id] }); },
    });
    const revoke = useMutation({ mutationFn: (id: string) => apiSend("POST", `/ingestion/preview-shares/${id}/revoke`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["preview-shares", a.id] }) });
    const active = (list.data ?? []).filter((x) => !x.revoked_at && new Date(x.expires_at).getTime() > Date.now());
    return (
        <div className="mt-6 border-t border-line pt-5">
            <p className="font-semibold text-ink flex items-center gap-2"><Link2 className="h-4 w-4" aria-hidden />Share with your team</p>
            <p className="text-sm text-muted">Anyone with the link can open the provisional report, until the assessment ends. No login needed.</p>
            {made ? (
                <div className="mt-3 rounded-xl bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
                    <p className="text-sm text-ok">Link created. Copy it now: it is shown only once.</p>
                    <div className="mt-2 flex gap-2">
                        <input readOnly value={made} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} aria-label="Share link" />
                        <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(made); setCopied(true); }}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy"}</Button>
                    </div>
                    <button type="button" className="mt-2 text-sm text-accent hover:underline" onClick={() => { setMade(null); setCopied(false); }}>Make another link</button>
                </div>
            ) : (
                <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                    <Field label="Who is it for? (for your records)"><input className={`${inputClass} w-64`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Board meeting" /></Field>
                    <Button type="submit" disabled={create.isPending}>Create link</Button>
                </form>
            )}
            <ErrorBox error={create.error} />
            {active.length > 0 && (
                <ul className="mt-4 space-y-1 text-sm">
                    {active.map((x) => (
                        <li key={x.id} className="flex flex-wrap items-center gap-3 text-ink-3">
                            <span>{x.label ?? "Link"}</span>
                            <span className="text-faint">made {fmtDate(x.created_at)} · opened {x.opened_count}× · until {fmtDate(x.expires_at)}</span>
                            <button type="button" className="text-faint hover:text-bad" onClick={() => revoke.mutate(x.id)}>Stop this link</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function BookingCard({ project, from }: { project: PortalProjectDetail; from: Assessment | null }) {
    const [open, setOpen] = useState(false);
    const [f, setF] = useState({ purpose: "follow_up", duration_days: "14", preferred_start: "", contact_name: "", contact_phone: "", notes: "" });
    const book = useMutation({
        mutationFn: () => apiSend("POST", "/ingestion/booking-requests", {
            ...f, duration_days: Number(f.duration_days), preferred_start: f.preferred_start || undefined,
            project_id: f.purpose === "new_site" ? undefined : project.id, assessment_id: from?.id,
        }),
    });
    if (book.isSuccess) {
        return (
            <section className="rounded-2xl bg-emerald-500/10 p-6 ring-1 ring-emerald-500/30">
                <h3 className="text-lg font-semibold text-ink flex items-center gap-2"><Check className="h-5 w-5 text-ok" aria-hidden />Thank you, your request is with GridIQ.</h3>
                <p className="mt-1 text-[15px] text-ink-3">We'll contact you to confirm the dates and the meter installation.</p>
            </section>
        );
    }
    return (
        <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <div className="flex flex-wrap items-start gap-4">
                <span className="rounded-xl bg-blue-500/10 p-3"><CalendarPlus className="h-6 w-6 text-accent" aria-hidden /></span>
                <div className="flex-1 min-w-[240px]">
                    <h3 className="text-lg font-semibold text-ink">Book a follow-up assessment</h3>
                    <p className="mt-1 text-[15px] text-ink-3">Made changes on site? A second assessment shows whether they worked, on the same basis as this one. Or measure another site.</p>
                </div>
                {!open && <Button onClick={() => setOpen(true)}>Book an assessment</Button>}
            </div>
            {open && (
                <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); book.mutate(); }}>
                    <fieldset className="md:col-span-2">
                        <legend className="text-sm text-muted mb-2">What for?</legend>
                        <div className="flex flex-wrap gap-2">
                            {([["follow_up", "Follow-up at this site"], ["verify_improvement", "Check that changes worked"], ["new_site", "Another site"], ["other", "Something else"]] as const).map(([k, l]) => (
                                <label key={k} className={`cursor-pointer rounded-full px-4 py-2 text-sm ring-1 ${f.purpose === k ? "bg-blue-600 text-white ring-blue-600" : "text-ink-2 ring-line-strong hover:bg-surface-2"}`}>
                                    <input type="radio" name="purpose" value={k} className="sr-only" checked={f.purpose === k} onChange={() => setF({ ...f, purpose: k })} />{l}
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <Field label="How long?">
                        <select className={inputClass} value={f.duration_days} onChange={(e) => setF({ ...f, duration_days: e.target.value })}>
                            {[7, 14, 21, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
                        </select>
                    </Field>
                    <Field label="Preferred start (optional)"><input type="date" className={inputClass} value={f.preferred_start} onChange={(e) => setF({ ...f, preferred_start: e.target.value })} /></Field>
                    <Field label="Contact name"><input className={inputClass} value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} autoComplete="name" /></Field>
                    <Field label="Phone"><input type="tel" className={inputClass} value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} autoComplete="tel" /></Field>
                    <Field label="Anything we should know? (optional)"><textarea className={`${inputClass} min-h-[80px]`} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
                    <div className="md:col-span-2 flex items-center gap-3">
                        <Button type="submit" disabled={book.isPending}>Send booking request</Button>
                        <button type="button" className="text-sm text-muted hover:text-ink" onClick={() => setOpen(false)}>Cancel</button>
                    </div>
                    <div className="md:col-span-2"><ErrorBox error={book.error} /></div>
                </form>
            )}
        </section>
    );
}
