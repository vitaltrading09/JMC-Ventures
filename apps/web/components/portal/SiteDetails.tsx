"use client";

// Site details (client-experience plan, step 6): trust in the measurement.
// The installation (which meter, where, since when), a calendar of how complete
// each day's data is, then the metering layout and single-line diagram.

import { Gauge, CalendarCheck } from "lucide-react";
import { fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import type { PortalProjectDetail } from "@/lib/portal";
import type { Summary } from "@/lib/summary";
import type { Group, Window } from "@/components/portal/InvestigateView";
import { LayoutTab } from "@/components/portal/ProjectTabs";

const H = 3_600_000, SAST = 2 * H;
const ROLE: Record<string, string> = { incomer: "Main incomer", sub_load: "Sub-board", pv: "Solar PV", bess: "Battery", generator: "Generator", other: "Other" };

export function SiteDetails({ project, s }: { project: PortalProjectDetail; s: Summary | undefined }) {
    const pd = s?.point_detail;
    const dep = pd?.deployments?.[pd.deployments.length - 1];
    const days = completeness(s);
    return (
        <div className="space-y-8">
            {pd && (
                <section className="grid gap-6 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line md:grid-cols-2">
                    <div>
                        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-faint"><Gauge className="h-4 w-4" aria-hidden />The measurement</p>
                        <h3 className="mt-1 text-lg font-semibold text-ink">{s!.context.point?.name} · {ROLE[pd.role] ?? pd.role}</h3>
                        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[15px]">
                            <div><dt className="text-sm text-faint">Meter</dt><dd className="text-ink-2">{dep?.model ?? "Power-quality meter"}</dd></div>
                            <div><dt className="text-sm text-faint">Measuring since</dt><dd className="text-ink-2 tabular-nums">{dep ? `${fmtDateTime(dep.installed_at)} ${TZ_LABEL}` : "–"}</dd></div>
                            <div><dt className="text-sm text-faint">Nominal voltage</dt><dd className="text-ink-2 tabular-nums">{pd.nominal_voltage_v ? `${num(pd.nominal_voltage_v)} V phase–neutral` : "–"}</dd></div>
                            <div><dt className="text-sm text-faint">Current transformers</dt><dd className="text-ink-2 tabular-nums">{pd.ct_primary_a ? `${num(pd.ct_primary_a)} A primary` : "–"}</dd></div>
                            <div><dt className="text-sm text-faint">Readings</dt><dd className="text-ink-2 tabular-nums">{cadenceText(pd.coverage)}</dd></div>
                            <div><dt className="text-sm text-faint">Contracted demand</dt><dd className="text-ink-2 tabular-nums">{pd.demand?.contracted_mdi_kva ? `${num(pd.demand.contracted_mdi_kva)} kVA` : "not recorded"}</dd></div>
                        </dl>
                    </div>
                    <div>
                        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-faint"><CalendarCheck className="h-4 w-4" aria-hidden />Data received</p>
                        <h3 className="mt-1 text-lg font-semibold text-ink">{s!.context.coverage?.fraction != null ? `${Math.round(s!.context.coverage.fraction * 100)} % of the expected data so far` : "No data yet"}</h3>
                        <ul className="mt-4 grid grid-cols-7 gap-1.5" aria-label="Data completeness per day">
                            {days.map((d) => (
                                <li key={d.day} title={`${d.day}: ${d.hours} of 24 hours with data`}
                                    className="flex aspect-square flex-col items-center justify-center rounded-lg text-[11px]"
                                    style={{ background: d.hours >= 23 ? "rgba(16,185,129,.25)" : d.hours > 0 ? `rgba(245,158,11,${0.12 + 0.3 * (d.hours / 24)})` : "rgb(var(--c-surface-2))" }}>
                                    <span className="text-ink-2 font-medium">{d.day.slice(8)}</span>
                                    <span className="text-faint">{d.hours}h</span>
                                </li>
                            ))}
                        </ul>
                        <p className="mt-3 text-xs text-faint">Green: a full day received. Amber: part of the day. Grey: nothing received (meter offline or not yet installed).</p>
                    </div>
                </section>
            )}
            <LayoutTab project={project} />
        </div>
    );
}

const BAND: Record<number, string> = { 1: "every second", 10: "every few seconds", 60: "every minute", 300: "every 5 minutes", 900: "every 15 minutes" };
/** How often the meter reports; mixed intervals are both named. */
function cadenceText(cov: any) {
    const c = (cov?.cadences ?? []).filter((x: any) => (x.share ?? 0) >= 0.05);
    if (c.length > 1) return `${BAND[c[0].approx_interval_s] ?? "varies"}, at times ${BAND[c[1].approx_interval_s] ?? "other"}`;
    if (c.length === 1) return BAND[c[0].approx_interval_s] ?? `every ${c[0].approx_interval_s} s`;
    return cov?.median_spacing_s != null ? `every ${Math.round(cov.median_spacing_s)} s` : "–";
}

/** Hours with data per SAST day of the assessment so far. */
export function completeness(s: Summary | undefined) {
    if (!s) return [];
    const have = new Map<string, number>();
    for (const t of s.point_detail?.hourly_series?.t ?? []) {
        const d = new Date(new Date(t).getTime() + SAST).toISOString().slice(0, 10);
        have.set(d, (have.get(d) ?? 0) + 1);
    }
    const out: { day: string; hours: number }[] = [];
    const start = new Date(new Date(s.context.period_from).getTime() + SAST), end = new Date(new Date(s.context.period_to).getTime() + SAST);
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d <= end; d = new Date(d.getTime() + 24 * H)) {
        const k = d.toISOString().slice(0, 10);
        out.push({ day: k, hours: Math.min(24, have.get(k) ?? 0) });
    }
    return out;
}

