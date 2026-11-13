"use client";

// Metering report for one point and period (GET /points/:id/metering-report):
// energy and its TOU split, maximum demand, the average day, best and worst
// values with timestamps, the points to look at for a feasibility study and
// rough peak-shaving / arbitrage / solar sizing. Every section states its basis.
// Printable (Print / PDF): controls are data-noprint, colours go dark-on-white.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import {
    ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, Legend, ReferenceLine,
} from "recharts";
import { apiGet, fmtDateTime, fmtDate, TZ_LABEL } from "@/lib/api";
import { num, zar } from "@/lib/format";
import { PageHeader, Panel, Loading, ErrorBox, Empty, Button, Stat, Table, Badge, inputClass } from "@/components/ops/ui";

type Ex = { value: number | null; at: string | null; phase?: string };
type Pair = { worst: Ex; best: Ex };
interface Report {
    point: { id: string; name: string; role: string; project_id: string; project_name: string; tariff_type: string | null };
    period: { from: string; to: string; time_zone: string };
    energy: { import_kwh: number | null; export_kwh: number | null; coverage: number | null; basis: string } | null;
    tou: { period: "peak" | "standard" | "offpeak"; kwh: number | null; share: number | null; rate_zar_kwh: number | null; cost_zar: number | null }[];
    demand: {
        max_demand_kva: number | null; max_demand_at: string | null; max_kw: number | null; max_kw_at: string | null;
        avg_kw: number | null; load_factor: number | null; baseload_kw: number | null; p95_kw: number | null;
        intervals_within_10pct_of_max: number; contracted_mdi_kva: number | null; avg_power_factor: number | null; basis: string;
        weekday_profile: { slot: string; avg_kw: number | null; max_kw: number | null }[];
        weekend_profile: { slot: string; avg_kw: number | null; max_kw: number | null }[];
    };
    extremes: Record<string, Pair>;
    extremes_basis: string;
    feasibility: {
        notes: { level: "info" | "watch" | "act"; text: string }[];
        sizing_available?: boolean;
        handover?: string;
        peak_shaving: { target_kva: number; demand_reduction_kva: number; battery_power_kw: number; battery_energy_kwh: number; days_with_shaving: number; monthly_saving_zar: number | null; indicative_cost_zar: number; simple_payback_years: number | null }[];
        arbitrage: { battery_kwh: number; avg_weekday_peak_kwh: number; displaced_kwh_per_day: number; margin_zar_per_kwh: number; monthly_saving_zar: number; indicative_cost_zar: number; simple_payback_years: number | null } | null;
        solar: { lowest_midday_load_kw: number | null; no_export_kwp: number | null; options: { kwp: number; self_consumption: number | null; share_of_load: number | null; monthly_generation_kwh: number; monthly_self_used_kwh: number; monthly_saving_zar: number; indicative_cost_zar: number; simple_payback_years: number | null }[] } | null;
        assumptions: Record<string, number | number[]>;
        disclaimer: string;
    };
}

const TOU_COLOUR = { peak: "#f87171", standard: "#fbbf24", offpeak: "#34d399" } as const;
const TOU_LABEL = { peak: "Peak", standard: "Standard", offpeak: "Off-peak" } as const;
// NRS 048-2 and utility limits (CLAUDE.md): what makes a worst value red.
const EXTREME_ROWS: { key: string; label: string; unit: string; limit?: (v: number) => boolean; limitText?: string; dp?: number }[] = [
    { key: "voltage_low", label: "Lowest voltage", unit: "V", limit: (v) => v < 207, limitText: "≥ 207 V", dp: 1 },
    { key: "voltage_high", label: "Highest voltage", unit: "V", limit: (v) => v > 253, limitText: "≤ 253 V", dp: 1 },
    { key: "current_max", label: "Highest current", unit: "A", dp: 0 },
    { key: "power_factor_loaded", label: "Power factor (loaded)", unit: "", limit: (v) => v < 0.85, limitText: "≥ 0.85", dp: 3 },
    { key: "thd_voltage", label: "Voltage THD (10-min)", unit: "%", limit: (v) => v > 8, limitText: "≤ 8 %", dp: 2 },
    { key: "thd_current", label: "Current THD (10-min)", unit: "%", dp: 1 },
    { key: "frequency_low", label: "Lowest frequency", unit: "Hz", limit: (v) => v < 49, limitText: "≥ 49 Hz", dp: 2 },
    { key: "frequency_high", label: "Highest frequency", unit: "Hz", limit: (v) => v > 51, limitText: "≤ 51 Hz", dp: 2 },
    { key: "voltage_unbalance", label: "Voltage unbalance", unit: "%", limit: (v) => v > 2, limitText: "≤ 2 %", dp: 2 },
    { key: "current_unbalance", label: "Current unbalance", unit: "%", dp: 1 },
];

