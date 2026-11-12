"use client";

// Energy and demand (client-experience plan, step 3): four insight cards, each
// headline a sentence from the measurements.
//   1. The peak: daily maximum 30-minute demand against the contracted limit,
//      with the five highest intervals, each opening the investigation.
//   2. The load-duration curve: how long the site spends near its limit.
//   3. Daily energy: weekdays vs weekends.
//   4. A calendar heatmap (date × hour): shifts, weekends and after-hours load.
// Time-of-use cost is deliberately not shown.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, Cell, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from "recharts";
import { apiGet, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { siteHref } from "@/lib/siteNav";
import type { PortalProjectDetail } from "@/lib/portal";
import type { Summary } from "@/lib/summary";
import { InsightCard, Skeleton, ACCENT, CONTEXT, WARN } from "@/components/portal/Insight";
import { BalanceTab } from "@/components/portal/ProjectTabs";
import { ErrorBox } from "@/components/ops/ui";

const DAY = 86_400_000, H = 3_600_000, SAST = 2 * H;
const tip = { background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12, borderRadius: 8 };
const weekday = (iso: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T12:00:00Z`).getUTCDay()];
const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());

export function EnergyView({ project, s, since, pointId }: { project: PortalProjectDetail; s: Summary; since: string | null; pointId: string }) {
    const days = since ? Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / DAY)) : 30;
    const demand = useQuery({ queryKey: ["demand", pointId, days], queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/demand?days=${days}`) });
    const pd = s.point_detail;
    const d = demand.data;
    const mdi: number | null = d?.contracted_mdi_kva ?? null;
    const hoursByDay = useMemo(() => {
        const m = new Map<string, number>();
        for (const t of pd?.hourly_series?.t ?? []) { const k = sastDate(t); m.set(k, (m.get(k) ?? 0) + 1); }
        return m;
    }, [pd]);
    // Every SAST day of the window, so days without data show as gaps instead of disappearing.
    const dayList = useMemo(() => {
        const out: string[] = [];
        const from = since ? sastDate(since) : (pd?.daily?.[0]?.date ?? null);
        if (!from) return out;
        for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= sastDate(new Date().toISOString()); d = new Date(d.getTime() + DAY)) out.push(d.toISOString().slice(0, 10));
        return out;
    }, [since, pd]);
    const byDate = new Map<string, any>((pd?.daily ?? []).map((x: any) => [x.date, x]));
    const daily: any[] = dayList.map((date) => ({ date, ...(byDate.get(date) ?? {}), hours: hoursByDay.get(date) ?? 0 }));
    const full = daily.filter((x) => x.hours >= 20 && x.kwh_estimate != null);
    const partial = daily.filter((x) => x.kwh_estimate != null && x.hours < 20).length;

    const weekdayAvg = avg(full.filter((x) => !isWeekend(x.date)).map((x) => x.kwh_estimate));
    const weekendAvg = avg(full.filter((x) => isWeekend(x.date)).map((x) => x.kwh_estimate));
    const half = d?.duration_curve?.find((p: any) => p.pct >= 50)?.kva ?? null;

    return (
        <div className="space-y-8">
            {demand.isLoading ? <Skeleton className="h-96" /> : demand.error ? <ErrorBox error={demand.error} /> : d && (
                <InsightCard eyebrow="Maximum demand"
                    headline={d.max_kva != null
                        ? <>Your highest 30-minute demand was <b>{num(d.max_kva, 0)} kVA</b> on {weekday(sastDate(d.max_at))} {fmtDateTime(d.max_at)}{mdi ? <>, {Math.round((d.max_kva / mdi) * 100)} % of your contracted {num(mdi)} kVA</> : ""}.</>
                        : "No complete 30-minute interval has been measured yet."}
                    takeaway={mdi && d.hours_above_90pct_mdi != null
                        ? d.hours_above_90pct_mdi > 0 ? `The site spent ${num(d.hours_above_90pct_mdi, 1)} hours above 90 % of its contracted limit. Those are the moments to look at first.` : "The site never came within 10 % of its contracted limit: there is headroom."
                        : "No contracted limit is recorded for this point, so peaks are shown without a reference."}
                    method={<><p>{d.basis}.</p><p>{actual(d)}. Billing demand is the 30-minute average; short spikes inside an interval are averaged out.</p></>}>
                    <div className="h-56">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={dayList.map((date) => d.daily_max.find((x: any) => x.date === date) ?? { date, kva: null })} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                                <XAxis dataKey="date" stroke="var(--chart-axis)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(x) => `${weekday(x)} ${x.slice(8)}`} />
                                <YAxis stroke="var(--chart-axis)" fontSize={12} tickLine={false} axisLine={false} width={48} />
                                <Tooltip contentStyle={tip} formatter={(v: any) => [`${num(v, 1)} kVA`, "Highest 30 minutes"]} labelFormatter={(x) => `${weekday(String(x))} ${x}`} />
                                {mdi && <ReferenceLine y={mdi} stroke={WARN} strokeDasharray="5 4" ifOverflow="extendDomain" label={{ value: `Contracted ${num(mdi)} kVA`, position: "insideTopRight", fill: WARN, fontSize: 12 }} />}
                                <Bar dataKey="kva" radius={[4, 4, 0, 0]}>
                                    {dayList.map((date) => { const x = d.daily_max.find((y: any) => y.date === date); return <Cell key={date} fill={x?.kva === d.max_kva ? ACCENT : mdi && (x?.kva ?? 0) > mdi ? WARN : CONTEXT} />; })}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    {d.top_intervals.length > 0 && (
                        <ol className="mt-5 divide-y divide-line rounded-xl ring-1 ring-line">
                            {d.top_intervals.map((x: any, i: number) => {
                                const t = new Date(x.bucket).getTime();
                                return (
                                    <li key={x.bucket} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[15px]">
                                        <span className="w-6 text-faint tabular-nums">{i + 1}</span>
                                        <span className="w-44 text-ink-2 tabular-nums">{weekday(sastDate(x.bucket))} {fmtDateTime(x.bucket)}</span>
                                        <span className="font-semibold text-ink tabular-nums">{num(x.kva, 0)} kVA</span>
                                        {mdi && <span className="text-sm text-muted tabular-nums">{Math.round((x.kva / mdi) * 100)} %</span>}
                                        <a className="ml-auto py-1 text-sm text-accent hover:underline" href={siteHref(project.id, "investigate", { from: new Date(t - 3 * H).toISOString(), to: new Date(t + 3 * H).toISOString() })}>See what happened →</a>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </InsightCard>
            )}

            {d?.duration_curve?.length > 1 && (
                <InsightCard eyebrow="How the load is spread"
                    headline={<>Half of the time the site draws less than <b>{num(half, 0)} kVA</b>; the peak is {half ? `${num(d.max_kva / half, 1)} times` : "well above"} that.</>}
                    takeaway={d.max_kva && half && d.max_kva / half > 1.6 ? "A tall, narrow peak like this usually comes from a few coinciding operations, which is often the cheapest place to save demand charges." : "The load is fairly even, so the peak is part of normal operation rather than a short coincidence."}
                    method={<p>Load-duration curve: every measured 30-minute interval, sorted from highest to lowest. The horizontal axis is the share of the measured time.</p>}>
                    <div className="h-56">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={d.duration_curve} margin={{ top: 18, right: 24, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                                <XAxis dataKey="pct" type="number" domain={[0, 100]} stroke="var(--chart-axis)" fontSize={12} tickLine={false} axisLine={false} unit=" %" ticks={[0, 25, 50, 75, 100]} />
                                <YAxis stroke="var(--chart-axis)" fontSize={12} tickLine={false} axisLine={false} width={48} />
                                <Tooltip contentStyle={tip} formatter={(v: any) => [`${num(v, 0)} kVA`, "Demand"]} labelFormatter={(x) => `exceeded ${x} % of the time`} />
                                {mdi && <ReferenceLine y={mdi} stroke={WARN} strokeDasharray="5 4" label={{ value: "Contracted limit", position: "insideTopRight", fill: WARN, fontSize: 12 }} />}
                                <Area dataKey="kva" stroke={ACCENT} strokeWidth={2} fill={ACCENT} fillOpacity={0.12} isAnimationActive={false} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </InsightCard>
            )}

            {full.length + partial > 0 && (
                <InsightCard eyebrow="Daily energy"
                    headline={weekdayAvg != null && weekendAvg != null
                        ? <>A weekday uses about <b>{num(weekdayAvg, 0)} kWh</b>, a weekend day about <b>{num(weekendAvg, 0)} kWh</b>.</>
                        : weekdayAvg != null ? <>A complete weekday uses about <b>{num(weekdayAvg, 0)} kWh</b>; no complete weekend day has been measured yet.</>
                        : weekendAvg != null ? <>A complete weekend day uses about <b>{num(weekendAvg, 0)} kWh</b>; no complete weekday has been measured yet.</>
                        : <>No complete day has been measured yet; partial days are shown lighter.</>}
                    takeaway={weekdayAvg && weekendAvg ? (weekendAvg / weekdayAvg > 0.7 ? "Weekends use almost as much as weekdays: worth checking what keeps running when the site is quiet." : "Weekends drop well below weekdays, as expected for a site that closes or slows down.") : undefined}
                    method={<p>Daily energy from hourly average power (SAST days). Averages use complete days only (at least 20 hours of data); partial days are shown lighter. The assessment total comes from the meter's kWh register.</p>}>
                    <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                                <XAxis dataKey="date" stroke="var(--chart-axis)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(x) => `${weekday(x)} ${x.slice(8)}`} />
                                <YAxis stroke="var(--chart-axis)" fontSize={12} tickLine={false} axisLine={false} width={56} />
                                <Tooltip contentStyle={tip} formatter={(v: any) => [`${num(v, 0)} kWh`, "Energy"]} labelFormatter={(x) => `${weekday(String(x))} ${x}`} />
                                <Bar dataKey="kwh_estimate" radius={[4, 4, 0, 0]}>
                                    {daily.map((x) => <Cell key={x.date} fill={isWeekend(x.date) ? CONTEXT : ACCENT} fillOpacity={x.hours >= 20 ? 1 : 0.35} />)}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <p className="mt-2 text-xs text-faint"><span className="inline-block h-2 w-3 rounded-sm mr-1 align-middle" style={{ background: ACCENT }} />weekday <span className="inline-block h-2 w-3 rounded-sm ml-3 mr-1 align-middle" style={{ background: CONTEXT }} />weekend <span className="inline-block h-2 w-3 rounded-sm ml-3 mr-1 align-middle opacity-35" style={{ background: ACCENT }} />partial day (left out of the averages){partial ? ` · ${partial} partial` : ""}</p>
                </InsightCard>
            )}

            <CalendarHeat s={s} />

            {project.points.filter((p) => p.metered).length > 1 && (
                <details className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
                    <summary className="cursor-pointer text-[15px] font-semibold text-ink">Energy balance across the meters</summary>
                    <div className="mt-4"><BalanceTab project={project} since={since} /></div>
                </details>
            )}
        </div>
    );
}

/** Date × hour heatmap of average kW: the site's rhythm in one picture. */
function CalendarHeat({ s }: { s: Summary }) {
    const hs = s.point_detail?.hourly_series;
    const grid = useMemo(() => {
        const m = new Map<string, (number | null)[]>();
        (hs?.t ?? []).forEach((t: string, i: number) => {
            const local = new Date(new Date(t).getTime() + SAST);
            const day = local.toISOString().slice(0, 10);
            if (!m.has(day)) m.set(day, Array(24).fill(null));
            m.get(day)![local.getUTCHours()] = hs.kw[i];
        });
        return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [hs]);
    if (grid.length < 2) return null;
    const max = Math.max(1, ...grid.flatMap(([, v]) => v.filter((x): x is number => x !== null)));
    const oh = s.fingerprint?.operating_hours;
    const ratio = s.point_detail?.patterns?.baseload_ratio;
    return (
        <InsightCard eyebrow="Your site's rhythm"
            headline={ratio != null ? <>Outside working hours the load falls to <b>{Math.round(ratio * 100)} %</b> of the working-hours level.</> : "When the site uses power, hour by hour."}
            takeaway={ratio != null && ratio > 0.6 ? "Darker evenings and weekends mean equipment keeps running: worth a walk-round after hours." : "Each row is a day; darker means more power. Shifts, weekends and quiet periods stand out at a glance."}
            method={<p>Hourly average active power, SAST{oh ? `; working hours ${oh.declared ? "as declared" : "assumed"} ${oh.from}:00–${oh.to}:00 weekdays` : ""}. Grey cells are hours without data.</p>}>
            <div className="overflow-x-auto">
                <table className="border-separate border-spacing-[2px] text-[11px]" aria-label="Average kW by date and hour">
                    <thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="w-6 font-normal text-faint">{h % 3 === 0 ? h : ""}</th>)}</tr></thead>
                    <tbody>
                        {grid.map(([day, v]) => (
                            <tr key={day}>
                                <td className="pr-2 whitespace-nowrap text-faint">{weekday(day)} {day.slice(8)}</td>
                                {v.map((x, h) => (
                                    <td key={h} title={x == null ? `${day} ${h}:00 – no data` : `${day} ${h}:00 – ${num(x, 1)} kW`}
                                        className="h-5 w-6 rounded-[3px]"
                                        style={{ background: x == null ? "rgb(var(--c-surface-2))" : `rgba(37,99,235,${0.08 + 0.92 * (x / max)})` }} />
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </InsightCard>
    );
}

function avg(v: (number | null | undefined)[]) {
    const x = v.filter((n): n is number => n != null && Number.isFinite(n));
    return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
}
const sastDate = (iso: string) => new Date(new Date(iso).getTime() + SAST).toISOString().slice(0, 10);
const actual = (d: any) => (d?.from && d?.to ? `${fmtDateTime(d.from)} – ${fmtDateTime(d.to)} ${TZ_LABEL}` : "");
