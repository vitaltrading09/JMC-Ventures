// The assessment summary (GET /ingestion/assessments/:id/summary, built by
// services/ingestion-service/src/reports/summary.ts from the same dataset as
// the reports), and display constants shared by the site workspace.

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export type CategoryState = "ok" | "investigate" | "insufficient";

export interface TypicalDay {
    days: number; band: boolean; basis: string;
    hours: { hour: number; n: number; p10: number | null; median: number | null; p90: number | null }[];
}

export interface Summary {
    context: {
        assessment_id: string; reference: string; site: string; client: string;
        point: { id: string; name: string; role: string } | null;
        points: { id: string; name: string; role: string }[];
        period_from: string; period_to: string; observed_days: number; start_at: string; end_at: string; timezone: string;
        provisional: boolean; data_cutoff_at: string; last_data_at: string | null;
        coverage: { fraction: number | null; expected_slots: number; slots_with_data: number; mixed_cadence: boolean; gaps: number } | null;
    };
    glance: string[];
    metrics: { key: string; label: string; value: number | null; unit: string; at?: string | null; evidence: string; definition: string }[];
    categories: { key: string; title: string; state: CategoryState; label: string; reason: string; evidence: string }[];
    findings: { severity: "act" | "investigate" | "note"; point: string; text: string; evidence: string; confidence: string; who: string }[];
    next: { text: string; who: string }[];
    fingerprint: { weekday: TypicalDay | null; weekend: TypicalDay | null; operating_hours: { from: number; to: number; declared: boolean } | null } | null;
    feasibility: { supplied: string[]; missing: string[]; note: string };
    limitations: string[];
    point_detail: any;
}

export function useSummary(assessmentId: string | null | undefined, pointId?: string | null) {
    return useQuery({
        queryKey: ["assessment-summary", assessmentId, pointId ?? null],
        enabled: !!assessmentId,
        queryFn: () => apiGet<Summary>(`/ingestion/assessments/${assessmentId}/summary${pointId ? `?point=${pointId}` : ""}`),
        refetchInterval: 120_000,
    });
}

/** Stable phase styling across charts, legends, tooltips and PDFs: colour AND dash pattern. */
export const PHASE = {
    A: { color: "#e11d48", dash: undefined as string | undefined, label: "Phase A (L1)" },
    B: { color: "#d97706", dash: "6 3", label: "Phase B (L2)" },
    C: { color: "#2563eb", dash: "2 3", label: "Phase C (L3)" },
} as const;

export const STATE_STYLE: Record<CategoryState, { box: string; text: string; mark: string }> = {
    ok: { box: "border-line-strong bg-surface/40", text: "text-ok", mark: "✓" },
    investigate: { box: "border-amber-500/40 bg-amber-500/5", text: "text-warn", mark: "!" },
    insufficient: { box: "border-dashed border-line-strong bg-transparent", text: "text-muted", mark: "?" },
};

/** Which workspace tab shows the evidence for a dataset section. */
export function tabForEvidence(evidence: string): "energy" | "pq" | "findings" | "summary" | "reports" {
    if (evidence === "demand" || evidence === "energy" || evidence === "patterns") return "energy";
    if (evidence.startsWith("power_quality")) return "pq";
    if (evidence === "coverage") return "reports";
    return "findings";
}
