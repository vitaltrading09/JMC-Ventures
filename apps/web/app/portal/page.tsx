"use client";

// Client home: the client's sites as tiles. Everything else (findings, charts,
// reports) is one click away inside a site; alerts have their own page.

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { PortalProject } from "@/lib/portal";
import { ProjectCard } from "@/components/portal/ProjectCard";
import { usePortalAssessments } from "@/components/portal/AssessmentBanner";
import { Loading, ErrorBox, Empty } from "@/components/ops/ui";

export default function PortalHome() {
    const projects = useQuery({ queryKey: ["portal-projects"], queryFn: () => apiGet<PortalProject[]>("/ingestion/portal/projects"), refetchInterval: 60_000 });
    const assessments = usePortalAssessments();
    const assessmentFor = (id: string) => (assessments.data ?? []).filter((a) => a.project_id === id)
        .sort((a, b) => Number(b.live) - Number(a.live) || new Date(b.start_at ?? 0).getTime() - new Date(a.start_at ?? 0).getTime())[0] ?? null;
    const sites = (projects.data ?? []).filter((p) => p.status !== "archived");
    const live = sites.filter((p) => assessmentFor(p.id)?.live).length;

    return (
        <div className="max-w-6xl">
            <header className="mb-8">
                <h1 className="text-[28px] font-semibold text-ink">Your sites</h1>
                <p className="mt-1 text-[15px] text-muted">
                    {sites.length ? `${live} of ${sites.length} site${sites.length === 1 ? "" : "s"} being measured now. Open a site to see what was measured, what we found and what to do next.` : " "}
                </p>
            </header>
            {projects.isLoading ? <Loading /> : projects.error ? <ErrorBox error={projects.error} /> : sites.length === 0
                ? <Empty>No sites yet. GridIQ adds your site when your assessment is booked.</Empty> : (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {[...sites].sort((a, b) => Number(!!assessmentFor(b.id)?.live) - Number(!!assessmentFor(a.id)?.live) || a.name.localeCompare(b.name))
                            .map((p) => <ProjectCard key={p.id} p={p} a={assessmentFor(p.id)} />)}
                    </div>
                )}
        </div>
    );
}
