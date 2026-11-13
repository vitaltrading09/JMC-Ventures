"use client";

// The client's sites, each with its assessment state (the thing that decides
// what the client can see), today's energy and data completeness.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { num } from "@/lib/format";
import type { PortalProject } from "@/lib/portal";
import { usePortalAssessments } from "@/components/portal/AssessmentBanner";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty } from "@/components/ops/ui";

export default function PortalSites() {
    const projects = useQuery({ queryKey: ["portal-projects"], queryFn: () => apiGet<PortalProject[]>("/ingestion/portal/projects"), refetchInterval: 60_000 });
    const assessments = usePortalAssessments();
    const latestFor = (id: string) => (assessments.data ?? []).filter((a) => a.project_id === id)
        .sort((a, b) => Number(b.live) - Number(a.live) || new Date(b.start_at ?? 0).getTime() - new Date(a.start_at ?? 0).getTime())[0] ?? null;
    return (
        <div>
            <PageHeader title="Sites" subtitle={`Each site's assessment decides what you can see: live data during it, final reports after it. Times ${TZ_LABEL}.`} />
            <Panel>
                {projects.isLoading ? <Loading /> : projects.error ? <ErrorBox error={projects.error} /> : (projects.data ?? []).length === 0 ? <Empty>No sites yet.</Empty> : (
                    <div className="overflow-x-auto">
                        <Table head={["Site", "Assessment", "Window", "Today", "Data, last 24 h", "Latest issued report"]}>
                            {projects.data!.filter((p) => p.status !== "archived").map((p) => {
                                const a = latestFor(p.id);
                                return (
                                    <tr key={p.id} className="hover:bg-surface-2/60 align-top">
                                        <td className="py-2.5 pr-4"><Link href={`/portal/projects/${p.id}`} className="font-medium text-accent hover:underline">{p.name}</Link>
                                            <p className="text-xs text-faint">{[p.end_client_name, p.address].filter(Boolean).join(" · ")}</p></td>
                                        <td className="py-2.5 pr-4 whitespace-nowrap">
                                            {!a ? <Badge>none</Badge> : a.live ? <><Badge tone="blue">Live</Badge> <span className="text-xs text-muted tabular-nums">{a.reference} · {a.remaining} left</span></>
                                                : a.effective_status === "ended" ? <><Badge>Ended</Badge> <span className="text-xs text-muted">{a.reference}</span></>
                                                : <><Badge tone="amber">Not started</Badge> <span className="text-xs text-muted">{a.reference}</span></>}
                                        </td>
                                        <td className="py-2.5 pr-4 text-xs whitespace-nowrap tabular-nums">{a?.start_at ? `${fmtDateTime(a.start_at)} → ${fmtDateTime(a.effective_end_at)}` : "–"}</td>
                                        <td className="py-2.5 pr-4 tabular-nums">{p.tiles?.today_kwh != null ? `${num(p.tiles.today_kwh)} kWh` : "–"}</td>
                                        <td className="py-2.5 pr-4 tabular-nums">{p.tiles?.coverage_24h != null ? <span className={p.tiles.coverage_24h < 0.95 ? "text-warn" : ""}>{Math.round(p.tiles.coverage_24h * 100)} %</span> : "–"}</td>
                                        <td className="py-2.5 pr-4 text-xs">{p.latest_report ? `${p.latest_report.title ?? "Report"} (to ${fmtDate(new Date(new Date(p.latest_report.period_end).getTime() - 1))})` : "none yet"}</td>
                                    </tr>
                                );
                            })}
                        </Table>
                    </div>
                )}
            </Panel>
        </div>
    );
}
