"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { apiGet, fmtDate } from "@/lib/api";
import { PortalProjectDetail, useRole } from "@/lib/portal";
import { PageHeader, Badge, Loading, ErrorBox, Panel } from "@/components/ops/ui";
import {
    OverviewTab, LayoutTab, BalanceTab, LoadProfileTab, DemandTab, PowerQualityTab, FindingsTab, ReportsTab,
} from "@/components/portal/ProjectTabs";
import { ExportsTab } from "@/components/portal/ExportsTab";
import { AssessmentBanner } from "@/components/portal/AssessmentBanner";

const TABS = [
    ["overview", "Overview"], ["layout", "Metering layout"], ["balance", "Energy balance"], ["load", "Load profile"],
    ["demand", "Demand"], ["pq", "Power quality"], ["findings", "Findings"], ["reports", "Reports"], ["exports", "Exports"],
] as const;
type Tab = (typeof TABS)[number][0];
// Tabs that read assessment data: shown only while the caller holds a live assessment.
// Reports stay (final deliverables during the delivery window).
const TELEMETRY_TABS: Tab[] = ["overview", "layout", "balance", "load", "demand", "pq", "findings", "exports"];

export default function PortalProjectPage() {
    const { id } = useParams<{ id: string }>();
    const role = useRole();
    const q = useQuery({ queryKey: ["portal-project", id], queryFn: () => apiGet<PortalProjectDetail>(`/ingestion/portal/projects/${id}`), refetchInterval: 60_000 });
    // ?tab=findings (links from the overview tiles) opens that tab.
    const asked = useSearchParams().get("tab");
    const [tab, setTab] = useState<Tab | null>(TABS.some(([k]) => k === asked) ? (asked as Tab) : null);

    if (q.isLoading) return <Loading />;
    if (q.error || !q.data) return <ErrorBox error={q.error ?? "Not found"} />;
    const p = q.data;
    const tabs = TABS.filter(([k]) => p.telemetry_visible || !TELEMETRY_TABS.includes(k));
    const current: Tab | null = tab && tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0] ?? null;

    return (
        <div className="space-y-5">
            <Link href="/portal/projects" className="inline-flex items-center text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4 mr-1" />Projects</Link>
            <PageHeader title={p.name} subtitle={[p.end_client_name, p.address, p.starts_on ? `${fmtDate(p.starts_on)} – ${fmtDate(p.ends_on)}` : null].filter(Boolean).join(" · ")}
                actions={<Badge tone={p.status === "active" ? "green" : "grey"}>{p.status}</Badge>} />
            <AssessmentBanner projectId={p.id} />
            <div className="flex flex-wrap gap-1 border-b border-slate-800">
                {tabs.map(([k, label]) => (
                    <button key={k} onClick={() => setTab(k)}
                        className={`px-3 py-2 text-sm border-b-2 -mb-px ${current === k ? "border-blue-500 text-white" : "border-transparent text-slate-400 hover:text-white"}`}>{label}</button>
                ))}
            </div>
            {current === "overview" && <OverviewTab project={p} />}
            {current === "layout" && <LayoutTab project={p} />}
            {current === "balance" && <BalanceTab project={p} />}
            {current === "load" && <LoadProfileTab project={p} />}
            {current === "demand" && <DemandTab project={p} />}
            {current === "pq" && <PowerQualityTab project={p} />}
            {current === "findings" && <FindingsTab project={p} />}
            {current === "reports" && <ReportsTab project={p} role={role} />}
            {current === "exports" && <ExportsTab project={p} />}
        </div>
    );
}
