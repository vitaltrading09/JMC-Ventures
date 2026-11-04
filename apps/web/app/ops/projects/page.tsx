"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { apiGet, apiSend, fmtDate } from "@/lib/api";
import { Project, pct, projectFlags } from "@/lib/ops";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty, Button, Field, inputClass, RagDot } from "@/components/ops/ui";

interface Tenant { id: string; name: string; kind: string; }

export default function ProjectsPage() {
    const [filter, setFilter] = useState<"attention" | "active" | "all">("active");
    const [adding, setAdding] = useState(false);
    const projects = useQuery({ queryKey: ["projects", "all"], queryFn: () => apiGet<Project[]>("/ingestion/projects") });
    const rows = (projects.data ?? [])
        .map((p) => ({ p, flags: projectFlags(p) }))
        .filter(({ p, flags }) => filter === "all" ? true : filter === "active" ? p.status === "active" || p.status === "planned" : flags.length > 0);

    return (
        <div>
            <PageHeader title="Projects" subtitle="Every client's projects. A report is due monthly while a project runs, and at its end."
                actions={<Button onClick={() => setAdding((v) => !v)}><Plus className="h-4 w-4" />New project</Button>} />
            {adding && <NewProject onDone={() => setAdding(false)} />}
            <div className="flex gap-2 mb-4">
                {(["attention", "active", "all"] as const).map((f) => (
                    <button key={f} onClick={() => setFilter(f)}
                        className={`px-3 py-1.5 rounded-lg text-sm border ${filter === f ? "bg-blue-600/20 border-blue-500/40 text-blue-200" : "border-slate-700 text-slate-400"}`}>
                        {f === "attention" ? "Needs attention" : f === "active" ? "Active" : "All"}
                    </button>
                ))}
            </div>
            <Panel>
                {projects.isLoading ? <Loading /> : projects.error ? <ErrorBox error={projects.error} /> : rows.length === 0 ? <Empty>No projects here.</Empty> : (
                    <Table head={["", "Project", "Client", "Status", "Dates", "Points / boxes", "Coverage 24 h", "Last report", "Attention"]}>
                        {rows.map(({ p, flags }) => (
                            <tr key={p.id} className="hover:bg-slate-900/60">
                                <td className="py-2.5 pr-3"><RagDot rag={flags.length ? (flags.some((f) => f.startsWith("coverage") || f === "past end date") ? "red" : "amber") : p.status === "active" ? "green" : "grey"} /></td>
                                <td className="py-2.5 pr-4"><Link href={`/ops/projects/${p.id}`} className="font-medium text-blue-300 hover:underline">{p.name}</Link>
                                    {p.end_client_name && <p className="text-xs text-slate-500">{p.end_client_name}</p>}</td>
                                <td className="py-2.5 pr-4">{p.tenant_name}</td>
                                <td className="py-2.5 pr-4"><Badge tone={p.status === "active" ? "green" : p.status === "planned" ? "blue" : "grey"}>{p.status}</Badge>
                                    {!p.live_data_visible && <span className="ml-1"><Badge tone="amber">live data hidden</Badge></span>}</td>
                                <td className="py-2.5 pr-4 whitespace-nowrap text-xs">{fmtDate(p.starts_on)} – {fmtDate(p.ends_on)}</td>
                                <td className="py-2.5 pr-4">{p.points} / {p.active_deployments}</td>
                                <td className="py-2.5 pr-4">{p.active_deployments ? pct(p.coverage_24h) : "–"}</td>
                                <td className="py-2.5 pr-4 whitespace-nowrap">{p.last_report_end ? `to ${fmtDate(new Date(new Date(p.last_report_end).getTime() - 1))}` : "none"}{p.reports_in_progress ? <span className="text-xs text-slate-500"> · {p.reports_in_progress} in progress</span> : null}</td>
                                <td className="py-2.5 pr-4 text-xs text-amber-300">{flags.join(", ")}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}

function NewProject({ onDone }: { onDone: () => void }) {
    const qc = useQueryClient();
    const tenants = useQuery({ queryKey: ["tenants"], queryFn: () => apiGet<Tenant[]>("/ingestion/tenants") });
    const [f, setF] = useState({ tenant_id: "", name: "", end_client_name: "", address: "", starts_on: "", ends_on: "" });
    const create = useMutation({
        mutationFn: () => apiSend("POST", "/ingestion/projects", Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""))),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects"] }); onDone(); },
    });
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
    return (
        <Panel title="New project" className="mb-4">
            <form className="grid md:grid-cols-3 gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                <Field label="Client">
                    <select className={inputClass} value={f.tenant_id} onChange={set("tenant_id")} required>
                        <option value="">Choose…</option>
                        {(tenants.data ?? []).filter((t) => t.kind === "client").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                </Field>
                <Field label="Project name"><input className={inputClass} value={f.name} onChange={set("name")} required /></Field>
                <Field label="End client"><input className={inputClass} value={f.end_client_name} onChange={set("end_client_name")} /></Field>
                <Field label="Address"><input className={inputClass} value={f.address} onChange={set("address")} /></Field>
                <Field label="Starts"><input type="date" className={inputClass} value={f.starts_on} onChange={set("starts_on")} /></Field>
                <Field label="Ends"><input type="date" className={inputClass} value={f.ends_on} onChange={set("ends_on")} /></Field>
                <div className="md:col-span-3 flex gap-2"><Button type="submit" disabled={create.isPending}>Create</Button><Button type="button" variant="secondary" onClick={onDone}>Cancel</Button></div>
                <div className="md:col-span-3"><ErrorBox error={create.error} /></div>
            </form>
        </Panel>
    );
}
