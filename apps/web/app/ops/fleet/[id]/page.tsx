"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, fmtDateTime, fmtDate, TZ_LABEL } from "@/lib/api";
import { ROLE_LABEL } from "@/lib/ops";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty, Button, Field, inputClass } from "@/components/ops/ui";
import { AssetHistory } from "@/components/ops/AssetHistory";

interface Deployment {
    id: string; installed_at: string; removed_at: string | null; point_name: string; role: string;
    project_id: string; project_name: string; tenant_name: string; power_sign: number; scale_correction: number;
    commissioning: { overall?: string } | null;
}
interface Device {
    id: string; code: string | null; name: string; serial_number: string | null; model: string | null; status: string;
    comms_module: string | null; firmware: string | null; router_model: string | null; sim_iccid: string | null;
    calibration_due_on: string | null; notes: string | null; mqtt_username: string | null; deployments: Deployment[];
}

const EDITABLE = ["name", "serial_number", "model", "comms_module", "firmware", "router_model", "sim_iccid", "calibration_due_on", "notes"] as const;

export default function DevicePage() {
    const { id } = useParams<{ id: string }>();
    const qc = useQueryClient();
    const dev = useQuery({ queryKey: ["device", id], queryFn: () => apiGet<Device>(`/ingestion/devices/${id}`) });
    const [form, setForm] = useState<Record<string, string>>({});
    useEffect(() => {
        if (dev.data) setForm(Object.fromEntries(EDITABLE.map((k) => [k, (dev.data as any)[k] ?? ""])));
    }, [dev.data]);

    const save = useMutation({
        mutationFn: (body: Record<string, unknown>) => apiSend("PATCH", `/ingestion/devices/${id}`, body),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["device", id] }); qc.invalidateQueries({ queryKey: ["fleet"] }); },
    });
    const retire = useMutation({
        mutationFn: () => apiSend("DELETE", `/ingestion/devices/${id}`, { reason: "retired from the ops console" }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["device", id] }); qc.invalidateQueries({ queryKey: ["fleet"] }); },
    });

    if (dev.isLoading) return <Loading />;
    if (dev.error || !dev.data) return <ErrorBox error={dev.error ?? "Not found"} />;
    const d = dev.data;
    const open = d.deployments.find((x) => !x.removed_at);

    return (
        <div className="space-y-6">
            <PageHeader title={d.code ?? d.name} subtitle={d.code ? `${d.name} · broker user ${d.mqtt_username}` : "Legacy meter (publishes on its UUID topic)"}
                actions={<>
                    <Badge tone={d.status === "deployed" ? "green" : d.status === "maintenance" ? "amber" : "grey"}>{d.status.replace("_", " ")}</Badge>
                    {open ? <Link href={`/ops/deployments/${open.id}`}><Button variant="secondary">Current deployment</Button></Link>
                        : d.status !== "retired" && <Link href={`/ops/install?device=${d.id}`}><Button>Install</Button></Link>}
                </>} />

            <Panel title="Deployment history" subtitle={`Every place this box has measured. Times ${TZ_LABEL}.`}>
                {d.deployments.length === 0 ? <Empty>Never deployed.</Empty> : (
                    <Table head={["Project", "Point", "Installed", "Removed", "Corrections", "Commissioning", ""]}>
                        {d.deployments.map((x) => (
                            <tr key={x.id}>
                                <td className="py-2 pr-4"><Link className="text-blue-300 hover:underline" href={`/ops/projects/${x.project_id}`}>{x.project_name}</Link>
                                    <p className="text-xs text-slate-500">{x.tenant_name}</p></td>
                                <td className="py-2 pr-4">{x.point_name} <span className="text-slate-500">({ROLE_LABEL[x.role] ?? x.role})</span></td>
                                <td className="py-2 pr-4 whitespace-nowrap">{fmtDateTime(x.installed_at)}</td>
                                <td className="py-2 pr-4 whitespace-nowrap">{x.removed_at ? fmtDateTime(x.removed_at) : <Badge tone="green">active</Badge>}</td>
                                <td className="py-2 pr-4">{x.power_sign === -1 || Number(x.scale_correction) !== 1
                                    ? `sign ${x.power_sign}, scale ${x.scale_correction}` : "none"}</td>
                                <td className="py-2 pr-4">{x.commissioning?.overall ?? "–"}</td>
                                <td className="py-2"><Link className="text-blue-300 hover:underline" href={`/ops/deployments/${x.id}`}>open</Link></td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>

            <AssetHistory deviceId={d.id} deployed={!!open} />

            <Panel title="Asset details">
                <form className="grid grid-cols-2 lg:grid-cols-3 gap-3" onSubmit={(e) => {
                    e.preventDefault();
                    const body = Object.fromEntries(EDITABLE.filter((k) => (form[k] ?? "") !== ((d as any)[k] ?? "")).map((k) => [k, form[k] === "" ? null : form[k]]));
                    if (Object.keys(body).length) save.mutate(body);
                }}>
                    {EDITABLE.map((k) => (
                        <Field key={k} label={k.replace(/_/g, " ")}>
                            <input type={k === "calibration_due_on" ? "date" : "text"} className={inputClass}
                                value={k === "calibration_due_on" ? (form[k] ?? "").slice(0, 10) : form[k] ?? ""}
                                onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                        </Field>
                    ))}
                    <div className="col-span-full flex items-center gap-2">
                        <Button type="submit" disabled={save.isPending}>Save</Button>
                        {save.isSuccess && <span className="text-sm text-emerald-300">Saved</span>}
                        <span className="text-xs text-slate-500 ml-auto">Calibration due {fmtDate(d.calibration_due_on)}</span>
                        {d.status !== "retired" && !open && (
                            <Button type="button" variant="danger" disabled={retire.isPending}
                                onClick={() => { if (confirm(`Retire ${d.code ?? d.name}? It stops ingesting. Its readings are kept.`)) retire.mutate(); }}>
                                Retire
                            </Button>
                        )}
                    </div>
                    <div className="col-span-full"><ErrorBox error={save.error ?? retire.error} /></div>
                </form>
            </Panel>
        </div>
    );
}
