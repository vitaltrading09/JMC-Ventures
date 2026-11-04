"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { zar } from "@/lib/format";
import type { Project } from "@/lib/ops";
import { EvidenceChart } from "@/components/ops/EvidenceChart";
import { PageHeader, Panel, Badge, Loading, ErrorBox, Empty, Button, Field, inputClass, Table } from "@/components/ops/ui";

interface Finding {
    id: string; tenant_name: string; site_id: string; site_name: string; meter_id: string | null; meter_name: string | null;
    type: string; priority: number; title: string; problem: string | null; solution: string | null;
    estimated_monthly_saving_zar: string | number; confidence: string; standard_reference: string | null;
    review_status: "draft" | "in_review" | "published" | "dismissed"; internal_notes: string | null;
    evidence: { from?: string; to?: string; metric?: string; calculation?: string; meter_id?: string | null } | null;
    created_at: string; reviewed_at: string | null;
}
interface Report {
    id: string; project_id: string; project_name: string; title: string | null; period_start: string; period_end: string;
    status: "draft" | "approved" | "published"; approved_at: string | null; published_at: string | null; created_at: string;
}

const REVIEW_TONE = { draft: "blue", in_review: "amber", published: "green", dismissed: "grey" } as const;

export default function ReviewPage() {
    const [tab, setTab] = useState<"findings" | "reports">("findings");
    return (
        <div>
            <PageHeader title="Review" subtitle="Nothing reaches a client until it is published here. Internal notes never leave Grid-IQ." />
            <div className="flex gap-2 mb-5">
                {(["findings", "reports"] as const).map((t) => (
                    <button key={t} onClick={() => setTab(t)}
                        className={`px-4 py-2 rounded-lg text-sm border capitalize ${tab === t ? "bg-blue-600/20 border-blue-500/40 text-blue-200" : "border-slate-700 text-slate-400 hover:text-white"}`}>{t}</button>
                ))}
            </div>
            {tab === "findings" ? <Findings /> : <Reports />}
        </div>
    );
}

function Findings() {
    const [status, setStatus] = useState("draft");
    const list = useQuery({
        queryKey: ["review", status],
        queryFn: () => apiGet<Finding[]>(`/ingestion/review/recommendations?review_status=${status}`),
    });
    return (
        <div className="space-y-4">
            <div className="flex gap-2">
                {["draft", "in_review", "published", "dismissed", "all"].map((s) => (
                    <button key={s} onClick={() => setStatus(s)}
                        className={`px-3 py-1.5 rounded-lg text-xs border ${status === s ? "bg-slate-700 border-slate-500 text-white" : "border-slate-700 text-slate-400"}`}>{s.replace("_", " ")}</button>
                ))}
            </div>
            {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (list.data ?? []).length === 0
                ? <Empty>Nothing {status === "all" ? "" : status.replace("_", " ")} to review.</Empty>
                : list.data!.map((f) => <FindingCard key={f.id} f={f} />)}
        </div>
    );
}

function FindingCard({ f }: { f: Finding }) {
    const qc = useQueryClient();
    const [notes, setNotes] = useState(f.internal_notes ?? "");
    const [supersede, setSupersede] = useState(true);
    const [showEvidence, setShowEvidence] = useState(false);
    const review = useMutation({
        mutationFn: (to: string) => apiSend("PATCH", `/ingestion/recommendations/${f.id}/review`, {
            review_status: to, internal_notes: notes || null, ...(to === "published" ? { supersede_previous: supersede } : {}),
        }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["review"] }),
    });
    const meter = f.evidence?.meter_id ?? f.meter_id;
    return (
        <Panel>
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge tone={REVIEW_TONE[f.review_status]}>{f.review_status.replace("_", " ")}</Badge>
                        <span className="text-xs text-slate-500">{f.tenant_name} · {f.site_name}{f.meter_name ? ` · ${f.meter_name}` : ""} · {f.type} · {f.confidence} confidence</span>
                    </div>
                    <h3 className="text-base font-semibold text-white">{f.title}</h3>
                </div>
                <div className="text-right shrink-0">
                    <p className="text-sm text-emerald-300">{zar(f.estimated_monthly_saving_zar)}/month</p>
                    <p className="text-xs text-slate-500">drafted {fmtDateTime(f.created_at)}</p>
                </div>
            </div>
            <div className="grid md:grid-cols-2 gap-4 mt-3 text-sm">
                <div><p className="text-xs uppercase text-slate-500 mb-1">Problem</p><p className="text-slate-300 whitespace-pre-line">{f.problem}</p></div>
                <div><p className="text-xs uppercase text-slate-500 mb-1">Recommendation</p><p className="text-slate-300 whitespace-pre-line">{f.solution}</p></div>
            </div>
            <div className="mt-3 text-xs text-slate-400">
                Evidence: {f.evidence?.from ? `${fmtDateTime(f.evidence.from)} – ${fmtDateTime(f.evidence.to)} ${TZ_LABEL}` : "no window recorded"}
                {f.evidence?.calculation ? ` · ${f.evidence.calculation}` : ""}{f.standard_reference ? ` · ${f.standard_reference}` : ""}
                {meter && f.evidence?.from && (
                    <button className="ml-2 text-blue-300 hover:underline" onClick={() => setShowEvidence((v) => !v)}>{showEvidence ? "hide chart" : "show chart"}</button>
                )}
            </div>
            {showEvidence && meter && f.evidence?.from && f.evidence?.to && <div className="mt-3"><EvidenceChart meterId={meter} from={f.evidence.from} to={f.evidence.to} /></div>}
            <div className="mt-4 grid md:grid-cols-[1fr_auto] gap-3 items-end">
                <Field label="Internal notes (never shown to the client)">
                    <textarea className={`${inputClass} h-16`} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-slate-400">
                        <input type="checkbox" checked={supersede} onChange={(e) => setSupersede(e.target.checked)} />
                        replaces the earlier published set
                    </label>
                    {f.review_status !== "in_review" && f.review_status !== "dismissed" && <Button variant="secondary" disabled={review.isPending} onClick={() => review.mutate("in_review")}>In review</Button>}
                    {f.review_status !== "published" && f.review_status !== "dismissed" && <Button disabled={review.isPending} onClick={() => review.mutate("published")}>Publish</Button>}
                    {f.review_status !== "dismissed" && <Button variant="danger" disabled={review.isPending} onClick={() => review.mutate("dismissed")}>Dismiss</Button>}
                    {f.review_status === "dismissed" && <Button variant="secondary" disabled={review.isPending} onClick={() => review.mutate("draft")}>Back to draft</Button>}
                </div>
            </div>
            <div className="mt-2"><ErrorBox error={review.error} /></div>
        </Panel>
    );
}

