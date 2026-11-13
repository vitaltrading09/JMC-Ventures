"use client";

// One meter's life as a company asset: health split into its dimensions,
// lifecycle status, capability profile, maintenance/calibration log, the
// assessments it served, and a single timeline of installs, removals and
// service. Used on /ops/fleet/[id].

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, fmtDateTime, fmtDate, fmtAgo, TZ_LABEL } from "@/lib/api";
import { zarCents, toCents } from "@/lib/assessments";
import { Panel, Badge, Button, Field, inputClass, Table, Empty, Loading, ErrorBox, RagDot, Rag } from "@/components/ops/ui";

interface Health {
    communication: { last_contact_at: string | null; seconds_ago: number | null; basis: string };
    freshness: { last_measurement_at: string | null; seconds_ago: number | null; basis: string };
    completeness: { coverage_24h: number | null; basis: string };
    quality: { clock_lag_s: number | null; conflicts_24h: number; unknown_params: number; basis: string };
    electrical: { open_alerts_7d: number; basis: string };
}
interface History {
    device: any;
    maintenance: { id: string; occurred_at: string; kind: string; description: string; technician: string | null; outcome: string | null; cost_cents: number | null; next_due_on: string | null }[];
    assessments: { id: string; reference: string; title: string; status: string; start_at: string | null; end_at: string | null; client_name: string }[];
    timeline: { at: string; kind: string; text: string }[];
    health: Health;
}

const STATUSES = [["available", "Available (depot)"], ["reserved", "Reserved"], ["in_transit", "In transit"], ["maintenance", "Maintenance"]] as const;

/** Thresholds for the health dots, relative to the box's own cadence where it matters. */
function rag(seconds: number | null, warnS: number, badS: number): Rag {
    if (seconds === null) return "grey";
    return seconds <= warnS ? "green" : seconds <= badS ? "amber" : "red";
}

