"use client";

// Portal overview: every project at a glance, open alerts, latest published reports.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmtDateTime, TZ_LABEL } from "@/lib/api";
import type { PortalProject } from "@/lib/portal";
import { ProjectCard } from "@/components/portal/ProjectCard";
import { PageHeader, Panel, Loading, ErrorBox, Empty, Badge } from "@/components/ops/ui";

interface Alert { id: string; meter_name: string; type: string; severity: string; message: string; created_at: string; is_read: boolean; }

export default function PortalOverview() {
    const projects = useQuery({ queryKey: ["portal-projects"], queryFn: () => apiGet<PortalProject[]>("/ingestion/portal/projects"), refetchInterval: 60_000 });
    const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => apiGet<Alert[]>("/ingestion/alerts") });
    const open = (alerts.data ?? []).filter((a) => !a.is_read).slice(0, 8);

    return (
        <div className="space-y-6">
            <PageHeader title="Overview" subtitle={`Your projects at a glance. Live values are 1-minute averages; times ${TZ_LABEL}.`} />
            {projects.isLoading ? <Loading /> : projects.error ? <ErrorBox error={projects.error} /> : (projects.data ?? []).length === 0
                ? <Empty>No projects yet.</Empty> : (
                    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {projects.data!.filter((p) => p.status !== "archived").map((p) => <ProjectCard key={p.id} p={p} />)}
                    </div>
                )}
            <Panel title="Open alerts" actions={<Link href="/portal/alerts" className="text-xs text-blue-300 hover:underline">all alerts</Link>}>
                {alerts.isLoading ? <Loading /> : open.length === 0 ? <Empty>No open alerts.</Empty> : (
                    <ul className="divide-y divide-slate-800">
                        {open.map((a) => (
                            <li key={a.id} className="flex items-start gap-3 py-2 text-sm">
                                <Badge tone={a.severity === "CRITICAL" || a.severity === "HIGH" ? "red" : a.severity === "WARNING" || a.severity === "MEDIUM" ? "amber" : "grey"}>{a.severity}</Badge>
                                <span className="text-slate-300 flex-1">{a.meter_name}: {a.message}</span>
                                <span className="text-xs text-slate-500 whitespace-nowrap">{fmtDateTime(a.created_at)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Panel>
        </div>
    );
}
