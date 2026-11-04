"use client";

// Portal project → Exports (Phase 9): request a CSV of one point's readings
// over a longer range; the server writes it in the background and keeps it for
// 7 days. The same data is available through the public API (curl example).

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, apiUrl, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { PortalProjectDetail, defaultPoint } from "@/lib/portal";
import { Panel, Loading, ErrorBox, Empty, Badge, Button, Field, inputClass, Table } from "@/components/ops/ui";

interface Export {
    id: string; status: "queued" | "running" | "done" | "failed" | "expired"; point_id: string; point_name: string;
    interval: string; from: string; to: string; rows: number | null; bytes: number | null; error: string | null;
    created_at: string; expires_at: string | null; download_url: string | null;
}

const INTERVALS = [
    ["15m", "15 minutes"], ["30m", "30 minutes"], ["1h", "1 hour"], ["1d", "1 day"], ["1m", "1 minute"],
] as const;
const TONE = { queued: "blue", running: "amber", done: "green", failed: "red", expired: "grey" } as const;

/** A SAST calendar date (yyyy-mm-dd) → the UTC instant of its midnight. */
const sastMidnight = (d: string) => new Date(`${d}T00:00:00+02:00`).toISOString();
const sastToday = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const size = (b: number | null) => (b === null ? "" : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

export function ExportsTab({ project }: { project: PortalProjectDetail }) {
    const qc = useQueryClient();
    const metered = project.points.filter((p) => p.metered);
    const ids = useMemo(() => new Set(project.points.map((p) => p.id)), [project.points]);
    const [f, setF] = useState(() => ({ point_id: defaultPoint(metered)?.id ?? "", interval: "15m", from: addDays(sastToday(), -30), to: sastToday() }));
    const list = useQuery({
        queryKey: ["exports", project.id],
        queryFn: () => apiGet<Export[]>("/v1/exports"),
        select: (rows) => rows.filter((e) => ids.has(e.point_id)),
        refetchInterval: (q) => ((q.state.data ?? []).some((e) => e.status === "queued" || e.status === "running") ? 5_000 : false),
    });
    const create = useMutation({
        // `to` is inclusive in the form: the export runs to the end of that SAST day.
        mutationFn: () => apiSend<Export>("POST", "/v1/exports", { point_id: f.point_id, interval: f.interval, from: sastMidnight(f.from), to: sastMidnight(addDays(f.to, 1)) }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["exports", project.id] }),
    });

    if (!metered.length) return <Panel title="Exports"><Empty>No metered point in this project yet.</Empty></Panel>;
    const example = apiUrl(`/v1/points/${f.point_id}/readings?interval=${f.interval}&from=${sastMidnight(f.from)}&to=${sastMidnight(addDays(f.to, 1))}&format=csv`);

    return (
        <div className="space-y-5">
            <Panel title="New export" subtitle={`CSV (gzip) of one point's readings. Dates are ${TZ_LABEL} days, both included. Ready in a minute or two; kept for 7 days.`}>
                <form className="grid md:grid-cols-5 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                    <Field label="Point">
                        <select className={inputClass} value={f.point_id} onChange={(e) => setF({ ...f, point_id: e.target.value })}>
                            {metered.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Interval">
                        <select className={inputClass} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}>
                            {INTERVALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </Field>
                    <Field label="From"><input type="date" className={inputClass} value={f.from} max={f.to} onChange={(e) => setF({ ...f, from: e.target.value })} required /></Field>
                    <Field label="To"><input type="date" className={inputClass} value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} required /></Field>
                    <Button type="submit" disabled={create.isPending || !f.point_id}>Export</Button>
                    <div className="md:col-span-5"><ErrorBox error={create.error} /></div>
                </form>
            </Panel>

            <Panel title="Recent exports">
                {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (list.data ?? []).length === 0 ? <Empty>No exports in the last 30 days.</Empty> : (
                    <Table head={["Point", "Interval", "Period", "Status", "Size", ""]}>
                        {list.data!.map((e) => (
                            <tr key={e.id}>
                                <td className="py-2 pr-4">{e.point_name}</td>
                                <td className="py-2 pr-4">{e.interval}</td>
                                <td className="py-2 pr-4 whitespace-nowrap text-xs">{fmtDateTime(e.from)} – {fmtDateTime(e.to)}</td>
                                <td className="py-2 pr-4"><Badge tone={TONE[e.status]}>{e.status}</Badge>{e.error && <span className="ml-2 text-xs text-red-300">{e.error}</span>}</td>
                                <td className="py-2 pr-4 text-xs text-slate-400">{e.rows !== null ? `${e.rows.toLocaleString()} rows · ${size(e.bytes)}` : ""}</td>
                                <td className="py-2 text-right whitespace-nowrap">
                                    {e.download_url && <a className="text-sm text-blue-300 hover:underline" href={apiUrl(e.download_url.replace(/^\/api/, ""))}>Download</a>}
                                    {e.status === "done" && e.expires_at && <span className="ml-2 text-xs text-slate-500">until {fmtDateTime(e.expires_at)}</span>}
                                </td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>

            <Panel title="From your own systems" subtitle="The same readings through the Grid-IQ API, with an API key (Settings → API keys).">
                <pre className="text-xs bg-slate-950 border border-slate-800 rounded p-3 overflow-x-auto text-slate-300">{`curl -H "Authorization: Bearer $GRIDIQ_API_KEY" \\\n  "${example}"`}</pre>
                <p className="mt-2 text-xs text-slate-500">
                    Timestamps are UTC and period-ending; every row has its sample count, coverage and flags. <a className="text-blue-300 hover:underline" href={apiUrl("/docs/")} target="_blank" rel="noreferrer">API documentation</a>
                </p>
            </Panel>
        </div>
    );
}
