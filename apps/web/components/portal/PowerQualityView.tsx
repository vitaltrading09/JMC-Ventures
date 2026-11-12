"use client";

// Power quality for one measurement point (engineering UI brief §6, §8),
// from the assessment dataset: per-phase voltage and THD trends with stable
// phase styling, screening results with their basis, and explicit states for
// what was not measured or not collected. Replaces the old health-check view,
// which stated compliance and responsibility the data cannot support.

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from "recharts";
import { fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { PHASE } from "@/lib/summary";
import { Panel, Empty, Table, Badge } from "@/components/ops/ui";

const SAST = 2 * 3_600_000;
const tick = (iso: string) => { const d = new Date(new Date(iso).getTime() + SAST); return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, "0")}h`; };

export function PowerQualityView({ detail, period }: { detail: any; period: { from: string; to: string } }) {
    if (!detail) return <Panel><Empty>No measurement point in this assessment.</Empty></Panel>;
    const pq = detail.power_quality, hs = detail.hourly_series;
    const range = `${fmtDateTime(period.from)} – ${fmtDateTime(period.to)} ${TZ_LABEL}`;
    const data = (hs?.t ?? []).map((t: string, i: number) => ({ t, va: hs.v_a[i], vb: hs.v_b[i], vc: hs.v_c[i], ta: hs.thd_v_a[i], tb: hs.thd_v_b[i], tc: hs.thd_v_c[i] }));
    const nominal = pq?.nominal_v ?? 230;
    const has = (k: string) => data.some((d: any) => d[k] !== null && d[k] !== undefined);
    const lines = (keys: [string, keyof typeof PHASE][]) => keys.filter(([k]) => has(k)).map(([k, ph]) => (
        <Line key={k} dataKey={k} name={PHASE[ph].label} stroke={PHASE[ph].color} strokeDasharray={PHASE[ph].dash} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls={false} />
    ));
    const axis = <XAxis dataKey="t" stroke="var(--chart-axis)" fontSize={11} tickFormatter={tick} minTickGap={40} />;
    const tip = <Tooltip contentStyle={{ background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12 }} labelFormatter={(t) => `${fmtDateTime(t)} ${TZ_LABEL} (hour average)`} />;

    return (
        <div className="space-y-6">
            <Panel title="Screening basis" subtitle={range}>
                <p className="text-sm text-ink-3">{pq.verdict.type === "formal" ? "Formal assessment basis met: " : "Screening only: "}{pq.verdict.reason}</p>
                <p className="text-xs text-faint mt-1">Statistics below use 10-minute values; the charts show hourly averages for readability, so short peaks are lower in the charts than in the tables.</p>
            </Panel>

            <div className="grid xl:grid-cols-2 gap-6">
                <Panel title="Voltage by phase" subtitle={`Hourly average, V. Screening band ±10 % of ${nominal} V.`}>
                    {!has("va") && !has("vb") && !has("vc") ? <Empty>Voltage not measured.</Empty> : (
                        <div className="h-64"><ResponsiveContainer width="100%" height="100%">
                            <LineChart data={data} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                                {axis}<YAxis stroke="var(--chart-axis)" fontSize={11} domain={["auto", "auto"]} width={48} />{tip}
                                <ReferenceLine y={nominal * 0.9} stroke="var(--chart-axis)" strokeDasharray="4 4" />
                                <ReferenceLine y={nominal * 1.1} stroke="var(--chart-axis)" strokeDasharray="4 4" />
                                <Legend wrapperStyle={{ fontSize: 12 }} />
                                {lines([["va", "A"], ["vb", "B"], ["vc", "C"]])}
                            </LineChart>
                        </ResponsiveContainer></div>
                    )}
                </Panel>
                <Panel title="Voltage distortion (THD-V) by phase" subtitle="Hourly average, %. Screening reference 8 % (NRS 048-2).">
                    {!has("ta") && !has("tb") && !has("tc") ? <Empty>THD-V not measured.</Empty> : (
                        <div className="h-64"><ResponsiveContainer width="100%" height="100%">
                            <LineChart data={data} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                                {axis}<YAxis stroke="var(--chart-axis)" fontSize={11} unit=" %" width={48} />{tip}
                                <ReferenceLine y={8} stroke="#f59e0b" strokeDasharray="4 4" />
                                <Legend wrapperStyle={{ fontSize: 12 }} />
                                {lines([["ta", "A"], ["tb", "B"], ["tc", "C"]])}
                            </LineChart>
                        </ResponsiveContainer></div>
                    )}
                </Panel>
            </div>

            <div className="grid xl:grid-cols-2 gap-6">
                <Panel title="Voltage statistics" subtitle="10-minute values">
                    {pq.voltage.length === 0 ? <Empty>Not measured.</Empty> : (
                        <Table head={["Phase", "Min", "P5", "P95", "Max", "Outside ±10 %"]}>
                            {pq.voltage.map((v: any) => (
                                <tr key={v.phase} className="tabular-nums"><td className="py-1.5 pr-4">{v.phase}</td><td className="pr-4">{v.min} V</td><td className="pr-4">{v.p05} V</td><td className="pr-4">{v.p95} V</td><td className="pr-4">{v.max} V</td><td>{v.outside_pct} %</td></tr>
                            ))}
                        </Table>
                    )}
                </Panel>
                <Panel title="Harmonic distortion" subtitle="10-minute values. THD-I is a percentage of the fundamental at that moment; it is not TDD.">
                    {!pq.thd_v && !pq.thd_i ? <Empty>Not measured.</Empty> : (
                        <Table head={["Phase", "THD-V P95", "THD-V max", "Above 8 %", "THD-I P95", "THD-I max"]}>
                            {["A", "B", "C"].map((ph) => {
                                const v = pq.thd_v?.find((x: any) => x.phase === ph), i = pq.thd_i?.find((x: any) => x.phase === ph);
                                if (!v && !i) return null;
                                return <tr key={ph} className="tabular-nums"><td className="py-1.5 pr-4">{ph}</td><td className="pr-4">{v ? `${v.p95} %` : "–"}</td><td className="pr-4">{v ? `${v.max} %` : "–"}</td><td className="pr-4">{v ? `${v.over_limit_pct} %` : "–"}</td><td className="pr-4">{i ? `${i.p95} %` : "–"}</td><td>{i ? `${i.max} %` : "–"}</td></tr>;
                            })}
                        </Table>
                    )}
                </Panel>
            </div>

            <div className="grid xl:grid-cols-3 gap-6">
                <Panel title="Power factor">
                    {!pq.pf ? <Empty>Not available.</Empty> : (
                        <dl className="text-sm space-y-1 tabular-nums">
                            <div className="flex justify-between"><dt className="text-muted">Average while loaded</dt><dd>{num(pq.pf.avg_loaded, 3)}</dd></div>
                            <div className="flex justify-between"><dt className="text-muted">5th percentile</dt><dd>{num(pq.pf.p05, 3)}</dd></div>
                            <div className="flex justify-between"><dt className="text-muted">Loaded intervals below 0.85</dt><dd>{Math.round((pq.pf.share_below_min ?? 0) * 100)} %</dd></div>
                            <p className="text-xs text-faint pt-1">Low PF raises kVA demand; it is not a supply-quality breach.</p>
                        </dl>
                    )}
                </Panel>
                <Panel title="Unbalance and frequency">
                    <dl className="text-sm space-y-1 tabular-nums">
                        <div className="flex justify-between"><dt className="text-muted">Voltage unbalance P95</dt><dd>{pq.unbalance.voltage_p95 ?? "not measured"}{pq.unbalance.voltage_p95 != null && " %"}</dd></div>
                        <div className="flex justify-between"><dt className="text-muted">Current unbalance P95</dt><dd>{pq.unbalance.current_p95 ?? "not measured"}{pq.unbalance.current_p95 != null && " %"}</dd></div>
                        <div className="flex justify-between"><dt className="text-muted">Frequency range</dt><dd>{pq.frequency.min ?? "–"}–{pq.frequency.max ?? "–"} Hz</dd></div>
                        <div className="flex justify-between"><dt className="text-muted">Minutes below 23 V</dt><dd>{pq.interruption_minutes}</dd></div>
                        <p className="text-xs text-faint pt-1">{pq.unbalance.metric}.</p>
                    </dl>
                </Panel>
                <Panel title="What this data cannot show">
                    <ul className="text-sm space-y-2">
                        <li><Badge>not collected</Badge> <span className="text-ink-3">Individual harmonic orders.</span> <span className="text-xs text-faint">{pq.harmonic_orders.reason}</span></li>
                        <li><Badge>not measured</Badge> <span className="text-ink-3">Flicker (Pst/Plt), interharmonics, transients.</span></li>
                        <li><Badge>{detail.capability?.profile?.events ? "device events" : "inferred"}</Badge> <span className="text-ink-3">{pq.events.count} voltage/frequency event(s).</span> <span className="text-xs text-faint">{pq.events.capability}.</span></li>
                        <li><Badge>not measured</Badge> <span className="text-ink-3">Sub-second dips:</span> <span className="text-xs text-faint">1-second RMS samples cannot show their absence.</span></li>
                    </ul>
                </Panel>
            </div>

            {pq.events.list.length > 0 && (
                <Panel title="Recorded voltage and frequency events" subtitle={pq.events.source}>
                    <Table head={["Start", "Type", "Phase", "Duration", "Extreme"]}>
                        {pq.events.list.slice(0, 20).map((e: any, i: number) => (
                            <tr key={i} className="tabular-nums"><td className="py-1.5 pr-4">{fmtDateTime(e.started_at)}</td><td className="pr-4">{e.type}</td><td className="pr-4">{e.phase ?? "–"}</td><td className="pr-4">{e.duration_s != null ? `${num(e.duration_s, 0)} s` : "ongoing"}</td><td>{e.extreme ?? "–"}</td></tr>
                        ))}
                    </Table>
                </Panel>
            )}
        </div>
    );
}
