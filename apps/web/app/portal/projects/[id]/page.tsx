"use client";

// A site workspace. The portal sidebar lists this site's sections (lib/siteNav.ts),
// so the page itself only shows the site name, one compact context strip and
// the chosen section: Overview (glance, numbers, finding tiles, typical day),
// Findings, a finding's own page, Energy and demand, Power quality,
// Investigation, Reports and data, Site details. Everything reads the live
// assessment of THIS site; a client without one sees the access state and
// the Reports section only.

import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";
import { PortalProjectDetail, useRole } from "@/lib/portal";
import { useSummary } from "@/lib/summary";
import { SITE_VIEWS, siteHref, viewFrom, type SiteView } from "@/lib/siteNav";
import { Loading, ErrorBox, Empty, Panel } from "@/components/ops/ui";
import { OverviewTab, EnergyDemandTab } from "@/components/portal/ProjectTabs";
import { ExportsTab } from "@/components/portal/ExportsTab";
import { AssessmentBanner, usePortalAssessments } from "@/components/portal/AssessmentBanner";
import { SiteHeader } from "@/components/portal/SiteHeader";
import { SummaryTab } from "@/components/portal/SummaryTab";
import { PowerQualityView } from "@/components/portal/PowerQualityView";
import { InvestigateView } from "@/components/portal/InvestigateView";
import { FindingTiles } from "@/components/portal/FindingTiles";
import { FindingDetail } from "@/components/portal/FindingDetail";
import { EnergyView } from "@/components/portal/EnergyView";
import { ReportsView } from "@/components/portal/ReportsView";
import { SkeletonPage } from "@/components/portal/Insight";
import { SiteDetails, startingPoints } from "@/components/portal/SiteDetails";

export default function PortalSitePage() {
    const { id } = useParams<{ id: string }>();
    const params = useSearchParams();
    const router = useRouter();
    const role = useRole();
    const q = useQuery({ queryKey: ["portal-project", id], queryFn: () => apiGet<PortalProjectDetail>(`/ingestion/portal/projects/${id}`), refetchInterval: 60_000 });
    const mine = usePortalAssessments();
    const live = (mine.data ?? []).find((a) => a.project_id === id && a.live) ?? null;
    const ended = (mine.data ?? []).filter((a) => a.project_id === id && a.effective_status === "ended").sort((a, b) => new Date(b.effective_end_at ?? 0).getTime() - new Date(a.effective_end_at ?? 0).getTime())[0] ?? null;
    const [pointId, setPointId] = useState<string | null>(null);
    const summary = useSummary(live?.id, pointId);
    const findings = useQuery({ queryKey: ["findings", id], enabled: !!q.data?.telemetry_visible, queryFn: () => apiGet<any[]>(`/ingestion/sites/${id}/recommendations`) });
    const cases = useQuery({ queryKey: ["cases", live?.id], enabled: !!live, queryFn: () => apiGet<any[]>(`/ingestion/assessments/${live!.id}/cases`) });
    const go = (v: SiteView) => router.push(siteHref(id, v));

    if (q.isLoading || mine.isLoading) return <SkeletonPage />;
    if (q.error || !q.data) return <ErrorBox error={q.error ?? "Not found"} />;
    const p = q.data;
    const telemetry = p.telemetry_visible;
    const asked = viewFrom(params);
    const allowed = (v: SiteView) => v === "reports" || v === "overview" || (telemetry && (v !== "investigate" || !!live));
    const view: SiteView = allowed(asked) ? asked : telemetry ? "overview" : "reports";
    const s = summary.data;
    const effectivePoint = pointId ?? s?.context.point?.id ?? null;
    const list = findings.data ?? [];
    const title = view === "finding" || view === "overview" ? null : SITE_VIEWS.find((v) => v.key === view)?.label;
    const fid = params.get("f");

    return (
        <div className="space-y-6 max-w-[1400px]">
            <header>
                <h1 className="text-[28px] font-semibold text-ink leading-tight">{p.name}</h1>
                {p.address && <p className="text-[15px] text-muted">{p.address}</p>}
            </header>
            {live ? <SiteHeader a={live} summary={s} pointId={effectivePoint} onPoint={setPointId} /> : <AssessmentBanner projectId={p.id} />}
            {title && <h2 className="text-xl font-semibold text-ink pt-2">{title}</h2>}

            {view === "overview" && (live
                ? summary.isLoading ? <SkeletonPage /> : summary.error ? <ErrorBox error={summary.error} />
                    : s && <SummaryTab s={s} assessment={live} projectId={p.id} findings={list} cases={cases.data} onTab={(t) => go(t === "summary" ? "overview" : t)} />
                : telemetry ? <OverviewTab project={p} /> : <Empty>Live data is shown during an assessment. Final reports are under Reports and data.</Empty>)}

            {view === "findings" && (
                <div className="space-y-4">
                    <p className="text-[15px] text-muted max-w-3xl">Each finding opens on its own page: what was measured, why it can matter, what to check, the follow-up, and the charts behind it.</p>
                    {findings.isLoading ? <Loading /> : <FindingTiles projectId={p.id} findings={list} cases={cases.data} />}
                </div>
            )}
            {view === "finding" && (findings.isLoading ? <Loading /> : (
                <FindingDetail f={list.find((f) => f.id === fid) ?? null} c={(cases.data ?? []).find((c) => c.recommendation_id === fid) ?? null}
                    project={p} live={live} role={role} findings={list} />
            ))}

            {view === "energy" && (live && s && effectivePoint
                ? <EnergyView project={p} s={s} since={live.start_at} pointId={effectivePoint} />
                : live && summary.isLoading ? <SkeletonPage /> : <EnergyDemandTab project={p} since={live?.start_at ?? null} pointId={effectivePoint} />)}
            {view === "pq" && (live
                ? summary.isLoading ? <Loading label="Assessing" /> : s ? <PowerQualityView detail={s.point_detail} period={{ from: s.context.period_from, to: s.context.period_to }} /> : <ErrorBox error={summary.error} />
                : <Empty>Power quality is shown during a live assessment.</Empty>)}
            {view === "investigate" && live && effectivePoint && (
                <InvestigateView assessment={live} pointId={effectivePoint} points={p.points} role={role} starts={startingPoints(s)}
                    initial={params.get("from") && params.get("to") ? { from: params.get("from")!, to: params.get("to")! } : null}
                    findings={list.map((f) => ({ id: f.id, title: f.title }))} />
            )}
            {view === "reports" && (
                <div className="space-y-8">
                    <ReportsView project={p} a={live} ended={ended} s={s} role={role} />
                    {s && (
                        <Panel title="Feasibility handover" subtitle={s.feasibility.note}>
                            <p className="text-[15px] text-ink-2">Supplied: {s.feasibility.supplied.join("; ")}.</p>
                            {s.feasibility.missing.length > 0 && <p className="text-[15px] text-ink-2 mt-2">Still missing: {s.feasibility.missing.join("; ")}.</p>}
                        </Panel>
                    )}
                    {telemetry && <ExportsTab project={p} />}
                </div>
            )}
            {view === "site" && <SiteDetails project={p} s={s} />}
        </div>
    );
}