/** Notable moments to start an investigation from, found in the assessment data. */
export function startingPoints(s: Summary | undefined): { label: string; detail: string; window: Window; groups: Group[] }[] {
    const pd = s?.point_detail, hs = pd?.hourly_series;
    if (!pd || !hs?.t?.length) return [];
    const out: { label: string; detail: string; window: Window; groups: Group[] }[] = [];
    const around = (iso: string, h: number): Window => ({ from: new Date(new Date(iso).getTime() - h * H).toISOString(), to: new Date(new Date(iso).getTime() + h * H).toISOString() });
    const local = (iso: string) => fmtDateTime(iso);
    if (pd.demand?.max_kva_at) out.push({ label: "Highest peak", detail: `${num(pd.demand.max_kva, 0)} kVA · ${local(pd.demand.max_kva_at)}`, window: around(pd.demand.max_kva_at, 3), groups: ["power", "current", "pf"] });
    const best = (vals: (number | null)[], pick: (a: number, b: number) => boolean) => {
        let i = -1;
        vals.forEach((v, j) => { if (v != null && (i < 0 || pick(v, vals[i] as number))) i = j; });
        return i;
    };
    const thd = hs.t.map((_: string, i: number) => Math.max(hs.thd_v_a?.[i] ?? -1, hs.thd_v_b?.[i] ?? -1, hs.thd_v_c?.[i] ?? -1)).map((v: number) => (v < 0 ? null : v));
    const ti = best(thd, (a, b) => a > b);
    if (ti >= 0) out.push({ label: "Worst distortion hour", detail: `${num(thd[ti], 1)} % THD-V · ${local(hs.t[ti])}`, window: around(hs.t[ti], 6), groups: ["thd", "power", "voltage"] });
    const vmin = hs.t.map((_: string, i: number) => { const v = [hs.v_a?.[i], hs.v_b?.[i], hs.v_c?.[i]].filter((x: any) => x != null && x > 23); return v.length ? Math.min(...v) : null; });
    const vi = best(vmin, (a, b) => a < b);
    if (vi >= 0) out.push({ label: "Lowest voltage", detail: `${num(vmin[vi], 0)} V (hour average) · ${local(hs.t[vi])}`, window: around(hs.t[vi], 6), groups: ["voltage", "power"] });
    const night = hs.t.map((t: string, i: number) => { const h = new Date(new Date(t).getTime() + SAST).getUTCHours(); return h < 5 ? hs.kw[i] : null; });
    const ni = best(night, (a, b) => a > b);
    if (ni >= 0) out.push({ label: "Biggest night load", detail: `${num(night[ni], 0)} kW · ${local(hs.t[ni])}`, window: around(hs.t[ni], 4), groups: ["power", "current"] });
    return out;
}
