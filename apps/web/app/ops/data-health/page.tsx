"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmtAgo, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { PageHeader, Panel, Table, Loading, ErrorBox, Empty, Badge, Stat } from "@/components/ops/ui";

interface DataHealth {
    generated_at: string;
    silent_minutes: number;
    silent: { id: string; code: string | null; name: string; project_name: string | null; point_name: string | null; last_seen: string | null }[];
    clock_drift: { id: string; code: string | null; name: string; project_name: string | null; drift_s: number }[];
    dead_letters: { last_24h: { error_msg: string; n: number; last: string }[]; recent: { id: number; received_at: string; topic: string; error_msg: string; payload: string }[] };
    unknown_params: { meter_id: string; code: string | null; meter_name: string; model: string | null; name: string; first_seen: string; last_seen: string }[];
    conflicts: { meter_id: string; code: string | null; name: string; conflicts: number; rows: number }[];
    registers: { id: string; code: string | null; name: string; project_name: string | null; register_resets: number; implausible_jumps: number }[];
}

const box = (x: { id?: string; meter_id?: string; code: string | null; name?: string; meter_name?: string }) => (
    <Link href={`/ops/fleet/${x.id ?? x.meter_id}`} className="text-blue-300 hover:underline">{x.code ?? x.name ?? x.meter_name}</Link>
);

export default function DataHealthPage() {
    const q = useQuery({ queryKey: ["data-health"], queryFn: () => apiGet<DataHealth>("/ingestion/ops/data-health"), refetchInterval: 60_000 });
    if (q.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error ?? "No data"} />;
    const h = q.data;
    const dead24 = h.dead_letters.last_24h.reduce((a, r) => a + r.n, 0);

    return (
        <div className="space-y-6">
            <PageHeader title="Data health" subtitle={`What is wrong with the data coming in, and where. Updated ${fmtDateTime(h.generated_at)} ${TZ_LABEL}.`} />
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                <Stat label="Silent boxes" value={h.silent.length} tone={h.silent.length ? "red" : "green"} />
                <Stat label="Clock drift > 5 s" value={h.clock_drift.length} tone={h.clock_drift.length ? "amber" : "green"} />
                <Stat label="Dead letters (24 h)" value={dead24} tone={dead24 ? "amber" : "green"} />
                <Stat label="Unknown parameters (7 d)" value={h.unknown_params.length} tone={h.unknown_params.length ? "amber" : "green"} />
                <Stat label="Timestamp conflicts (24 h)" value={h.conflicts.reduce((a, r) => a + r.conflicts, 0)} tone={h.conflicts.length ? "amber" : "green"} />
                <Stat label="Register resets (7 d)" value={h.registers.reduce((a, r) => a + r.register_resets, 0)} tone={h.registers.length ? "amber" : "green"} />
            </div>

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Silent meters" subtitle={`Deployed, but nothing for ${h.silent_minutes} min (or three reporting intervals, for a meter that reports less often)`}>
                    {h.silent.length === 0 ? <Empty>Every deployed meter is reporting.</Empty> : (
                        <Table head={["Box", "Where", "Last reading"]}>
                            {h.silent.map((d) => <tr key={d.id}><td className="py-2 pr-4">{box(d)}</td><td className="py-2 pr-4">{d.project_name} · {d.point_name}</td><td className="py-2">{fmtAgo(d.last_seen)}</td></tr>)}
                        </Table>
                    )}
                </Panel>
                <Panel title="Clock drift" subtitle="Median lag of the freshest reading per minute, last hour. Set NTP on the meter.">
                    {h.clock_drift.length === 0 ? <Empty>All clocks within 5 s.</Empty> : (
                        <Table head={["Box", "Where", "Drift"]}>
                            {h.clock_drift.map((d) => <tr key={d.id}><td className="py-2 pr-4">{box(d)}</td><td className="py-2 pr-4">{d.project_name}</td><td className="py-2">{d.drift_s} s</td></tr>)}
                        </Table>
                    )}
                </Panel>
            </div>

            <Panel title="Unknown parameter names" subtitle="Sent by a meter but not in the channel map (services/ingestion-service/src/ingest/channels.ts). Add them there to store them.">
                {h.unknown_params.length === 0 ? <Empty>None in the last 7 days.</Empty> : (
                    <Table head={["Box", "Model", "Parameter", "First seen", "Last seen"]}>
                        {h.unknown_params.map((u) => (
                            <tr key={`${u.meter_id}-${u.name}`}><td className="py-2 pr-4">{box(u)}</td><td className="py-2 pr-4">{u.model ?? "–"}</td>
                                <td className="py-2 pr-4 font-mono text-xs">{u.name}</td><td className="py-2 pr-4">{fmtDateTime(u.first_seen)}</td><td className="py-2">{fmtAgo(u.last_seen)}</td></tr>
                        ))}
                    </Table>
                )}
            </Panel>

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Duplicate timestamps" subtitle="Readings rejected because the meter already sent that timestamp (last 24 h)">
                    {h.conflicts.length === 0 ? <Empty>None.</Empty> : (
                        <Table head={["Box", "Conflicts", "Rows written"]}>
                            {h.conflicts.map((c) => <tr key={c.meter_id}><td className="py-2 pr-4">{box(c)}</td><td className="py-2 pr-4">{c.conflicts}</td><td className="py-2">{c.rows}</td></tr>)}
                        </Table>
                    )}
                </Panel>
                <Panel title="Energy registers" subtitle="Resets and implausible jumps in the kWh register (last 7 days); skipped, never summed through">
                    {h.registers.length === 0 ? <Empty>No resets or jumps.</Empty> : (
                        <Table head={["Box", "Project", "Resets", "Jumps"]}>
                            {h.registers.map((r) => <tr key={r.id}><td className="py-2 pr-4">{box(r)}</td><td className="py-2 pr-4">{r.project_name ?? "–"}</td><td className="py-2 pr-4">{r.register_resets}</td><td className="py-2">{r.implausible_jumps}</td></tr>)}
                        </Table>
                    )}
                </Panel>
            </div>

            <Panel title="Dead letters" subtitle="Messages that could not be stored: unknown meter, unreadable payload">
                {h.dead_letters.last_24h.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                        {h.dead_letters.last_24h.map((r) => <Badge key={r.error_msg} tone="amber">{r.error_msg}: {r.n}</Badge>)}
                    </div>
                )}
                {h.dead_letters.recent.length === 0 ? <Empty>None.</Empty> : (
                    <Table head={["Received", "Topic", "Reason", "Payload (start)"]}>
                        {h.dead_letters.recent.map((r) => (
                            <tr key={r.id}><td className="py-2 pr-4 whitespace-nowrap">{fmtDateTime(r.received_at)}</td><td className="py-2 pr-4 font-mono text-xs">{r.topic}</td>
                                <td className="py-2 pr-4">{r.error_msg}</td><td className="py-2 font-mono text-xs text-slate-500 max-w-md truncate">{r.payload}</td></tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}
