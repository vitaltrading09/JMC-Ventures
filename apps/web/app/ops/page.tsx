"use client";

// Ops home (GridIQ, prompt section 7): clients and live assessments, the fleet
// map, fleet status (lifecycle separate from health), assessments ending soon,
// reports awaiting review, data and commissioning exceptions, and maintenance /
// calibration due. Every tile links to its page.

import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, fmtAgo, fmtDateTime, fmtDate, TZ_LABEL } from "@/lib/api";
import { FleetRow, deviceHealth } from "@/lib/ops";
import { Assessment, STATUS_LABEL, STATUS_TONE } from "@/lib/assessments";
import { PageHeader, Panel, Stat, Loading, ErrorBox, Empty, RagDot, Button, Badge } from "@/components/ops/ui";
import { FleetMap } from "@/components/ops/FleetMap";

const DAY = 86_400_000;

export default function OpsHome() {
    const fleet = useQuery({ queryKey: ["fleet"], queryFn: () => apiGet<FleetRow[]>("/ingestion/fleet"), refetchInterval: 60_000 });
    const assessments = useQuery({ queryKey: ["assessments"], queryFn: () => apiGet<Assessment[]>("/ingestion/assessments"), refetchInterval: 60_000 });
    const drafts = useQuery({ queryKey: ["review", "draft"], queryFn: () => apiGet<any[]>("/ingestion/review/recommendations?review_status=draft") });
    const inReview = useQuery({ queryKey: ["review", "in_review"], queryFn: () => apiGet<any[]>("/ingestion/review/recommendations?review_status=in_review") });
    const reports = useQuery({ queryKey: ["reports"], queryFn: () => apiGet<any[]>("/ingestion/reports") });
    const health = useQuery({ queryKey: ["data-health"], queryFn: () => apiGet<any>("/ingestion/ops/data-health"), refetchInterval: 60_000 });

    const now = Date.now();
    const all = assessments.data ?? [];
    const live = all.filter((a) => a.live);
    const clients = new Set(live.map((a) => a.tenant_name));
    const endingSoon = live.filter((a) => a.remaining_ms < 2 * DAY).sort((a, b) => a.remaining_ms - b.remaining_ms);
    const toStart = all.filter((a) => a.effective_status === "scheduled" || (a.effective_status === "draft" && a.payment_state === "paid"));
    const unpaid = all.filter((a) => (a.effective_status === "draft" || a.effective_status === "scheduled") && a.payment_state !== "paid" && a.payment_state !== "exception");
    const deletionSoon = all.filter((a) => a.retention_until && new Date(a.retention_until).getTime() - now < 14 * DAY && a.retention_status === "retained");

    const boxes = (fleet.data ?? []).filter((d) => d.status !== "retired");
    const byStatus = (s: string) => boxes.filter((d) => d.status === s).length;
    const exceptions = boxes.filter((d) => d.status === "deployed").map((d) => ({ d, h: deviceHealth(d) })).filter((x) => x.h.rag === "red" || x.h.rag === "amber");
    const commissioning = boxes.filter((d) => d.commissioning && d.commissioning !== "pass");
    const calDue = boxes.filter((d) => d.calibration_due_on && new Date(d.calibration_due_on).getTime() - now < 30 * DAY)
        .sort((a, b) => new Date(a.calibration_due_on!).getTime() - new Date(b.calibration_due_on!).getTime());
    const reportsOpen = (reports.data ?? []).filter((r) => r.status !== "published");
    const findings = (drafts.data?.length ?? 0) + (inReview.data?.length ?? 0);
    const quiet = [
        ...(!assessments.isLoading && endingSoon.length === 0 && deletionSoon.length === 0 ? ["nothing ends in the next 48 h"] : []),
        ...(!fleet.isLoading && exceptions.length + commissioning.length === 0 ? ["every deployed meter is reporting normally"] : []),
        ...(!fleet.isLoading && calDue.length === 0 ? ["no maintenance or calibration due within 30 days"] : []),
    ];

    return (
        <div className="space-y-6">
            <PageHeader title="GridIQ operations" subtitle={`Assessments, fleet and deliverables. Times in ${TZ_LABEL}.`}
                actions={<>
                    <Link href="/ops/assessments?new=1"><Button>New assessment</Button></Link>
                    <Link href="/ops/install"><Button variant="secondary">Deploy meter</Button></Link>
                </>} />

            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                <Stat label="Clients with live assessments" value={assessments.isLoading ? "…" : clients.size} hint={`${live.length} live assessment(s)`} />
                <Stat label="Ending within 48 h" value={assessments.isLoading ? "…" : endingSoon.length} tone={endingSoon.length ? "amber" : undefined} />
                <Stat label="Waiting to start" value={assessments.isLoading ? "…" : toStart.length} hint={`${unpaid.length} awaiting payment`} />
                <Stat label="Meter assets deployed / available" value={fleet.isLoading ? "…" : `${byStatus("deployed")} / ${byStatus("available")}`}
                    hint={`${byStatus("reserved")} reserved · ${byStatus("in_transit")} in transit · ${byStatus("maintenance")} maintenance`} />
                <Stat label="Data / commissioning exceptions" value={fleet.isLoading ? "…" : exceptions.length + commissioning.length} tone={exceptions.length + commissioning.length ? "amber" : "green"} />
                <Stat label="To review" value={drafts.isLoading ? "…" : findings + reportsOpen.length} hint={`${findings} findings · ${reportsOpen.length} reports`} tone={findings + reportsOpen.length ? "amber" : "green"} />
            </div>

            <div className="grid lg:grid-cols-5 gap-6 items-start">
                <Panel title="Clients and assessments" className="lg:col-span-3" actions={<Link href="/ops/assessments" className="text-xs text-blue-300 hover:underline">all assessments</Link>}>
                    {assessments.isLoading ? <Loading /> : assessments.error ? <ErrorBox error={assessments.error} /> :
                        live.length + toStart.length === 0 ? <Empty>No live or upcoming assessments. <Link className="text-blue-300 hover:underline" href="/ops/assessments?new=1">Create one</Link>.</Empty> : (
                            <ul className="divide-y divide-slate-800">
                                {[...live.sort((a, b) => a.remaining_ms - b.remaining_ms), ...toStart].slice(0, 12).map((a) => (
                                    <li key={a.id} className="py-2 text-sm flex items-center gap-3">
                                        <Badge tone={STATUS_TONE[a.effective_status]}>{STATUS_LABEL[a.effective_status]}</Badge>
                                        <Link href={`/ops/assessments/${a.id}`} className="text-blue-300 hover:underline w-24 shrink-0">{a.reference}</Link>
                                        <span className="flex-1 truncate"><span className="text-slate-200">{a.tenant_name}</span> <span className="text-slate-500">· {a.project_name}</span></span>
                                        <span className="text-xs text-slate-400 w-40 text-right">{a.live ? `${a.remaining} left` : a.planned_start_at ? `planned ${fmtDate(a.planned_start_at)}` : a.payment_state}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                </Panel>
                <Panel title="Fleet map" className="lg:col-span-2" actions={<Link href="/ops/fleet" className="text-xs text-blue-300 hover:underline">fleet</Link>}>
                    {fleet.isLoading ? <Loading /> : fleet.error ? <ErrorBox error={fleet.error} /> : <FleetMap fleet={fleet.data ?? []} />}
                </Panel>
            </div>

            {/* Content-sized queues: an empty queue is one line below, not half a screen. */}
            {quiet.length > 0 && <p className="text-sm text-slate-400">All clear: {quiet.join(" · ")}.</p>}
            <div className="grid lg:grid-cols-3 gap-6 items-start">
                {(endingSoon.length > 0 || deletionSoon.length > 0) && <Panel title="Ending soon" subtitle="Access stops exactly at the end time">
                    {endingSoon.length === 0 ? <Empty>Nothing ends in the next 48 hours.</Empty> : (
                        <ul className="text-sm space-y-1.5">{endingSoon.map((a) => (
                            <li key={a.id} className="flex gap-2"><Link className="text-blue-300 hover:underline" href={`/ops/assessments/${a.id}`}>{a.reference}</Link>
                                <span className="text-slate-400 flex-1 truncate">{a.tenant_name}</span><span className="text-amber-300 text-xs">{fmtDateTime(a.effective_end_at)}</span></li>
                        ))}</ul>
                    )}
                    {deletionSoon.length > 0 && <>
                        <h3 className="text-xs uppercase tracking-wider text-slate-500 mt-4 mb-1">Data deletion within 14 days</h3>
                        <ul className="text-sm space-y-1">{deletionSoon.map((a) => (
                            <li key={a.id}><Link className="text-blue-300 hover:underline" href={`/ops/assessments/${a.id}`}>{a.reference}</Link> <span className="text-slate-400">{fmtDate(a.retention_until)}</span></li>
                        ))}</ul>
                    </>}
                </Panel>}
                {(fleet.isLoading || exceptions.length + commissioning.length > 0) && <Panel title="Data and commissioning exceptions" actions={<Link href="/ops/data-health" className="text-xs text-blue-300 hover:underline">data health</Link>}>
                    {fleet.isLoading ? <Loading /> : exceptions.length + commissioning.length === 0 ? <Empty>Every deployed meter is reporting normally.</Empty> : (
                        <ul className="divide-y divide-slate-800">
                            {[...exceptions.map((x) => ({ d: x.d, rag: x.h.rag, why: x.h.reasons.join(", ") })),
                              ...commissioning.filter((d) => !exceptions.some((x) => x.d.id === d.id)).map((d) => ({ d, rag: "amber" as const, why: `commissioning ${d.commissioning}` }))]
                                .slice(0, 10).map(({ d, rag, why }) => (
                                    <li key={d.id} className="flex items-center gap-2 py-1.5 text-sm">
                                        <RagDot rag={rag} />
                                        <Link href={`/ops/fleet/${d.id}`} className="text-blue-300 hover:underline w-24 truncate">{d.code ?? d.name}</Link>
                                        <span className="text-xs text-amber-300 flex-1 truncate">{why}</span>
                                        <span className="text-xs text-slate-500">{fmtAgo(d.last_seen)}</span>
                                    </li>
                                ))}
                        </ul>
                    )}
                    {health.data && <p className="text-xs text-slate-500 mt-3">Dead letters 24 h: {health.data.dead_letters.last_24h.reduce((a: number, r: any) => a + r.n, 0)} · unmapped channels: {health.data.unknown_params.length} · register resets: {health.data.registers.length}</p>}
                </Panel>}
                {(fleet.isLoading || calDue.length > 0) && <Panel title="Maintenance and calibration due" subtitle="Within 30 days or overdue">
                    {fleet.isLoading ? <Loading /> : calDue.length === 0 ? <Empty>Nothing due.</Empty> : (
                        <ul className="text-sm space-y-1.5">{calDue.slice(0, 10).map((d) => {
                            const overdue = new Date(d.calibration_due_on!).getTime() < now;
                            return <li key={d.id} className="flex gap-2"><Link className="text-blue-300 hover:underline" href={`/ops/fleet/${d.id}`}>{d.code ?? d.name}</Link>
                                <span className="text-slate-400 flex-1">{d.status}</span><span className={overdue ? "text-red-400 text-xs" : "text-amber-300 text-xs"}>{overdue ? "overdue " : ""}{fmtDate(d.calibration_due_on)}</span></li>;
                        })}</ul>
                    )}
                </Panel>}
            </div>

            <BookingRequests />

            <Panel title="Awaiting review" actions={<Link href="/ops/review" className="text-xs text-blue-300 hover:underline">review</Link>}>
                <div className="flex gap-6 text-sm">
                    <span>Findings: <b className={findings ? "text-amber-300" : "text-emerald-300"}>{findings}</b> <span className="text-slate-500">(drafts and in review)</span></span>
                    <span>Reports not yet issued: <b className={reportsOpen.length ? "text-amber-300" : "text-emerald-300"}>{reportsOpen.length}</b></span>
                </div>
            </Panel>
        </div>
    );
}

const PURPOSE: Record<string, string> = { follow_up: "Follow-up", verify_improvement: "Verify improvement", new_site: "New site", other: "Other" };

/** Booking requests from clients ("Book a follow-up assessment"). Shown while any is open. */
function BookingRequests() {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["booking-requests"], queryFn: () => apiGet<any[]>("/ingestion/booking-requests"), refetchInterval: 60_000 });
    const set = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => apiSend("PATCH", `/ingestion/booking-requests/${id}`, { status }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["booking-requests"] }) });
    const open = (q.data ?? []).filter((b) => b.status === "new" || b.status === "contacted");
    if (!open.length) return null;
    return (
        <Panel title={`Booking requests (${open.length})`} subtitle="Clients asking for a follow-up or new assessment">
            <ul className="divide-y divide-slate-800">
                {open.map((b) => (
                    <li key={b.id} className="py-2.5 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
                        <Badge tone={b.status === "new" ? "amber" : "blue"}>{b.status}</Badge>
                        <span className="text-slate-200">{b.tenant_name}{b.project_name ? ` · ${b.project_name}` : ""}</span>
                        <span className="text-slate-400">{PURPOSE[b.purpose] ?? b.purpose}{b.duration_days ? `, ${b.duration_days} days` : ""}{b.preferred_start ? `, from ${fmtDate(b.preferred_start)}` : ""}</span>
                        <span className="text-slate-500">{[b.contact_name, b.contact_phone, b.requested_by_email].filter(Boolean).join(" · ")}</span>
                        <span className="text-xs text-slate-500">{fmtAgo(b.created_at)}</span>
                        <select aria-label="Status" className="ml-auto rounded bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-slate-200" value={b.status} onChange={(e) => set.mutate({ id: b.id, status: e.target.value })}>
                            {["new", "contacted", "booked", "declined"].map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                        {b.notes && <p className="basis-full text-slate-400">{b.notes}</p>}
                    </li>
                ))}
            </ul>
        </Panel>
    );
}
