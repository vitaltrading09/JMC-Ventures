"use client";

// Data explorer: every measured channel at every resolution, for the engineer
// in the client ("what was THD-I on phase B in the 1-minute interval at 12:05?").
//   - pick up to 8 channels (grouped chips; phases keep their colours)
//   - resolution: auto, every reading (raw), 1 minute, 10 minutes, 1 hour
//   - range: last hour / 6 h / 24 h / 7 days / whole assessment, or custom; live
//     mode refreshes every 15 s while the window ends now
//   - one chart per unit, all on one synced time cursor with a single readout;
//     aggregates can show the min–max band inside each period
//   - an exact-values table, "jump to" a time, and CSV download of what is shown
// Data: GET /points/:id/explore (clamped to the assessment, corrections applied).

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { Download, Radio } from "lucide-react";
import { apiGet, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { PHASE } from "@/lib/summary";
import type { Assessment } from "@/lib/assessments";
import { ErrorBox, inputClass } from "@/components/ops/ui";
import { Skeleton } from "@/components/portal/Insight";

const H = 3_600_000, D = 24 * H, SAST = 2 * H;
type Ch = { key: string; label: string; unit: string; group: string; agg: boolean };
const p3 = ["a", "b", "c"] as const;
const CHANNELS: Ch[] = [
    ...p3.map((p) => ({ key: `voltage_${p}`, label: `V ${p.toUpperCase()}-N`, unit: "V", group: "Voltage", agg: true })),
    ...["ab", "bc", "ca"].map((p) => ({ key: `voltage_${p}`, label: `V ${p.toUpperCase()}`, unit: "V", group: "Voltage", agg: false })),
    ...p3.map((p) => ({ key: `current_${p}`, label: `I ${p.toUpperCase()}`, unit: "A", group: "Current", agg: true })),
    { key: "current_n", label: "I N", unit: "A", group: "Current", agg: false },
    { key: "power_active_total", label: "kW total", unit: "kW", group: "Power", agg: true },
    { key: "power_reactive_total", label: "kvar total", unit: "kvar", group: "Power", agg: true },
    { key: "power_apparent_total", label: "kVA total", unit: "kVA", group: "Power", agg: true },
    ...p3.map((p) => ({ key: `power_active_${p}`, label: `kW ${p.toUpperCase()}`, unit: "kW", group: "Power per phase", agg: false })),
    ...p3.map((p) => ({ key: `power_reactive_${p}`, label: `kvar ${p.toUpperCase()}`, unit: "kvar", group: "Power per phase", agg: false })),
    ...p3.map((p) => ({ key: `power_apparent_${p}`, label: `kVA ${p.toUpperCase()}`, unit: "kVA", group: "Power per phase", agg: false })),
    { key: "power_factor_total", label: "PF total", unit: "PF", group: "Power factor", agg: true },
    ...p3.map((p) => ({ key: `power_factor_${p}`, label: `PF ${p.toUpperCase()}`, unit: "PF", group: "Power factor", agg: false })),
    { key: "frequency", label: "Frequency", unit: "Hz", group: "Frequency", agg: true },
    ...p3.map((p) => ({ key: `thd_voltage_${p}`, label: `THD-V ${p.toUpperCase()}`, unit: "%", group: "Distortion", agg: true })),
    ...p3.map((p) => ({ key: `thd_current_${p}`, label: `THD-I ${p.toUpperCase()}`, unit: "%", group: "Distortion", agg: true })),
    { key: "voltage_unbalance", label: "V unbalance", unit: "%", group: "Unbalance", agg: true },
    { key: "current_unbalance", label: "I unbalance", unit: "%", group: "Unbalance", agg: true },
];
const BY = new Map(CHANNELS.map((c) => [c.key, c]));
const GROUPS = Array.from(new Set(CHANNELS.map((c) => c.group)));
const OTHER = ["#2563eb", "#0d9488", "#7c3aed", "#db2777", "#65a30d", "#0891b2", "#ea580c", "#475569"];
const colorOf = (k: string, i: number) => {
    const m = /_(a|b|c)$/.exec(k)?.[1];
    return m ? PHASE[m.toUpperCase() as "A" | "B" | "C"].color : OTHER[i % OTHER.length];
};
const dashOf = (k: string) => { const m = /_(a|b|c)$/.exec(k)?.[1]; return m ? PHASE[m.toUpperCase() as "A" | "B" | "C"].dash : undefined; };
const INTERVALS = [["auto", "Auto"], ["raw", "Every reading"], ["1m", "1 minute"], ["10m", "10 minutes"], ["1h", "1 hour"]] as const;
const RANGES = [["1h", "Last hour", H], ["6h", "6 hours", 6 * H], ["24h", "24 hours", D], ["7d", "7 days", 7 * D], ["all", "Whole assessment", 0]] as const;
const toLocal = (ms: number) => new Date(ms + SAST).toISOString().slice(0, 16);
const fromLocal = (v: string) => new Date(`${v}:00Z`).getTime() - SAST;
const clock = (ms: number, withSec: boolean) => new Date(ms + SAST).toISOString().slice(11, withSec ? 19 : 16);
const day = (ms: number) => new Date(ms + SAST).toISOString().slice(5, 10).replace("-", "/");
const dec = (unit: string) => (unit === "PF" || unit === "Hz" ? 3 : 2);

export function DataExplorer({ assessment, pointId, pointName }: { assessment: Assessment; pointId: string; pointName: string }) {
    const start = new Date(assessment.start_at ?? Date.now()).getTime();
    const endOf = () => Math.min(Date.now(), new Date(assessment.effective_end_at ?? Date.now()).getTime());
    const [channels, setChannels] = useState<string[]>(["power_active_total", "thd_current_a", "thd_current_b", "thd_current_c"]);
    const [interval, setInterval] = useState<string>("auto");
    const [range, setRange] = useState<string>("6h");
    const [custom, setCustom] = useState<{ from: number; to: number } | null>(null);
    const [live, setLive] = useState(true);
    const [band, setBand] = useState(false);
    const [view, setView] = useState<"chart" | "table">("chart");
    const [jump, setJump] = useState<string>("");
    const [hover, setHover] = useState<number | null>(null);
    const [tick, setTick] = useState(0);

    // The window: a preset ending now (live), or a custom one.
    const win = useMemo(() => {
        if (custom) return custom;
        const to = endOf();
        const r = RANGES.find(([k]) => k === range)!;
        return { from: r[2] ? Math.max(start, to - r[2]) : start, to };
    }, [custom, range, tick]); // eslint-disable-line react-hooks/exhaustive-deps
    const isLive = live && !custom && endOf() >= Date.now() - 60_000;
    useEffect(() => { if (!isLive) return; const t = window.setInterval(() => setTick((x) => x + 1), 15_000); return () => window.clearInterval(t); }, [isLive]);

    const q = useQuery({
        queryKey: ["explore", pointId, channels.join(","), interval, win.from, win.to],
        enabled: channels.length > 0,
        placeholderData: (prev) => prev,
        queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/explore?from=${new Date(win.from).toISOString()}&to=${new Date(win.to).toISOString()}&interval=${interval}&channels=${channels.join(",")}`),
    });
    const res = q.data;
    const width = (res?.bucket_seconds ?? 60) * 1000;
    const rows: any[] = useMemo(() => {
        const src = (res?.rows ?? []).map((r: any) => ({ ...r, ms: new Date(r.t).getTime() }));
        // Raw: a gap is anything longer than 3× the typical spacing; aggregates: a missing bucket.
        const spacing = res?.interval === "raw" && src.length > 2 ? median(src.slice(1).map((r: any, i: number) => r.ms - src[i].ms)) : width;
        const out: any[] = [];
        src.forEach((r: any, i: number) => {
            if (i > 0 && r.ms - src[i - 1].ms > (res?.interval === "raw" ? 3 : 1.5) * spacing) out.push({ ms: src[i - 1].ms + spacing, gap: true });
            out.push(band ? { ...r, ...Object.fromEntries(channels.filter((k) => r[`${k}_min`] != null).map((k) => [`${k}_band`, [r[`${k}_min`], r[`${k}_max`]]])) } : r);
        });
        return out;
    }, [res, band, channels, width]);
    const units = Array.from(new Set(channels.map((k) => BY.get(k)!.unit)));
    const unavailable = (res?.channels ?? []).filter((c: any) => !c.available).map((c: any) => c.label);
    const withSec = res?.interval === "raw";
    const jumpMs = jump ? fromLocal(jump) : null;
    const jumpIdx = jumpMs == null ? -1 : nearest(rows, jumpMs);
    const readIdx = hover ?? (jumpIdx >= 0 ? jumpIdx : null);
    const readRow = readIdx != null ? rows[readIdx] : null;

    const toggle = (k: string) => setChannels((cs) => (cs.includes(k) ? cs.filter((x) => x !== k) : cs.length >= 8 ? cs : [...cs, k]));
    const csv = () => {
        const head = ["time_sast", ...channels.flatMap((k) => (res?.interval !== "raw" && BY.get(k)!.agg ? [k, `${k}_min`, `${k}_max`] : [k]))];
        const body = (res?.rows ?? []).map((r: any) => [new Date(new Date(r.t).getTime() + SAST).toISOString().slice(0, 19).replace("T", " "), ...head.slice(1).map((h) => r[h] ?? "")].join(","));
        const blob = new Blob([`# ${pointName}, ${res?.interval_label}, ${res?.basis}\n${head.join(",")}\n${body.join("\n")}\n`], { type: "text/csv" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${pointName.replace(/\W+/g, "_")}_${res?.interval}_${toLocal(win.from).replace(/[:T]/g, "")}.csv`; a.click();
    };

    return (
        <div className="space-y-6">
            <section className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line space-y-4" aria-label="What to show">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                    <Seg label="Time range" value={custom ? "" : range} options={RANGES.map(([k, l]) => [k, l])} onChange={(v) => { setCustom(null); setRange(v); }} />
                    <Seg label="Resolution" value={interval} options={INTERVALS.map(([k, l]) => [k, l])} onChange={setInterval} />
                    <label className="inline-flex items-center gap-2 text-sm text-ink-3 pb-1.5">
                        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
                        <Radio className={`h-4 w-4 ${isLive ? "text-ok" : "text-faint"}`} aria-hidden />Live (every 15 s)
                    </label>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm text-muted">From ({TZ_LABEL})<input type="datetime-local" className={`${inputClass} mt-1 w-52`} value={toLocal(win.from)} min={toLocal(start)} onChange={(e) => e.target.value && setCustom({ from: fromLocal(e.target.value), to: win.to })} /></label>
                    <label className="text-sm text-muted">To<input type="datetime-local" className={`${inputClass} mt-1 w-52`} value={toLocal(win.to)} onChange={(e) => e.target.value && setCustom({ from: win.from, to: fromLocal(e.target.value) })} /></label>
                    <label className="text-sm text-muted">Jump to a time<input type="datetime-local" step={withSec ? 1 : 60} className={`${inputClass} mt-1 w-56`} value={jump} min={toLocal(win.from)} max={toLocal(win.to)} onChange={(e) => setJump(e.target.value)} /></label>
                    {jump && <button type="button" className="pb-2 text-sm text-muted hover:text-ink" onClick={() => setJump("")}>Clear</button>}
                </div>
                <details>
                    <summary className="cursor-pointer select-none text-sm text-muted">
                        Channels: <span className="text-ink-2">{channels.map((k) => BY.get(k)!.label).join(", ")}</span> <span className="text-accent">· change</span>
                    </summary>
                <fieldset className="mt-3">
                    <legend className="sr-only">Channels ({channels.length} of 8)</legend>
                    <div className="space-y-2">
                        {GROUPS.map((g) => (
                            <div key={g} className="flex flex-wrap items-center gap-1.5">
                                <span className="w-32 text-xs uppercase tracking-wide text-faint">{g}</span>
                                {CHANNELS.filter((c) => c.group === g).map((c) => {
                                    const on = channels.includes(c.key);
                                    return (
                                        <button key={c.key} type="button" aria-pressed={on} onClick={() => toggle(c.key)}
                                            title={c.agg ? "Available at every resolution" : "Stored as individual readings only: shown at 'Every reading'"}
                                            className={`rounded-full px-3 py-1 text-[13px] ring-1 ${on ? "bg-blue-600 text-white ring-blue-600" : "text-ink-2 ring-line-strong hover:bg-surface-2"} ${!c.agg ? "italic" : ""}`}>
                                            {c.label}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                    <p className="mt-2 text-xs text-faint">Channels in italics are kept as individual readings only, so they show at "Every reading" (windows of up to 6 hours).</p>
                </fieldset>
                </details>
            </section>

            <section className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
                <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm text-ink-2">
                        <b>{pointName}</b> · {fmtDateTime(new Date(win.from))} – {fmtDateTime(new Date(win.to))} {TZ_LABEL}
                        {res && <span className="text-faint"> · {res.interval_label} · {res.rows.length.toLocaleString("en-ZA")} {res.interval === "raw" ? "readings" : "periods"}</span>}
                    </p>
                    <div className="ml-auto flex items-center gap-2">
                        {res?.interval !== "raw" && <label className="inline-flex items-center gap-1.5 text-sm text-ink-3"><input type="checkbox" checked={band} onChange={(e) => setBand(e.target.checked)} />Min–max band</label>}
                        <Seg value={view} options={[["chart", "Chart"], ["table", "Table"]]} onChange={(v) => setView(v as any)} />
                        <button type="button" onClick={csv} disabled={!res?.rows?.length} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ring-1 ring-line-strong text-ink-2 hover:bg-surface-2 disabled:opacity-40"><Download className="h-4 w-4" aria-hidden />CSV</button>
                    </div>
                </div>
                {q.error && <div className="mt-3"><ErrorBox error={q.error} /></div>}
                {unavailable.length > 0 && <p className="mt-2 text-sm text-warn">{unavailable.join(", ")}: individual readings only. Choose "Every reading" and a window of up to 6 hours to see {unavailable.length === 1 ? "it" : "them"}.</p>}
                {res?.truncated && <p className="mt-2 text-sm text-warn">Showing the first 30 000 readings; choose a shorter window for the rest.</p>}
                {res && <p className="mt-1 text-xs text-faint">{res.basis}.</p>}

                {q.isLoading && !res ? <Skeleton className="mt-4 h-72" /> : !rows.length ? (
                    <p className="mt-6 text-[15px] text-muted">No measurements in this window.</p>
                ) : view === "chart" ? (
                    <>
                        <Readout row={readRow} channels={channels} withSec={withSec} interval={res?.interval} />
                        <div className="space-y-4">
                            {units.map((u) => (
                                <div key={u}>
                                    <p className="text-xs text-faint mb-1">{u}</p>
                                    <div className="h-72">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={rows} syncId="explore" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
                                                onMouseMove={(e: any) => { if (e?.activeTooltipIndex != null) setHover(e.activeTooltipIndex); }} onMouseLeave={() => setHover(null)}>
                                                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                                                <XAxis dataKey="ms" type="number" scale="time" domain={[win.from, win.to]} allowDataOverflow stroke="var(--chart-axis)" fontSize={11}
                                                    tickFormatter={(ms) => (win.to - win.from > D ? `${day(ms)} ${clock(ms, false)}` : clock(ms, withSec && win.to - win.from < 10 * 60_000))} minTickGap={50} />
                                                <YAxis stroke="var(--chart-axis)" fontSize={11} width={56} domain={["auto", "auto"]} tickFormatter={(v) => num(v, u === "PF" ? 2 : Math.abs(v) >= 100 ? 0 : 1)} />
                                                <Tooltip content={() => null} cursor={{ stroke: "var(--chart-axis)" }} />
                                                {jumpMs != null && <ReferenceLine x={jumpMs} stroke="#a855f7" strokeDasharray="3 3" />}
                                                {channels.filter((k) => BY.get(k)!.unit === u).map((k) => band && rows.some((r) => r[`${k}_band`]) ? (
                                                    <Area key={`${k}b`} dataKey={`${k}_band`} stroke="none" fill={colorOf(k, channels.indexOf(k))} fillOpacity={0.12} isAnimationActive={false} />
                                                ) : null)}
                                                {channels.filter((k) => BY.get(k)!.unit === u).map((k) => (
                                                    <Line key={k} dataKey={k} name={BY.get(k)!.label} stroke={colorOf(k, channels.indexOf(k))} strokeDasharray={dashOf(k)} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls={false} />
                                                ))}
                                            </ComposedChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <ValuesTable rows={rows.filter((r) => !r.gap)} channels={channels} withSec={withSec} aggregate={res?.interval !== "raw"} focusMs={jumpMs} />
                )}
            </section>
        </div>
    );
}

function Seg({ label, value, options, onChange }: { label?: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
    return (
        <div>
            {label && <p className="text-sm text-muted mb-1">{label}</p>}
            <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1">
                {options.map(([k, l]) => (
                    <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}
                        className={`rounded-full px-3 py-1 text-sm ${value === k ? "bg-blue-600 text-white" : "text-ink-2 ring-1 ring-line-strong hover:bg-surface-2"}`}>{l}</button>
                ))}
            </div>
        </div>
    );
}

function Readout({ row, channels, withSec, interval }: { row: any; channels: string[]; withSec: boolean; interval?: string }) {
    return (
        <div className="sticky top-12 lg:top-0 z-10 my-3 rounded-xl bg-surface-2/95 px-4 py-2 text-[13px] tabular-nums backdrop-blur">
            {!row || row.gap ? <span className="text-faint">Hover over a chart, or jump to a time, to read the exact values.</span> : (
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                    <span className="font-medium text-ink">{fmtDateTime(new Date(row.ms))}{withSec ? `:${new Date(row.ms + SAST).toISOString().slice(17, 19)}` : ""} <span className="font-normal text-faint">{TZ_LABEL}{interval !== "raw" ? " · period start" : ""}</span></span>
                    {channels.map((k, i) => {
                        const c = BY.get(k)!;
                        return (
                            <span key={k}><span style={{ color: colorOf(k, i) }}>■</span> <span className="text-faint">{c.label} </span>{row[k] == null ? "–" : num(row[k], dec(c.unit))}{c.unit === "PF" ? "" : ` ${c.unit}`}
                                {row[`${k}_max`] != null && <span className="text-faint"> ({num(row[`${k}_min`], dec(c.unit))}–{num(row[`${k}_max`], dec(c.unit))})</span>}</span>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** Exact values; rows around a jump target are shown (and highlighted) when there are many. */
function ValuesTable({ rows, channels, withSec, aggregate, focusMs }: { rows: any[]; channels: string[]; withSec: boolean; aggregate: boolean; focusMs: number | null }) {
    const ref = useRef<HTMLTableRowElement>(null);
    const focus = focusMs == null ? -1 : nearest(rows, focusMs);
    const LIMIT = 1500;
    const startAt = rows.length <= LIMIT ? 0 : focus >= 0 ? Math.max(0, Math.min(rows.length - LIMIT, focus - LIMIT / 2)) : Math.max(0, rows.length - LIMIT);
    const shown = rows.slice(startAt, startAt + LIMIT);
    useEffect(() => { ref.current?.scrollIntoView({ block: "center" }); }, [focus]);
    return (
        <div className="mt-4">
            {rows.length > LIMIT && <p className="mb-2 text-xs text-faint">Showing {LIMIT.toLocaleString("en-ZA")} of {rows.length.toLocaleString("en-ZA")} rows{focus >= 0 ? " around the chosen time" : " (the most recent)"}; the CSV has them all.</p>}
            <div className="max-h-[560px] overflow-auto rounded-xl ring-1 ring-line">
                <table className="w-full text-[13px] tabular-nums">
                    <thead className="sticky top-0 bg-surface-2 text-left text-faint">
                        <tr>
                            <th className="px-3 py-2 font-medium">Time ({TZ_LABEL}){aggregate ? ", period start" : ""}</th>
                            {channels.map((k) => <th key={k} className="px-3 py-2 font-medium whitespace-nowrap">{BY.get(k)!.label}{BY.get(k)!.unit !== "PF" ? ` (${BY.get(k)!.unit})` : ""}{aggregate && BY.get(k)!.agg ? <span className="font-normal"> avg · min–max</span> : ""}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((r, i) => {
                            const at = startAt + i === focus;
                            return (
                                <tr key={r.t} ref={at ? ref : undefined} className={`border-t border-line ${at ? "bg-blue-500/10" : ""}`}>
                                    <td className="px-3 py-1.5 whitespace-nowrap text-ink-2">{new Date(r.ms + SAST).toISOString().slice(0, withSec ? 19 : 16).replace("T", " ")}</td>
                                    {channels.map((k) => {
                                        const u = BY.get(k)!.unit;
                                        return <td key={k} className="px-3 py-1.5 whitespace-nowrap">{r[k] == null ? "–" : num(r[k], dec(u))}{aggregate && r[`${k}_min`] != null && <span className="text-faint"> · {num(r[`${k}_min`], dec(u))}–{num(r[`${k}_max`], dec(u))}</span>}</td>;
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function nearest(rows: any[], ms: number) {
    let best = -1, d = Infinity;
    rows.forEach((r, i) => { if (!r.gap && Math.abs(r.ms - ms) < d) { d = Math.abs(r.ms - ms); best = i; } });
    return best;
}
function median(v: number[]) { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 1000; }
