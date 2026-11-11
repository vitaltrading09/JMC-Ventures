"use client";

// Internal project page: details, its assessments (client access), measurement points
// (with the box at each), the energy balance, reports, tariffs and alert
// thresholds. The client sees the same project in the portal (PR 2).

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { apiGet, apiSend, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/ops";
import { BalanceView, Balance } from "@/components/fleet/BalanceView";
import { SldView } from "@/components/sld/SldView";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty, Button, Field, inputClass } from "@/components/ops/ui";
import { Assessment, STATUS_LABEL, STATUS_TONE } from "@/lib/assessments";

interface Point {
    id: string; name: string; role: string; parent_point_id: string | null; nominal_voltage_v: string | null;
    ct_primary_a: string | null; contracted_mdi_kva: string | null; archived_at: string | null; sort_order: number;
    deployment_id: string | null; device_id: string | null; device_code: string | null; device_name: string | null; installed_at: string | null;
}
interface ProjectDetail {
    id: string; tenant_id: string; name: string; end_client_name: string | null; address: string | null; status: string;
    starts_on: string | null; ends_on: string | null; live_data_visible: boolean; notes: string | null; timezone: string;
    gps_lat: number | null; gps_lon: number | null; site_context: Record<string, unknown> | null;
    points: Point[];
}

const DETAIL_FIELDS = ["name", "end_client_name", "address", "gps_lat", "gps_lon", "status", "notes"] as const;
const SETTINGS_FIELDS: [string, string][] = [
    ["tariff_peak", "Peak tariff (R/kWh)"], ["tariff_standard", "Standard (R/kWh)"], ["tariff_offpeak", "Off-peak (R/kWh)"],
    ["tariff_demand", "Demand (R/kVA)"], ["contracted_mdi_kva", "Contracted MDI (kVA)"], ["alert_max_kw", "Alert above (kW)"],
    ["alert_min_v", "Alert below (V)"], ["alert_max_v", "Alert above (V)"], ["alert_max_thd", "THD-V limit (%)"],
];

