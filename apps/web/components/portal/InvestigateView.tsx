"use client";

// Linked investigation workspace (engineering UI brief §7B). One selected
// window; power, voltage, current, power factor and voltage THD stacked and
// aligned with a shared time cursor; each bucket's minimum and maximum drawn
// as a band so decimation never hides a peak; recorded/inferred events marked
// on every chart. Zoom re-reads the window at a finer resolution. A window can
// be saved as an evidence reference (optionally tied to a finding) and is then
// listed in the report. Not a waveform: these are RMS trend buckets.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, ReferenceArea, Brush } from "recharts";
import { apiGet, apiSend, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import { askConsultant, canEdit } from "@/lib/portal";
import { PHASE } from "@/lib/summary";
import { Panel, Loading, ErrorBox, Empty, Button, Field, inputClass, Badge } from "@/components/ops/ui";

const H = 3_600_000, D = 24 * H;
const SAST = 2 * H;
export interface Window { from: string; to: string }

/** Inserts an empty row where buckets are missing, so lines break at gaps instead of bridging them. */
function withGaps(rows: any[], widthMs: number) {
    const out: any[] = [];
    rows.forEach((r, i) => {
        if (i > 0 && new Date(r.t).getTime() - new Date(rows[i - 1].t).getTime() > 1.5 * widthMs)
            out.push({ gap: true, t: new Date(new Date(rows[i - 1].t).getTime() + widthMs).toISOString(), ms: new Date(rows[i - 1].t).getTime() + widthMs });
        out.push(r);
    });
    return out;
}

const toLocal = (iso: string) => new Date(new Date(iso).getTime() + SAST).toISOString().slice(0, 16);
const fromLocal = (v: string) => new Date(new Date(`${v}:00Z`).getTime() - SAST).toISOString();
const tick = (ms: number, span: number) => {
    const d = new Date(ms + SAST);
    const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    return span > 2 * D ? `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${hm}` : hm;
};

export type Group = "power" | "voltage" | "current" | "pf" | "thd";
const GROUPS: { key: Group; label: string }[] = [
    { key: "power", label: "Power (kW, kvar)" }, { key: "voltage", label: "Voltage" }, { key: "current", label: "Current" },
    { key: "pf", label: "Power factor" }, { key: "thd", label: "Voltage THD" },
];

export function InvestigateView({ assessment, pointId, points, role, initial, findings, initialGroups }: {
    assessment: { id: string; start_at: string | null; effective_end_at: string | null };
    pointId: string; points: { id: string; name: string }[]; role: string | null;
    initial?: Window | null; findings?: { id: string; title: string }[];
    /** Channels to open with (a finding page opens with the ones that explain it). */
    initialGroups?: Group[];
}) {
    const start = assessment.start_at ?? new Date(Date.now() - 7 * D).toISOString();
    const end = () => new Date(Math.min(Date.now(), new Date(assessment.effective_end_at ?? Date.now()).getTime())).toISOString();
    const [win, setWin] = useState<Window>(initial ?? { from: new Date(Math.max(new Date(start).getTime(), Date.now() - D)).toISOString(), to: end() });
    useEffect(() => { if (initial) setWin(initial); }, [initial?.from, initial?.to]); // eslint-disable-line react-hooks/exhaustive-deps
    const [groups, setGroups] = useState<Group[]>(initialGroups ?? ["power", "voltage", "pf", "thd"]);
    const [phases, setPhases] = useState<("A" | "B" | "C")[]>(["A", "B", "C"]);
    const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
    const qc = useQueryClient();

    const q = useQuery({
        queryKey: ["investigate", pointId, win.from, win.to],
        queryFn: () => apiGet<any>(`/ingestion/points/${pointId}/investigate?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}`),
    });
    const evidence = useQuery({ queryKey: ["evidence", assessment.id], queryFn: () => apiGet<any[]>(`/ingestion/assessments/${assessment.id}/evidence`) });
    const rows = useMemo(() => withGaps((q.data?.rows ?? []), (q.data?.bucket_seconds ?? 60) * 1000).map((x: any) => x.gap ? x : ({
        ...x, ms: new Date(x.t).getTime(),
        kw_band: x.kw_min != null && x.kw_max != null ? [x.kw_min, x.kw_max] : null,
        va_band: x.va_min != null ? [x.va_min, x.va_max] : null, vb_band: x.vb_min != null ? [x.vb_min, x.vb_max] : null, vc_band: x.vc_min != null ? [x.vc_min, x.vc_max] : null,
    })), [q.data]);
    const span = new Date(win.to).getTime() - new Date(win.from).getTime();
    const events: any[] = q.data?.events ?? [];

    const preset = (ms: number | "all") => {
        const to = end();
        const from = ms === "all" ? start : new Date(Math.max(new Date(start).getTime(), new Date(to).getTime() - ms)).toISOString();
        setWin({ from, to }); setSel(null);
    };
    const shift = (dir: -1 | 1) => {
        const f = new Date(win.from).getTime() + dir * span, t = new Date(win.to).getTime() + dir * span;
        if (f < new Date(start).getTime() || t > new Date(end()).getTime() + 60_000) return;
        setWin({ from: new Date(f).toISOString(), to: new Date(t).toISOString() }); setSel(null);
    };
    const zoom = () => { if (sel && rows[sel.a] && rows[sel.b] && sel.b > sel.a) { setWin({ from: rows[sel.a].t, to: new Date(rows[sel.b].ms + (q.data?.bucket_seconds ?? 60) * 1000).toISOString() }); setSel(null); } };

    const chart = (key: Group) => {
        const common = (
            <>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="ms" type="number" domain={["dataMin", "dataMax"]} scale="time" stroke="var(--chart-axis)" fontSize={11} tickFormatter={(v) => tick(v, span)} minTickGap={50} />
                <Tooltip contentStyle={{ background: "var(--tooltip-bg)", color: "var(--tooltip-ink)", border: "1px solid var(--tooltip-border)", fontSize: 12 }}
                    labelFormatter={(v) => `${fmtDateTime(new Date(Number(v)))} ${TZ_LABEL} (${q.data?.resolution} bucket)`}
                    formatter={(v: any, name: string) => [Array.isArray(v) ? `${num(v[0], 1)} – ${num(v[1], 1)}` : num(v, key === "pf" ? 3 : 1), name]} />
                {events.map((e, i) => <ReferenceLine key={i} x={new Date(e.started_at).getTime()} stroke="#a855f7" strokeDasharray="2 2" ifOverflow="hidden" />)}
            </>
        );
        const ph = (k: string, p: "A" | "B" | "C", name: string) => phases.includes(p) &&
            <Line key={k} dataKey={k} name={`${name} ${PHASE[p].label}`} stroke={PHASE[p].color} strokeDasharray={PHASE[p].dash} dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls={false} />;
        const height = key === "power" ? 200 : 150;
        let body: React.ReactNode = null, unit = "", title = "";
        if (key === "power") {
            title = "Active and reactive power"; unit = "kW / kvar";
            body = <>{common}
                <Area dataKey="kw_band" name="kW min–max in bucket" stroke="none" fill="#3b82f6" fillOpacity={0.15} isAnimationActive={false} />
                <Line dataKey="kw" name="kW (average)" stroke="#2563eb" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line dataKey="kvar" name="kvar (average)" stroke="#64748b" strokeDasharray="5 3" dot={false} strokeWidth={1.2} isAnimationActive={false} />
                <Brush dataKey="ms" height={22} stroke="var(--chart-axis)" travellerWidth={8} tickFormatter={(v) => tick(v, span)}
                    onChange={(r: any) => r && setSel({ a: r.startIndex, b: r.endIndex })} />
            </>;
        } else if (key === "voltage") {
            title = "Phase voltage (average; band = min–max)"; unit = "V";
            body = <>{common}{(["A", "B", "C"] as const).filter((p) => phases.includes(p)).map((p) =>
                <Area key={p} dataKey={`v${p.toLowerCase()}_band`} name={`V ${p} min–max`} stroke="none" fill={PHASE[p].color} fillOpacity={0.08} isAnimationActive={false} />)}
                {ph("va", "A", "V")}{ph("vb", "B", "V")}{ph("vc", "C", "V")}</>;
        } else if (key === "current") {
            title = "Phase current (average)"; unit = "A";
            body = <>{common}{ph("ia", "A", "I")}{ph("ib", "B", "I")}{ph("ic", "C", "I")}</>;
        } else if (key === "pf") {
            title = "Power factor (average and bucket minimum)"; unit = "PF";
            body = <>{common}
                <Line dataKey="pf" name="PF (average)" stroke="#0d9488" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line dataKey="pf_min" name="PF (bucket minimum)" stroke="#0d9488" strokeDasharray="2 3" dot={false} strokeWidth={1} isAnimationActive={false} /></>;
        } else {
            title = "Voltage THD by phase (average)"; unit = "%";
            body = <>{common}<ReferenceLine y={8} stroke="#f59e0b" strokeDasharray="4 4" />{ph("thd_va", "A", "THD-V")}{ph("thd_vb", "B", "THD-V")}{ph("thd_vc", "C", "THD-V")}</>;
        }
        const vals = rows.map((x: any) => x[key === "power" ? "kw_max" : key === "voltage" ? "va" : key === "current" ? "ia_max" : key === "pf" ? "pf_min" : "thd_va_max"]).filter((v: any) => v != null);
        const summary = vals.length ? `${title}: range ${num(Math.min(...vals), key === "pf" ? 3 : 1)} to ${num(Math.max(...vals), key === "pf" ? 3 : 1)} ${unit}.` : `${title}: no data in this window.`;
        return (
            <section key={key} aria-label={title}>
                <p className="text-[13px] font-medium text-ink-2 mb-1">{title} <span className="text-faint font-normal">· {unit}</span></p>
                {vals.length === 0 ? <p className="text-sm text-faint py-4">Not measured in this window.</p> : (
                    <div style={{ height }} role="img" aria-label={summary}>
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={rows} syncId="investigate" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                                <YAxis stroke="var(--chart-axis)" fontSize={11} width={52} domain={["auto", "auto"]} />
                                {body}
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                )}
                <p className="sr-only">{summary}</p>
            </section>
        );
    };

    return (
        <div className="space-y-6">
            <Panel title="Investigation window" subtitle={q.data ? `${fmtDateTime(q.data.from)} – ${fmtDateTime(q.data.to)} ${TZ_LABEL} · ${q.data.basis}` : undefined}>
                <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-wrap gap-1" role="group" aria-label="Window presets">
                        {([["6 h", 6 * H], ["24 h", D], ["7 days", 7 * D], ["Assessment", "all"]] as const).map(([l, ms]) =>
                            <Button key={l} variant="secondary" onClick={() => preset(ms)}>{l}</Button>)}
                    </div>
                    <Field label={`From (${TZ_LABEL})`}><input type="datetime-local" className={`${inputClass} w-52`} value={toLocal(win.from)} onChange={(e) => e.target.value && setWin({ ...win, from: fromLocal(e.target.value) })} /></Field>
                    <Field label={`To (${TZ_LABEL})`}><input type="datetime-local" className={`${inputClass} w-52`} value={toLocal(win.to)} onChange={(e) => e.target.value && setWin({ ...win, to: fromLocal(e.target.value) })} /></Field>
                    <div className="flex gap-1" role="group" aria-label="Before and after">
                        <Button variant="secondary" onClick={() => shift(-1)} title="The same length of time just before">← Before</Button>
                        <Button variant="secondary" onClick={() => shift(1)} title="The same length of time just after">After →</Button>
                    </div>
                    <Button disabled={!sel} onClick={zoom} title="Drag the handles under the power chart, then zoom">Zoom to selection</Button>
                </div>
                <div className="flex flex-wrap gap-4 mt-4 text-sm">
                    <fieldset className="flex flex-wrap gap-3"><legend className="sr-only">Channels</legend>
                        {GROUPS.map((g) => (
                            <label key={g.key} className="inline-flex items-center gap-1.5 text-ink-3">
                                <input type="checkbox" checked={groups.includes(g.key)} onChange={(e) => setGroups(e.target.checked ? [...groups, g.key] : groups.filter((x) => x !== g.key))} />{g.label}
                            </label>
                        ))}
                    </fieldset>
                    <fieldset className="flex gap-3"><legend className="sr-only">Phases</legend>
                        {(["A", "B", "C"] as const).map((p) => (
                            <label key={p} className="inline-flex items-center gap-1.5 text-ink-3">
                                <input type="checkbox" checked={phases.includes(p)} onChange={(e) => setPhases(e.target.checked ? [...phases, p] : phases.filter((x) => x !== p))} />
                                <span style={{ color: PHASE[p].color }}>■</span>{PHASE[p].label}
                            </label>
                        ))}
                    </fieldset>
                </div>
            </Panel>

            <Panel title="Aligned channels" subtitle="One time cursor across all charts. Purple dashed lines: voltage/frequency events in this window.">
                {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : rows.length === 0 ? <Empty>No measurements in this window.</Empty> : (
                    <div className="space-y-5">{GROUPS.filter((g) => groups.includes(g.key)).map((g) => chart(g.key))}</div>
                )}
                {events.length > 0 && (
                    <details className="mt-4 text-sm">
                        <summary className="cursor-pointer text-muted">{events.length} event(s) in this window · {q.data?.events_basis}</summary>
                        <ul className="mt-2 space-y-1">{events.map((e, i) => (
                            <li key={i} className="flex flex-wrap gap-3 tabular-nums">
                                <button type="button" className="text-accent hover:underline" onClick={() => setWin({ from: new Date(new Date(e.started_at).getTime() - 30 * 60_000).toISOString(), to: new Date(new Date(e.started_at).getTime() + 30 * 60_000).toISOString() })}>{fmtDateTime(e.started_at)}</button>
                                <span>{e.type}</span><span className="text-faint">{e.phase ?? ""} {e.duration_s != null ? `${num(e.duration_s, 0)} s` : "ongoing"} {e.extreme != null ? `· ${e.extreme}` : ""}</span>
                            </li>
                        ))}</ul>
                    </details>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => askConsultant(`Explain what happened at ${points.find((p) => p.id === pointId)?.name ?? "this point"} between ${fmtDateTime(win.from)} and ${fmtDateTime(win.to)} ${TZ_LABEL}: power, voltage, PF and distortion together.`)}>Explain this window</Button>
                </div>
            </Panel>

            <EvidencePanel assessmentId={assessment.id} pointId={pointId} win={win} role={role} findings={findings ?? []}
                list={evidence.data ?? []} onOpen={(w) => { setWin(w); setSel(null); }} onChange={() => qc.invalidateQueries({ queryKey: ["evidence", assessment.id] })} />
        </div>
    );
}

function EvidencePanel({ assessmentId, pointId, win, role, list, findings, onOpen, onChange }: {
    assessmentId: string; pointId: string; win: Window; role: string | null; list: any[]; findings: { id: string; title: string }[];
    onOpen: (w: Window) => void; onChange: () => void;
}) {
    const [title, setTitle] = useState("");
    const [note, setNote] = useState("");
    const [finding, setFinding] = useState("");
    const [report, setReport] = useState(true);
    const save = useMutation({
        mutationFn: () => apiSend("POST", `/ingestion/assessments/${assessmentId}/evidence`, { point_id: pointId, from: win.from, to: win.to, title, note: note || undefined, recommendation_id: finding || undefined, include_in_report: report }),
        onSuccess: () => { setTitle(""); setNote(""); onChange(); },
    });
    const remove = useMutation({ mutationFn: (id: string) => apiSend("POST", `/ingestion/evidence/${id}/remove`, {}), onSuccess: onChange });
    return (
        <Panel title="Saved evidence" subtitle="Named windows for the report and for follow-up. Opening one restores its window.">
            {list.length === 0 ? <Empty>No evidence saved yet.</Empty> : (
                <ul className="divide-y divide-line text-sm">
                    {list.map((e, i) => (
                        <li key={e.id} className="py-2 flex flex-wrap items-center gap-3">
                            <span className="text-faint tabular-nums">E{i + 1}</span>
                            <button type="button" className="text-accent hover:underline font-medium" onClick={() => onOpen({ from: e.from_at, to: e.to_at })}>{e.title}</button>
                            <span className="text-faint tabular-nums">{e.point_name} · {fmtDateTime(e.from_at)} – {fmtDateTime(e.to_at)}</span>
                            {e.include_in_report && <Badge tone="blue">in report</Badge>}
                            {e.note && <span className="text-ink-3 basis-full">{e.note}</span>}
                            {canEdit(role) && <button type="button" className="ml-auto text-xs text-faint hover:text-bad" onClick={() => remove.mutate(e.id)}>Remove</button>}
                        </li>
                    ))}
                </ul>
            )}
            {canEdit(role) && (
                <form className="mt-4 grid md:grid-cols-4 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                    <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Tuesday start-up peak" required /></Field>
                    <Field label="Note (optional)"><input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                    <Field label="Finding (optional)">
                        <select className={inputClass} value={finding} onChange={(e) => setFinding(e.target.value)}>
                            <option value="">None</option>{findings.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
                        </select>
                    </Field>
                    <div className="flex items-center gap-3">
                        <label className="inline-flex items-center gap-1.5 text-sm text-ink-3"><input type="checkbox" checked={report} onChange={(e) => setReport(e.target.checked)} />Include in report</label>
                        <Button type="submit" disabled={!title.trim() || save.isPending}>Save this window</Button>
                    </div>
                    <div className="md:col-span-4"><ErrorBox error={save.error} /></div>
                </form>
            )}
        </Panel>
    );
}
