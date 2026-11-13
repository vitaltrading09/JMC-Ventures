"use client";

// The first screen of a site (engineering UI brief §5): "your site at a
// glance", four headline metrics, the operating fingerprint, up to three
// prioritised findings and what to do next. Everything comes from the
// assessment summary (the same dataset as the reports); nothing is computed here.

import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceArea, Legend } from "recharts";
import { ArrowRight } from "lucide-react";
import { fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { askConsultant } from "@/lib/portal";
import { Summary, STATE_STYLE, tabForEvidence } from "@/lib/summary";
import { Panel, Empty } from "@/components/ops/ui";
import { FindingTiles } from "@/components/portal/FindingTiles";
import { Sparkline, InsightCard } from "@/components/portal/Insight";
import { Journey } from "@/components/portal/Journey";
import { MomentTeaser } from "@/components/portal/Closeups";
import type { Assessment } from "@/lib/assessments";

type Tab = ReturnType<typeof tabForEvidence>;

/**
 * Site overview, top to bottom:
 *   1. A meter warning, only when the meter has stopped reporting.
 *   2. One hero card: the headline about the site, the supporting sentences and
 *      the four area statuses on the left; the assessment journey on the right.
 *   3. Four numbers, each with a plain line of context (and a trend where useful).
 *   4. What we found (tiles), then the site's typical day.
 * Each fact appears once; detail is one click away.
 */
export function SummaryTab({ s, onTab, projectId, findings, cases, assessment }: {
    s: Summary; onTab: (t: Tab) => void; projectId: string; findings: any[]; cases?: any[]; assessment?: Assessment | null;
}) {
    const cov = s.context.coverage?.fraction;
    const last = s.context.last_data_at ? new Date(s.context.last_data_at).getTime() + 3_600_000 : null;   // end of the latest hour
    const silentH = last != null ? (Date.now() - last) / 3_600_000 : null;
    const [headline, ...rest] = s.glance;
    const open = findings.filter((f) => !(cases ?? []).some((c) => c.recommendation_id === f.id && (c.status === "verified" || c.status === "not_needed")));
    const daily: any[] = s.point_detail?.daily ?? [];
    const mdi = s.point_detail?.demand?.contracted_mdi_kva;
    const metric = (k: string) => s.metrics.find((m) => m.key === k);
    const lf = metric("load_factor")?.value ?? null;
    const tiles = [
        { m: metric("energy"), trend: daily.map((d) => d.kwh_estimate), trendLabel: "daily energy",
          context: daily.length ? `about ${num((metric("energy")?.value ?? 0) / Math.max(1, s.context.observed_days))} kWh a day` : "" },
        { m: metric("demand"), trend: daily.map((d) => d.max_kw), trendLabel: "daily peak kW",
          context: mdi && metric("demand")?.value != null ? `${Math.round((metric("demand")!.value! / mdi) * 100)} % of your contracted ${num(mdi)} kVA` : "highest 30-minute average" },
        { m: metric("load_factor"), trend: null, trendLabel: "",
          context: lf == null ? "" : lf >= 60 ? "the load is steady through the day" : lf >= 35 ? "busy during working hours, quieter outside them" : "the site works in short, intense periods; peaks are far above the average" },
    ];
    return (
        <div className="space-y-8">
            {silentH != null && silentH > 2 && (
                <div role="status" className="flex items-start gap-3 rounded-2xl bg-amber-500/10 p-4 ring-1 ring-amber-500/30">
                    <span aria-hidden className="mt-0.5 font-bold text-warn">!</span>
                    <p className="text-[15px] text-ink-2"><b>{s.context.point?.name} has not sent data since {fmtDateTime(new Date(last!))} {TZ_LABEL}.</b> The figures below cover the data received so far. GridIQ checks the meter connection; nothing is lost if the meter has stored the readings.</p>
                </div>
            )}

            <section aria-labelledby="glance" className="grid gap-8 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-faint" id="glance">Your site at a glance</p>
                    <h2 className="mt-2 text-[22px] leading-snug font-semibold text-ink">{headline}</h2>
                    {rest.length > 0 && <ul className="mt-3 space-y-1.5 text-[15px] text-ink-3">{rest.map((g, i) => <li key={i}>{g}</li>)}</ul>}
                    <ul className="mt-5 grid gap-2 xl:grid-cols-2" aria-label="Assessment by area">
                        {s.categories.map((c) => {
                            const st = STATE_STYLE[c.state];
                            return (
                                <li key={c.key} title={c.reason} className="flex items-center gap-2 text-sm">
                                    <span aria-hidden className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${c.state === "ok" ? "bg-emerald-500/15" : c.state === "investigate" ? "bg-amber-500/15" : "bg-surface-3"} ${st.text}`}>{st.mark}</span>
                                    <span className="text-ink-2">{c.title}</span>
                                    {c.state !== "ok" && <span className={`text-xs ${st.text}`}>{c.label.toLowerCase()}</span>}
                                </li>
                            );
                        })}
                    </ul>
                    <p className="mt-4 text-xs text-faint">
                        {s.context.observed_days < 1 ? `${Math.round(s.context.observed_days * 24)} hours` : `${s.context.observed_days.toFixed(1)} days`} measured{cov != null ? ` · ${Math.round(cov * 100)} % of the expected data received` : ""}{s.context.provisional ? " · provisional" : ""} · screening rules, not a certification
                    </p>
                </div>
                {assessment && <Journey a={assessment} compact />}
            </section>

            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                {tiles.map(({ m, trend, trendLabel, context }) => m && (
                    <button key={m.key} type="button" onClick={() => onTab(tabForEvidence(m.evidence))} title={m.definition}
                        className="flex flex-col text-left rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line transition hover:ring-blue-400/60 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
                        <p className="text-sm text-muted">{m.label}</p>
                        <p className="mt-1 text-[32px] leading-tight font-semibold text-ink tabular-nums">
                            {m.value === null ? "–" : m.key === "energy" ? num(m.value) : m.value}<span className="ml-1 text-base font-normal text-muted">{m.unit}</span>
                        </p>
                        <p className="mt-1 text-sm text-ink-3">{context}</p>
                        {trend && trend.filter((x) => x != null).length > 1 && (
                            <div className="mt-auto pt-3"><Sparkline values={trend.slice(-14)} label={`${m.label}, ${trendLabel}`} /><p className="mt-1 text-[11px] text-faint">{trendLabel}, last {Math.min(14, trend.length)} days</p></div>
                        )}
                    </button>
                ))}
                <a href="#findings-h" className="flex flex-col rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line transition hover:ring-blue-400/60 hover:shadow-md">
                    <p className="text-sm text-muted">Findings</p>
                    <p className="mt-1 text-[32px] leading-tight font-semibold text-ink tabular-nums">{open.length}<span className="ml-1 text-base font-normal text-muted">open</span></p>
                    <p className="mt-1 text-sm text-ink-3">{open.length ? "see What we found below" : "nothing needs follow-up so far"}</p>
                </a>
            </div>

            {s.context.point?.id && <MomentTeaser projectId={projectId} pointId={s.context.point.id} findings={open} />}

            <section aria-labelledby="findings-h" className="scroll-mt-20">
                <div className="flex items-baseline justify-between mb-3">
                    <h2 id="findings-h" className="text-xl font-semibold text-ink">What we found</h2>
                    <button type="button" className="inline-flex items-center gap-1 py-1 text-sm text-accent hover:underline" onClick={() => askConsultant("What are the most important findings for this site so far, and what should we check first?")}>
                        Ask the consultant<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </div>
                <FindingTiles projectId={projectId} findings={findings} cases={cases}
                    emptyText={s.categories.some((c) => c.state === "investigate") ? "No findings about the site itself so far. The one area marked above is about the measurement, not the installation." : undefined} />
            </section>

            <Fingerprint s={s} />
        </div>
    );
}

function Fingerprint({ s }: { s: Summary }) {
    const wk = s.fingerprint?.weekday, we = s.fingerprint?.weekend, oh = s.fingerprint?.operating_hours;
    if (!wk || (wk.days === 0 && (!we || we.days === 0))) {
        return <Panel title="Operating fingerprint"><Empty>A full day of measurements is needed for the first operating profile.</Empty></Panel>;
    }
    const data = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        band: wk.hours[h]?.p10 != null && wk.hours[h]?.p90 != null ? [wk.hours[h].p10, wk.hours[h].p90] : null,
        weekday: wk.hours[h]?.median ?? null,
        weekend: we?.hours[h]?.median ?? null,
    }));
    const summaryText = (() => {
        const v = data.filter((d) => d.weekday !== null);
        if (!v.length) return "";
        const max = v.reduce((a, b) => (b.weekday! > a.weekday! ? b : a));
        const min = v.reduce((a, b) => (b.weekday! < a.weekday! ? b : a));
        return `Weekday median ranges from ${num(min.weekday!, 0)} kW at ${min.hour}:00 to ${num(max.weekday!, 0)} kW at ${max.hour}:00.`;
    })();
    return (
        <InsightCard eyebrow="Your typical day" headline={summaryText || "How the site uses power through a typical day."}
            method={<p>Hourly average kW, {TZ_LABEL}. Weekdays: {wk.days} day(s){wk.band ? ", median with the P10–P90 band" : " (too few days for a band)"}; weekend: {we?.days ?? 0} day(s).{oh ? ` Working hours ${oh.declared ? "declared" : "assumed"} ${oh.from}:00–${oh.to}:00 (shaded).` : ""}</p>}>
            <div className="h-72" role="img" aria-label={`Operating fingerprint chart. ${summaryText}`}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                        {oh && <ReferenceArea x1={oh.from} x2={Math.min(23, oh.to)} fill="rgb(var(--c-surface-3))" fillOpacity={0.45} />}
                        <XAxis dataKey="hour" stroke="var(--chart-axis)" fontSize={12} tickFormatter={(h) => `${String(h).padStart(2, "0")}:00`} interval={2} />
                        <YAxis stroke="var(--chart-axis)" fontSize={12} unit=" kW" width={72} />
                        <Tooltip contentStyle={{ background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12 }}
                            labelFormatter={(h) => `${String(h).padStart(2, "0")}:00–${String(Number(h) + 1).padStart(2, "0")}:00 ${TZ_LABEL}`}
                            formatter={(v: any, name: string) => [Array.isArray(v) ? `${num(v[0], 1)}–${num(v[1], 1)} kW` : `${num(v, 1)} kW`, name]} />
                        <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-ink-3">{v}</span>} />
                        {wk.band && <Area dataKey="band" name="Weekday P10–P90" stroke="none" fill="#3b82f6" fillOpacity={0.18} isAnimationActive={false} />}
                        <Line dataKey="weekday" name="Weekday median" stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                        {we && we.days > 0 && <Line dataKey="weekend" name="Weekend median" stroke="#a3a3a3" strokeDasharray="6 4" strokeWidth={2} dot={false} isAnimationActive={false} />}
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-faint">{summaryText} Shaded: operating hours. Gaps are hours without data, never zero.</p>
        </InsightCard>
    );
}
