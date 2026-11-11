"use client";

// Ops: assessments. Every purchased assessment with its clocks (access window,
// time left, report, retention) and a form to draft a new one.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { apiGet, apiSend, fmtDateTime, fmtDate, TZ_LABEL } from "@/lib/api";
import type { Project } from "@/lib/ops";
import { Assessment, Package, STATUS_LABEL, STATUS_TONE, zarCents, toCents } from "@/lib/assessments";
import { PageHeader, Panel, Loading, ErrorBox, Empty, Badge, Button, Field, inputClass, Table } from "@/components/ops/ui";

export default function AssessmentsPage() {
    const qc = useQueryClient();
    const router = useRouter();
    const [showNew, setShowNew] = useState(false);
    useEffect(() => { if (new URLSearchParams(window.location.search).get("new") === "1") setShowNew(true); }, []);
    const [filter, setFilter] = useState<"open" | "all">("open");
    const list = useQuery({ queryKey: ["assessments"], queryFn: () => apiGet<Assessment[]>("/ingestion/assessments"), refetchInterval: 60_000 });
    const rows = (list.data ?? []).filter((a) => filter === "all" || ["draft", "scheduled", "active"].includes(a.effective_status));

    return (
        <div className="space-y-6">
            <PageHeader title="Assessments" subtitle={`Purchased measurement periods. Times in ${TZ_LABEL}; a day is 24 hours from the confirmed start.`}
                actions={<>
                    <Link href="/ops/packages"><Button variant="secondary">Packages &amp; prices</Button></Link>
                    <Button onClick={() => setShowNew((v) => !v)}>{showNew ? "Close" : "New assessment"}</Button>
                </>} />
            {showNew && <NewAssessment onCreated={(a) => { qc.invalidateQueries({ queryKey: ["assessments"] }); router.push(`/ops/assessments/${a.id}`); }} />}
            <Panel title="Assessments" actions={
                <select className={inputClass + " w-auto"} value={filter} onChange={(e) => setFilter(e.target.value as any)}>
                    <option value="open">Draft, scheduled and live</option><option value="all">All</option>
                </select>}>
                {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : rows.length === 0 ? <Empty>No assessments yet.</Empty> : (
                    <Table head={["Ref", "Client · site", "Package", "Status", "Window", "Time left", "Payment", "Report", "Deletion"]}>
                        {rows.map((a) => (
                            <tr key={a.id} className="border-t border-slate-800">
                                <td className="py-2 pr-3"><Link className="text-blue-300 hover:underline" href={`/ops/assessments/${a.id}`}>{a.reference}</Link></td>
                                <td className="py-2 pr-3"><div className="text-slate-200">{a.tenant_name}</div><div className="text-xs text-slate-500">{a.project_name}</div></td>
                                <td className="py-2 pr-3 text-slate-300">{a.package_name ?? `${a.duration_days} days (custom)`}</td>
                                <td className="py-2 pr-3"><Badge tone={STATUS_TONE[a.effective_status]}>{STATUS_LABEL[a.effective_status]}</Badge></td>
                                <td className="py-2 pr-3 text-xs text-slate-400 whitespace-nowrap">
                                    {a.start_at ? <>{fmtDateTime(a.start_at)}<br />→ {fmtDateTime(a.effective_end_at)}</> : a.planned_start_at ? <>planned {fmtDateTime(a.planned_start_at)}</> : "not scheduled"}
                                </td>
                                <td className="py-2 pr-3 text-slate-200">{a.live ? a.remaining : "—"}</td>
                                <td className="py-2 pr-3"><Badge tone={a.payment_state === "paid" ? "green" : a.payment_state === "exception" ? "amber" : "grey"}>{a.payment_state}</Badge></td>
                                <td className="py-2 pr-3 text-xs text-slate-400">{a.report_status.replace(/_/g, " ")}</td>
                                <td className="py-2 pr-3 text-xs text-slate-400">{a.retention_until ? fmtDate(a.retention_until) : `${a.retention_months} months after end`}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}

function NewAssessment({ onCreated }: { onCreated: (a: Assessment) => void }) {
    const projects = useQuery({ queryKey: ["projects", "all"], queryFn: () => apiGet<Project[]>("/ingestion/projects") });
    const packages = useQuery({ queryKey: ["packages"], queryFn: () => apiGet<Package[]>("/ingestion/assessment-packages") });
    const [f, setF] = useState({ project_id: "", package_id: "", duration_days: "", price: "", retention_months: "3", planned_start_at: "", title: "", internal_notes: "" });
    const [err, setErr] = useState<string | null>(null);
    const pkg = (packages.data ?? []).find((p) => p.id === f.package_id);
    const create = useMutation({
        mutationFn: () => {
            const body: any = { project_id: f.project_id, retention_months: Number(f.retention_months) };
            if (f.package_id) body.package_id = f.package_id;
            if (f.duration_days) body.duration_days = Number(f.duration_days);
            const cents = toCents(f.price);
            if (cents !== null) body.price_cents = cents;
            if (f.planned_start_at) body.planned_start_at = new Date(f.planned_start_at).toISOString();
            if (f.title) body.title = f.title;
            if (f.internal_notes) body.internal_notes = f.internal_notes;
            return apiSend<Assessment>("POST", "/ingestion/assessments", body);
        },
        onSuccess: onCreated,
        onError: (e: any) => setErr(e.message),
    });
    const clientProjects = (projects.data ?? []).filter((p) => p.status !== "archived");
    return (
        <Panel title="New assessment" subtitle="Creates a draft. The clock starts only when you confirm the start on the assessment page, after payment (or an approved exception).">
            <form className="grid md:grid-cols-3 gap-4" onSubmit={(e) => { e.preventDefault(); setErr(null); create.mutate(); }}>
                <Field label="Site / project">
                    <select required className={inputClass} value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
                        <option value="">Choose…</option>
                        {clientProjects.map((p) => <option key={p.id} value={p.id}>{p.tenant_name} · {p.name}</option>)}
                    </select>
                </Field>
                <Field label="Package" hint={pkg ? `${pkg.duration_days} days · ${pkg.price}${pkg.tax_basis ? "" : " (VAT basis not set)"}` : "or a custom duration"}>
                    <select className={inputClass} value={f.package_id} onChange={(e) => setF({ ...f, package_id: e.target.value })}>
                        <option value="">Custom</option>
                        {(packages.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} · {zarCents(p.price_cents)}{p.status === "draft" ? " (draft)" : ""}</option>)}
                    </select>
                </Field>
                <Field label="Duration (days)" hint={pkg ? "blank = the package's" : "required for a custom assessment"}>
                    <input className={inputClass} type="number" min={1} max={366} value={f.duration_days} onChange={(e) => setF({ ...f, duration_days: e.target.value })} />
                </Field>
                <Field label="Agreed price (R)" hint={pkg ? `blank = ${zarCents(pkg.price_cents)}` : "the quoted price"}>
                    <input className={inputClass} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
                </Field>
                <Field label="Data retention after the end">
                    <select className={inputClass} value={f.retention_months} onChange={(e) => setF({ ...f, retention_months: e.target.value })}>
                        <option value="3">3 calendar months</option><option value="6">6 calendar months</option>
                    </select>
                </Field>
                <Field label={`Planned start (${TZ_LABEL})`} hint="for planning only">
                    <input className={inputClass} type="datetime-local" value={f.planned_start_at} onChange={(e) => setF({ ...f, planned_start_at: e.target.value })} />
                </Field>
                <Field label="Title" hint="blank = site and duration"><input className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
                <Field label="Internal notes" hint="staff only"><input className={inputClass} value={f.internal_notes} onChange={(e) => setF({ ...f, internal_notes: e.target.value })} /></Field>
                <div className="flex items-end gap-3">
                    <Button type="submit" disabled={create.isPending || !f.project_id}>{create.isPending ? "Creating…" : "Create draft"}</Button>
                    {err && <span className="text-sm text-red-400">{err}</span>}
                </div>
            </form>
            <p className="text-xs text-slate-500 mt-3">Points: every metered point of the site is included; change them on the draft before starting.</p>
        </Panel>
    );
}
