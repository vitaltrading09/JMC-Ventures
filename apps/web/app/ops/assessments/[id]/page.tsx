"use client";

// Ops: one assessment. Its four clocks (access window, report, delivery,
// retention), payment, start/extend/close/cancel, named access and the audit
// trail. Every transition asks for what the server requires (confirmation,
// reason) and is written to the audit log.

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, apiUrl, fmtDateTime, fmtDate, TZ_LABEL } from "@/lib/api";
import { AssessmentDetail, STATUS_LABEL, STATUS_TONE, zarCents, elapsedFraction } from "@/lib/assessments";
import { PageHeader, Panel, Loading, ErrorBox, Badge, Button, Field, inputClass, Table, Empty, Stat } from "@/components/ops/ui";

export default function AssessmentPage() {
    const { id } = useParams<{ id: string }>();
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["assessment", id], queryFn: () => apiGet<AssessmentDetail>(`/ingestion/assessments/${id}`), refetchInterval: 30_000 });
    const [err, setErr] = useState<string | null>(null);
    const act = useMutation({
        mutationFn: ({ path, method = "POST", body }: { path: string; method?: "POST" | "PATCH"; body?: any }) =>
            apiSend(method, `/ingestion/assessments/${id}${path}`, body),
        onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ["assessment", id] }); qc.invalidateQueries({ queryKey: ["assessments"] }); },
        onError: (e: any) => setErr(e.message),
    });
    if (q.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error ?? "Not found"} />;
    const a = q.data;
    const s = a.effective_status;
    const notStarted = a.status === "draft" || a.status === "scheduled";

    return (
        <div className="space-y-6">
            <PageHeader title={`${a.reference} · ${a.title}`}
                subtitle={`${a.tenant_name} · ${a.project_name} · ${a.package_name ?? "custom"} · ${a.duration_days} days`}
                actions={<><Badge tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Badge>
                    <Link href={`/ops/projects/${a.project_id}`}><Button variant="secondary">Site</Button></Link></>} />
            {err && <ErrorBox error={err} />}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Access" value={a.live ? a.remaining + " left" : STATUS_LABEL[s]} tone={a.live ? "green" : undefined}
                    hint={a.start_at ? `${fmtDateTime(a.start_at)} → ${fmtDateTime(a.effective_end_at)} ${TZ_LABEL}` : "clock not started"} />
                <Stat label="Payment" value={a.payment_state ?? "—"} tone={a.payment_state === "paid" ? "green" : a.payment_state === "exception" ? "amber" : undefined}
                    hint={`${zarCents(a.price_cents)}${a.quote?.tax_basis ? "" : " · VAT basis not set"}`} />
                <Stat label="Report" value={a.report_status.replace(/_/g, " ")} hint={a.delivery_until ? `final files until ${fmtDate(a.delivery_until)}` : `${a.delivery_days} days of final delivery after the end`} />
                <Stat label="Data deletion" value={a.retention_until ? fmtDate(a.retention_until) : `${a.retention_months} months after end`}
                    hint={a.retention_exception_until ? "exception recorded" : a.retention_status} />
            </div>
            {a.live && (
                <div className="h-2 rounded-full bg-slate-800 overflow-hidden" title="Purchased window elapsed">
                    <div className="h-full bg-emerald-500" style={{ width: `${Math.round(elapsedFraction(a) * 100)}%` }} />
                </div>
            )}

            <div className="grid lg:grid-cols-2 gap-6">
                <Lifecycle a={a} busy={act.isPending} act={(path, body) => act.mutate({ path, body })} />
                <Payment a={a} busy={act.isPending} save={(body) => act.mutate({ path: "", method: "PATCH", body })} notStarted={notStarted} />
            </div>

            <Access a={a} busy={act.isPending} act={(path, body) => act.mutate({ path, body })} />

            {a.start_at && <Deliverables id={a.id} live={a.live} />}

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Measurement points" subtitle={notStarted ? "Fixed once the clock starts" : "Fixed: the clock has started"}>
                    {a.points.length === 0 ? <Empty>No points: add a metered point to the site, then recreate or edit the draft.</Empty> : (
                        <ul className="text-sm space-y-1">{a.points.map((p) => <li key={p.id} className="text-slate-200">{p.name} <span className="text-slate-500">· {p.role}</span></li>)}</ul>
                    )}
                    <h3 className="text-xs uppercase tracking-wider text-slate-500 mt-4 mb-2">Devices at these points</h3>
                    {a.deployments.length === 0 ? <Empty>No device installed yet.</Empty> : (
                        <ul className="text-sm space-y-1">{a.deployments.map((d) => (
                            <li key={d.id}><Link className="text-blue-300 hover:underline" href={`/ops/fleet/${d.device_id}`}>{d.device_code ?? "device"}</Link>
                                <span className="text-slate-400"> at {d.point_name}: {fmtDateTime(d.installed_at)} → {d.removed_at ? fmtDateTime(d.removed_at) : "now"}</span></li>
                        ))}</ul>
                    )}
                    <p className="text-xs text-slate-500 mt-3">Clients see readings only inside [start, end) of this assessment, attributed by deployment window.</p>
                </Panel>
                <Panel title="Audit trail">
                    {a.audit.length === 0 ? <Empty>Nothing yet.</Empty> : (
                        <ul className="text-sm divide-y divide-slate-800">{a.audit.map((l, i) => (
                            <li key={i} className="py-1.5 flex gap-3"><span className="text-slate-500 text-xs w-36 shrink-0">{fmtDateTime(l.at)}</span>
                                <span className="text-slate-200">{l.action.replace("assessment.", "")}</span>
                                <span className="text-slate-500 text-xs">{l.actor_email ?? ""}</span>
                                {l.reason && <span className="text-amber-200 text-xs">“{l.reason}”</span>}</li>
                        ))}</ul>
                    )}
                </Panel>
            </div>
        </div>
    );
}

