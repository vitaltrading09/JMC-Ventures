"use client";

// The tabs of a portal project page (Phase 8, approved list): Overview,
// Metering layout, Energy balance, Load profile, Demand, Power quality,
// Findings, Reports. Every figure states its basis and that times are SAST.

import { usePortalAssessments } from "@/components/portal/AssessmentBanner";
import type { Assessment } from "@/lib/assessments";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from "recharts";
import { ChevronRight } from "lucide-react";
import { apiGet, apiSend, apiUrl, fmtAgo, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num, zar } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/ops";
import { PortalProjectDetail, PortalPoint, pointTree, defaultPoint, canEdit, askConsultant, isDraftFinding, findingSource } from "@/lib/portal";
import { BalanceView, Balance } from "@/components/fleet/BalanceView";
import { SldView } from "@/components/sld/SldView";
import { Panel, Loading, ErrorBox, Empty, Badge, Button, Field, inputClass, Table, Stat } from "@/components/ops/ui";

const DAY = 86_400_000;

/** Range options: 0 = the assessment to date (the default), else the last N days inside it. */
function RangeSelect({ value, onChange, options }: { value: number; onChange: (d: number) => void; options: number[] }) {
    return (
        <select aria-label="Observation window" className={`${inputClass} w-44`} value={value} onChange={(e) => onChange(Number(e.target.value))}>
            <option value={0}>Assessment to date</option>
            {options.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
    );
}
/** Whole days to request for "assessment to date" (the server clamps to the window). */
const sinceDays = (since?: string | null) => (since ? Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / DAY)) : 30);
/** The range a response actually covers. */
const actual = (d: any) => (d?.from && d?.to ? `${fmtDateTime(d.from)} – ${fmtDateTime(d.to)} ${TZ_LABEL}` : "");

/** Energy and demand (brief §4): demand, load profile and energy balance, assessment to date by default. */
export function EnergyDemandTab({ project, since, pointId }: { project: PortalProjectDetail; since?: string | null; pointId?: string | null }) {
    return (
        <div className="space-y-6">
            <DemandTab project={project} since={since} pointId={pointId} />
            <LoadProfileTab project={project} since={since} pointId={pointId} />
            <BalanceTab project={project} since={since} />
        </div>
    );
}

/** Pick one metered point for the per-point tabs. */
function PointPicker({ points, value, onChange }: { points: PortalPoint[]; value: string; onChange: (id: string) => void }) {
    const metered = points.filter((p) => p.metered);
    return (
        <select className={`${inputClass} max-w-xs`} value={value} onChange={(e) => onChange(e.target.value)}>
            {metered.map((p) => <option key={p.id} value={p.id}>{p.name} ({ROLE_LABEL[p.role] ?? p.role})</option>)}
        </select>
    );
}

function usePoint(project: PortalProjectDetail) {
    const [id, setId] = useState(() => defaultPoint(project.points)?.id ?? "");
    return [id, setId] as const;
}

// ── Overview ────────────────────────────────────────────────────────────────
export function OverviewTab({ project }: { project: PortalProjectDetail }) {
    const incomer = defaultPoint(project.points);
    const to = useMemo(() => new Date(), []);
    const from = useMemo(() => new Date(to.getTime() - 30 * DAY), [to]);
    const balance = useQuery({
        queryKey: ["balance", project.id, 30],
        queryFn: () => apiGet<Balance>(`/ingestion/projects/${project.id}/energy-balance?from=${from.toISOString()}&to=${to.toISOString()}`),
    });
    const demand = useQuery({
        queryKey: ["demand", incomer?.id, 30], enabled: !!incomer?.metered,
        queryFn: () => apiGet<any>(`/ingestion/points/${incomer!.id}/demand?days=30`),
    });
    const pf = useQuery({
        queryKey: ["pf7", incomer?.id], enabled: !!incomer?.metered,
        queryFn: async () => {
            const rows = await apiGet<any[]>(`/ingestion/points/${incomer!.id}/readings?from=${new Date(Date.now() - 7 * DAY).toISOString()}&to=${new Date().toISOString()}`);
            const v = rows.map((r) => r.power_factor_total).filter((x) => x !== null).map(Number);
            return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
        },
    });
    const b = balance.data;
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Incomer now" value={incomer?.live?.kw != null ? `${num(incomer.live.kw, 1)} kW` : "–"}
                    hint={incomer?.live ? `1-minute average, ${fmtAgo(incomer.live.at)}` : "no reading in the last 15 min"} />
                <Stat label="Consumption, last 30 days" value={b?.site_consumption_kwh != null ? `${num(b.site_consumption_kwh)} kWh` : "–"}
                    hint="from the kWh registers" />
                <Stat label="Peak demand, last 30 days" value={demand.data?.max_kva != null ? `${num(demand.data.max_kva, 1)} kVA` : "–"}
                    hint={demand.data?.max_at ? `30-min billing basis, ${fmtDateTime(demand.data.max_at)}` : "30-minute billing basis"}
                    tone={demand.data?.utilisation_pct > 100 ? "red" : demand.data?.utilisation_pct > 90 ? "amber" : undefined} />
                <Stat label="Power factor, last 7 days" value={pf.data != null ? num(pf.data, 2) : "–"}
                    hint="average at the incomer" tone={pf.data != null && pf.data < 0.85 ? "red" : pf.data != null && pf.data < 0.9 ? "amber" : undefined} />
            </div>
            <Panel title="Measurement points" subtitle="Live 1-minute values">
                <PointList project={project} />
            </Panel>
        </div>
    );
}

