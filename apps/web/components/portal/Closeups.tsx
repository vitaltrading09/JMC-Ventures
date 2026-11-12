"use client";

// Close-ups: the worst moments behind a finding, reading by reading
// (GET /points/:id/moments, services/ingestion-service/src/moments.ts).
// Each card: when, the headline number, the readings around it (per phase, with
// the level that matters and the exact moment marked), the site load underneath
// on the same time axis, what the readings show, and a careful reading of
// whether it points to the site or the supply. Colour is never the only cue:
// phases differ by dash, the verdict is written out.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { Factory, UtilityPole, HelpCircle, MessageSquare, ZoomIn } from "lucide-react";
import Link from "next/link";
import { apiGet, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { PHASE } from "@/lib/summary";
import { askConsultant } from "@/lib/portal";
import { siteHref } from "@/lib/siteNav";
import { Skeleton } from "@/components/portal/Insight";

export type MomentKind = "sags" | "voltage_high" | "thd" | "demand" | "imbalance" | "pf";
type Row = Record<string, any>;
type Moment = {
    at: string; from: string; to: string; value: number | null; unit: string; phase: string | null; headline: string; facts: string[];
    reading: "site" | "supply" | "unclear"; reading_text: string; cadence_s: number | null; threshold: number | null; series: Row[];
};

const SAST = 2 * 3_600_000;
const clock = (ms: number, sec = true) => new Date(ms + SAST).toISOString().slice(11, sec ? 19 : 16);
const tip = { background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12, borderRadius: 8 };

const KIND: Record<MomentKind, { title: string; lines: { key: string; name: string; phase?: "A" | "B" | "C" }[]; unit: string; level: string }> = {
    sags: { title: "The deepest dips, up close", unit: "V", level: "90 % of nominal", lines: ["a", "b", "c"].map((p) => ({ key: `voltage_${p}`, name: `Phase ${p.toUpperCase()}`, phase: p.toUpperCase() as "A" })) },
    voltage_high: { title: "The highest voltages, up close", unit: "V", level: "110 % of nominal", lines: ["a", "b", "c"].map((p) => ({ key: `voltage_${p}`, name: `Phase ${p.toUpperCase()}`, phase: p.toUpperCase() as "A" })) },
    thd: { title: "The worst distortion, up close", unit: "%", level: "8 % screening level", lines: ["a", "b", "c"].map((p) => ({ key: `thd_${p}`, name: `Phase ${p.toUpperCase()}`, phase: p.toUpperCase() as "A" })) },
    demand: { title: "The highest peaks, up close", unit: "kVA", level: "contracted limit", lines: [{ key: "kva", name: "Apparent power" }] },
    imbalance: { title: "The most uneven moments, up close", unit: "A", level: "", lines: ["a", "b", "c"].map((p) => ({ key: `current_${p}`, name: `Phase ${p.toUpperCase()}`, phase: p.toUpperCase() as "A" })) },
    pf: { title: "The lowest power factor, up close", unit: "PF", level: "0.85 minimum", lines: [{ key: "pf", name: "Power factor" }] },
};
/** Which close-up a finding type gets (none for after-hours load: it has no single moment). */
export function momentKindOf(type: string | null | undefined): MomentKind | null {
    const t = String(type ?? "").toUpperCase();
    if (/SAG|DIP|UNDERVOLT/.test(t)) return "sags";
    if (/SWELL|OVERVOLT|VOLTAGE_HIGH/.test(t)) return "voltage_high";
    if (/THD|HARMONIC|DISTORTION/.test(t)) return "thd";
    if (/MDI|DEMAND|PEAK/.test(t)) return "demand";
    if (/IMBALANCE|UNBALANCE/.test(t)) return "imbalance";
    if (/PF|POWER_FACTOR/.test(t)) return "pf";
    return null;
}

const READING = {
    site: { icon: Factory, label: "Points to equipment on site", cls: "bg-blue-500/10 text-accent ring-blue-500/25" },
    supply: { icon: UtilityPole, label: "Points to the supply side", cls: "bg-violet-500/10 text-ink-2 ring-violet-500/30" },
    unclear: { icon: HelpCircle, label: "Cause not clear from the readings", cls: "bg-surface-2 text-ink-3 ring-line" },
} as const;

export function Closeups({ projectId, pointId, kind, window, findingTitle }: {
    projectId: string; pointId: string; kind: MomentKind; window: { from: string; to: string } | null; findingTitle?: string;
}) {
    const q = useQuery({
        queryKey: ["moments", pointId, kind, window?.from, window?.to],
        queryFn: () => apiGet<{ moments: Moment[]; basis: string; point: string | null }>(
            `/ingestion/points/${pointId}/moments?kind=${kind}${window ? `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}` : ""}`),
        staleTime: 5 * 60_000,
    });
    const k = KIND[kind];
    if (q.isLoading) return <Skeleton className="h-72 w-full" />;
    const moments = q.data?.moments ?? [];
    if (!moments.length) return null;
    const perSecond = moments.some((m) => (m.cadence_s ?? 99) <= 1.5);
    return (
        <section aria-labelledby="closeups-h">
            <h3 id="closeups-h" className="text-lg font-semibold text-ink">{k.title}</h3>
            <p className="mt-1 mb-4 text-sm text-muted">
                The {moments.length === 1 ? "worst moment" : `${moments.length} worst moments`} of the period, shown {perSecond ? "second by second" : "reading by reading"} with the site load underneath, so you can see what happened first.
            </p>
            <div className="grid gap-4 2xl:grid-cols-2 [&>*]:min-w-0">
                {moments.map((m, i) => <Card key={m.at} m={m} i={i} kind={kind} projectId={projectId} pointId={pointId} findingTitle={findingTitle} />)}
            </div>
            <p className="mt-3 text-xs text-faint">{q.data?.basis}</p>
        </section>
    );
}

