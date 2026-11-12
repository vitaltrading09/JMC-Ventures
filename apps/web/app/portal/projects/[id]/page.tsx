"use client";

// A site workspace (engineering UI brief §4): one persistent context strip and
// six views: Summary, Energy and demand, Power quality, Findings, Reports and
// data, Site details. Everything reads the live assessment of THIS site; a
// client without one sees the access state and the Reports view only.

import Link from "next/link";
import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { apiGet } from "@/lib/api";
import { PortalProjectDetail, useRole } from "@/lib/portal";
import { useSummary } from "@/lib/summary";
import { PageHeader, Loading, ErrorBox } from "@/components/ops/ui";
import { OverviewTab, LayoutTab, EnergyDemandTab, FindingsTab, ReportsTab } from "@/components/portal/ProjectTabs";
import { ExportsTab } from "@/components/portal/ExportsTab";
import { AssessmentBanner, usePortalAssessments } from "@/components/portal/AssessmentBanner";
import { SiteHeader } from "@/components/portal/SiteHeader";
import { SummaryTab } from "@/components/portal/SummaryTab";
import { PowerQualityView } from "@/components/portal/PowerQualityView";

const TABS = [
    ["summary", "Summary"], ["energy", "Energy and demand"], ["pq", "Power quality"], ["findings", "Findings and actions"],
    ["reports", "Reports and data"], ["site", "Site details"],
] as const;
type Tab = (typeof TABS)[number][0];
// Old links (?tab=findings, ?tab=demand …) still land somewhere sensible.
const ALIAS: Record<string, Tab> = { overview: "summary", balance: "energy", load: "energy", demand: "energy", layout: "site", exports: "reports" };

export default function PortalProjectPage() {
    const { id } = useParams<{ id: string }>();
    const role = useRole();
    const q = useQuery({ queryKey: ["portal-project", id], queryFn: () => apiGet<PortalProjectDetail>(`/ingestion/portal/projects/${id}`), refetchInterval: 60_000 });
    const mine = usePortalAssessments();
    const live = (mine.data ?? []).find((a) => a.project_id === id && a.live) ?? null;
    const [pointId, setPointId] = useState<string | null>(null);
    const summary = useSummary(live?.id, pointId);
    const asked = useSearchParams().get("tab") ?? "";
    const initial: Tab = (TABS.some(([k]) => k === asked) ? asked : ALIAS[asked]) as Tab ?? "summary";
    const [tab, setTab] = useState<Tab>(initial ?? "summary");

    if (q.isLoading || mine.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error ?? "Not found"} />;
    const p = q.data;
    const telemetry = p.telemetry_visible;
    const tabs = TABS.filter(([k]) => telemetry || k === "reports");
    const current: Tab = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
    const s = summary.data;
    const effectivePoint = pointId ?? s?.context.point?.id ?? null;

    return (
        <div className="space-y-5">
            <Link href="/portal/projects" className="inline-flex items-center text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4 mr-1" />Sites</Link>
            <PageHeader title={p.name} subtitle={[p.end_client_name, p.address].filter(Boolean).join(" · ")} />
            {live ? <SiteHeader a={live} summary={s} pointId={effectivePoint} onPoint={setPointId} /> : <AssessmentBanner projectId={p.id} />}
            <nav aria-label="Site views" className="flex flex-wrap gap-1 border-b border-slate-800" role="tablist">
                {tabs.map(([k, label]) => (
                    <button key={k} role="tab" aria-selected={current === k} onClick={() => setTab(k)}
                        className={`px-3 py-2 text-[15px] border-b-2 -mb-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 ${current === k ? "border-blue-500 text-white" : "border-transparent text-slate-400 hover:text-white"}`}>{label}</button>
                ))}
            </nav>
            {current === "summary" && (live
                ? summary.isLoading ? <Loading label="Building the summary" /> : summary.error ? <ErrorBox error={summary.error} /> : s && <SummaryTab s={s} onTab={setTab} />
                : <OverviewTab project={p} />)}
            {current === "energy" && <EnergyDemandTab project={p} since={live?.start_at ?? null} pointId={effectivePoint} />}
            {current === "pq" && (live
                ? summary.isLoading ? <Loading label="Assessing" /> : s ? <PowerQualityView detail={s.point_detail} period={{ from: s.context.period_from, to: s.context.period_to }} /> : <ErrorBox error={summary.error} />
                : <ErrorBox error="Power quality is shown during a live assessment." />)}
            {current === "findings" && <FindingsTab project={p} />}
            {current === "reports" && (
                <div className="space-y-6">
                    <ReportsTab project={p} role={role} />
                    {telemetry && <ExportsTab project={p} />}
                </div>
            )}
            {current === "site" && <LayoutTab project={p} />}
        </div>
    );
}