function PointList({ project }: { project: PortalProjectDetail }) {
    const rows = pointTree(project.points);
    if (rows.length === 0) return <Empty>No measurement points yet.</Empty>;
    return (
        <ul className="divide-y divide-line">
            {rows.map(({ point: p, depth }) => (
                <li key={p.id}>
                    <Link href={`/portal/projects/${project.id}/points/${p.id}`} className="flex items-center gap-4 py-2.5 hover:bg-surface/60 rounded-lg px-2">
                        <span style={{ paddingLeft: depth * 24 }} className="flex-1 min-w-0">
                            <span className="text-sm text-ink">{depth > 0 && <span className="text-faint mr-1">└</span>}{p.name}</span>
                            <span className="text-xs text-faint ml-2">{ROLE_LABEL[p.role] ?? p.role}</span>
                        </span>
                        {p.metered ? (
                            p.live ? (
                                <span className="text-sm text-ink-3 tabular-nums">
                                    {p.live.kw != null ? `${num(p.live.kw, 1)} kW` : "–"} · PF {p.live.pf != null ? num(p.live.pf, 2) : "–"} · {p.live.v != null ? `${num(p.live.v, 0)} V` : "–"}
                                </span>
                            ) : <Badge tone="amber">no recent reading</Badge>
                        ) : <Badge>not metered</Badge>}
                        <ChevronRight className="h-4 w-4 text-faint" />
                    </Link>
                </li>
            ))}
        </ul>
    );
}

// ── Metering layout ─────────────────────────────────────────────────────────
export function LayoutTab({ project }: { project: PortalProjectDetail }) {
    return (
        <div className="space-y-4">
            <Panel title="Measurement points" subtitle="The incomer at the top, sub-loads and sources under it, with live 1-minute values">
                <PointList project={project} />
            </Panel>
            <Panel title="Single-line diagram">
                <SldView projectId={project.id} />
            </Panel>
        </div>
    );
}

// ── Energy balance ──────────────────────────────────────────────────────────
export function BalanceTab({ project, since }: { project: PortalProjectDetail; since?: string | null }) {
    const [days, setDays] = useState(since ? 0 : 30);
    const range = useMemo(() => { const to = new Date(); return { from: days === 0 && since ? new Date(since) : new Date(to.getTime() - (days || 30) * DAY), to }; }, [days, since]);
    const q = useQuery({
        queryKey: ["balance", project.id, days],
        queryFn: () => apiGet<Balance>(`/ingestion/projects/${project.id}/energy-balance?from=${range.from.toISOString()}&to=${range.to.toISOString()}`),
    });
    return (
        <Panel title="Energy balance"
            subtitle={`${fmtDateTime(range.from)} – ${fmtDateTime(range.to)} ${TZ_LABEL}. From the kWh registers (power-integrated where a meter has none). Consumption = grid import − export + PV + battery discharge − charge.`}
            actions={<RangeSelect value={days} onChange={setDays} options={[1, 7]} />}>
            {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data && <BalanceView b={q.data} />}
        </Panel>
    );
}

