"use client";

// A measurement point: the per-meter chart page, by point. Readings come from
// the corrected point views, so only this point's deployment windows show.

import Link from "next/link";
import { useCallback } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { apiGet, fmtDate } from "@/lib/api";
import { ROLE_LABEL } from "@/lib/ops";
import type { PortalProjectDetail } from "@/lib/portal";
import { MeasurementChart } from "@/components/charts/MeasurementChart";
import { PageHeader, Loading, ErrorBox, Badge } from "@/components/ops/ui";

const API = process.env.NEXT_PUBLIC_API_URL;

export default function PortalPointPage() {
    const { id, pointId } = useParams<{ id: string; pointId: string }>();
    const project = useQuery({ queryKey: ["portal-project", id], queryFn: () => apiGet<PortalProjectDetail>(`/ingestion/portal/projects/${id}`) });
    const load = useCallback(async (from: string, to: string) => {
        // Whole SAST days.
        const res = await fetch(`${API}/ingestion/points/${pointId}/readings?from=${encodeURIComponent(`${from}T00:00:00+02:00`)}&to=${encodeURIComponent(`${to}T23:59:59+02:00`)}`, { credentials: "include" });
        return { rows: res.ok ? await res.json() : [], basis: res.headers.get("X-Readings-Source") };
    }, [pointId]);

    if (project.isLoading) return <Loading />;
    if (project.error || !project.data) return <ErrorBox error={project.error ?? "Not found"} />;
    const point = project.data.points.find((p) => p.id === pointId);
    if (!point) return <ErrorBox error="This point is not part of the project." />;

    return (
        <div className="space-y-5">
            <Link href={`/portal/projects/${id}`} className="inline-flex items-center text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4 mr-1" />{project.data.name}</Link>
            <PageHeader title={point.name}
                subtitle={`${ROLE_LABEL[point.role] ?? point.role}${point.nominal_voltage_v ? ` · ${point.nominal_voltage_v} V nominal` : ""}${point.ct_primary_a ? ` · CT ${point.ct_primary_a} A` : ""}${point.metered_since ? ` · metered since ${fmtDate(point.metered_since)}` : ""}`}
                actions={point.metered ? <Badge tone="green">metered</Badge> : <Badge>not metered</Badge>} />
            {project.data.telemetry_visible
                ? <MeasurementChart title={point.name} load={load} />
                : <ErrorBox error="Live data for this project is shared through published reports." />}
        </div>
    );
}
