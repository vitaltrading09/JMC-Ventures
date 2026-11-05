"use client";

// The tabs of a portal project page (Phase 8, approved list): Overview,
// Metering layout, Energy balance, Load profile, Demand, Power quality,
// Findings, Reports. Every figure states its basis and that times are SAST.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from "recharts";
import { ChevronRight } from "lucide-react";
import { apiGet, apiSend, apiUrl, fmtAgo, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num, zar } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/ops";
import { PortalProjectDetail, PortalPoint, pointTree, defaultPoint, canEdit, askConsultant, isDraftFinding, findingSource } from "@/lib/portal";
import { BalanceView, Balance } from "@/components/fleet/BalanceView";
import HealthCheckReport from "@/components/report/HealthCheckReport";
import { SldView } from "@/components/sld/SldView";
import { Panel, Loading, ErrorBox, Empty, Badge, Button, Field, inputClass, Table, Stat } from "@/components/ops/ui";

const DAY = 86_400_000;

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
        <ul className="divide-y divide-slate-800">
            {rows.map(({ point: p, depth }) => (
                <li key={p.id}>
                    <Link href={`/portal/projects/${project.id}/points/${p.id}`} className="flex items-center gap-4 py-2.5 hover:bg-slate-900/60 rounded-lg px-2">
                        <span style={{ paddingLeft: depth * 24 }} className="flex-1 min-w-0">
                            <span className="text-sm text-slate-100">{depth > 0 && <span className="text-slate-600 mr-1">└</span>}{p.name}</span>
                            <span className="text-xs text-slate-500 ml-2">{ROLE_LABEL[p.role] ?? p.role}</span>
                        </span>
                        {p.metered ? (
                            p.live ? (
                                <span className="text-sm text-slate-300 tabular-nums">
                                    {p.live.kw != null ? `${num(p.live.kw, 1)} kW` : "–"} · PF {p.live.pf != null ? num(p.live.pf, 2) : "–"} · {p.live.v != null ? `${num(p.live.v, 0)} V` : "–"}
                                </span>
                            ) : <Badge tone="amber">no recent reading</Badge>
                        ) : <Badge>not metered</Badge>}
                        <ChevronRight className="h-4 w-4 text-slate-600" />
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
export function BalanceTab({ project }: { project: PortalProjectDetail }) {
    const [days, setDays] = useState(30);
    const range = useMemo(() => { const to = new Date(); return { from: new Date(to.getTime() - days * DAY), to }; }, [days]);
    const q = useQuery({
        queryKey: ["balance", project.id, days],
        queryFn: () => apiGet<Balance>(`/ingestion/projects/${project.id}/energy-balance?from=${range.from.toISOString()}&to=${range.to.toISOString()}`),
    });
    return (
        <Panel title="Energy balance"
            subtitle={`${fmtDateTime(range.from)} – ${fmtDateTime(range.to)} ${TZ_LABEL}. From the kWh registers (power-integrated where a meter has none). Consumption = grid import − export + PV + battery discharge − charge.`}
            actions={<select className={`${inputClass} w-36`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>}>
            {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data && <BalanceView b={q.data} />}
        </Panel>
    );
}

// ── Load profile ────────────────────────────────────────────────────────────
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function LoadProfileTab({ project }: { project: PortalProjectDetail }) {
    const [pointId, setPointId] = usePoint(project);
    const [days, setDays] = useState(28);
    const q = useQuery({ queryKey: ["load-profile", pointId, days], enabled: !!pointId, queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/load-profile?days=${days}`) });
    const max = Math.max(1, ...(q.data?.cells ?? []).map((c: any) => c.kw));
    const cell = (wd: number, h: number) => q.data?.cells.find((c: any) => c.weekday === wd && c.hour === h);
    return (
        <Panel title="Load profile" subtitle={q.data ? `${q.data.basis}; last ${days} days; ${TZ_LABEL}` : undefined}
            actions={<div className="flex gap-2">
                <PointPicker points={project.points} value={pointId} onChange={setPointId} />
                <select className={`${inputClass} w-32`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {[7, 28, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
            </div>}>
            {!pointId ? <Empty>No metered point.</Empty> : q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <Stat label="Baseload" value={q.data.baseload_kw != null ? `${num(q.data.baseload_kw, 1)} kW` : "–"} hint="10th percentile of hourly averages" />
                        <Stat label="After-hours load" value={q.data.after_hours_kw != null ? `${num(q.data.after_hours_kw, 1)} kW` : "–"} hint="median, 18:00–06:00 and weekends" />
                    </div>
                    <div className="overflow-x-auto">
                        <table className="text-[11px] border-separate border-spacing-0.5">
                            <thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="text-slate-500 font-normal w-8">{h}</th>)}</tr></thead>
                            <tbody>
                                {WEEKDAYS.map((d, i) => (
                                    <tr key={d}>
                                        <td className="text-slate-400 pr-2">{d}</td>
                                        {Array.from({ length: 24 }, (_, h) => {
                                            const c = cell(i + 1, h);
                                            const a = c ? 0.12 + 0.88 * (c.kw / max) : 0;
                                            return <td key={h} title={c ? `${d} ${h}:00 – ${num(c.kw, 1)} kW (${c.hours} h)` : "no data"}
                                                className="w-8 h-6 rounded" style={{ background: c ? `rgba(59,130,246,${a})` : "#0f172a" }} />;
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-slate-500">Darker = higher average kW. Columns are the hour starting at that time.</p>
                </div>
            )}
        </Panel>
    );
}

// ── Demand ──────────────────────────────────────────────────────────────────
export function DemandTab({ project }: { project: PortalProjectDetail }) {
    const [pointId, setPointId] = usePoint(project);
    const [days, setDays] = useState(30);
    const q = useQuery({ queryKey: ["demand", pointId, days], enabled: !!pointId, queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/demand?days=${days}`) });
    const d = q.data;
    return (
        <Panel title="Maximum demand" subtitle={d ? `${d.basis}; ${TZ_LABEL}` : undefined}
            actions={<div className="flex gap-2">
                <PointPicker points={project.points} value={pointId} onChange={setPointId} />
                <select className={`${inputClass} w-32`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {[7, 30, 90].map((x) => <option key={x} value={x}>{x} days</option>)}
                </select>
            </div>}>
            {!pointId ? <Empty>No metered point.</Empty> : q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <Stat label="Maximum demand" value={d.max_kva != null ? `${num(d.max_kva, 1)} kVA` : "–"} hint={d.max_at ? fmtDateTime(d.max_at) : undefined} />
                        <Stat label="At that interval" value={d.max_kw != null ? `${num(d.max_kw, 1)} kW` : "–"} />
                        <Stat label="Contracted MDI" value={d.contracted_mdi_kva != null ? `${num(d.contracted_mdi_kva)} kVA` : "not set"} />
                        <Stat label="Utilisation" value={d.utilisation_pct != null ? `${d.utilisation_pct} %` : "–"}
                            tone={d.utilisation_pct > 100 ? "red" : d.utilisation_pct > 90 ? "amber" : undefined} />
                    </div>
                    {d.daily_max.length === 0 ? <Empty>No complete 30-minute intervals in this period.</Empty> : (
                        <div className="h-64">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={d.daily_max} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                                    <XAxis dataKey="date" stroke="#64748b" fontSize={11} tickFormatter={(x) => x.slice(5)} />
                                    <YAxis stroke="#64748b" fontSize={11} unit=" kVA" width={70} />
                                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155" }}
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

// ── Power quality ───────────────────────────────────────────────────────────
export function PowerQualityTab({ project }: { project: PortalProjectDetail }) {
    const [pointId, setPointId] = usePoint(project);
    const [days, setDays] = useState(7);
    const q = useQuery({ queryKey: ["pq", pointId, days], enabled: !!pointId, queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/power-quality?days=${days}`) });
    const brand = useQuery({ queryKey: ["branding"], queryFn: () => apiGet<any>("/ingestion/branding") });
    return (
        <div className="space-y-4">
            <Panel title="Power quality" subtitle={q.data ? `${q.data.basis}${q.data.days < q.data.requested_days ? ` (the box has been here ${q.data.days} day${q.data.days === 1 ? "" : "s"})` : ""}` : undefined}
                actions={<div className="flex gap-2">
                    <PointPicker points={project.points} value={pointId} onChange={setPointId} />
                    <select className={`${inputClass} w-32`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                        {[7, 30, 90].map((x) => <option key={x} value={x}>{x} days</option>)}
                    </select>
                </div>}>
                {!pointId ? <Empty>No metered point.</Empty> : q.isLoading ? <Loading label="Assessing" /> : q.error ? <ErrorBox error={q.error} />
                    : !q.data.report ? <Empty>No assessment: the point has no box installed.</Empty> : null}
            </Panel>
            {q.data?.report && <HealthCheckReport report={q.data.report} brand={brand.data ?? null} forecast={null} summary={null} />}
        </div>
    );
}

// ── Findings (published; drafts too when the platform shares them, labelled) ──
export function FindingsTab({ project }: { project: PortalProjectDetail }) {
    const q = useQuery({ queryKey: ["findings", project.id], queryFn: () => apiGet<any[]>(`/ingestion/sites/${project.id}/recommendations`) });
    // A link to #finding-<id> (overview tiles): scroll to it once the findings have loaded.
    useEffect(() => {
        if (!q.data || typeof window === "undefined" || !window.location.hash.startsWith("#finding-")) return;
        document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [q.data]);
    const [asked, setAsked] = useState<Record<string, string>>({});
    const notify = useMutation({
        mutationFn: (id: string) => apiSend("POST", `/ingestion/recommendations/${id}/notify`, {}),
        onSuccess: (_d, id) => setAsked((a) => ({ ...a, [id]: "Grid-IQ will be in touch." })),
        onError: (e: any, id) => setAsked((a) => ({ ...a, [id]: e?.status === 409 ? "Already with Grid-IQ." : String(e?.message ?? e) })),
    });
    if (q.isLoading) return <Loading />;
    if (q.error) return <ErrorBox error={q.error} />;
    if ((q.data ?? []).length === 0) return <Panel><Empty>No findings for this project yet.</Empty></Panel>;
    return (
        <div className="space-y-4">
            {q.data!.map((f) => (
                <div key={f.id} id={`finding-${f.id}`} className="scroll-mt-24"><Panel>
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                                {isDraftFinding(f.review_status) && <Badge tone="blue">Draft · not yet reviewed by Grid-IQ</Badge>}
                                <span className="text-xs text-slate-400">{findingSource(f.type)}</span>
                            </div>
                            <p className="text-xs text-slate-500">{f.meter_name ? `${f.meter_name} · ` : ""}{f.confidence} confidence{f.reviewed_at ? ` · reviewed ${fmtDate(f.reviewed_at)}` : ""}</p>
                            <h3 className="text-base font-semibold text-white mt-1">{f.title}</h3>
                        </div>
                        {Number(f.estimated_monthly_saving_zar) > 0 && <p className="text-sm text-emerald-300 whitespace-nowrap">{zar(f.estimated_monthly_saving_zar)}/month</p>}
                    </div>
                    <div className="grid md:grid-cols-2 gap-4 mt-3 text-sm">
                        <div><p className="text-xs uppercase text-slate-500 mb-1">What we found</p><p className="text-slate-300 whitespace-pre-line">{f.problem}</p></div>
                        <div><p className="text-xs uppercase text-slate-500 mb-1">What we recommend</p><p className="text-slate-300 whitespace-pre-line">{f.solution}</p></div>
                    </div>
                    {f.evidence?.from && <p className="text-xs text-slate-500 mt-3">Based on {fmtDateTime(f.evidence.from)} – {fmtDateTime(f.evidence.to)} {TZ_LABEL}{f.standard_reference ? ` · ${f.standard_reference}` : ""}</p>}
                    <div className="flex items-center gap-3 mt-3">
                        <Button variant="secondary" disabled={notify.isPending || !!asked[f.id]} onClick={() => notify.mutate(f.id)}>Ask Grid-IQ to follow up</Button>
                        <Button variant="secondary" onClick={() => askConsultant(`Explain this finding for ${project.name} and what we should do first: "${f.title}". ${f.problem ?? ""}`)}>Ask the AI consultant</Button>
                        {asked[f.id] && <span className="text-sm text-slate-400">{asked[f.id]}</span>}
                    </div>
                </Panel></div>
            ))}
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
        <Panel title="Reports" subtitle="Reports Grid-IQ has reviewed and published. A share link shows the report to someone without an account.">
            {(q.data ?? []).length === 0 ? <Empty>No published report yet.</Empty> : (
                <ul className="divide-y divide-slate-800">
                    {q.data!.map((r) => (
                        <li key={r.id} className="py-3">
                            <div className="flex items-center gap-4">
                                <div className="flex-1">
                                    <p className="text-sm text-white">{r.title ?? "Report"}</p>
                                    <p className="text-xs text-slate-500">{fmtDate(r.period_start)} – {fmtDate(new Date(new Date(r.period_end).getTime() - 1))} · published {fmtDate(r.published_at)}</p>
                                </div>
                                {r.pdf_path && <a className="text-sm text-blue-300 hover:underline" href={apiUrl(`/ingestion/reports/${r.id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>}
                                {canEdit(role) && <Button variant="secondary" onClick={() => setSharing(sharing === r.id ? null : r.id)}>Share link</Button>}
                            </div>
                            {sharing === r.id && <ShareForm project={project} reportId={r.id} />}
                        </li>
                    ))}
                </ul>
            )}
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
                <p className="text-emerald-300">Link created. Copy it now: it is shown only once.</p>
                <input readOnly className={`${inputClass} mt-2 font-mono text-xs`} value={link} onFocus={(e) => e.target.select()} />
                <p className="text-xs text-slate-500 mt-1">Expires {fmtDate(share.data.expires_at)}.</p>
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