// ── Load profile ────────────────────────────────────────────────────────────
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function LoadProfileTab({ project, since, pointId: forced }: { project: PortalProjectDetail; since?: string | null; pointId?: string | null }) {
    const [own, setPointId] = usePoint(project);
    const pointId = forced ?? own;
    const [days, setDays] = useState(since ? 0 : 28);
    const ask = days === 0 ? Math.max(7, sinceDays(since)) : days;
    const q = useQuery({ queryKey: ["load-profile", pointId, ask], enabled: !!pointId, queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/load-profile?days=${ask}`) });
    const max = Math.max(1, ...(q.data?.cells ?? []).map((c: any) => c.kw));
    const cell = (wd: number, h: number) => q.data?.cells.find((c: any) => c.weekday === wd && c.hour === h);
    return (
        <Panel title="Load profile by weekday and hour" subtitle={q.data ? `${actual(q.data)}. ${q.data.basis}.` : undefined}
            actions={<div className="flex gap-2">
                {!forced && <PointPicker points={project.points} value={pointId} onChange={setPointId} />}
                <RangeSelect value={days} onChange={setDays} options={[7]} />
            </div>}>
            {!pointId ? <Empty>No metered point.</Empty> : q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <Stat label="Baseload" value={q.data.baseload_kw != null ? `${num(q.data.baseload_kw, 1)} kW` : "–"} hint="10th percentile of hourly averages" />
                        <Stat label="After-hours load" value={q.data.after_hours_kw != null ? `${num(q.data.after_hours_kw, 1)} kW` : "–"} hint="median, 18:00–06:00 and weekends" />
                    </div>
                    <div className="overflow-x-auto">
                        <table className="text-[11px] border-separate border-spacing-0.5">
                            <thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="text-faint font-normal w-8">{h}</th>)}</tr></thead>
                            <tbody>
                                {WEEKDAYS.map((d, i) => (
                                    <tr key={d}>
                                        <td className="text-muted pr-2">{d}</td>
                                        {Array.from({ length: 24 }, (_, h) => {
                                            const c = cell(i + 1, h);
                                            const a = c ? 0.12 + 0.88 * (c.kw / max) : 0;
                                            return <td key={h} title={c ? `${d} ${h}:00 – ${num(c.kw, 1)} kW (${c.hours} h)` : "no data"}
                                                className="w-8 h-6 rounded" style={{ background: c ? `rgba(59,130,246,${a})` : "rgb(var(--c-surface-2))", outline: c ? undefined : "1px dashed rgb(var(--c-line-strong))", outlineOffset: -1 }} />;
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-faint">Darker blue = higher average kW; dashed grey = no data in that hour. Columns are the hour starting at that time.</p>
                </div>
            )}
        </Panel>
    );
}

// ── Demand ──────────────────────────────────────────────────────────────────
export function DemandTab({ project, since, pointId: forced }: { project: PortalProjectDetail; since?: string | null; pointId?: string | null }) {
    const [own, setPointId] = usePoint(project);
    const pointId = forced ?? own;
    const [days, setDays] = useState(since ? 0 : 30);
    const ask = days === 0 ? sinceDays(since) : days;
    const q = useQuery({ queryKey: ["demand", pointId, ask], enabled: !!pointId, queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/demand?days=${ask}`) });
    const d = q.data;
    return (
        <Panel title="Maximum demand" subtitle={d ? `${actual(d)}. ${d.basis}.` : undefined}
            actions={<div className="flex gap-2">
                {!forced && <PointPicker points={project.points} value={pointId} onChange={setPointId} />}
                <RangeSelect value={days} onChange={setDays} options={[1, 7]} />
            </div>}>
            {!pointId ? <Empty>No metered point.</Empty> : q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <Stat label="Maximum 30-minute demand" value={d.max_kva != null ? `${num(d.max_kva, 1)} kVA` : "–"} hint={d.max_at ? fmtDateTime(d.max_at) : undefined} />
                        <Stat label="At that interval" value={d.max_kw != null ? `${num(d.max_kw, 1)} kW` : "–"} />
                        <Stat label="Contracted MDI" value={d.contracted_mdi_kva != null ? `${num(d.contracted_mdi_kva)} kVA` : "not set"} />
                        <Stat label="Utilisation" value={d.utilisation_pct != null ? `${d.utilisation_pct} %` : "–"}
                            tone={d.utilisation_pct > 100 ? "red" : d.utilisation_pct > 90 ? "amber" : undefined} />
                    </div>
                    {d.daily_max.length === 0 ? <Empty>No complete 30-minute intervals in this period.</Empty> : (
                        <div className="h-64">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={d.daily_max} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                                    <XAxis dataKey="date" stroke="var(--chart-axis)" fontSize={11} tickFormatter={(x) => x.slice(5)} />
                                    <YAxis stroke="var(--chart-axis)" fontSize={11} unit=" kVA" width={70} />
                                    <Tooltip contentStyle={{ background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)" }}
                                        formatter={(v: any) => [`${num(v, 1)} kVA`, "daily maximum"]} />
                                    {d.contracted_mdi_kva && <ReferenceLine y={d.contracted_mdi_kva} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "contracted MDI", fill: "#ef4444", fontSize: 10, position: "insideTopRight" }} />}
                                    <Bar dataKey="kva">
                                        {d.daily_max.map((x: any) => (
                                            <Cell key={x.date} fill={d.contracted_mdi_kva && x.kva > d.contracted_mdi_kva ? "#ef4444" : "#3b82f6"} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                    {d.max_at && <Button variant="secondary" onClick={() => askConsultant(`Explain the demand peak of ${num(d.max_kva, 1)} kVA at ${fmtDateTime(d.max_at)} ${TZ_LABEL}: what coincided with it and what should we verify?`)}>Explain this peak</Button>}
                    {d.top_intervals.length > 0 && (
                        <Table head={["Highest intervals", "kVA", "kW"]}>
                            {d.top_intervals.map((x: any) => (
                                <tr key={x.bucket}><td className="py-1.5 pr-4">{fmtDateTime(x.bucket)} (30 min)</td><td className="py-1.5 pr-4">{num(x.kva, 1)}</td><td className="py-1.5">{x.kw != null ? num(x.kw, 1) : "–"}</td></tr>
                            ))}
                        </Table>
                    )}
                </div>
            )}
        </Panel>
    );
}

// ── Findings and actions: each finding is a small investigation case (brief §7C) ──
const CASE_STATUS: Record<string, string> = {
    open: "Open", investigating: "Investigating", action_planned: "Action planned", action_done: "Action done",
    verified: "Verified", not_needed: "No action needed",
};
const DAY_MS = 86_400_000;

export function FindingsTab({ project, assessmentId, role, onInspect }: {
    project: PortalProjectDetail; assessmentId?: string | null; role?: string | null;
    onInspect?: (w: { from: string; to: string }) => void;
}) {
    const q = useQuery({ queryKey: ["findings", project.id], queryFn: () => apiGet<any[]>(`/ingestion/sites/${project.id}/recommendations`) });
    const cases = useQuery({ queryKey: ["cases", assessmentId], enabled: !!assessmentId, queryFn: () => apiGet<any[]>(`/ingestion/assessments/${assessmentId}/cases`) });
    // A link to #finding-<id> (overview tiles): scroll to it once the findings have loaded.
    useEffect(() => {
        if (!q.data || typeof window === "undefined" || !window.location.hash.startsWith("#finding-")) return;
        document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [q.data]);
    const [asked, setAsked] = useState<Record<string, string>>({});
    const notify = useMutation({
        mutationFn: (id: string) => apiSend("POST", `/ingestion/recommendations/${id}/notify`, {}),
        onSuccess: (_d, id) => setAsked((a) => ({ ...a, [id]: "GridIQ will be in touch." })),
        onError: (e: any, id) => setAsked((a) => ({ ...a, [id]: e?.status === 409 ? "Already with GridIQ." : String(e?.message ?? e) })),
    });
    if (q.isLoading) return <Loading />;
    if (q.error) return <ErrorBox error={q.error} />;
    if ((q.data ?? []).length === 0) return <Panel><Empty>No findings for this site yet. A site without findings is a result too: see the Summary for what was measured.</Empty></Panel>;
    const byId = new Map((cases.data ?? []).map((c) => [c.recommendation_id, c]));
    return (
        <div className="space-y-4">
            {q.data!.map((f) => {
                const c = byId.get(f.id);
                const w = f.evidence?.from ? { from: f.evidence.from, to: f.evidence.to } : null;
                return (
                    <article key={f.id} id={`finding-${f.id}`} className="scroll-mt-24 rounded-xl border border-line bg-surface/50 p-5" aria-labelledby={`ft-${f.id}`}>
                        <div className="flex flex-wrap items-center gap-2 mb-1 text-xs">
                            <Badge tone={f.priority === 1 ? "red" : f.priority === 2 ? "amber" : "grey"}>{f.priority === 1 ? "Material concern" : f.priority === 2 ? "Investigate" : "Note"}</Badge>
                            <span className="text-muted">{f.confidence ?? "–"} confidence</span>
                            <span className="text-muted">· {findingSource(f.type)}</span>
                            {isDraftFinding(f.review_status) ? <Badge tone="blue">Draft · not yet reviewed by GridIQ</Badge> : f.reviewed_at && <span className="text-muted">· reviewed {fmtDate(f.reviewed_at)}</span>}
                            <span className="ml-auto"><Badge tone={c?.status === "verified" ? "green" : c ? "blue" : "grey"}>{CASE_STATUS[c?.status ?? "open"]}</Badge></span>
                        </div>
                        <h3 id={`ft-${f.id}`} className="text-base font-semibold text-ink">{f.title}</h3>
                        {f.meter_name && <p className="text-xs text-faint">{f.meter_name}</p>}
                        <ol className="grid md:grid-cols-3 gap-4 mt-3 text-sm">
                            <li><p className="text-xs uppercase tracking-wide text-faint mb-1">1. Observed</p><p className="text-ink-3 whitespace-pre-line">{f.problem}</p>
                                {w && <p className="text-xs text-faint mt-1">{fmtDateTime(w.from)} – {fmtDateTime(w.to)} {TZ_LABEL}{f.standard_reference ? ` · ${f.standard_reference}` : ""}</p>}</li>
                            <li><p className="text-xs uppercase tracking-wide text-faint mb-1">2. Next verification and action</p><p className="text-ink-3 whitespace-pre-line">{f.solution}</p>
                                {Number(f.estimated_monthly_saving_zar) > 0 && <p className="text-xs text-muted mt-1">Indicative {zar(f.estimated_monthly_saving_zar)}/month from the declared demand tariff; confirm against the bill before relying on it.</p>}</li>
                            <li><p className="text-xs uppercase tracking-wide text-faint mb-1">3. Follow-up</p>
                                {c ? (
                                    <dl className="text-ink-3 space-y-0.5">
                                        <div><dt className="inline text-faint">Owner: </dt><dd className="inline">{c.owner ?? "not assigned"}</dd></div>
                                        {c.next_step && <div><dt className="inline text-faint">Next: </dt><dd className="inline">{c.next_step}</dd></div>}
                                        {c.due_on && <div><dt className="inline text-faint">Due: </dt><dd className="inline">{fmtDate(c.due_on)}</dd></div>}
                                        {c.verification?.result && <div><dt className="inline text-faint">Verification: </dt><dd className="inline">{String(c.verification.result).replace(/_/g, " ")}{c.verification.note ? `: ${c.verification.note}` : ""}</dd></div>}
                                        {c.evidence_count > 0 && <div className="text-faint">{c.evidence_count} saved evidence window(s)</div>}
                                    </dl>
                                ) : <p className="text-faint">Not tracked yet.</p>}
                            </li>
                        </ol>
                        <div className="flex flex-wrap items-center gap-2 mt-4">
                            {onInspect && <Button variant="secondary" onClick={() => onInspect(w ?? { from: new Date(Date.now() - DAY_MS).toISOString(), to: new Date().toISOString() })}>Inspect evidence</Button>}
                            <Button variant="secondary" onClick={() => askConsultant(`Explain this finding for ${project.name} and what we should verify first: "${f.title}". ${f.problem ?? ""}`)}>Ask the consultant</Button>
                            <Button variant="secondary" disabled={notify.isPending || !!asked[f.id]} onClick={() => notify.mutate(f.id)}>Ask GridIQ to follow up</Button>
                            {asked[f.id] && <span className="text-sm text-muted">{asked[f.id]}</span>}
                        </div>
                        {assessmentId && canEdit(role ?? null) && <CaseEditor f={f} c={c} assessmentId={assessmentId} project={project} />}
                    </article>
                );
            })}
        </div>
    );
}

export function CaseEditor({ f, c, assessmentId, project }: { f: any; c: any; assessmentId: string; project: PortalProjectDetail }) {
    const qc = useQueryClient();
    const [open, setOpen] = useState<"" | "case" | "verify">("");
    const [form, setForm] = useState({ owner: c?.owner ?? "", status: c?.status ?? "open", next_step: c?.next_step ?? "", due_on: c?.due_on?.slice(0, 10) ?? "" });
    const save = useMutation({
        mutationFn: (body: any) => apiSend("PATCH", `/ingestion/recommendations/${f.id}/case`, body),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["cases", assessmentId] }); setOpen(""); },
    });
    return (
        <div className="mt-3 border-t border-line pt-3">
            <div className="flex gap-3 text-sm">
                <button type="button" className="text-accent hover:underline" aria-expanded={open === "case"} onClick={() => setOpen(open === "case" ? "" : "case")}>Update follow-up</button>
                <button type="button" className="text-accent hover:underline" aria-expanded={open === "verify"} onClick={() => setOpen(open === "verify" ? "" : "verify")}>Verify improvement</button>
            </div>
            {open === "case" && (
                <form className="mt-3 grid md:grid-cols-5 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); save.mutate({ owner: form.owner || null, status: form.status, next_step: form.next_step || null, due_on: form.due_on || null }); }}>
                    <Field label="Owner"><input className={inputClass} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="e.g. Facilities manager" /></Field>
                    <Field label="Status">
                        <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                            {Object.entries(CASE_STATUS).filter(([k]) => k !== "verified").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                    </Field>
                    <Field label="Next step"><input className={inputClass} value={form.next_step} onChange={(e) => setForm({ ...form, next_step: e.target.value })} /></Field>
                    <Field label="Due"><input type="date" className={inputClass} value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} /></Field>
                    <Button type="submit" disabled={save.isPending}>Save</Button>
                    <div className="md:col-span-5"><ErrorBox error={save.error} /></div>
                </form>
            )}
            {open === "verify" && <VerifyPanel f={f} project={project} onSave={(v) => save.mutate({ status: "verified", verification: v })} saving={save.isPending} error={save.error} />}
        </div>
    );
}

