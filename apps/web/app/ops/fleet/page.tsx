"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { apiGet, apiSend, fmtAgo, fmtDate, TZ_LABEL } from "@/lib/api";
import { FleetRow, deviceHealth, fmtBytes, pct, ROLE_LABEL } from "@/lib/ops";
import { PageHeader, Panel, Table, RagDot, Badge, Loading, ErrorBox, Empty, Button, Field, inputClass } from "@/components/ops/ui";

const STATUSES = ["all", "deployed", "available", "reserved", "in_transit", "maintenance", "retired"] as const;
const STATUS_LABEL: Record<string, string> = { deployed: "Deployed", available: "Available", reserved: "Reserved", in_transit: "In transit", maintenance: "Maintenance", retired: "Retired" };

export default function FleetPage() {
    const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
    const [adding, setAdding] = useState(false);
    const fleet = useQuery({
        queryKey: ["fleet"],
        queryFn: () => apiGet<FleetRow[]>("/ingestion/fleet"),
        refetchInterval: 60_000,
    });
    const rows = (fleet.data ?? []).filter((d) => status === "all" ? d.status !== "retired" : d.status === status);
    const counts = (fleet.data ?? []).reduce<Record<string, number>>((a, d) => ({ ...a, [d.status]: (a[d.status] ?? 0) + 1 }), {});

    return (
        <div>
            <PageHeader title="Fleet" subtitle={`Every box, where it is and how it is doing. Coverage and drift over the last 24 h / hour; times ${TZ_LABEL}.`}
                actions={<Button onClick={() => setAdding((v) => !v)}><Plus className="h-4 w-4" />New box</Button>} />
            {adding && <NewDevice onDone={() => setAdding(false)} />}
            <div className="flex flex-wrap gap-2 mb-4">
                {STATUSES.map((s) => (
                    <button key={s} onClick={() => setStatus(s)}
                        className={`px-3 py-1.5 rounded-lg text-sm border ${status === s ? "bg-blue-600/20 border-blue-500/40 text-blue-200" : "border-slate-700 text-slate-400 hover:text-white"}`}>
                        {s === "all" ? "All active" : STATUS_LABEL[s]} {s !== "all" && counts[s] ? `(${counts[s]})` : ""}
                    </button>
                ))}
            </div>
            <Panel>
                {fleet.isLoading ? <Loading /> : fleet.error ? <ErrorBox error={fleet.error} /> : rows.length === 0 ? <Empty>No boxes here.</Empty> : (
                    <Table head={["", "Box", "Status", "Project / point", "Last seen", "Coverage 24 h", "Clock drift", "Data / day", "Calibration due"]}>
                        {rows.map((d) => {
                            const h = deviceHealth(d);
                            return (
                                <tr key={d.id} className="hover:bg-slate-900/60">
                                    <td className="py-2.5 pr-3"><RagDot rag={h.rag} title={h.reasons.join(", ") || "healthy"} /></td>
                                    <td className="py-2.5 pr-4">
                                        <Link href={`/ops/fleet/${d.id}`} className="font-medium text-blue-300 hover:underline">{d.code ?? d.name}</Link>
                                        <p className="text-xs text-slate-500">{d.code ? d.name : "legacy meter"}{d.serial_number ? ` · ${d.serial_number}` : ""}</p>
                                    </td>
                                    <td className="py-2.5 pr-4"><Badge tone={d.status === "deployed" ? "green" : d.status === "maintenance" ? "amber" : "grey"}>{STATUS_LABEL[d.status]}</Badge></td>
                                    <td className="py-2.5 pr-4">
                                        {d.project_id ? (
                                            <>
                                                <Link href={`/ops/projects/${d.project_id}`} className="text-slate-200 hover:underline">{d.project_name}</Link>
                                                <p className="text-xs text-slate-500">{d.tenant_name} · {d.point_name} ({ROLE_LABEL[d.point_role ?? ""] ?? d.point_role})</p>
                                            </>
                                        ) : <span className="text-slate-500">–</span>}
                                    </td>
                                    <td className="py-2.5 pr-4 whitespace-nowrap">{fmtAgo(d.last_seen)}</td>
                                    <td className="py-2.5 pr-4">{d.status === "deployed" ? pct(d.coverage_24h) : "–"}</td>
                                    <td className="py-2.5 pr-4">{d.clock_drift_s === null ? "–" : `${d.clock_drift_s} s`}</td>
                                    <td className="py-2.5 pr-4">{fmtBytes(d.payload_bytes_24h)}</td>
                                    <td className="py-2.5 pr-4 whitespace-nowrap">{fmtDate(d.calibration_due_on)}</td>
                                </tr>
                            );
                        })}
                    </Table>
                )}
            </Panel>
            <p className="text-xs text-slate-500 mt-3">Red: silent 15 min, coverage under 80 %, clock 30 s off or commissioning failed. Amber: coverage under 95 %, clock 5 s off, calibration due within 30 days.</p>
        </div>
    );
}

function NewDevice({ onDone }: { onDone: () => void }) {
    const qc = useQueryClient();
    const [f, setF] = useState({ code: "", serial_number: "", model: "Acuvim II", comms_module: "AXM-WEB2", router_model: "", sim_iccid: "", calibration_due_on: "" });
    const create = useMutation({
        mutationFn: () => apiSend<any>("POST", "/ingestion/devices", Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""))),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["fleet"] }); },
    });
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
    return (
        <Panel title="New box" className="mb-4" subtitle="The code becomes the broker username (lower case) and the topic segment.">
            {create.data ? (
                <div className="space-y-2 text-sm">
                    <p className="text-emerald-300">Created {create.data.code}.</p>
                    <p className="text-slate-300">Broker username <code className="text-white">{create.data.mqtt.username}</code>, topic <code className="text-white">{create.data.mqtt.topic}</code>.</p>
                    <p className="text-slate-400">{create.data.mqtt.note}</p>
                    <Button variant="secondary" onClick={onDone}>Close</Button>
                </div>
            ) : (
                <form className="grid grid-cols-2 lg:grid-cols-4 gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                    <Field label="Code"><input className={inputClass} value={f.code} onChange={set("code")} placeholder="GQ-M01" required /></Field>
                    <Field label="Meter serial"><input className={inputClass} value={f.serial_number} onChange={set("serial_number")} /></Field>
                    <Field label="Meter model"><input className={inputClass} value={f.model} onChange={set("model")} /></Field>
                    <Field label="Comms module"><input className={inputClass} value={f.comms_module} onChange={set("comms_module")} /></Field>
                    <Field label="Router"><input className={inputClass} value={f.router_model} onChange={set("router_model")} /></Field>
                    <Field label="SIM ICCID"><input className={inputClass} value={f.sim_iccid} onChange={set("sim_iccid")} /></Field>
                    <Field label="Calibration due"><input type="date" className={inputClass} value={f.calibration_due_on} onChange={set("calibration_due_on")} /></Field>
                    <div className="flex items-end gap-2">
                        <Button type="submit" disabled={create.isPending}>Create</Button>
                        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
                    </div>
                    <div className="col-span-full"><ErrorBox error={create.error} /></div>
                </form>
            )}
        </Panel>
    );
}