function Card({ m, i, kind, projectId, pointId, findingTitle }: { m: Moment; i: number; kind: MomentKind; projectId: string; pointId: string; findingTitle?: string }) {
    const k = KIND[kind];
    const R = READING[m.reading];
    const [hover, setHover] = useState<number | null>(null);
    const rows: Row[] = m.series.map((r) => ({ ...r, ms: new Date(r.t).getTime() }));
    const atMs = new Date(m.at).getTime();
    const lines = kind === "demand" && rows.every((r) => r.kva == null) ? [{ key: "kw", name: "Active power" }] : k.lines;
    const unit = kind === "demand" ? m.unit : k.unit;
    const span = rows.length ? rows[rows.length - 1].ms - rows[0].ms : 0;
    const withSec = span <= 15 * 60_000;
    const h = hover != null ? rows[hover] : rows.find((r) => r.ms === atMs) ?? null;
    const dec = unit === "PF" ? 3 : unit === "%" ? 2 : 1;
    return (
        <article className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
            <header className="flex flex-wrap items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold text-ink-2" aria-hidden>{i + 1}</span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm tabular-nums text-muted">{fmtDateTime(m.at)}:{clock(atMs).slice(6)} {TZ_LABEL}</p>
                    <h4 className="text-xl font-semibold leading-snug text-ink">{m.headline}</h4>
                </div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${R.cls}`}><R.icon className="h-3.5 w-3.5" aria-hidden />{R.label}</span>
            </header>

            <div className="mt-4" onMouseLeave={() => setHover(null)}>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-faint">
                    <span>{unit}{m.threshold != null && k.level ? ` · dashed line: ${num(m.threshold, unit === "PF" ? 2 : 0)} ${unit === "PF" ? "" : unit} (${k.level})` : ""}</span>
                    <span className="flex flex-wrap gap-x-3">
                        {lines.map((l) => (
                            <span key={l.key} className="inline-flex items-center gap-1 tabular-nums">
                                <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={l.phase ? PHASE[l.phase].color : "#2563eb"} strokeWidth="2" strokeDasharray={l.phase ? PHASE[l.phase].dash : undefined} /></svg>
                                <span className="text-ink-3">{l.name}{h && h[l.key] != null ? `: ${num(h[l.key], dec)}` : ""}</span>
                            </span>
                        ))}
                    </span>
                </div>
                <div className="h-44" role="img" aria-label={`${k.title}: ${m.headline}. ${m.facts[0] ?? ""}`}>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={rows} syncId={`closeup-${m.at}`} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} onMouseMove={(e: any) => { if (e?.activeTooltipIndex != null) setHover(e.activeTooltipIndex); }}>
                            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                            <XAxis dataKey="ms" type="number" scale="time" domain={["dataMin", "dataMax"]} hide />
                            <YAxis stroke="var(--chart-axis)" fontSize={11} width={48} domain={[(min: number) => Math.min(min, m.threshold ?? min) - pad(unit), (max: number) => Math.max(max, m.threshold ?? max) + pad(unit)]}
                                tickFormatter={(v) => num(v, unit === "PF" ? 2 : 0)} allowDecimals />
                            <Tooltip content={() => null} cursor={{ stroke: "var(--chart-axis)" }} />
                            {m.threshold != null && <ReferenceLine y={m.threshold} stroke="#dc2626" strokeDasharray="5 4" />}
                            <ReferenceLine x={atMs} stroke="#a855f7" strokeDasharray="3 3" />
                            {lines.map((l) => <Line key={l.key} dataKey={l.key} name={l.name} type="linear" stroke={l.phase ? PHASE[l.phase].color : "#2563eb"} strokeDasharray={l.phase ? PHASE[l.phase].dash : undefined}
                                strokeWidth={1.75} dot={rows.length <= 40 ? { r: 2 } : false} isAnimationActive={false} connectNulls />)}
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
                <p className="mt-1 flex justify-between text-xs text-faint"><span>Site load, kW</span><span className="tabular-nums text-ink-3">{h?.kw != null ? `${num(h.kw, 0)} kW at ${clock(h.ms, withSec)}` : ""}</span></p>
                <div className="h-24" aria-hidden>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={rows} syncId={`closeup-${m.at}`} margin={{ top: 2, right: 8, left: 0, bottom: 0 }} onMouseMove={(e: any) => { if (e?.activeTooltipIndex != null) setHover(e.activeTooltipIndex); }}>
                            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                            <XAxis dataKey="ms" type="number" scale="time" domain={["dataMin", "dataMax"]} stroke="var(--chart-axis)" fontSize={11} tickFormatter={(v) => clock(v, withSec)} minTickGap={56} />
                            <YAxis stroke="var(--chart-axis)" fontSize={11} width={48} domain={["auto", "auto"]} tickFormatter={(v) => num(v, 0)} />
                            <Tooltip content={() => null} cursor={{ stroke: "var(--chart-axis)" }} />
                            <ReferenceLine x={atMs} stroke="#a855f7" strokeDasharray="3 3" />
                            <Area dataKey="kw" type="stepAfter" stroke="#64748b" fill="#64748b" fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} connectNulls />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </div>

            <ul className="mt-4 space-y-1.5 text-[15px] text-ink-2">
                {m.facts.map((f, j) => <li key={j} className="flex gap-2"><span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-current opacity-50" /><span>{f}</span></li>)}
            </ul>
            <p className={`mt-4 rounded-xl px-3.5 py-2.5 text-[15px] ring-1 ${R.cls.replace(/text-\S+/g, "")} text-ink-2`}>{m.reading_text}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1">
                <button type="button" className="inline-flex items-center gap-1.5 py-1 text-sm font-medium text-accent hover:underline"
                    onClick={() => askConsultant(`Explain this moment${findingTitle ? ` of the finding "${findingTitle}"` : ""}: ${m.headline} at ${fmtDateTime(m.at)} ${TZ_LABEL}. What most likely happened and what should we check?`, { point_id: pointId, from: m.from, to: m.to })}>
                    <MessageSquare className="h-4 w-4" aria-hidden />Ask the consultant about this moment
                </button>
                <Link className="inline-flex items-center gap-1.5 py-1 text-sm text-muted hover:text-ink"
                    href={siteHref(projectId, "investigate", { from: new Date(atMs - 30 * 60_000).toISOString(), to: new Date(atMs + 30 * 60_000).toISOString() })}>
                    <ZoomIn className="h-4 w-4" aria-hidden />See the hour around it
                </Link>
            </div>
        </article>
    );
}

const pad = (unit: string) => (unit === "PF" ? 0.02 : unit === "%" ? 0.5 : unit === "V" ? 2 : 5);
