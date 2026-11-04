"use client";

// Ops home: the morning view. Fleet health, the review queue, projects that
// need attention and data-health counts, each linking to its page.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmtAgo } from "@/lib/api";
import { FleetRow, Project, deviceHealth, projectFlags } from "@/lib/ops";
import { PageHeader, Panel, Stat, Loading, ErrorBox, Empty, RagDot, Button } from "@/components/ops/ui";

export default function OpsHome() {
    const fleet = useQuery({ queryKey: ["fleet"], queryFn: () => apiGet<FleetRow[]>("/ingestion/fleet"), refetchInterval: 60_000 });
    const drafts = useQuery({ queryKey: ["review", "draft"], queryFn: () => apiGet<any[]>("/ingestion/review/recommendations?review_status=draft") });
    const inReview = useQuery({ queryKey: ["review", "in_review"], queryFn: () => apiGet<any[]>("/ingestion/review/recommendations?review_status=in_review") });
    const reports = useQuery({ queryKey: ["reports"], queryFn: () => apiGet<any[]>("/ingestion/reports") });
    const projects = useQuery({ queryKey: ["projects", "all"], queryFn: () => apiGet<Project[]>("/ingestion/projects") });
    const health = useQuery({ queryKey: ["data-health"], queryFn: () => apiGet<any>("/ingestion/ops/data-health"), refetchInterval: 60_000 });

    const boxes = (fleet.data ?? []).filter((d) => d.status !== "retired").map((d) => ({ d, h: deviceHealth(d) }));
    const red = boxes.filter((b) => b.h.rag === "red");
    const amber = boxes.filter((b) => b.h.rag === "amber");
    const deployed = boxes.filter((b) => b.d.status === "deployed").length;
    const attention = (projects.data ?? []).map((p) => ({ p, flags: projectFlags(p) })).filter((x) => x.flags.length);
    const reportsOpen = (reports.data ?? []).filter((r) => r.status !== "published").length;

    return (
        <div className="space-y-6">
            <PageHeader title="Good morning" subtitle="What needs doing today." actions={<Link href="/ops/install"><Button>Install a box</Button></Link>} />
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <Stat label="Boxes deployed" value={fleet.isLoading ? "…" : `${deployed} / ${boxes.length}`} />
                <Stat label="Boxes needing action" value={fleet.isLoading ? "…" : red.length + amber.length} tone={red.length ? "red" : amber.length ? "amber" : "green"} hint={`${red.length} red, ${amber.length} amber`} />
                <Stat label="Findings to review" value={drafts.isLoading ? "…" : (drafts.data?.length ?? 0) + (inReview.data?.length ?? 0)} tone={(drafts.data?.length ?? 0) ? "amber" : "green"} />
                <Stat label="Reports in progress" value={reports.isLoading ? "…" : reportsOpen} />
                <Stat label="Projects needing attention" value={projects.isLoading ? "…" : attention.length} tone={attention.length ? "amber" : "green"} />
            </div>

            <div className="grid lg:grid-cols-2 gap-6">
                <Panel title="Fleet" actions={<Link href="/ops/fleet" className="text-xs text-blue-300 hover:underline">all boxes</Link>}>
                    {fleet.isLoading ? <Loading /> : fleet.error ? <ErrorBox error={fleet.error} /> : red.length + amber.length === 0
                        ? <Empty>Every box is healthy.</Empty> : (
                            <ul className="divide-y divide-slate-800">
                                {[...red, ...amber].slice(0, 10).map(({ d, h }) => (
                                    <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
                                        <RagDot rag={h.rag} />
                                        <Link href={`/ops/fleet/${d.id}`} className="text-blue-300 hover:underline w-28 truncate">{d.code ?? d.name}</Link>
                                        <span className="text-slate-400 flex-1 truncate">{d.project_name ?? "not deployed"}</span>
                                        <span className="text-xs text-amber-300">{h.reasons.join(", ")}</span>
                                        <span className="text-xs text-slate-500 w-20 text-right">{fmtAgo(d.last_seen)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                </Panel>
                <Panel title="Projects needing attention" actions={<Link href="/ops/projects" className="text-xs text-blue-300 hover:underline">all projects</Link>}>
                    {projects.isLoading ? <Loading /> : attention.length === 0 ? <Empty>Nothing due.</Empty> : (
                        <ul className="divide-y divide-slate-800">
                            {attention.slice(0, 10).map(({ p, flags }) => (
                                <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
                                    <Link href={`/ops/projects/${p.id}`} className="text-blue-300 hover:underline flex-1 truncate">{p.name}</Link>
                                    <span className="text-slate-500 text-xs">{p.tenant_name}</span>
                                    <span className="text-xs text-amber-300">{flags.join(", ")}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Panel>
            </div>

            <Panel title="Data health" actions={<Link href="/ops/data-health" className="text-xs text-blue-300 hover:underline">details</Link>}>
                {health.isLoading ? <Loading /> : health.error ? <ErrorBox error={health.error} /> : (
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
                        <span>Silent: <b className={health.data.silent.length ? "text-red-400" : "text-emerald-300"}>{health.data.silent.length}</b></span>
                        <span>Clock drift: <b>{health.data.clock_drift.length}</b></span>
                        <span>Dead letters 24 h: <b>{health.data.dead_letters.last_24h.reduce((a: number, r: any) => a + r.n, 0)}</b></span>
                        <span>Unknown parameters: <b>{health.data.unknown_params.length}</b></span>
                        <span>Register resets: <b>{health.data.registers.length}</b></span>
                    </div>
                )}
            </Panel>
        </div>
    );
}