function Reports() {
    const qc = useQueryClient();
    const reports = useQuery({ queryKey: ["reports"], queryFn: () => apiGet<Report[]>("/ingestion/reports") });
    const projects = useQuery({ queryKey: ["projects", "all"], queryFn: () => apiGet<Project[]>("/ingestion/projects") });
    const [f, setF] = useState({ project_id: "", title: "", period_start: "", period_end: "" });
    const create = useMutation({
        mutationFn: () => apiSend("POST", "/ingestion/reports", {
            project_id: f.project_id, title: f.title || null,
            // Whole SAST days; the end date is inclusive.
            period_start: new Date(`${f.period_start}T00:00:00+02:00`).toISOString(),
            period_end: new Date(new Date(`${f.period_end}T00:00:00+02:00`).getTime() + 86_400_000).toISOString(),
        }),
        onSuccess: () => { setF({ project_id: "", title: "", period_start: "", period_end: "" }); qc.invalidateQueries({ queryKey: ["reports"] }); },
    });
    const act = useMutation({
        mutationFn: ({ id, action }: { id: string; action: string }) => apiSend("POST", `/ingestion/reports/${id}/${action}`, {}),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["reports"] }),
    });
    return (
        <div className="space-y-4">
            <Panel title="New report" subtitle="A report covers one project for a fixed period. Draft → approved → published; share links work only while published.">
                <form className="grid md:grid-cols-5 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                    <Field label="Project">
                        <select className={inputClass} value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })} required>
                            <option value="">Choose…</option>
                            {(projects.data ?? []).filter((p) => p.status !== "archived").map((p) => <option key={p.id} value={p.id}>{p.tenant_name} · {p.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Title"><input className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="October 2026 audit" /></Field>
                    <Field label="Period start"><input type="date" className={inputClass} value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} required /></Field>
                    <Field label="Period end (inclusive)"><input type="date" className={inputClass} value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} required /></Field>
                    <Button type="submit" disabled={create.isPending}>Create draft</Button>
                    <div className="md:col-span-5"><ErrorBox error={create.error} /></div>
                </form>
            </Panel>
            <Panel title="Reports">
                {reports.isLoading ? <Loading /> : reports.error ? <ErrorBox error={reports.error} /> : (reports.data ?? []).length === 0 ? <Empty>No reports yet.</Empty> : (
                    <Table head={["Project", "Title", "Period", "Status", "", ""]}>
                        {reports.data!.map((r) => (
                            <tr key={r.id}>
                                <td className="py-2 pr-4"><Link className="text-blue-300 hover:underline" href={`/ops/projects/${r.project_id}`}>{r.project_name}</Link></td>
                                <td className="py-2 pr-4">{r.title ?? "–"}</td>
                                <td className="py-2 pr-4 whitespace-nowrap">{fmtDate(r.period_start)} – {fmtDate(new Date(new Date(r.period_end).getTime() - 1))}</td>
                                <td className="py-2 pr-4"><Badge tone={r.status === "published" ? "green" : r.status === "approved" ? "amber" : "blue"}>{r.status}</Badge></td>
                                <td className="py-2 pr-4 text-xs text-slate-500">{r.published_at ? `published ${fmtDateTime(r.published_at)}` : r.approved_at ? `approved ${fmtDateTime(r.approved_at)}` : ""}</td>
                                <td className="py-2 flex gap-2 justify-end">
                                    {r.status === "draft" && <Button variant="secondary" onClick={() => act.mutate({ id: r.id, action: "approve" })}>Approve</Button>}
                                    {r.status === "approved" && <Button onClick={() => act.mutate({ id: r.id, action: "publish" })}>Publish</Button>}
                                    {r.status !== "draft" && <Button variant="secondary" onClick={() => { if (confirm("Withdraw? Its share links stop working at once.")) act.mutate({ id: r.id, action: "withdraw" }); }}>Withdraw</Button>}
                                </td>
                            </tr>
                        ))}
                    </Table>
                )}
                <div className="mt-2"><ErrorBox error={act.error} /></div>
            </Panel>
        </div>
    );
}
