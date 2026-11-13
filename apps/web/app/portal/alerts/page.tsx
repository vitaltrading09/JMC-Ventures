"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty, Button } from "@/components/ops/ui";

interface Alert { id: string; meter_name: string; type: string; severity: string; message: string; created_at: string; is_read: boolean; }

const TONE = (s: string) => (s === "CRITICAL" || s === "HIGH" ? "red" : s === "WARNING" || s === "MEDIUM" ? "amber" : "grey") as "red" | "amber" | "grey";

export default function PortalAlerts() {
    const qc = useQueryClient();
    const [show, setShow] = useState<"open" | "all">("open");
    const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => apiGet<Alert[]>("/ingestion/alerts"), refetchInterval: 60_000 });
    const read = useMutation({
        mutationFn: (id: string) => apiSend("POST", `/ingestion/alerts/${id}/read`),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
    });
    const rows = (alerts.data ?? []).filter((a) => show === "all" || !a.is_read);
    return (
        <div>
            <PageHeader title="Alerts" subtitle={`The latest 50. Each alert says what it is based on; times ${TZ_LABEL}.`} />
            <div className="flex gap-2 mb-4">
                {(["open", "all"] as const).map((s) => (
                    <button key={s} onClick={() => setShow(s)}
                        className={`px-3 py-1.5 rounded-lg text-sm border ${show === s ? "bg-blue-600/20 border-blue-500/40 text-accent" : "border-line-strong text-muted"}`}>
                        {s === "open" ? "Open" : "All"}
                    </button>
                ))}
            </div>
            <Panel>
                {alerts.isLoading ? <Loading /> : alerts.error ? <ErrorBox error={alerts.error} /> : rows.length === 0 ? <Empty>No alerts.</Empty> : (
                    <Table head={["When", "Severity", "Meter", "Alert", ""]}>
                        {rows.map((a) => (
                            <tr key={a.id} className={a.is_read ? "opacity-60" : ""}>
                                <td className="py-2 pr-4 whitespace-nowrap">{fmtDateTime(a.created_at)}</td>
                                <td className="py-2 pr-4"><Badge tone={TONE(a.severity)}>{a.severity}</Badge></td>
                                <td className="py-2 pr-4">{a.meter_name}</td>
                                <td className="py-2 pr-4 text-ink-3">{a.message}</td>
                                <td className="py-2 text-right">{!a.is_read && <Button variant="secondary" disabled={read.isPending} onClick={() => read.mutate(a.id)}>Mark read</Button>}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}