/** SAST calendar date (YYYY-MM-DD) of an instant. */
const sastDay = (d: Date) => new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => sastDay(new Date(new Date(`${day}T12:00:00+02:00`).getTime() + n * 86_400_000));

function presets() {
    const today = sastDay(new Date());
    const [y, m] = today.split("-").map(Number);
    const firstThis = `${y}-${String(m).padStart(2, "0")}-01`;
    const firstLast = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
    return [
        { key: "7", label: "Last 7 days", from: addDays(today, -6), to: today },
        { key: "30", label: "Last 30 days", from: addDays(today, -29), to: today },
        { key: "month", label: "This month", from: firstThis, to: today },
        { key: "lastmonth", label: "Last month", from: firstLast, to: addDays(firstThis, -1) },
        { key: "90", label: "Last 90 days", from: addDays(today, -89), to: today },
    ];
}

const fmtEx = (e: Ex, dp = 1, unit = "") => (e.value === null ? "–" : `${num(e.value, dp)}${unit ? ` ${unit}` : ""}${e.phase ? ` (L${e.phase === "A" ? 1 : e.phase === "B" ? 2 : 3})` : ""}`);

export default function MeteringReportPage() {
    const { id, pointId } = useParams<{ id: string; pointId: string }>();
    const ps = useMemo(presets, []);
    const [range, setRange] = useState({ from: ps[1].from, to: ps[1].to });
    const fromIso = `${range.from}T00:00:00+02:00`;
    const toIso = `${addDays(range.to, 1)}T00:00:00+02:00`;
    const q = useQuery({
        queryKey: ["metering-report", pointId, range.from, range.to],
        queryFn: () => apiGet<Report>(`/ingestion/points/${pointId}/metering-report?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
    });

    // Print: dark-on-white, controls and the portal chrome hidden.
    useEffect(() => {
        const el = document.createElement("style");
        el.textContent = `
            @media print {
                [data-noprint="true"], aside, nav, header button { display: none !important; }
                body, main { background: #fff !important; }
                .mr-report, .mr-report * { color: #0f172a !important; background: transparent !important; border-color: #cbd5e1 !important; box-shadow: none !important; }
                .mr-break { break-inside: avoid; page-break-inside: avoid; }
                @page { margin: 12mm; size: A4 portrait; }
            }`;
        document.head.appendChild(el);
        return () => { el.remove(); };
    }, []);

    const r = q.data;
    const totalCost = r ? r.tou.reduce((a, t) => a + (t.cost_zar ?? 0), 0) : 0;
    const anyRates = r ? r.tou.some((t) => t.rate_zar_kwh !== null) : false;
    const profile = r ? r.demand.weekday_profile.map((w, i) => ({
        slot: w.slot, weekday: w.avg_kw, weekend: r.demand.weekend_profile[i]?.avg_kw ?? null, weekday_max: w.max_kw,
    })) : [];
    const days = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000);
    const mdi = r?.demand.contracted_mdi_kva ?? null;

    return (
        <div className="space-y-5 mr-report">
            <Link data-noprint="true" href={`/portal/projects/${id}/points/${pointId}`} className="inline-flex items-center text-sm text-slate-500 hover:text-slate-900">
                <ArrowLeft className="h-4 w-4 mr-1" />Meter readings
            </Link>
            <PageHeader title={r ? `Metering report · ${r.point.name}` : "Metering report"}
                subtitle={r ? `${r.point.project_name} · ${fmtDate(fromIso)} – ${fmtDate(new Date(new Date(toIso).getTime() - 1))} (${days} days, ${TZ_LABEL})${r.point.tariff_type ? ` · tariff ${r.point.tariff_type}` : ""}` : undefined}
                actions={<span data-noprint="true"><Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4 mr-1 inline" />Print / PDF</Button></span>} />

            <div data-noprint="true" className="flex flex-wrap items-end gap-2">
                {ps.map((p) => (
                    <button key={p.key} onClick={() => setRange({ from: p.from, to: p.to })}
                        className={`rounded-lg px-3 py-1.5 text-sm border ${range.from === p.from && range.to === p.to ? "border-blue-500 bg-blue-500/10 text-white" : "border-slate-700 text-slate-300 hover:border-slate-500"}`}>
                        {p.label}
                    </button>
                ))}
                <label className="text-xs text-slate-500 ml-2">From <input type="date" className={`${inputClass} w-40`} value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((x) => ({ ...x, from: e.target.value }))} /></label>
                <label className="text-xs text-slate-500">To <input type="date" className={`${inputClass} w-40`} value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((x) => ({ ...x, to: e.target.value }))} /></label>
                <span className="text-xs text-slate-500">Whole SAST days, at most 93.</span>
            </div>

            {q.isLoading ? <Loading label="Building the report" /> : q.error ? <ErrorBox error={q.error} /> : !r ? null : (
                <>
                    {/* Summary */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mr-break">
                        <Stat label="Energy imported" value={r.energy?.import_kwh == null ? "–" : `${num(r.energy.import_kwh)} kWh`}
                            hint={r.energy ? `${Math.round((r.energy.coverage ?? 0) * 100)} % of the period metered` : "no register data"} />
                        <Stat label="Maximum demand" value={r.demand.max_demand_kva == null ? "–" : `${num(r.demand.max_demand_kva)} kVA`}
                            tone={mdi && r.demand.max_demand_kva ? (r.demand.max_demand_kva > mdi ? "red" : r.demand.max_demand_kva > 0.9 * mdi ? "amber" : "green") : undefined}
                            hint={r.demand.max_demand_at ? `${fmtDateTime(r.demand.max_demand_at)}${mdi ? ` · MDI ${num(mdi)} kVA` : ""}` : "30-min billed demand"} />
                        <Stat label="Peak power" value={r.demand.max_kw == null ? "–" : `${num(r.demand.max_kw)} kW`}
                            hint={r.demand.max_kw_at ? `${fmtDateTime(r.demand.max_kw_at)} (30-min avg)` : undefined} />
                        <Stat label="Estimated energy cost" value={anyRates ? zar(totalCost) : "–"} hint={anyRates ? "TOU energy charges only" : "no tariff set for this project"} />
                        <Stat label="Average load" value={r.demand.avg_kw == null ? "–" : `${num(r.demand.avg_kw)} kW`} hint={r.demand.baseload_kw == null ? undefined : `baseload ${num(r.demand.baseload_kw)} kW (5th pct)`} />
                        <Stat label="Load factor" value={r.demand.load_factor ?? "–"} hint="average ÷ maximum kW" />
                        <Stat label="Average power factor" value={r.demand.avg_power_factor == null ? "–" : num(r.demand.avg_power_factor, 2)}
                            tone={r.demand.avg_power_factor == null ? undefined : r.demand.avg_power_factor < 0.85 ? "red" : r.demand.avg_power_factor < 0.9 ? "amber" : "green"} hint="30-min values while loaded" />
                        <Stat label="Energy exported" value={r.energy?.export_kwh == null ? "–" : `${num(r.energy.export_kwh)} kWh`} hint="registers" />
                    </div>

                    {/* TOU */}
                    <Panel title="Energy by time-of-use period" subtitle={`From 30-minute average power. Weekdays use the project's TOU windows; Saturday standard 07–12 and 18–20; Sunday off-peak. Totals above are from the energy registers (${r.energy?.basis ?? "n/a"}).`} className="mr-break">
                        <div className="grid md:grid-cols-2 gap-4 items-center">
                            <div className="h-48">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={r.tou.map((t) => ({ name: TOU_LABEL[t.period], kwh: t.kwh ?? 0, period: t.period }))} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                                        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                                        <XAxis dataKey="name" stroke="#64748b" fontSize={12} />
                                        <YAxis stroke="#64748b" fontSize={11} unit=" kWh" width={80} />
                                        <Tooltip formatter={(v: any) => [`${num(v)} kWh`, "Energy"]} contentStyle={{ background: "#0f172a", border: "1px solid #334155" }} />
                                        <Bar dataKey="kwh">{r.tou.map((t) => <Cell key={t.period} fill={TOU_COLOUR[t.period]} />)}</Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                            <Table head={["Period", "kWh", "Share", "Rate", "Cost"]}>
                                {r.tou.map((t) => (
                                    <tr key={t.period}>
                                        <td className="py-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm mr-2" style={{ background: TOU_COLOUR[t.period] }} />{TOU_LABEL[t.period]}</td>
                                        <td className="tabular-nums">{num(t.kwh)}</td>
                                        <td className="tabular-nums">{t.share == null ? "–" : `${Math.round(t.share * 100)} %`}</td>
                                        <td className="tabular-nums">{t.rate_zar_kwh == null ? "–" : `R ${num(t.rate_zar_kwh, 2)}`}</td>
                                        <td className="tabular-nums">{t.cost_zar == null ? "–" : zar(t.cost_zar)}</td>
                                    </tr>
                                ))}
                            </Table>
                        </div>
                    </Panel>

                    {/* Average day */}
                    <Panel title="The average day" subtitle={`Mean kW per half-hour (${TZ_LABEL}), weekdays and weekends, with the highest weekday half-hour. ${r.demand.basis}.`} className="mr-break">
                        {profile.every((x) => x.weekday === null && x.weekend === null) ? <Empty>No readings in this period.</Empty> : (
                            <div className="h-64">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={profile} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                                        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                                        <XAxis dataKey="slot" stroke="#64748b" fontSize={11} interval={5} />
                                        <YAxis stroke="#64748b" fontSize={11} unit=" kW" width={70} />
                                        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155" }} formatter={(v: any, n: any) => [v == null ? "–" : `${num(v, 1)} kW`, n]} />
                                        <Legend wrapperStyle={{ fontSize: 12 }} />
                                        <Line dataKey="weekday" name="Weekday average" stroke="#60a5fa" dot={false} strokeWidth={2} connectNulls />
                                        <Line dataKey="weekend" name="Weekend average" stroke="#a78bfa" dot={false} strokeWidth={2} connectNulls />
                                        <Line dataKey="weekday_max" name="Weekday highest" stroke="#f87171" dot={false} strokeWidth={1} strokeDasharray="4 3" connectNulls />
                                        {r.demand.baseload_kw != null && <ReferenceLine y={r.demand.baseload_kw} stroke="#64748b" strokeDasharray="2 4" label={{ value: "baseload", fill: "#64748b", fontSize: 11, position: "insideBottomLeft" }} />}
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </Panel>

                    {/* Extremes */}
                    <Panel title="Best and worst values" subtitle={`${r.extremes_basis}. Times ${TZ_LABEL}. Red: outside the NRS 048-2 / utility limit.`} className="mr-break">
                        <Table head={["Measure", "Worst", "When", "Best", "When", "Limit"]}>
                            {EXTREME_ROWS.map((row) => {
                                const e = r.extremes[row.key];
                                if (!e) return null;
                                const bad = e.worst.value !== null && row.limit?.(e.worst.value);
                                return (
                                    <tr key={row.key}>
                                        <td className="py-1.5 text-slate-300">{row.label}</td>
                                        <td className={`tabular-nums ${bad ? "text-red-400 font-semibold" : "text-white"}`}>{fmtEx(e.worst, row.dp, row.unit)}</td>
                                        <td className="text-xs text-slate-400">{e.worst.at ? fmtDateTime(e.worst.at) : "–"}</td>
                                        <td className="tabular-nums text-slate-300">{fmtEx(e.best, row.dp, row.unit)}</td>
                                        <td className="text-xs text-slate-400">{e.best.at ? fmtDateTime(e.best.at) : "–"}</td>
                                        <td className="text-xs text-slate-500">{row.limitText ?? ""}</td>
                                    </tr>
                                );
                            })}
                        </Table>
                    </Panel>

                    {/* Feasibility */}
                    <Panel title="Points to look at for a feasibility study" className="mr-break">
                        {r.feasibility.notes.length === 0 ? <Empty>Nothing stands out in this period.</Empty> : (
                            <ul className="space-y-2">
                                {r.feasibility.notes.map((n, i) => (
                                    <li key={i} className="flex items-start gap-2 text-sm">
                                        <Badge tone={n.level === "act" ? "red" : n.level === "watch" ? "amber" : "grey"}>{n.level === "act" ? "Act" : n.level === "watch" ? "Watch" : "Note"}</Badge>
                                        <span className="text-slate-300">{n.text}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Panel>

                    {r.feasibility.sizing_available && r.feasibility.peak_shaving && r.feasibility.assumptions ? (<>
                    <Panel title="Peak shaving with a battery" subtitle="Cap the 30-minute billed demand at a target. Battery sized from the largest daily energy above the target in this period (usable kWh ÷ depth of discharge). Saving = demand reduction × the project's demand charge." className="mr-break">
                        {r.feasibility.peak_shaving.length === 0 ? <Empty>No billed demand in this period.</Empty> : (
                            <div className="overflow-x-auto [&_td]:whitespace-nowrap"><Table head={["Cap demand at", "Reduction", "Battery power", "Battery energy", "Days it worked", "Saving / month", "Indicative cost", "Payback"]}>
                                {r.feasibility.peak_shaving.map((s) => (
                                    <tr key={s.target_kva}>
                                        <td className="py-1.5 tabular-nums">{num(s.target_kva)} kVA</td>
                                        <td className="tabular-nums">{num(s.demand_reduction_kva)} kVA</td>
                                        <td className="tabular-nums">{num(s.battery_power_kw)} kW</td>
                                        <td className="tabular-nums">{num(s.battery_energy_kwh)} kWh</td>
                                        <td className="tabular-nums">{s.days_with_shaving}</td>
                                        <td className="tabular-nums text-emerald-300">{s.monthly_saving_zar == null ? "no demand tariff" : zar(s.monthly_saving_zar)}</td>
                                        <td className="tabular-nums">{zar(s.indicative_cost_zar)}</td>
                                        <td className="tabular-nums">{s.simple_payback_years == null ? "–" : `${num(s.simple_payback_years, 1)} yr`}</td>
                                    </tr>
                                ))}
                            </Table></div>
                        )}
                    </Panel>

                    <div className="grid md:grid-cols-2 gap-4">
                        <Panel title="TOU arbitrage" subtitle="Charge off-peak, discharge into this point's own weekday peak-window load (no export). Uses the middle peak-shaving battery." className="mr-break">
                            {!r.feasibility.arbitrage ? <Empty>Needs peak and off-peak tariffs on the project.</Empty> : (() => {
                                const a = r.feasibility.arbitrage!;
                                return (
                                    <dl className="grid grid-cols-2 gap-y-2 text-sm">
                                        <dt className="text-slate-500">Battery</dt><dd className="text-white tabular-nums">{num(a.battery_kwh)} kWh</dd>
                                        <dt className="text-slate-500">Weekday peak-window load</dt><dd className="text-white tabular-nums">{num(a.avg_weekday_peak_kwh)} kWh/day</dd>
                                        <dt className="text-slate-500">Shifted per weekday</dt><dd className="text-white tabular-nums">{num(a.displaced_kwh_per_day)} kWh</dd>
                                        <dt className="text-slate-500">Margin</dt><dd className="text-white tabular-nums">R {num(a.margin_zar_per_kwh, 2)}/kWh</dd>
                                        <dt className="text-slate-500">Saving</dt><dd className="text-emerald-300 tabular-nums">{zar(a.monthly_saving_zar)}/month</dd>
                                        <dt className="text-slate-500">Payback (arbitrage alone)</dt><dd className="text-white tabular-nums">{a.simple_payback_years == null ? "–" : `${num(a.simple_payback_years, 1)} yr`}</dd>
                                    </dl>
                                );
                            })()}
                            <p className="text-xs text-slate-500 mt-3">The same battery can do peak shaving and arbitrage; the savings overlap only partly.</p>
                        </Panel>

                        <Panel title="Solar for own consumption" subtitle={`Simulated against this period's measured load. Starts at the no-export size: PV at noon never exceeds the lowest midday load${r.feasibility.solar?.lowest_midday_load_kw != null ? ` (${num(r.feasibility.solar.lowest_midday_load_kw)} kW)` : ""}.`} className="mr-break">
                            {!r.feasibility.solar || r.feasibility.solar.options.length === 0 ? <Empty>Not enough daytime load to size PV.</Empty> : (
                                <div className="overflow-x-auto [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap"><Table head={["Size", "Self-used", "Of the load", "Saving / month", "Cost", "Payback"]}>
                                    {r.feasibility.solar.options.map((o) => (
                                        <tr key={o.kwp}>
                                            <td className="py-1.5 tabular-nums">{num(o.kwp)} kWp</td>
                                            <td className="tabular-nums">{o.self_consumption == null ? "–" : `${Math.round(o.self_consumption * 100)} %`}</td>
                                            <td className="tabular-nums">{o.share_of_load == null ? "–" : `${Math.round(o.share_of_load * 100)} %`}</td>
                                            <td className="tabular-nums text-emerald-300">{zar(o.monthly_saving_zar)}</td>
                                            <td className="tabular-nums">{zar(o.indicative_cost_zar)}</td>
                                            <td className="tabular-nums">{o.simple_payback_years == null ? "–" : `${num(o.simple_payback_years, 1)} yr`}</td>
                                        </tr>
                                    ))}
                                </Table></div>
                            )}
                        </Panel>
                    </div>

                    <Panel title="Assumptions" className="mr-break">
                        <p className="text-sm text-amber-200/90">{r.feasibility.disclaimer}</p>
                        <ul className="grid md:grid-cols-2 gap-x-6 gap-y-1 mt-3 text-xs text-slate-400">
                            <li>Battery: R {num(r.feasibility.assumptions.bess_cost_zar_per_kwh as number)}/kWh installed, {Math.round((r.feasibility.assumptions.bess_round_trip as number) * 100)} % round trip, {Math.round((r.feasibility.assumptions.bess_depth_of_discharge as number) * 100)} % depth of discharge</li>
                            <li>PV: R {num(r.feasibility.assumptions.pv_cost_zar_per_kwp as number)}/kWp installed, {num(r.feasibility.assumptions.pv_yield_kwh_per_kwp_day as number, 1)} kWh/kWp/day, bell-shaped output {(r.feasibility.assumptions.pv_hours as number[]).join("–")} h {TZ_LABEL}, no weather</li>
                            <li>Tariffs from the project settings; energy charges and demand charge only (no network, service or reactive charges)</li>
                            <li>{r.feasibility.assumptions.weekdays_per_month as number} weekdays and {num(r.feasibility.assumptions.days_per_month as number, 1)} days per month; public holidays not modelled</li>
                        </ul>
                    </Panel>
                    </>) : (
                        <Panel title="Feasibility handover" className="mr-break">
                            <p className="text-sm text-slate-300">{r.feasibility.handover ?? "GridIQ supplies the measured data for an independent feasibility study."}</p>
                            <p className="text-xs text-slate-500 mt-2">Use the Exports tab (or the API) for the interval load profile, demand and power-quality data of this assessment.</p>
                        </Panel>
                    )}
                </>
            )}
        </div>
    );
}
