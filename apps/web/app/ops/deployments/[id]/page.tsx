"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, AlertTriangle, Clock, MinusCircle } from "lucide-react";
import { apiGet, apiSend, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { ROLE_LABEL } from "@/lib/ops";
import { PageHeader, Panel, Badge, Loading, ErrorBox, Button, Field, inputClass, Table, Empty } from "@/components/ops/ui";

interface Check { id: string; label: string; status: string; detail: string; }
interface Deployment {
    id: string; device_id: string; device_code: string | null; device_name: string;
    measurement_point_id: string; point_name: string; role: string; project_id: string; project_name: string;
    installed_at: string; removed_at: string | null; installed_by: string | null;
    power_sign: number; scale_correction: number; ct_ratio_configured: string | null; pt_ratio_configured: string | null;
    commissioning: { final: boolean; overall: string; evaluated_at?: string; window_to?: string; note?: string; checks: Check[] } | null;
    audit: { at: string; actor_email: string | null; action: string; before: any; after: any; reason: string | null }[];
}

const ICON: Record<string, React.ReactNode> = {
    pass: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
    fail: <XCircle className="h-4 w-4 text-red-400" />,
    warn: <AlertTriangle className="h-4 w-4 text-amber-300" />,
    pending: <Clock className="h-4 w-4 text-blue-300" />,
};
const TONE: Record<string, "green" | "red" | "amber" | "blue" | "grey"> = { pass: "green", fail: "red", warn: "amber", pending: "blue" };

export default function DeploymentPage() {
    const { id } = useParams<{ id: string }>();
    const qc = useQueryClient();
    const dep = useQuery({
        queryKey: ["deployment", id],
        queryFn: () => apiGet<Deployment>(`/ingestion/deployments/${id}`),
        // Live while the 15-minute checklist runs.
        refetchInterval: (q) => (q.state.data && !q.state.data.removed_at && !q.state.data.commissioning?.final ? 15_000 : false),
    });
    const refresh = () => { qc.invalidateQueries({ queryKey: ["deployment", id] }); qc.invalidateQueries({ queryKey: ["fleet"] }); };

    const [corr, setCorr] = useState({ power_sign: "", scale_correction: "", ct_ratio_configured: "", pt_ratio_configured: "", reason: "" });
    const correct = useMutation({
        mutationFn: () => apiSend("PATCH", `/ingestion/deployments/${id}/corrections`, {
            reason: corr.reason,
            ...(corr.power_sign ? { power_sign: Number(corr.power_sign) } : {}),
            ...(corr.scale_correction ? { scale_correction: Number(corr.scale_correction) } : {}),
            ...(corr.ct_ratio_configured ? { ct_ratio_configured: Number(corr.ct_ratio_configured) } : {}),
            ...(corr.pt_ratio_configured ? { pt_ratio_configured: Number(corr.pt_ratio_configured) } : {}),
        }),
        onSuccess: () => { setCorr({ power_sign: "", scale_correction: "", ct_ratio_configured: "", pt_ratio_configured: "", reason: "" }); refresh(); },
    });
    const [rm, setRm] = useState({ removed_at: "", device_status: "available", reason: "" });
    const remove = useMutation({
        mutationFn: () => apiSend("POST", `/ingestion/deployments/${id}/remove`, {
            device_status: rm.device_status, reason: rm.reason || undefined,
            ...(rm.removed_at ? { removed_at: new Date(rm.removed_at).toISOString() } : {}),
        }),
        onSuccess: refresh,
    });

    if (dep.isLoading) return <Loading />;
    if (dep.error || !dep.data) return <ErrorBox error={dep.error ?? "Not found"} />;
    const d = dep.data;
    const c = d.commissioning;

    return (
        <div className="space-y-6 max-w-5xl">
            <PageHeader
                title={`${d.device_code ?? d.device_name} at ${d.point_name}`}
                subtitle={`${d.project_name} · ${ROLE_LABEL[d.role] ?? d.role} · installed ${fmtDateTime(d.installed_at)} ${TZ_LABEL}${d.installed_by ? ` by ${d.installed_by}` : ""}`}
                actions={<>
                    {d.removed_at ? <Badge>removed {fmtDateTime(d.removed_at)}</Badge> : <Badge tone="green">active</Badge>}
                    <Link href={`/ops/projects/${d.project_id}`}><Button variant="secondary">Project</Button></Link>
                    <Link href={`/ops/fleet/${d.device_id}`}><Button variant="secondary">Box</Button></Link>
                </>} />

            <Panel title="Commissioning checklist"
                subtitle={c?.note ?? (c ? `${c.final ? "Final" : "Live: re-evaluated every minute for 15 minutes after install"} · last evaluated ${fmtDateTime(c.evaluated_at)}` : "Waiting for the first evaluation (within a minute)")}
                actions={c && <Badge tone={TONE[c.overall] ?? "grey"}>{c.overall}</Badge>}>
                {!c || c.checks.length === 0 ? <Empty>{c?.note ?? "No result yet."}</Empty> : (
                    <ul className="divide-y divide-slate-800">
                        {c.checks.map((ch) => (
                            <li key={ch.id} className="flex items-start gap-3 py-2.5">
                                <span className="mt-0.5">{ICON[ch.status] ?? <MinusCircle className="h-4 w-4 text-slate-500" />}</span>
                                <div className="flex-1">
                                    <p className="text-sm text-slate-100">{ch.label}</p>
                                    <p className="text-xs text-slate-400">{ch.detail}</p>
                                </div>
                                <span className="text-xs text-slate-500">{ch.status.replace("_", " ")}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Panel>

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Corrections" subtitle={`Now: power sign ${d.power_sign}, scale ${d.scale_correction}, CT ${d.ct_ratio_configured ?? "–"}, PT ${d.pt_ratio_configured ?? "–"}. Raw readings are never changed.`}>
                    <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); correct.mutate(); }}>
                        <Field label="Power sign">
                            <select className={inputClass} value={corr.power_sign} onChange={(e) => setCorr({ ...corr, power_sign: e.target.value })}>
                                <option value="">unchanged</option><option value="1">+1</option><option value="-1">−1 (CT reversed)</option>
                            </select>
                        </Field>
                        <Field label="Scale correction"><input className={inputClass} value={corr.scale_correction} onChange={(e) => setCorr({ ...corr, scale_correction: e.target.value })} placeholder="unchanged" /></Field>
                        <Field label="CT ratio configured"><input className={inputClass} value={corr.ct_ratio_configured} onChange={(e) => setCorr({ ...corr, ct_ratio_configured: e.target.value })} placeholder="unchanged" /></Field>
                        <Field label="PT ratio configured"><input className={inputClass} value={corr.pt_ratio_configured} onChange={(e) => setCorr({ ...corr, pt_ratio_configured: e.target.value })} placeholder="unchanged" /></Field>
                        <div className="col-span-2"><Field label="Reason (required, audit-logged)"><input className={inputClass} value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} placeholder="CT installed backwards on L1–L3" required /></Field></div>
                        <div className="col-span-2 flex items-center gap-2">
                            <Button type="submit" disabled={correct.isPending || !corr.reason}>Apply correction</Button>
                        </div>
                        <div className="col-span-2"><ErrorBox error={correct.error} /></div>
                    </form>
                </Panel>

                {!d.removed_at && (
                    <Panel title="Remove" subtitle="When the box is disconnected. Readings after this belong to no project until the next install.">
                        <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); if (confirm("Record this box as removed?")) remove.mutate(); }}>
                            <Field label="Disconnected at (your local time)" hint="Empty = now"><input type="datetime-local" className={inputClass} value={rm.removed_at} onChange={(e) => setRm({ ...rm, removed_at: e.target.value })} /></Field>
                            <Field label="Box goes to">
                                <select className={inputClass} value={rm.device_status} onChange={(e) => setRm({ ...rm, device_status: e.target.value })}>
                                    <option value="available">Available (depot)</option><option value="in_transit">In transit</option><option value="maintenance">Maintenance</option>
                                </select>
                            </Field>
                            <div className="col-span-2"><Field label="Note"><input className={inputClass} value={rm.reason} onChange={(e) => setRm({ ...rm, reason: e.target.value })} /></Field></div>
                            <div className="col-span-2"><Button type="submit" variant="danger" disabled={remove.isPending}>Remove</Button></div>
                            <div className="col-span-2"><ErrorBox error={remove.error} /></div>
                        </form>
                    </Panel>
                )}
            </div>

            <Panel title="Audit trail">
                {d.audit.length === 0 ? <Empty>No changes recorded.</Empty> : (
                    <Table head={["When", "Who", "What", "Before → after", "Reason"]}>
                        {d.audit.map((a, i) => (
                            <tr key={i}>
                                <td className="py-2 pr-4 whitespace-nowrap">{fmtDateTime(a.at)}</td>
                                <td className="py-2 pr-4">{a.actor_email ?? "–"}</td>
                                <td className="py-2 pr-4">{a.action}</td>
                                <td className="py-2 pr-4 text-xs text-slate-400 font-mono">{a.action === "deployment.correct" ? `${JSON.stringify(a.before)} → ${JSON.stringify(a.after)}` : ""}</td>
                                <td className="py-2 pr-4">{a.reason ?? ""}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}
