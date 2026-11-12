"use client";

// The consultant's briefing for a measurement point (staff only): a short
// interview about where the meter is connected and what it feeds
// (GET /points/:id/briefing, PATCH /points/:id {context}; questions and wording
// come from services/ingestion-service/src/point-context.ts). One question at a
// time, follow-ups only when they apply, every answer can be changed. Below it:
// what the answers come to, and what they change for each kind of finding.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Check, Pencil } from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { Panel, Button, ErrorBox, Loading, inputClass } from "@/components/ops/ui";

type Question = { id: string; type: "single" | "multi" | "number" | "text"; ask: string; why: string; unit?: string; options?: { value: string; label: string }[] };
type Briefing = {
    point: { id: string; name: string; role: string }; context: Record<string, any>; total: number; answered: number; complete: boolean; next: string | null;
    questions: Question[]; summary: string[]; hints: { kind: string; text: string }[];
};
const KIND_LABEL: Record<string, string> = { sags: "Voltage dips", thd: "Distortion", pf: "Power factor", demand: "Maximum demand", imbalance: "Phase balance", baseload: "After-hours load" };

export function PointBriefings({ points }: { points: { id: string; name: string }[] }) {
    const [sel, setSel] = useState(points[0]?.id ?? "");
    useEffect(() => { if (!points.some((p) => p.id === sel)) setSel(points[0]?.id ?? ""); }, [points, sel]);
    if (!points.length) return null;
    return (
        <Panel title="Consultant briefing" subtitle="A few questions per measurement point. The answers make findings, watch conclusions and the consultant's advice specific to this site.">
            {points.length > 1 && (
                <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Measurement point">
                    {points.map((p) => (
                        <button key={p.id} type="button" role="tab" aria-selected={p.id === sel} onClick={() => setSel(p.id)}
                            className={`rounded-full px-3 py-1.5 text-sm ring-1 ${p.id === sel ? "bg-blue-600 text-white ring-blue-600" : "text-ink-3 ring-line-strong hover:bg-surface-2"}`}>{p.name}</button>
                    ))}
                </div>
            )}
            {sel && <Interview key={sel} pointId={sel} />}
        </Panel>
    );
}