function Lifecycle({ a, busy, act }: { a: AssessmentDetail; busy: boolean; act: (path: string, body?: any) => void }) {
    const [start, setStart] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [days, setDays] = useState("1");
    const [reason, setReason] = useState("");
    const [planned, setPlanned] = useState("");
    const s = a.effective_status;
    return (
        <Panel title="Clock" subtitle="Starts only on an explicit confirmation; missing data neither pauses nor extends it.">
            {(a.status === "draft" || a.status === "scheduled") && (
                <div className="space-y-3">
                    {a.status === "draft" && (
                        <div className="flex gap-2 items-end">
                            <Field label={`Planned start (${TZ_LABEL})`}><input type="datetime-local" className={inputClass} value={planned} onChange={(e) => setPlanned(e.target.value)} /></Field>
                            <Button variant="secondary" disabled={busy || !planned} onClick={() => act("/schedule", { planned_start_at: new Date(planned).toISOString() })}>Schedule</Button>
                        </div>
                    )}
                    <Field label={`Confirmed start (${TZ_LABEL})`} hint="Blank = now. At most 24 h back (the commissioning time); never in the future.">
                        <input type="datetime-local" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
                    </Field>
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                        Start the purchased {a.duration_days}-day clock (ends {a.duration_days} × 24 h later; cannot be paused)
                    </label>
                    <div className="flex gap-2">
                        <Button disabled={busy || !confirm} onClick={() => act("/start", { confirm: true, ...(start ? { start_at: new Date(start).toISOString() } : {}) })}>Start assessment</Button>
                        <Button variant="danger" disabled={busy || !reason} onClick={() => act("/cancel", { reason })}>Cancel</Button>
                    </div>
                    <Field label="Reason (for cancel)"><input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                </div>
            )}
            {(a.status === "active" || a.status === "ended") && (
                <div className="space-y-3 text-sm">
                    <p className="text-slate-300">Started {fmtDateTime(a.start_at)}; {a.closed_at ? <>closed early {fmtDateTime(a.closed_at)} (“{a.close_reason}”)</> : <>ends {fmtDateTime(a.end_at)} {TZ_LABEL}</>}.</p>
                    <Field label="Reason (required for extend and close)"><input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                    {!a.closed_at && (
                        <div className="flex gap-2 items-end">
                            <Field label="Extend by (days)"><input type="number" min={1} max={90} className={inputClass + " w-24"} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
                            <Button variant="secondary" disabled={busy || !reason} onClick={() => act("/extend", { days: Number(days), reason })}>Extend</Button>
                            {s === "active" && <Button variant="danger" disabled={busy || !reason} onClick={() => act("/close", { reason })}>Close early</Button>}
                        </div>
                    )}
                </div>
            )}
            {a.status === "cancelled" && <p className="text-sm text-slate-400">Cancelled: {a.close_reason}</p>}
        </Panel>
    );
}

