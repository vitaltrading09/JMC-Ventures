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

type Tab = ReturnType<typeof tabForEvidence>;

export function SummaryTab({ s, onTab }: { s: Summary; onTab: (t: Tab) => void }) {
    return (
        <div className="space-y-6">
            <section aria-labelledby="glance" className="rounded-xl border border-line bg-surface/50 px-5 py-4">
                <h2 id="glance" className="text-base font-semibold text-ink">Your site at a glance</h2>
                <div className="mt-2 space-y-1 text-[15px] leading-relaxed text-ink-2 max-w-3xl">
                    {s.glance.map((g, i) => <p key={i}>{g}</p>)}
                </div>
                <p className="mt-3 text-xs text-faint">{s.context.provisional ? "Provisional: covers the elapsed part of the assessment only. " : ""}Built from the measured data only; categories use declared screening rules, not certification.</p>
            </section>

            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                {s.metrics.map((m) => (
                    <button key={m.key} type="button" onClick={() => onTab(tabForEvidence(m.evidence))}
                        className="text-left rounded-xl border border-line bg-surface/50 px-4 py-3 hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">
                        <p className="text-[13px] text-muted">{m.label}</p>
                        <p className="mt-1 text-2xl font-semibold text-ink tabular-nums">
                            {m.value === null ? "–" : m.key === "energy" ? num(m.value) : m.value}
                            <span className="ml-1 text-sm font-normal text-muted">{m.unit}</span>
                        </p>
                        <p className="mt-1 text-xs text-faint">{m.definition}{m.at ? ` At ${fmtDateTime(m.at)}.` : ""}</p>
                    </button>
                ))}
            </div>

            <div className="grid lg:grid-cols-4 gap-3" role="list" aria-label="Assessment categories">
                {s.categories.map((c) => {
                    const st = STATE_STYLE[c.state];
                    return (
                        <div key={c.key} role="listitem" className={`rounded-xl border px-4 py-3 ${st.box}`}>
                            <p className="text-[13px] text-ink-3">{c.title}</p>
                            <p className={`mt-1 text-sm font-semibold ${st.text}`}><span aria-hidden className="mr-1">{st.mark}</span>{c.label}</p>
                            <p className="mt-1 text-xs text-muted">{c.reason}</p>
                        </div>
                    );
                })}
            </div>

            <Fingerprint s={s} />

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Prioritised findings" subtitle="At most three, most significant first. Severity and confidence are separate.">
                    {s.findings.length === 0 ? <Empty>No observation needs follow-up so far.</Empty> : (
                        <ol className="space-y-4">
                            {s.findings.map((f, i) => (
                                <li key={i} className="border-l-2 pl-3 border-line-strong">
                                    <p className="text-xs text-faint">
                                        <span className={f.severity === "act" ? "text-bad" : "text-warn"}>{f.severity === "act" ? "Material concern" : "Investigate"}</span>
                                        {" · "}{f.confidence} confidence · for {f.who}
                                    </p>
                                    <p className="text-sm text-ink mt-1">{f.text}</p>
                                    <div className="flex gap-4 mt-2 text-sm">
                                        <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => onTab(tabForEvidence(f.evidence))}>
                                            Inspect evidence<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                                        </button>
                                        <button type="button" className="text-muted hover:text-ink-2" onClick={() => askConsultant(`Explain this observation and what we should verify first: "${f.text}"`)}>Ask the consultant</button>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    )}
                </Panel>
                <Panel title="What to do next">
                    <ol className="space-y-2 text-sm text-ink-2 list-decimal pl-5">
                        {s.next.map((n, i) => <li key={i}>{n.text} <span className="text-xs text-faint">({n.who})</span></li>)}
                    </ol>
                    <div className="mt-5 border-t border-line pt-4">
                        <h3 className="text-sm font-semibold text-ink">Feasibility handover</h3>
                        <p className="text-xs text-faint mt-0.5">{s.feasibility.note}</p>
                        {s.feasibility.missing.length > 0
                            ? <p className="text-sm text-ink-3 mt-2">Still missing: {s.feasibility.missing.join("; ")}.</p>
                            : <p className="text-sm text-ok mt-2">All listed inputs are available.</p>}
                    </div>
                </Panel>
            </div>
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