function Interview({ pointId }: { pointId: string }) {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["briefing", pointId], queryFn: () => apiGet<Briefing>(`/ingestion/points/${pointId}/briefing`) });
    const [editing, setEditing] = useState<string | null>(null);
    const [skipped, setSkipped] = useState<string[]>([]);
    const save = useMutation({
        mutationFn: (context: Record<string, any>) => apiSend("PATCH", `/ingestion/points/${pointId}`, { context }),
        onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ["briefing", pointId] }); },
    });
    if (q.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error ?? "Not found"} />;
    const b = q.data;
    const answer = (id: string, value: any) => save.mutate({ ...b.context, [id]: value });
    const active = editing ?? b.questions.find((x) => b.context[x.id] === undefined && !skipped.includes(x.id))?.id ?? null;
    const shown = b.questions.filter((x) => b.context[x.id] !== undefined || x.id === active);
    const labelOf = (x: Question, v: any) => x.type === "multi" ? (v as string[]).map((o) => x.options!.find((p) => p.value === o)?.label ?? o).join(", ")
        : x.type === "single" ? x.options!.find((p) => p.value === v)?.label ?? String(v) : x.type === "number" ? `${v} ${x.unit ?? ""}` : String(v);
    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div>
                <div className="mb-4 flex items-center gap-3">
                    <div className="h-1.5 flex-1 rounded-full bg-surface-3" role="progressbar" aria-valuenow={b.answered} aria-valuemin={0} aria-valuemax={b.total} aria-label="Questions answered">
                        <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${(b.answered / Math.max(1, b.total)) * 100}%` }} />
                    </div>
                    <span className="text-sm tabular-nums text-muted">{b.answered} of {b.total} answered</span>
                </div>
                <ol className="space-y-4">
                    {shown.map((x) => {
                        const isActive = x.id === active;
                        return (
                            <li key={x.id}>
                                <div className="flex gap-2.5">
                                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600/15 text-accent" aria-hidden><MessageSquare className="h-4 w-4" /></span>
                                    <div className="min-w-0">
                                        <p className={`text-[15px] ${isActive ? "font-medium text-ink" : "text-ink-3"}`}>{x.ask}</p>
                                        {isActive && <p className="mt-0.5 text-sm text-muted">{x.why}</p>}
                                    </div>
                                </div>
                                {isActive ? (
                                    <div className="ml-9 mt-3">
                                        <Control x={x} value={b.context[x.id]} busy={save.isPending} onAnswer={(v) => answer(x.id, v)}
                                            onSkip={() => { setEditing(null); if (b.context[x.id] === undefined) setSkipped((s) => [...s, x.id]); }} skipLabel={b.context[x.id] === undefined ? "Not known yet" : "Cancel"} />
                                    </div>
                                ) : (
                                    <div className="ml-9 mt-1.5 flex items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-xl bg-surface-2 px-3 py-1.5 text-[15px] text-ink"><Check className="h-4 w-4 text-ok" aria-hidden />{labelOf(x, b.context[x.id])}</span>
                                        <button type="button" className="inline-flex items-center gap-1 py-1 text-sm text-muted hover:text-ink" onClick={() => setEditing(x.id)}><Pencil className="h-3.5 w-3.5" aria-hidden />Change</button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ol>
                {!active && (
                    <p className="mt-5 text-[15px] text-ink-3">
                        {b.complete ? "That is everything the consultant needs for this point." : "The open questions can be answered later: "}
                        {!b.complete && <button type="button" className="text-accent hover:underline" onClick={() => setSkipped([])}>ask them again</button>}
                    </p>
                )}
                <ErrorBox error={save.error} />
            </div>

            <aside className="space-y-5 rounded-xl bg-surface-2 p-4">
                <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">What we know about {b.point.name}</h4>
                    {b.summary.length ? <ul className="mt-2 space-y-1.5 text-[15px] text-ink-2">{b.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                        : <p className="mt-2 text-[15px] text-muted">Nothing yet. Without answers the advice stays general.</p>}
                </div>
                <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">What this changes in the advice</h4>
                    {b.hints.length ? (
                        <dl className="mt-2 space-y-3">
                            {b.hints.map((h) => <div key={h.kind}><dt className="text-sm font-medium text-ink">{KIND_LABEL[h.kind] ?? h.kind}</dt><dd className="text-sm text-ink-3">{h.text}</dd></div>)}
                        </dl>
                    ) : <p className="mt-2 text-[15px] text-muted">Once the loads and the connection point are known, each kind of finding gets a site-specific note here. Clients see it on the finding.</p>}
                </div>
            </aside>
        </div>
    );
}

function Control({ x, value, busy, onAnswer, onSkip, skipLabel }: { x: Question; value: any; busy: boolean; onAnswer: (v: any) => void; onSkip: () => void; skipLabel: string }) {
    const [multi, setMulti] = useState<string[]>(Array.isArray(value) ? value : []);
    const [text, setText] = useState(value != null && !Array.isArray(value) ? String(value) : "");
    const chip = (on: boolean) => `rounded-xl px-3 py-2 text-left text-[15px] ring-1 ${on ? "bg-blue-600 text-white ring-blue-600" : "text-ink-2 ring-line-strong hover:bg-surface-2"}`;
    const skip = <button type="button" className="py-1 text-sm text-muted hover:text-ink" onClick={onSkip}>{skipLabel}</button>;
    if (x.type === "single") {
        return (
            <div className="flex flex-wrap items-center gap-2">
                {x.options!.map((o) => <button key={o.value} type="button" disabled={busy} className={chip(value === o.value)} onClick={() => onAnswer(o.value)}>{o.label}</button>)}
                {skip}
            </div>
        );
    }
    if (x.type === "multi") {
        const toggle = (v: string) => setMulti((m) => (m.includes(v) ? m.filter((y) => y !== v) : v === "none" ? ["none"] : [...m.filter((y) => y !== "none"), v]));
        return (
            <div>
                <div className="flex flex-wrap gap-2" role="group" aria-label={x.ask}>
                    {x.options!.map((o) => <button key={o.value} type="button" aria-pressed={multi.includes(o.value)} className={chip(multi.includes(o.value))} onClick={() => toggle(o.value)}>{o.label}</button>)}
                </div>
                <div className="mt-3 flex items-center gap-3"><Button disabled={busy || !multi.length} onClick={() => onAnswer(multi)}>Save answer</Button>{skip}</div>
            </div>
        );
    }
    return (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(x.type === "number" ? Number(text) : text.trim()); }}>
            <input className={`${inputClass} ${x.type === "number" ? "w-36" : "w-full max-w-lg"}`} type={x.type === "number" ? "number" : "text"} min={x.type === "number" ? 0 : undefined} step="any"
                value={text} onChange={(e) => setText(e.target.value)} aria-label={x.ask} autoFocus />
            {x.unit && <span className="text-sm text-muted">{x.unit}</span>}
            <Button type="submit" disabled={busy || !text.trim()}>Save answer</Button>{skip}
        </form>
    );
}