/** Before/after on matched windows of the same point (brief §7C "Verify improvement"). */
export function VerifyPanel({ f, project, onSave, saving, error }: { f: any; project: PortalProjectDetail; onSave: (v: any) => void; saving: boolean; error: unknown }) {
    const point = project.points.find((p) => p.device_id === f.meter_id) ?? defaultPoint(project.points);
    const now = Date.now();
    const len = f.evidence?.from ? Math.max(3_600_000, new Date(f.evidence.to).getTime() - new Date(f.evidence.from).getTime()) : 2 * DAY_MS;
    const toLocal = (ms: number) => new Date(ms + 2 * 3_600_000).toISOString().slice(0, 16);
    const fromLocal = (v: string) => new Date(new Date(`${v}:00Z`).getTime() - 2 * 3_600_000).toISOString();
    const [w, setW] = useState({
        a_from: toLocal(f.evidence?.from ? new Date(f.evidence.from).getTime() : now - 2 * len), a_to: toLocal(f.evidence?.to ? new Date(f.evidence.to).getTime() : now - len),
        b_from: toLocal(now - len), b_to: toLocal(now),
    });
    const [result, setResult] = useState("improved");
    const [note, setNote] = useState("");
    const q = useQuery({
        queryKey: ["compare", point?.id, w], enabled: !!point,
        queryFn: () => apiGet<any>(`/ingestion/points/${point!.id}/compare?a_from=${fromLocal(w.a_from)}&a_to=${fromLocal(w.a_to)}&b_from=${fromLocal(w.b_from)}&b_to=${fromLocal(w.b_to)}`),
    });
    const row = (label: string, k: (x: any) => any, d = 1) => (
        <tr><td className="py-1 pr-4 text-muted">{label}</td><td className="pr-4">{q.data ? num(k(q.data.before), d) : "…"}</td><td>{q.data ? num(k(q.data.after), d) : "…"}</td></tr>
    );
    return (
        <div className="mt-3 space-y-3">
            <div className="grid md:grid-cols-4 gap-3">
                {(["a_from", "a_to", "b_from", "b_to"] as const).map((k) => (
                    <Field key={k} label={`${k.startsWith("a") ? "Before" : "After"} ${k.endsWith("from") ? "from" : "to"} (${TZ_LABEL})`}>
                        <input type="datetime-local" className={inputClass} value={w[k]} onChange={(e) => e.target.value && setW({ ...w, [k]: e.target.value })} />
                    </Field>
                ))}
            </div>
            {q.error ? <ErrorBox error={q.error} /> : (
                <table className="text-sm tabular-nums">
                    <thead><tr className="text-left text-faint"><th className="pr-4 font-normal">At {point?.name}</th><th className="pr-4 font-normal">Before ({q.data?.before.values ?? "…"} values)</th><th className="font-normal">After ({q.data?.after.values ?? "…"} values)</th></tr></thead>
                    <tbody>
                        {row("Average kW", (x) => x.kw_avg)}{row("kW 95th percentile", (x) => x.kw_p95)}{row("Highest kW", (x) => x.kw_max)}
                        {row("Loaded PF", (x) => x.pf_loaded_avg, 3)}{row("THD-V P95, phase A (%)", (x) => x.thd_v_p95.A, 2)}
                        {row("Lowest voltage (V)", (x) => x.v_min)}{row("Current unbalance P95 (%)", (x) => x.current_unbalance_p95)}
                    </tbody>
                </table>
            )}
            {q.data && <p className="text-xs text-faint">{q.data.basis}{q.data.comparable ? "" : " The two windows differ in length: compare with care."}</p>}
            <form className="grid md:grid-cols-4 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); onSave({ before: { from: fromLocal(w.a_from), to: fromLocal(w.a_to) }, after: { from: fromLocal(w.b_from), to: fromLocal(w.b_to) }, result, note: note || null }); }}>
                <Field label="Result">
                    <select className={inputClass} value={result} onChange={(e) => setResult(e.target.value)}>
                        <option value="improved">Improved</option><option value="no_change">No change</option><option value="worse">Worse</option><option value="inconclusive">Inconclusive (conditions differed)</option>
                    </select>
                </Field>
                <Field label="What changed on site"><input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. HVAC schedule changed on 5 Nov" /></Field>
                <Button type="submit" disabled={saving || !q.data}>Record verification</Button>
                <div className="md:col-span-4"><ErrorBox error={error} /></div>
            </form>
        </div>
    );
}

