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
import { Sparkline } from "@/components/portal/Insight";
import { Journey } from "@/components/portal/Journey";
import type { Assessment } from "@/lib/assessments";

type Tab = ReturnType<typeof tabForEvidence>;

/**
 * Site overview: the story first (glance + area statuses), then four numbers,
 * then the findings as tiles, then the site's typical day. Detail is one click away.
 */
export function SummaryTab({ s, onTab, projectId, findings, cases, assessment }: {
    s: Summary; onTab: (t: Tab) => void; projectId: string; findings: any[]; cases?: any[]; assessment?: Assessment | null;
}) {
    const cov = s.context.coverage?.fraction;
    return (
        <div className="space-y-8">
            {assessment && <Journey a={assessment} />}
            <section aria-labelledby="glance" className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
                <div className="flex flex-wrap items-baseline gap-x-3">
                    <h2 id="glance" className="text-xl font-semibold text-ink">Your site at a glance</h2>
                    <p className="text-sm text-faint">
                        {s.context.observed_days < 1 ? `${Math.round(s.context.observed_days * 24)} hours` : `${s.context.observed_days.toFixed(1)} days`} measured
                        {cov != null ? ` · ${Math.round(cov * 100)} % of the expected data received` : ""}{s.context.provisional ? " · provisional" : ""}
                    </p>
                </div>
                <div className="mt-3 space-y-1.5 text-[16px] leading-relaxed text-ink-2 max-w-3xl">
                    {s.glance.map((g, i) => <p key={i}>{g}</p>)}
                </div>
                <ul className="mt-5 flex flex-wrap gap-2" aria-label="Assessment by area">
                    {s.categories.map((c) => {
                        const st = STATE_STYLE[c.state];
                        return (
                            <li key={c.key} title={c.reason}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${c.state === "investigate" ? "border-amber-500/40 bg-amber-500/10" : c.state === "insufficient" ? "border-dashed border-line-strong" : "border-line-strong"}`}>
                                <span aria-hidden className={`font-bold ${st.text}`}>{st.mark}</span>
                                <span className="text-ink-2">{c.title}</span>
                                <span className={`${st.text}`}>· {c.label}</span>
                            </li>
                        );
                    })}
                </ul>
                <p className="mt-4 text-xs text-faint">Built from the measured data only, using declared screening rules; this is not a certification. Hover an area for the rule behind it.</p>
            </section>

            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                {s.metrics.map((m) => {
                    const daily: any[] = s.point_detail?.daily ?? [];
                    const trend = m.key === "energy" ? daily.map((d) => d.kwh_estimate) : m.key === "demand" ? daily.map((d) => d.max_kw) : null;
                    const mdi = s.point_detail?.demand?.contracted_mdi_kva;
                    const context = m.key === "demand" && mdi && m.value != null ? `${Math.round((m.value / mdi) * 100)} % of your contracted ${num(mdi)} kVA`
                        : m.key === "energy" && daily.length ? `about ${num((m.value ?? 0) / Math.max(1, s.context.observed_days))} kWh a day`
                        : m.key === "load_factor" ? (m.value == null ? "" : m.value >= 60 ? "a steady, well-used supply" : m.value >= 35 ? "typical for a day-shift site" : "short, sharp peaks") 
                        : m.key === "findings" ? (m.value ? "see What we found below" : "nothing needs follow-up so far") : "";
                    return (
                        <button key={m.key} type="button" onClick={() => onTab(tabForEvidence(m.evidence))} title={m.definition}
                            className="text-left rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line transition hover:ring-blue-400/60 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
                            <p className="text-sm text-muted">{m.label}</p>
                            <p className="mt-1 text-[32px] leading-tight font-semibold text-ink tabular-nums">
                                {m.value === null ? "–" : m.key === "energy" ? num(m.value) : m.value}
                                <span className="ml-1 text-base font-normal text-muted">{m.unit}</span>
                            </p>
                            <p className="mt-1 text-sm text-ink-3">{context}</p>
                            {trend && trend.filter((x) => x != null).length > 1 && <div className="mt-3"><Sparkline values={trend.slice(-14)} label={`${m.label}, daily trend`} /></div>}
                            {trend && <p className="mt-1 text-[11px] text-faint">{m.key === "energy" ? "daily energy" : "daily peak kW"}, last {Math.min(14, trend.length)} days</p>}
                        </button>
                    );
                })}
            </div>

            <section aria-labelledby="findings-h">
                <div className="flex items-baseline justify-between mb-3">
                    <h2 id="findings-h" className="text-xl font-semibold text-ink">What we found</h2>
                    <button type="button" className="inline-flex items-center gap-1 text-sm text-accent hover:underline" onClick={() => askConsultant("What are the most important findings for this site so far, and what should we check first?")}>
                        Ask the consultant<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </div>
                <FindingTiles projectId={projectId} findings={findings} cases={cases} />
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
        <Panel title="Operating fingerprint"
            subtitle={`Typical day, hourly average kW, ${TZ_LABEL}. Weekdays: ${wk.days} day(s)${wk.band ? ", median with P10–P90 band" : " (too few days for a band)"}; weekend: ${we?.days ?? 0} day(s).${oh ? ` Operating hours ${oh.declared ? "declared" : "assumed"} ${oh.from}:00–${oh.to}:00.` : ""}`}>
            <div className="h-72" role="img" aria-label={`Operating fingerprint chart. ${summaryText}`}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                        {oh && <ReferenceArea x1={oh.from} x2={Math.min(23, oh.to)} fill="#334155" fillOpacity={0.25} />}
                        <XAxis dataKey="hour" stroke="var(--chart-axis)" fontSize={12} tickFormatter={(h) => `${String(h).padStart(2, "0")}:00`} interval={2} />
                        <YAxis stroke="var(--chart-axis)" fontSize={12} unit=" kW" width={72} />
                        <Tooltip contentStyle={{ background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12 }}
                            labelFormatter={(h) => `${String(h).padStart(2, "0")}:00–${String(Number(h) + 1).padStart(2, "0")}:00 ${TZ_LABEL}`}
                            formatter={(v: any, name: string) => [Array.isArray(v) ? `${num(v[0], 1)}–${num(v[1], 1)} kW` : `${num(v, 1)} kW`, name]} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        {wk.band && <Area dataKey="band" name="Weekday P10–P90" stroke="none" fill="#3b82f6" fillOpacity={0.18} isAnimationActive={false} />}
                        <Line dataKey="weekday" name="Weekday median" stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                        {we && we.days > 0 && <Line dataKey="weekend" name="Weekend median" stroke="#a3a3a3" strokeDasharray="6 4" strokeWidth={2} dot={false} isAnimationActive={false} />}
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-faint">{summaryText} Shaded: operating hours. Gaps are hours without data, never zero.</p>
        </Panel>
    );
}