function Payment({ a, busy, save, notStarted }: { a: AssessmentDetail; busy: boolean; save: (b: any) => void; notStarted: boolean }) {
    const [state, setState] = useState(a.payment_state ?? "unpaid");
    const [ref, setRef] = useState(a.payment_reference ?? "");
    const [why, setWhy] = useState(a.payment_exception_reason ?? "");
    const [notes, setNotes] = useState(a.internal_notes ?? "");
    const [ret, setRet] = useState(String(a.retention_months));
    return (
        <Panel title="Commercial" subtitle="Manual invoice and staff-recorded payment. Money is stored in cents.">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Payment">
                    <select className={inputClass} value={state} onChange={(e) => setState(e.target.value as any)}>
                        <option value="unpaid">Unpaid</option><option value="invoiced">Invoiced</option><option value="paid">Paid</option><option value="exception">Approved exception</option>
                    </select>
                </Field>
                <Field label="Invoice / payment reference"><input className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
                {state === "exception" && <div className="col-span-2"><Field label="Why the exception (required)"><input className={inputClass} value={why} onChange={(e) => setWhy(e.target.value)} /></Field></div>}
                <Field label="Retention">
                    <select className={inputClass} value={ret} onChange={(e) => setRet(e.target.value)}>
                        <option value="3">3 calendar months</option><option value="6">6 calendar months</option>
                    </select>
                </Field>
                <Field label="Agreed price"><div className="text-slate-200 py-2">{zarCents(a.price_cents)} {notStarted ? "" : "(fixed)"}</div></Field>
                <div className="col-span-2"><Field label="Internal notes (never shown to the client)"><textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div>
            </div>
            <Button className="mt-3" disabled={busy} onClick={() => save({
                payment_state: state, payment_reference: ref || null, internal_notes: notes || null,
                retention_months: Number(ret), ...(state === "exception" ? { payment_exception_reason: why } : {}),
            })}>Save</Button>
            {a.quote?.package && <p className="text-xs text-slate-500 mt-3">Quote snapshot {fmtDateTime(a.quote.snapshot_at)}: {a.quote.package.name}, {zarCents(a.quote.package.price_cents)}, tax basis {a.quote.tax_basis ?? "not set"}.</p>}
        </Panel>
    );
}

function Access({ a, busy, act }: { a: AssessmentDetail; busy: boolean; act: (path: string, body?: any) => void }) {
    const [email, setEmail] = useState("");
    const [revokeWhy, setRevokeWhy] = useState<Record<string, string>>({});
    return (
        <Panel title="Named access" subtitle="Each person sees this assessment only during its window (and its final files during the delivery period). Revoking takes effect on their next request.">
            <form className="flex gap-2 items-end mb-4" onSubmit={(e) => { e.preventDefault(); act("/grants", { email }); setEmail(""); }}>
                <Field label="Invite by email"><input type="email" required className={inputClass + " w-80"} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@client.co.za" /></Field>
                <Button type="submit" disabled={busy || a.status === "cancelled"}>Grant access</Button>
            </form>
            {a.grants.length === 0 ? <Empty>Nobody has access yet.</Empty> : (
                <Table head={["Email", "Account", "Reports", "Granted", "Status", ""]}>
                    {a.grants.map((g) => (
                        <tr key={g.id}>
                            <td className="py-2 pr-3 text-slate-200">{g.email}</td>
                            <td className="py-2 pr-3 text-xs text-slate-400">{g.user_id ? g.user_role : "no account yet (signs in with an email code)"}</td>
                            <td className="py-2 pr-3 text-xs text-slate-400">{g.receives_reports ? "receives" : "—"}</td>
                            <td className="py-2 pr-3 text-xs text-slate-400">{fmtDateTime(g.created_at)}</td>
                            <td className="py-2 pr-3">{g.revoked_at ? <Badge tone="red">revoked {fmtDate(g.revoked_at)}</Badge> : <Badge tone="green">active</Badge>}</td>
                            <td className="py-2 pr-3">{!g.revoked_at && (
                                <div className="flex gap-2">
                                    <input className={inputClass + " w-44"} placeholder="reason" value={revokeWhy[g.id] ?? ""} onChange={(e) => setRevokeWhy({ ...revokeWhy, [g.id]: e.target.value })} />
                                    <Button variant="danger" disabled={busy || !revokeWhy[g.id]} onClick={() => act(`/grants/${g.id}/revoke`, { reason: revokeWhy[g.id] })}>Revoke</Button>
                                </div>
                            )}</td>
                        </tr>
                    ))}
                </Table>
            )}
        </Panel>
    );
}

