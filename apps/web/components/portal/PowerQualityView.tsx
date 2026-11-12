"use client";

// Power quality for one measurement point (engineering UI brief §6, §8),
// from the assessment dataset: per-phase voltage and THD trends with stable
// phase styling, screening results with their basis, and explicit states for
// what was not measured or not collected. Replaces the old health-check view,
// which stated compliance and responsibility the data cannot support.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from "recharts";
import { fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { PHASE } from "@/lib/summary";
import { Panel, Empty, Table, Badge } from "@/components/ops/ui";
import { BulletBar } from "@/components/portal/Insight";

const SAST = 2 * 3_600_000;
const hm = (ms: number) => { const d = new Date(ms + SAST); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const tick = (ms: number) => { const d = new Date(ms + SAST); return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, "0")}h`; };

export function PowerQualityView({ detail, period, pointId }: { detail: any; period: { from: string; to: string }; pointId?: string | null }) {
    if (!detail) return <Panel><Empty>No measurement point in this assessment.</Empty></Panel>;
    return (
        <div className="space-y-8">
            <PQRows pq={detail.power_quality} />
            <details className="group rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line" open>
                <summary className="cursor-pointer text-[15px] font-semibold text-ink">Phase-by-phase detail, charts and what this data cannot show</summary>
                <div className="mt-6"><PQDetail detail={detail} period={period} pointId={pointId} /></div>
            </details>
        </div>
    );
}

type Row = { name: string; status: "ok" | "close" | "out" | "none"; sentence: string; bar?: React.ComponentProps<typeof BulletBar> };
const STATUS = {
    ok: { word: "Within limits", cls: "text-ok" }, close: { word: "Close to the limit", cls: "text-warn" },
    out: { word: "Outside the limit", cls: "text-warn" }, none: { word: "Not measured", cls: "text-faint" },
} as const;

/** One row per quantity: a status word, one sentence, and a bullet bar against the screening limit. */
function PQRows({ pq }: { pq: any }) {
    const nominal = pq.nominal_v ?? 230, lo = nominal * 0.9, hi = nominal * 1.1;
    const rows: Row[] = [];
    const v = pq.voltage ?? [];
    if (v.length) {
        const p5 = Math.min(...v.map((x: any) => x.p05)), p95 = Math.max(...v.map((x: any) => x.p95));
        const outside = Math.max(...v.map((x: any) => x.outside_pct ?? 0));
        const margin = Math.min(p5 - lo, hi - p95);
        rows.push({ name: "Voltage", status: outside > 0 ? "out" : margin < nominal * 0.02 ? "close" : "ok",
            sentence: outside > 0 ? `Outside ${num(lo, 0)}–${num(hi, 0)} V in ${num(outside, 1)} % of the time on the worst phase.` : `Normally between ${num(p5, 0)} and ${num(p95, 0)} V on all phases; at least ${num(margin, 0)} V from the nearest limit.`,
            bar: { min: nominal * 0.85, max: nominal * 1.15, band: [lo, hi], range: [p5, p95], unit: "V", decimals: 0, ariaLabel: `Voltage ${num(p5, 0)} to ${num(p95, 0)} V against ${num(lo, 0)} to ${num(hi, 0)} V` } });
    } else rows.push({ name: "Voltage", status: "none", sentence: "No voltage measurements yet." });
    const thd = (pq.thd_v ?? []).map((x: any) => x.p95).filter((x: any) => x != null);
    if (thd.length) {
        const worst = Math.max(...thd);
        rows.push({ name: "Voltage distortion", status: worst > 8 ? "out" : worst > 6.5 ? "close" : "ok",
            sentence: worst > 8 ? `Up to ${num(worst, 1)} % on the worst phase (95 % of the time below that), above the 8 % screening level.` : `At most ${num(worst, 1)} % on any phase, ${num(8 - worst, 1)} points below the 8 % screening level.`,
            bar: { min: 0, max: Math.max(12, worst * 1.2), band: [0, 8], value: worst, unit: "%", decimals: 0, ariaLabel: `Voltage distortion ${num(worst, 1)} % against 8 %` } });
    } else rows.push({ name: "Voltage distortion", status: "none", sentence: "Not measured by this meter." });
    const iu = pq.unbalance?.current_p95;
    if (iu != null) rows.push({ name: "Phase balance", status: iu > 15 ? "out" : iu > 10 ? "close" : "ok",
        sentence: iu > 15 ? `The phases differ by up to ${num(iu, 0)} % in current: one phase carries noticeably more.` : `Current is shared evenly across the phases (up to ${num(iu, 0)} % difference).`,
        bar: { min: 0, max: Math.max(30, iu * 1.2), band: [0, 15], value: iu, unit: "%", decimals: 0, ariaLabel: `Current unbalance ${num(iu, 1)} % against the 15 % investigation level` } });
    const pf = pq.pf?.avg_loaded;
    if (pf != null) rows.push({ name: "Power factor", status: pf < 0.85 ? "out" : pf < 0.9 ? "close" : "ok",
        sentence: pf < 0.85 ? `Averages ${num(pf, 2)} while the site is working: more kVA is drawn than the useful kW needs.` : `Averages ${num(pf, 2)} while the site is working.`,
        bar: { min: 0.6, max: 1, band: [0.85, 1], value: pf, unit: "", decimals: 2, ariaLabel: `Power factor ${num(pf, 2)} against 0.85` } });
    const f = pq.frequency;
    if (f?.min != null) rows.push({ name: "Frequency", status: f.outside_values > 0 ? "out" : "ok",
        sentence: f.outside_values > 0 ? `Left 49–51 Hz in ${f.outside_values} ten-minute period(s).` : `Stayed between ${num(f.min, 2)} and ${num(f.max, 2)} Hz.`,
        bar: { min: 48.5, max: 51.5, band: [49, 51], range: [f.min, f.max], unit: "Hz", decimals: 0, ariaLabel: `Frequency ${f.min} to ${f.max} Hz against 49 to 51 Hz` } });
    const ev = pq.events?.count ?? 0, mins = pq.interruption_minutes ?? 0;
    rows.push({ name: "Dips and interruptions", status: ev > 0 || mins > 0 ? "close" : "ok",
        sentence: ev || mins ? `${ev} voltage/frequency event(s) and ${mins} minute(s) without supply were recorded; see Investigation for the times.` : "No dips, swells or interruptions were recorded in the 1-second data." });
    const flagged = rows.filter((r) => r.status === "out" || r.status === "close").length;
    return (
        <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <p className="text-xs font-semibold uppercase tracking-wider text-faint">Supply and installation health</p>
            <h3 className="mt-1 text-lg font-semibold text-ink">{flagged === 0 ? "Everything measured so far is within the screening limits." : `${flagged} of ${rows.length} measures need a closer look.`}</h3>
            <ul className="mt-5 divide-y divide-line">
                {rows.map((r) => (
                    <li key={r.name} className="grid gap-x-6 gap-y-2 py-4 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1.1fr)] items-center">
                        <div>
                            <p className="font-semibold text-ink">{r.name}</p>
                            <p className={`text-sm ${STATUS[r.status].cls}`}>{STATUS[r.status].word}</p>
                        </div>
                        <p className="text-[15px] text-ink-3">{r.sentence}</p>
                        <div className="pb-3">{r.bar ? <BulletBar {...r.bar} /> : null}</div>
                    </li>
                ))}
            </ul>
            <p className="mt-3 text-xs text-faint">Shaded band: the acceptable range (NRS 048-2 screening levels; 15 % for phase balance is GridIQ's investigation level). Bars show the typical range or the 95th-percentile value from 10-minute data. Screening only, not certification.</p>
        </section>
    );
}

type Span = "day" | "week" | "all";
const SPANS: [Span, string][] = [["day", "Last day"], ["week", "Last week"], ["all", "Whole assessment"]];

/** Day / week / whole assessment, shown under the charts (one choice drives both). */
function SpanSwitch({ value, onChange }: { value: Span; onChange: (s: Span) => void }) {
    return (
        <div role="group" aria-label="Chart period" className="mt-3 flex justify-center gap-1">
            {SPANS.map(([k, l]) => (
                <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}
                    className={`rounded-full px-3 py-1 text-sm ${value === k ? "bg-blue-600 text-white" : "text-muted ring-1 ring-line-strong hover:bg-surface-2"}`}>{l}</button>
            ))}
        </div>
    );
}

function PQDetail({ detail, period, pointId }: { detail: any; period: { from: string; to: string }; pointId?: string | null }) {
    const [span, setSpan] = useState<Span>("day");
    const to = new Date(period.to).getTime(), start = new Date(period.from).getTime();
    const from = span === "all" ? start : Math.max(start, to - (span === "day" ? 1 : 7) * 86_400_000);
    // 1 day: 10-minute values; a week or more: hourly (the investigation endpoint keeps min/max).
    const q = useQuery({
        queryKey: ["pq-series", pointId, from, to], enabled: !!pointId,
        queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/investigate?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`),
    });
    if (!detail) return <Panel><Empty>No measurement point in this assessment.</Empty></Panel>;
    const pq = detail.power_quality;
    const range = `${fmtDateTime(period.from)} – ${fmtDateTime(period.to)} ${TZ_LABEL}`;
    const width = (q.data?.bucket_seconds ?? 3600) * 1000;
    // Rows from the API, with an empty row where buckets are missing so lines break at gaps.
    const rows = (q.data?.rows ?? []).map((r: any) => ({ ms: new Date(r.t).getTime(), va: r.va, vb: r.vb, vc: r.vc, ta: r.thd_va, tb: r.thd_vb, tc: r.thd_vc }));
    const data: any[] = [];
    rows.forEach((r: any, i: number) => { if (i > 0 && r.ms - rows[i - 1].ms > 1.5 * width) data.push({ ms: rows[i - 1].ms + width }); data.push(r); });
    const expected = Math.max(1, Math.round((to - from) / width));
    const measured = rows.length;
    const nominal = pq?.nominal_v ?? 230;
    const has = (k: string) => data.some((d: any) => d[k] !== null && d[k] !== undefined);
    const lines = (keys: [string, keyof typeof PHASE][]) => keys.filter(([k]) => has(k)).map(([k, ph]) => (
        <Line key={k} dataKey={k} name={PHASE[ph].label} stroke={PHASE[ph].color} strokeDasharray={PHASE[ph].dash} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls={false} />
    ));
    const axis = <XAxis dataKey="ms" type="number" scale="time" domain={[from, to]} allowDataOverflow stroke="var(--chart-axis)" fontSize={11} tickFormatter={(ms) => (span === "day" ? hm(ms) : tick(ms))} minTickGap={40} />;
    const tip = <Tooltip contentStyle={{ background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12 }}
        labelFormatter={(ms) => `${fmtDateTime(new Date(Number(ms)))} ${TZ_LABEL} (${q.data?.resolution ?? ""} average)`} formatter={(v: any) => num(v, 2)} />;
    const res = q.data?.resolution ? `${q.data.resolution[0].toUpperCase()}${q.data.resolution.slice(1)} averages` : "Averages";
    const chart = (body: React.ReactElement) => q.isLoading ? <div className="h-64 animate-pulse rounded-xl bg-surface-2" /> : (
        <div className="h-64"><ResponsiveContainer width="100%" height="100%">{body}</ResponsiveContainer></div>
    );

    return (
        <div className="space-y-6">
            <Panel title="Screening basis" subtitle={range}>
                <p className="text-sm text-ink-3">{pq.verdict.type === "formal" ? "Formal assessment basis met: " : "Screening only: "}{pq.verdict.reason}</p>
                <p className="text-xs text-faint mt-1">The statistics tables use every 10-minute value of the assessment; the charts show the period you choose under them.</p>
            </Panel>

            <div>
                <div className="grid xl:grid-cols-2 gap-6">
                    <Panel title="Voltage by phase" subtitle={`${res}, V. Screening band ±10 % of ${nominal} V.`}>
                        {!q.isLoading && !has("va") && !has("vb") && !has("vc") ? <Empty>No voltage measurements in this period.</Empty> : chart(
                            <LineChart data={data} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                                {axis}<YAxis stroke="var(--chart-axis)" fontSize={11} domain={["auto", "auto"]} width={48} />{tip}
                                <ReferenceLine y={nominal * 0.9} stroke="var(--chart-axis)" strokeDasharray="4 4" />
                                <ReferenceLine y={nominal * 1.1} stroke="var(--chart-axis)" strokeDasharray="4 4" />
                                <Legend wrapperStyle={{ fontSize: 12 }} />
                                {lines([["va", "A"], ["vb", "B"], ["vc", "C"]])}
                            </LineChart>)}
                    </Panel>
                    <Panel title="Voltage distortion (THD-V) by phase" subtitle={`${res}, %. Screening reference 8 % (NRS 048-2).`}>
                        {!q.isLoading && !has("ta") && !has("tb") && !has("tc") ? <Empty>No distortion measurements in this period.</Empty> : chart(
                            <LineChart data={data} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                                {axis}<YAxis stroke="var(--chart-axis)" fontSize={11} unit=" %" width={48} domain={[0, (m: number) => Math.max(9, Math.ceil(m))]} />{tip}
                                <ReferenceLine y={8} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: "8 %", position: "insideTopRight", fill: "#d97706", fontSize: 11 }} />
                                <Legend wrapperStyle={{ fontSize: 12 }} />
                                {lines([["ta", "A"], ["tb", "B"], ["tc", "C"]])}
                            </LineChart>)}
                    </Panel>
                </div>
                <SpanSwitch value={span} onChange={setSpan} />
                {!q.isLoading && measured < expected * 0.9 && (
                    <p className="mt-2 text-center text-sm text-warn">{expected - Math.min(expected, measured)} of {expected} {q.data?.resolution === "hourly" ? "hours" : "10-minute periods"} in this period have no measurements; they show as gaps.</p>
                )}
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