// ── Reports (published) and share links ─────────────────────────────────────
export function ReportsTab({ project, role }: { project: PortalProjectDetail; role: string | null }) {
    const q = useQuery({ queryKey: ["reports", project.id], queryFn: () => apiGet<any[]>(`/ingestion/reports?project_id=${project.id}`) });
    const [sharing, setSharing] = useState<string | null>(null);
    if (q.isLoading) return <Loading />;
    if (q.error) return <ErrorBox error={q.error} />;
    return (
        <div className="space-y-5">
        <AssessmentDeliverables projectId={project.id} />
        <Panel title="Reports" subtitle="Reports GridIQ has reviewed and issued. A share link shows the report to someone without an account while the assessment is live or in its delivery period.">
            {(q.data ?? []).length === 0 ? <Empty>No published report yet.</Empty> : (
                <ul className="divide-y divide-line">
                    {q.data!.map((r) => (
                        <li key={r.id} className="py-3">
                            <div className="flex items-center gap-4">
                                <div className="flex-1">
                                    <p className="text-sm text-ink">{r.title ?? "Report"}</p>
                                    <p className="text-xs text-faint">{fmtDate(r.period_start)} – {fmtDate(new Date(new Date(r.period_end).getTime() - 1))} · published {fmtDate(r.published_at)}</p>
                                </div>
                                {r.pdf_path && <a className="text-sm text-accent hover:underline" href={apiUrl(`/ingestion/reports/${r.id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>}
                                {canEdit(role) && <Button variant="secondary" onClick={() => setSharing(sharing === r.id ? null : r.id)}>Share link</Button>}
                            </div>
                            {sharing === r.id && <ShareForm project={project} reportId={r.id} />}
                        </li>
                    ))}
                </ul>
            )}
        </Panel>
        </div>
    );
}

/** Per assessment of this project: the frozen deliverables and, while live, a provisional preview. */
function AssessmentDeliverables({ projectId }: { projectId: string }) {
    const mine = usePortalAssessments();
    const list = (mine.data ?? []).filter((a) => a.project_id === projectId && (a.live || a.delivery_open));
    if (!list.length) return null;
    return (
        <>
            {list.map((a) => <Deliverables key={a.id} a={a} />)}
        </>
    );
}

function Deliverables({ a }: { a: Assessment }) {
    const q = useQuery({ queryKey: ["deliverables", a.id], queryFn: () => apiGet<{ files: { name: string; title: string; url: string; sha256: string | null }[]; pending_review: string[] }>(`/ingestion/assessments/${a.id}/deliverables`) });
    const origin = (() => { const b = process.env.NEXT_PUBLIC_API_URL ?? ""; return b.startsWith("/") ? "" : new URL(b).origin; })();
    return (
        <Panel title={`${a.reference} deliverables`} subtitle={a.live ? "Live assessment: the provisional preview covers the elapsed period only and is not final." : `Final files, available until ${fmtDate(a.delivery_until)}.`}>
            {a.live && (
                <p className="text-sm mb-3">
                    <a className="text-accent hover:underline" href={apiUrl(`/ingestion/assessments/${a.id}/preview.pdf?kind=overview`)} target="_blank" rel="noreferrer">Provisional overview (PDF)</a>
                    {" · "}
                    <a className="text-accent hover:underline" href={apiUrl(`/ingestion/assessments/${a.id}/preview.pdf?kind=power_quality`)} target="_blank" rel="noreferrer">Provisional power quality (PDF)</a>
                </p>
            )}
            {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (q.data?.files ?? []).length === 0
                ? <Empty>{a.live ? "The final reports and data package are produced when the assessment ends." : "Being prepared."}</Empty> : (
                    <ul className="text-sm space-y-1">{q.data!.files.map((f) => (
                        <li key={f.name}><a className="text-accent hover:underline" href={`${origin}${f.url}`}>{f.name}</a> <span className="text-xs text-faint">{f.title}</span></li>
                    ))}</ul>
                )}
            {(q.data?.pending_review ?? []).length > 0 && <p className="text-xs text-faint mt-2">In engineering review: {q.data!.pending_review.join(", ")}.</p>}
        </Panel>
    );
}

function ShareForm({ project, reportId }: { project: PortalProjectDetail; reportId: string }) {
    const metered = project.points.filter((p) => p.metered && p.device_id);
    const [pointId, setPointId] = useState(defaultPoint(metered)?.id ?? "");
    const [label, setLabel] = useState("");
    const [daysValid, setDaysValid] = useState(30);
    const share = useMutation({
        mutationFn: () => {
            const pt = metered.find((p) => p.id === pointId)!;
            return apiSend<{ path: string; expires_at: string }>("POST", `/ingestion/meters/${pt.device_id}/shares`, { report_id: reportId, label, days_valid: daysValid });
        },
    });
    if (share.data) {
        const link = `${window.location.origin}${share.data.path}`;
        return (
            <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                <p className="text-ok">Link created. Copy it now: it is shown only once.</p>
                <input readOnly className={`${inputClass} mt-2 font-mono text-xs`} value={link} onFocus={(e) => e.target.select()} />
                <p className="text-xs text-faint mt-1">Expires {fmtDate(share.data.expires_at)}.</p>
            </div>
        );
    }
    return (
        <form className="mt-3 grid md:grid-cols-4 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); share.mutate(); }}>
            <Field label="Measurement point">
                <select className={inputClass} value={pointId} onChange={(e) => setPointId(e.target.value)}>
                    {metered.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
            </Field>
            <Field label="Who is it for? (your records)"><input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
            <Field label="Expires after">
                <select className={inputClass} value={daysValid} onChange={(e) => setDaysValid(Number(e.target.value))}>
                    {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d === 365 ? "1 year" : `${d} days`}</option>)}
                </select>
            </Field>
            <Button type="submit" disabled={share.isPending || !pointId}>Create link</Button>
            <div className="md:col-span-4"><ErrorBox error={share.error} /></div>
        </form>
    );
}

