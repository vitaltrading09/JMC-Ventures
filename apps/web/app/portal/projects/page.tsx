"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmtDate, fmtAgo } from "@/lib/api";
import { num } from "@/lib/format";
import type { PortalProject } from "@/lib/portal";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty } from "@/components/ops/ui";

export default function PortalProjects() {
    const projects = useQuery({ queryKey: ["portal-projects"], queryFn: () => apiGet<PortalProject[]>("/ingestion/portal/projects"), refetchInterval: 60_000 });
    return (
        <div>
            <PageHeader title="Projects" subtitle="Live values are 1-minute averages at the main incomer; today is the South African calendar day." />
            <Panel>
                {projects.isLoading ? <Loading /> : projects.error ? <ErrorBox error={projects.error} /> : (projects.data ?? []).length === 0 ? <Empty>No projects yet.</Empty> : (
                    <Table head={["Project", "Status", "Dates", "Incomer now", "Today", "Coverage 24 h", "Latest report"]}>
                        {projects.data!.map((p) => (
                            <tr key={p.id} className="hover:bg-slate-900/60">
                                <td className="py-2.5 pr-4"><Link href={`/portal/projects/${p.id}`} className="font-medium text-blue-300 hover:underline">{p.name}</Link>
                                    {p.end_client_name && <p className="text-xs text-slate-500">{p.end_client_name}</p>}</td>
                                <td className="py-2.5 pr-4"><Badge tone={p.status === "active" ? "green" : p.status === "planned" ? "blue" : "grey"}>{p.status}</Badge></td>
                                <td className="py-2.5 pr-4 text-xs whitespace-nowrap">{fmtDate(p.starts_on)} – {fmtDate(p.ends_on)}</td>
                                {p.tiles ? (
                                    <>
                                        <td className="py-2.5 pr-4 whitespace-nowrap">{p.tiles.incomer_kw === null ? "–" : `${num(p.tiles.incomer_kw, 1)} kW`}
                                            {p.tiles.incomer_at && <span className="text-xs text-slate-500"> · {fmtAgo(p.tiles.incomer_at)}</span>}</td>
                                        <td className="py-2.5 pr-4">{p.tiles.today_kwh === null ? "–" : `${num(p.tiles.today_kwh)} kWh`}</td>
                                        <td className="py-2.5 pr-4">{p.tiles.coverage_24h === null ? "–" : `${Math.round(p.tiles.coverage_24h * 100)} %`}</td>
                                    </>
                                ) : <td colSpan={3} className="py-2.5 pr-4 text-xs text-slate-500">no live assessment</td>}
                                <td className="py-2.5 pr-4 text-xs">{p.latest_report ? `${p.latest_report.title ?? "Report"} (to ${fmtDate(new Date(new Date(p.latest_report.period_end).getTime() - 1))})` : "none yet"}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Panel>
        </div>
    );
}
