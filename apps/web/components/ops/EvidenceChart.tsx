"use client";

// The evidence window of a finding: active power and power factor of the
// meter over the period the finding was drawn from. States its basis (the
// aggregate and bucket the API chose) and the time zone.

import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { TZ, TZ_LABEL } from "@/lib/api";
import { Loading, ErrorBox, Empty } from "./ui";

const API = process.env.NEXT_PUBLIC_API_URL;

export function EvidenceChart({ meterId, from, to }: { meterId: string; from: string; to: string }) {
    const q = useQuery({
        queryKey: ["evidence", meterId, from, to],
        queryFn: async () => {
            const res = await fetch(`${API}/ingestion/meters/${meterId}/readings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { credentials: "include" });
            if (!res.ok) throw new Error(`Readings unavailable (${res.status})`);
            return { rows: (await res.json()) as any[], basis: res.headers.get("X-Readings-Source") ?? "" };
        },
    });
    if (q.isLoading) return <Loading label="Loading evidence" />;
    if (q.error) return <ErrorBox error={q.error} />;
    const rows = (q.data?.rows ?? []).map((r) => ({
        t: new Date(r.time).getTime(),
        kw: r.power_active_total === null ? null : Number(r.power_active_total),
        pf: r.power_factor_total === null ? null : Number(r.power_factor_total),
    }));
    if (rows.length === 0) return <Empty>No readings in the evidence window.</Empty>;
    const tick = (t: number) => new Date(t).toLocaleString("en-ZA", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    const [source, bucket] = (q.data?.basis ?? "").split("; bucket=");
    return (
        <div>
            <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rows} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tick} stroke="#64748b" fontSize={11} />
                        <YAxis yAxisId="kw" stroke="#60a5fa" fontSize={11} />
                        <YAxis yAxisId="pf" orientation="right" domain={[0, 1]} stroke="#34d399" fontSize={11} />
                        <Tooltip labelFormatter={(t) => tick(Number(t))} contentStyle={{ background: "#0f172a", border: "1px solid #334155" }} />
                        <Line yAxisId="kw" dataKey="kw" name="kW" stroke="#60a5fa" dot={false} strokeWidth={1.5} connectNulls={false} />
                        <Line yAxisId="pf" dataKey="pf" name="PF" stroke="#34d399" dot={false} strokeWidth={1.5} connectNulls={false} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <p className="text-xs text-slate-500 mt-1">
                Active power (kW) and power factor, {bucket ? `${bucket} averages` : "averages"} from {source || "the aggregates"}; times {TZ_LABEL}.
            </p>
        </div>
    );
}