export default function OpsProjectPage() {
    const { id } = useParams<{ id: string }>();
    const qc = useQueryClient();
    const project = useQuery({ queryKey: ["project", id], queryFn: () => apiGet<ProjectDetail>(`/ingestion/projects/${id}`) });
    const balance = useQuery({ queryKey: ["balance", id], queryFn: () => apiGet<Balance>(`/ingestion/projects/${id}/energy-balance`) });
    const reports = useQuery({ queryKey: ["reports", id], queryFn: () => apiGet<any[]>(`/ingestion/reports?project_id=${id}`) });
    const settings = useQuery({ queryKey: ["settings", id], queryFn: () => apiGet<Record<string, any>>(`/ingestion/sites/${id}/settings`) });
    const refresh = () => { qc.invalidateQueries({ queryKey: ["project", id] }); qc.invalidateQueries({ queryKey: ["projects"] }); };

    const [form, setForm] = useState<Record<string, string>>({});
    useEffect(() => {
        if (project.data) setForm(Object.fromEntries(DETAIL_FIELDS.map((k) => [k, ((project.data as any)[k] ?? "").toString().slice(0, k.endsWith("_on") ? 10 : undefined)])));
    }, [project.data]);
    const saveDetails = useMutation({
        mutationFn: (body: Record<string, unknown>) => apiSend("PATCH", `/ingestion/projects/${id}`, body),
        onSuccess: refresh,
    });

    if (project.isLoading) return <Loading />;
    if (project.error || !project.data) return <ErrorBox error={project.error ?? "Not found"} />;
    const p = project.data;
    const live = p.points.filter((x) => !x.archived_at);

    return (
        <div className="space-y-6">
            <PageHeader title={p.name} subtitle={[p.end_client_name, p.address].filter(Boolean).join(" · ") || undefined}
                actions={<>
                    <Badge tone={p.status === "active" ? "green" : "grey"}>{p.status}</Badge>
                    <Link href="/ops/assessments?new=1"><Button>New assessment</Button></Link>
                </>} />

            <ProjectAssessments projectId={id} />
            <SiteContext projectId={id} context={p.site_context ?? {}} onSaved={refresh} />

            <Points projectId={id} points={live} onChange={refresh} />

            <Panel title="Metering layout" subtitle="Single-line diagram with the project's points pinned on it. Edit to upload the site's SLD PDF and place the points.">
                <SldView projectId={id} editable />
            </Panel>

            <Panel title="Energy balance" subtitle={balance.data ? `${fmtDateTime(balance.data.from)} – ${fmtDateTime(balance.data.to)} ${TZ_LABEL}, from the kWh registers (power-integrated where a meter has none)` : "Last 30 days"}>
                {balance.isLoading ? <Loading /> : balance.error ? <ErrorBox error={balance.error} /> : balance.data && <BalanceView b={balance.data} />}
            </Panel>

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Details">
                    <form className="grid grid-cols-2 gap-3" onSubmit={(e) => {
                        e.preventDefault();
                        const body = Object.fromEntries(DETAIL_FIELDS.map((k) => [k, form[k] === "" ? null : k.startsWith("gps_") ? Number(form[k]) : form[k]]));
                        saveDetails.mutate(body);
                    }}>
                        {DETAIL_FIELDS.map((k) => (
                            <Field key={k} label={k.replace(/_/g, " ")}>
                                {k === "status" ? (
                                    <select className={inputClass} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
                                        {["planned", "active", "completed", "archived"].map((s) => <option key={s}>{s}</option>)}
                                    </select>
                                ) : (
                                    <input type={k.endsWith("_on") ? "date" : "text"} className={inputClass} value={form[k] ?? ""}
                                        onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                                )}
                            </Field>
                        ))}
                        <div className="col-span-2 flex items-center gap-2">
                            <Button type="submit" disabled={saveDetails.isPending}>Save</Button>
                            {saveDetails.isSuccess && <span className="text-sm text-emerald-300">Saved</span>}
                        </div>
                        <div className="col-span-2"><ErrorBox error={saveDetails.error} /></div>
                    </form>
                </Panel>
                <TariffSettings projectId={id} current={settings.data} />
            </div>

            <Panel title="Reports" actions={<Link href="/ops/review"><Button variant="secondary">Review queue</Button></Link>}>
                {reports.isLoading ? <Loading /> : (reports.data ?? []).length === 0 ? <Empty>No reports yet. Create one in Review → Reports.</Empty> : (
                    <Table head={["Title", "Period", "Status"]}>
                        {reports.data!.map((r) => (
                            <tr key={r.id}>
                                <td className="py-2 pr-4">{r.title ?? "–"}</td>
                                <td className="py-2 pr-4">{fmtDate(r.period_start)} – {fmtDate(new Date(new Date(r.period_end).getTime() - 1))}</td>
                                <td className="py-2 pr-4"><Badge tone={r.status === "published" ? "green" : r.status === "approved" ? "amber" : "blue"}>{r.status}</Badge></td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}

function Points({ projectId, points, onChange }: { projectId: string; points: Point[]; onChange: () => void }) {
    const [adding, setAdding] = useState(false);
    const [edit, setEdit] = useState<string | null>(null);
    const blank = { name: "", role: "incomer", parent_point_id: "", nominal_voltage_v: "230", ct_primary_a: "", contracted_mdi_kva: "" };
    const [f, setF] = useState(blank);
    const toBody = () => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === "" ? null : (["nominal_voltage_v", "ct_primary_a", "contracted_mdi_kva"].includes(k) ? Number(v) : v)]));
    const save = useMutation({
        mutationFn: () => edit ? apiSend("PATCH", `/ingestion/points/${edit}`, toBody()) : apiSend("POST", `/ingestion/projects/${projectId}/points`, toBody()),
        onSuccess: () => { setAdding(false); setEdit(null); setF(blank); onChange(); },
    });
    const archive = useMutation({ mutationFn: (pid: string) => apiSend("DELETE", `/ingestion/points/${pid}`), onSuccess: onChange });
    const startEdit = (pt: Point) => {
        setEdit(pt.id); setAdding(true);
        setF({ name: pt.name, role: pt.role, parent_point_id: pt.parent_point_id ?? "", nominal_voltage_v: pt.nominal_voltage_v ?? "",
            ct_primary_a: pt.ct_primary_a ?? "", contracted_mdi_kva: pt.contracted_mdi_kva ?? "" });
    };
    const byId = new Map(points.map((x) => [x.id, x]));
    return (
        <Panel title="Measurement points" subtitle="Places on the site. The box at each comes from its active deployment."
            actions={<div className="flex gap-2">
                <Link href="/ops/install"><Button variant="secondary">Install a box</Button></Link>
                <Button onClick={() => { setAdding(!adding); setEdit(null); setF(blank); }}><Plus className="h-4 w-4" />Point</Button>
            </div>}>
            {adding && (
                <form className="grid md:grid-cols-6 gap-3 mb-4 items-end" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                    <Field label="Name"><input className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
                    <Field label="Role">
                        <select className={inputClass} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                            {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </Field>
                    <Field label="Parent">
                        <select className={inputClass} value={f.parent_point_id} onChange={(e) => setF({ ...f, parent_point_id: e.target.value })}>
                            <option value="">Top level</option>
                            {points.filter((x) => x.id !== edit).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Nominal V (L-N)"><input className={inputClass} value={f.nominal_voltage_v} onChange={(e) => setF({ ...f, nominal_voltage_v: e.target.value })} /></Field>
                    <Field label="CT primary (A)"><input className={inputClass} value={f.ct_primary_a} onChange={(e) => setF({ ...f, ct_primary_a: e.target.value })} /></Field>
                    <Field label="Contracted MDI (kVA)"><input className={inputClass} value={f.contracted_mdi_kva} onChange={(e) => setF({ ...f, contracted_mdi_kva: e.target.value })} /></Field>
                    <div className="md:col-span-6 flex gap-2"><Button type="submit" disabled={save.isPending}>{edit ? "Save point" : "Add point"}</Button>
                        <Button type="button" variant="secondary" onClick={() => { setAdding(false); setEdit(null); }}>Cancel</Button></div>
                    <div className="md:col-span-6"><ErrorBox error={save.error} /></div>
                </form>
            )}
            {points.length === 0 ? <Empty>No points yet.</Empty> : (
                <Table head={["Point", "Role", "Parent", "Nominal V", "CT primary", "Box", ""]}>
                    {points.map((pt) => (
                        <tr key={pt.id}>
                            <td className="py-2 pr-4 font-medium">{pt.name}</td>
                            <td className="py-2 pr-4">{ROLE_LABEL[pt.role] ?? pt.role}</td>
                            <td className="py-2 pr-4">{pt.parent_point_id ? byId.get(pt.parent_point_id)?.name ?? "–" : "–"}</td>
                            <td className="py-2 pr-4">{pt.nominal_voltage_v ?? "–"}</td>
                            <td className="py-2 pr-4">{pt.ct_primary_a ? `${pt.ct_primary_a} A` : "–"}</td>
                            <td className="py-2 pr-4">{pt.deployment_id
                                ? <Link href={`/ops/deployments/${pt.deployment_id}`} className="text-blue-300 hover:underline">{pt.device_code ?? pt.device_name}</Link>
                                : <span className="text-slate-500">none</span>}</td>
                            <td className="py-2 text-right whitespace-nowrap">
                                <button className="text-xs text-blue-300 hover:underline mr-3" onClick={() => startEdit(pt)}>edit</button>
                                {!pt.deployment_id && <button className="text-xs text-red-300 hover:underline" onClick={() => { if (confirm(`Archive point "${pt.name}"?`)) archive.mutate(pt.id); }}>archive</button>}
                            </td>
                        </tr>
                    ))}
                </Table>
            )}
            <ErrorBox error={archive.error} />
        </Panel>
    );
}

function TariffSettings({ projectId, current }: { projectId: string; current?: Record<string, any> }) {
    const qc = useQueryClient();
    const [f, setF] = useState<Record<string, string>>({});
    useEffect(() => { if (current) setF(Object.fromEntries(SETTINGS_FIELDS.map(([k]) => [k, current[k] ?? ""]))); }, [current]);
    const save = useMutation({
        mutationFn: () => apiSend("POST", `/ingestion/sites/${projectId}/settings`,
            Object.fromEntries(SETTINGS_FIELDS.filter(([k]) => f[k] !== "").map(([k]) => [k, Number(f[k])]))),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", projectId] }),
    });
    return (
        <Panel title="Tariff and alert thresholds" subtitle="Used for demand charges, TOU cost and alerts. Empty fields keep their value.">
            <form className="grid grid-cols-3 gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                {SETTINGS_FIELDS.map(([k, l]) => (
                    <Field key={k} label={l}><input className={inputClass} value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
                ))}
                <div className="col-span-3 flex items-center gap-2"><Button type="submit" disabled={save.isPending}>Save</Button>
                    {save.isSuccess && <span className="text-sm text-emerald-300">Saved</span>}</div>
                <div className="col-span-3"><ErrorBox error={save.error} /></div>
            </form>
        </Panel>
    );
}

/** The project's assessments: client access follows these, not a project switch. */
function ProjectAssessments({ projectId }: { projectId: string }) {
    const q = useQuery({ queryKey: ["assessments", projectId], queryFn: () => apiGet<Assessment[]>(`/ingestion/assessments?project_id=${projectId}`) });
    return (
        <Panel title="Assessments" subtitle="Clients see this site's data only through a live assessment they hold a grant on.">
            {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (q.data ?? []).length === 0
                ? <Empty>No assessment: the client sees no data for this site. Existing (pre-GridIQ) sites need one created, with real dates.</Empty> : (
                    <ul className="text-sm divide-y divide-slate-800">{(q.data ?? []).map((a) => (
                        <li key={a.id} className="py-1.5 flex items-center gap-3">
                            <Badge tone={STATUS_TONE[a.effective_status]}>{STATUS_LABEL[a.effective_status]}</Badge>
                            <Link className="text-blue-300 hover:underline" href={`/ops/assessments/${a.id}`}>{a.reference}</Link>
                            <span className="text-slate-400 flex-1">{a.title}</span>
                            <span className="text-xs text-slate-500">{a.start_at ? `${fmtDateTime(a.start_at)} → ${fmtDateTime(a.effective_end_at)}` : "not started"}</span>
                        </li>
                    ))}</ul>
                )}
        </Panel>
    );
}

const CONTEXT_FIELDS: [string, string, string][] = [
    ["nominal_voltage", "Nominal voltage", "e.g. 400 V L-L / 230 V L-N, or 11 kV"],
    ["wiring", "Wiring system", "3-phase 4-wire, 3-wire, single phase"],
    ["supply", "Supply", "Eskom / municipal, tariff name, transformer kVA"],
    ["measurement_location", "Measurement location", "PCC, main LV board, a feeder"],
    ["fault_level", "Fault level (if known)", "kA or MVA, with source"],
    ["operating_hours", "Operating hours", "e.g. Mon–Fri 06:00–18:00, Sat 07:00–12:00"],
    ["major_loads", "Major loads", "motors, VSDs, compressors, ovens"],
    ["pf_correction", "Capacitors / PF correction", "size, stages, detuned?"],
    ["generation", "PV / inverters / generators / BESS", "sizes and where they connect"],
    ["symptoms", "Reported symptoms", "nuisance trips, flicker, failed drives"],
];

/** Site context used by the analysis and reports (prompt section 10). */
function SiteContext({ projectId, context, onSaved }: { projectId: string; context: Record<string, unknown>; onSaved: () => void }) {
    const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(CONTEXT_FIELDS.map(([k]) => [k, String(context[k] ?? "")])));
    const save = useMutation({
        mutationFn: () => apiSend("PATCH", `/ingestion/projects/${projectId}`, { site_context: Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim())) }),
        onSuccess: onSaved,
    });
    return (
        <Panel title="Site context" subtitle="What the reports and consultant may rely on. Unknown is better than guessed.">
            <form className="grid md:grid-cols-2 lg:grid-cols-3 gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                {CONTEXT_FIELDS.map(([k, label, hint]) => (
                    <Field key={k} label={label}><input className={inputClass} placeholder={hint} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
                ))}
                <div className="flex items-end gap-2"><Button type="submit" disabled={save.isPending}>Save context</Button>
                    {save.isSuccess && <span className="text-sm text-emerald-300">Saved</span>}<ErrorBox error={save.error} /></div>
            </form>
        </Panel>
    );
}