export function AssetHistory({ deviceId, deployed }: { deviceId: string; deployed: boolean }) {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["device-history", deviceId], queryFn: () => apiGet<History>(`/ingestion/devices/${deviceId}/history`), refetchInterval: 60_000 });
    const [m, setM] = useState({ kind: "calibration", occurred_at: "", description: "", technician: "", outcome: "", cost: "", next_due_on: "" });
    const [err, setErr] = useState<string | null>(null);
    const log = useMutation({
        mutationFn: () => apiSend("POST", `/ingestion/devices/${deviceId}/maintenance`, {
            kind: m.kind, description: m.description, technician: m.technician || null, outcome: m.outcome || null,
            ...(m.occurred_at ? { occurred_at: new Date(m.occurred_at).toISOString() } : {}),
            ...(m.cost ? { cost_cents: toCents(m.cost) } : {}), ...(m.next_due_on ? { next_due_on: m.next_due_on } : {}),
        }),
        onSuccess: () => { setErr(null); setM({ ...m, description: "", outcome: "", cost: "" }); qc.invalidateQueries({ queryKey: ["device-history", deviceId] }); qc.invalidateQueries({ queryKey: ["device", deviceId] }); },
        onError: (e: any) => setErr(e.message),
    });
    const status = useMutation({
        mutationFn: (s: string) => apiSend("PATCH", `/ingestion/devices/${deviceId}`, { status: s }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["device-history", deviceId] }); qc.invalidateQueries({ queryKey: ["device", deviceId] }); qc.invalidateQueries({ queryKey: ["fleet"] }); },
        onError: (e: any) => setErr(e.message),
    });
    const [caps, setCaps] = useState<string | null>(null);
    const saveCaps = useMutation({
        mutationFn: (v: any) => apiSend("PATCH", `/ingestion/devices/${deviceId}`, { capability_profile: v }),
        onSuccess: () => { setCaps(null); qc.invalidateQueries({ queryKey: ["device-history", deviceId] }); },
        onError: (e: any) => setErr(e.message),
    });

    if (q.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error} />;
    const { health: h, device } = q.data;
    const cov = h.completeness.coverage_24h;
    const rows: { label: string; rag: Rag; value: string; basis: string }[] = [
        { label: "Communication", rag: deployed ? rag(h.communication.seconds_ago, 180, 900) : "grey", value: h.communication.last_contact_at ? `last message ${fmtAgo(h.communication.last_contact_at)}` : "no message in 2 days", basis: h.communication.basis },
        { label: "Measurement freshness", rag: deployed ? rag(h.freshness.seconds_ago, 180, 900) : "grey", value: h.freshness.last_measurement_at ? `newest value ${fmtAgo(h.freshness.last_measurement_at)} (${fmtDateTime(h.freshness.last_measurement_at)})` : "none in 2 days", basis: h.freshness.basis },
        { label: "Completeness", rag: cov === null ? "grey" : cov >= 0.95 ? "green" : cov >= 0.8 ? "amber" : "red", value: cov === null ? "—" : `${Math.round(cov * 1000) / 10} % of expected samples (24 h)`, basis: h.completeness.basis },
        { label: "Data quality", rag: (h.quality.clock_lag_s ?? 0) >= 30 || h.quality.conflicts_24h > 0 ? "amber" : "green", value: `clock lag ${h.quality.clock_lag_s ?? "—"} s · conflicts ${h.quality.conflicts_24h} · unmapped channels ${h.quality.unknown_params}`, basis: h.quality.basis },
        { label: "Electrical observations", rag: h.electrical.open_alerts_7d ? "amber" : "green", value: `${h.electrical.open_alerts_7d} open alert(s), 7 days`, basis: h.electrical.basis },
    ];

    return (
        <div className="space-y-6">
            {err && <ErrorBox error={err} />}
            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Health" subtitle="Each dimension on its own: a connected box with stale values is not measuring; silence is not an outage. Hover for the basis.">
                    <ul className="space-y-2 text-sm">
                        {rows.map((r) => (
                            <li key={r.label} className="flex items-start gap-3" title={r.basis}>
                                <span className="mt-1.5"><RagDot rag={r.rag} /></span>
                                <span className="w-44 shrink-0 text-slate-400">{r.label}</span>
                                <span className="text-slate-200">{r.value}</span>
                            </li>
                        ))}
                    </ul>
                </Panel>
                <Panel title="Lifecycle and capability">
                    <div className="flex items-end gap-2 mb-4">
                        <Field label="Status" hint={deployed ? "Deployed: remove the deployment to change it" : "Deployed is set by an install"}>
                            <select className={inputClass} disabled={deployed || device.status === "retired" || status.isPending} value={device.status}
                                onChange={(e) => status.mutate(e.target.value)}>
                                {device.status === "deployed" && <option value="deployed">Deployed</option>}
                                {device.status === "retired" && <option value="retired">Retired</option>}
                                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </Field>
                    </div>
                    <p className="text-xs text-slate-500 mb-1">Capability profile (confirmed per unit; reports never claim a channel this box does not record)</p>
                    {caps === null ? (
                        <div className="flex items-start gap-2">
                            <pre className="text-xs text-slate-300 bg-slate-950 rounded p-2 flex-1 overflow-x-auto">{JSON.stringify(device.capability_profile ?? {}, null, 1) === "{}" ? "not confirmed yet" : JSON.stringify(device.capability_profile, null, 1)}</pre>
                            <Button variant="secondary" onClick={() => setCaps(JSON.stringify(Object.keys(device.capability_profile ?? {}).length ? device.capability_profile : { cadence_s: 1, thd_voltage: true, thd_current: true, harmonic_orders: [], events: false, waveform: false, confirmed_by: "", confirmed_on: "" }, null, 1))}>Edit</Button>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <textarea className={inputClass + " font-mono text-xs"} rows={8} value={caps} onChange={(e) => setCaps(e.target.value)} />
                            <div className="flex gap-2">
                                <Button onClick={() => { try { saveCaps.mutate(JSON.parse(caps)); } catch { setErr("Capability profile: not valid JSON"); } }}>Save</Button>
                                <Button variant="secondary" onClick={() => setCaps(null)}>Cancel</Button>
                            </div>
                        </div>
                    )}
                    <p className="text-xs text-slate-500 mt-3">Calibration due: {fmtDate(device.calibration_due_on)}</p>
                </Panel>
            </div>

            <Panel title="Maintenance and calibration" subtitle={`Service history of this asset. Times ${TZ_LABEL}.`}>
                <form className="grid md:grid-cols-4 gap-3 mb-4" onSubmit={(e) => { e.preventDefault(); log.mutate(); }}>
                    <Field label="Kind">
                        <select className={inputClass} value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value })}>
                            {["calibration", "maintenance", "inspection", "fault", "repair", "firmware"].map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                    </Field>
                    <Field label="When" hint="blank = now"><input type="datetime-local" className={inputClass} value={m.occurred_at} onChange={(e) => setM({ ...m, occurred_at: e.target.value })} /></Field>
                    <Field label="Technician"><input className={inputClass} value={m.technician} onChange={(e) => setM({ ...m, technician: e.target.value })} /></Field>
                    <Field label="Next due" hint="a calibration sets the box's due date"><input type="date" className={inputClass} value={m.next_due_on} onChange={(e) => setM({ ...m, next_due_on: e.target.value })} /></Field>
                    <div className="md:col-span-2"><Field label="What was done / found"><input required className={inputClass} value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} /></Field></div>
                    <Field label="Outcome"><input className={inputClass} value={m.outcome} onChange={(e) => setM({ ...m, outcome: e.target.value })} /></Field>
                    <Field label="Cost (R, optional)"><input className={inputClass} value={m.cost} onChange={(e) => setM({ ...m, cost: e.target.value })} /></Field>
                    <div><Button type="submit" disabled={log.isPending || !m.description}>Log event</Button></div>
                </form>
                {q.data.maintenance.length === 0 ? <Empty>No service recorded.</Empty> : (
                    <Table head={["When", "Kind", "Description", "Technician", "Outcome", "Cost", "Next due"]}>
                        {q.data.maintenance.map((x) => (
                            <tr key={x.id}>
                                <td className="py-2 pr-3 whitespace-nowrap text-slate-400">{fmtDateTime(x.occurred_at)}</td>
                                <td className="py-2 pr-3"><Badge tone={x.kind === "fault" ? "red" : x.kind === "calibration" ? "blue" : "grey"}>{x.kind}</Badge></td>
                                <td className="py-2 pr-3 text-slate-200">{x.description}</td>
                                <td className="py-2 pr-3 text-slate-400">{x.technician ?? "—"}</td>
                                <td className="py-2 pr-3 text-slate-400">{x.outcome ?? "—"}</td>
                                <td className="py-2 pr-3 text-slate-400">{x.cost_cents === null ? "—" : zarCents(x.cost_cents)}</td>
                                <td className="py-2 pr-3 text-slate-400">{fmtDate(x.next_due_on)}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Assessments served">
                    {q.data.assessments.length === 0 ? <Empty>None yet.</Empty> : (
                        <ul className="text-sm space-y-1">{q.data.assessments.map((a) => (
                            <li key={a.id}><Link className="text-blue-300 hover:underline" href={`/ops/assessments/${a.id}`}>{a.reference}</Link>
                                <span className="text-slate-400"> · {a.client_name} · {a.status} · {a.start_at ? `${fmtDate(a.start_at)} → ${fmtDate(a.end_at)}` : "not started"}</span></li>
                        ))}</ul>
                    )}
                </Panel>
                <Panel title="Timeline">
                    <ol className="text-sm space-y-1.5 max-h-80 overflow-y-auto">{q.data.timeline.map((e, i) => (
                        <li key={i} className="flex gap-3"><span className="text-xs text-slate-500 w-36 shrink-0">{fmtDateTime(e.at)}</span>
                            <Badge tone={e.kind === "install" ? "green" : e.kind === "removal" ? "amber" : "grey"}>{e.kind}</Badge>
                            <span className="text-slate-300">{e.text}</span></li>
                    ))}</ol>
                </Panel>
            </div>
        </div>
    );
}