interface ReportsState {
    reports: { id: string; kind: string; revision: number; status: string; provisional: boolean; published_at: string | null; superseded_at: string | null;
               revision_reason: string | null; dataset_sha256: string; data_cutoff_at: string; generated_at: string; has_pdf: boolean }[];
    closeout: { closeout_status: string; closeout_at: string | null; closeout_error: string | null; package_path: string | null };
    late_data: { report_id: string; kind: string; revision: number; late_rows: number }[];
    emails: { to_email: string; purpose: string; status: string; attempts: number; last_error: string | null; sent_at: string | null; provider: string | null }[];
}
const KIND_LABEL: Record<string, string> = { overview: "Overview", power_quality: "Power quality", handover: "Feasibility handover" };

/** Report revisions (frozen datasets), close-out, late data and the email outbox. */
function Deliverables({ id, live }: { id: string; live: boolean }) {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["assessment-reports", id], queryFn: () => apiGet<ReportsState>(`/ingestion/assessments/${id}/reports`), refetchInterval: 30_000 });
    const [kind, setKind] = useState("overview");
    const [reason, setReason] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const refresh = () => { setErr(null); qc.invalidateQueries({ queryKey: ["assessment-reports", id] }); qc.invalidateQueries({ queryKey: ["assessment", id] }); };
    const revise = useMutation({ mutationFn: (issue: boolean) => apiSend("POST", `/ingestion/assessments/${id}/reports`, { kind, reason, issue }), onSuccess: () => { setReason(""); refresh(); }, onError: (e: any) => setErr(e.message) });
    const review = useMutation({
        mutationFn: async (rid: string) => { await apiSend("POST", `/ingestion/reports/${rid}/approve`); await apiSend("POST", `/ingestion/reports/${rid}/publish`); },
        onSuccess: refresh, onError: (e: any) => setErr(e.message),
    });
    const resend = useMutation({ mutationFn: () => apiSend("POST", `/ingestion/assessments/${id}/deliver`), onSuccess: refresh, onError: (e: any) => setErr(e.message) });
    if (q.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error} />;
    const d = q.data;
    const late = d.late_data.filter((x) => x.late_rows > 0);
    return (
        <Panel title="Reports and delivery" subtitle="Each revision freezes its dataset (SHA-256). Issued revisions never change: corrections are new revisions with a reason.">
            {err && <ErrorBox error={err} />}
            <div className="flex flex-wrap items-center gap-3 text-sm mb-4">
                <span>Close-out: <Badge tone={d.closeout.closeout_status === "done" ? "green" : d.closeout.closeout_status === "failed" ? "red" : "grey"}>{d.closeout.closeout_status}</Badge></span>
                {d.closeout.closeout_error && <span className="text-red-300 text-xs">{d.closeout.closeout_error}</span>}
                <a className="text-blue-300 hover:underline" href={apiUrl(`/ingestion/assessments/${id}/preview.pdf?kind=overview`)} target="_blank" rel="noreferrer">Provisional overview</a>
                <a className="text-blue-300 hover:underline" href={apiUrl(`/ingestion/assessments/${id}/preview.pdf?kind=power_quality`)} target="_blank" rel="noreferrer">Provisional PQ</a>
                <a className="text-blue-300 hover:underline" href={apiUrl(`/ingestion/assessments/${id}/preview.pdf?kind=handover`)} target="_blank" rel="noreferrer">Provisional handover</a>
                {d.closeout.closeout_status === "done" && <Button variant="secondary" disabled={resend.isPending} onClick={() => resend.mutate()}>Re-send deliverables</Button>}
            </div>
            {late.length > 0 && <p className="text-sm text-amber-300 mb-3">Late data: {late.map((x) => `${x.late_rows} reading(s) arrived after ${KIND_LABEL[x.kind]} r${x.revision} was frozen`).join("; ")}. Review and issue a corrected revision if it matters.</p>}
            {d.reports.length === 0 ? <Empty>No revision yet: close-out creates them after the end{live ? "; or issue an interim snapshot below" : ""}.</Empty> : (
                <Table head={["Report", "Rev", "Status", "Data cutoff", "Dataset", "Reason", ""]}>
                    {d.reports.map((r) => (
                        <tr key={r.id}>
                            <td className="py-2 pr-3 text-slate-200">{KIND_LABEL[r.kind]}{r.provisional && <span className="text-amber-300 text-xs"> (interim)</span>}</td>
                            <td className="py-2 pr-3">{r.revision}</td>
                            <td className="py-2 pr-3"><Badge tone={r.superseded_at ? "grey" : r.status === "published" ? "green" : "amber"}>{r.superseded_at ? "superseded" : r.status === "published" ? "issued" : "awaiting review"}</Badge></td>
                            <td className="py-2 pr-3 text-xs text-slate-400">{fmtDateTime(r.data_cutoff_at)}</td>
                            <td className="py-2 pr-3 text-xs text-slate-500 font-mono">{r.dataset_sha256?.slice(0, 12)}</td>
                            <td className="py-2 pr-3 text-xs text-slate-400">{r.revision_reason ?? "—"}</td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                                {r.has_pdf && <a className="text-blue-300 hover:underline text-sm mr-3" href={apiUrl(`/ingestion/reports/${r.id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>}
                                {r.status !== "published" && <Button disabled={review.isPending} onClick={() => { if (confirm("Approve and issue this report to the client? It cannot be changed afterwards.")) review.mutate(r.id); }}>Approve &amp; issue</Button>}
                            </td>
                        </tr>
                    ))}
                </Table>
            )}
            <div className="flex flex-wrap gap-2 items-end mt-4">
                <Field label="New revision of">
                    <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
                        {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                </Field>
                <Field label="Reason (required)"><input className={inputClass + " w-80"} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={live ? "interim snapshot for the client meeting" : "late data accepted from the meter buffer"} /></Field>
                <Button variant="secondary" disabled={!reason || revise.isPending} onClick={() => revise.mutate(false)}>Draft for review</Button>
                <Button disabled={!reason || revise.isPending} onClick={() => revise.mutate(true)}>Issue now</Button>
            </div>
            <h3 className="text-xs uppercase tracking-wider text-slate-500 mt-5 mb-2">Emails</h3>
            {d.emails.length === 0 ? <Empty>None yet.</Empty> : (
                <ul className="text-xs space-y-1">{d.emails.map((e, i) => (
                    <li key={i} className="flex gap-3"><Badge tone={e.status === "sent" ? "green" : e.status === "failed" ? "red" : "grey"}>{e.status}</Badge>
                        <span className="text-slate-300">{e.purpose.replace(/_/g, " ")}</span><span className="text-slate-400">{e.to_email}</span>
                        <span className="text-slate-500">{e.sent_at ? `${fmtDateTime(e.sent_at)} via ${e.provider}` : `${e.attempts} attempt(s)`}</span>
                        {e.last_error && <span className="text-red-300">{e.last_error}</span>}</li>
                ))}</ul>
            )}
            <p className="text-xs text-slate-500 mt-2">Status “sent” means the email provider accepted the message; it does not prove delivery.</p>
        </Panel>
    );
}
