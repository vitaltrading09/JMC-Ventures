// Shared types and health rules for the ops console (Phase 8).

import type { Rag } from "@/components/ops/ui";

export interface FleetRow {
    id: string;
    code: string | null;
    name: string;
    serial_number: string | null;
    model: string | null;
    status: "available" | "reserved" | "in_transit" | "deployed" | "maintenance" | "retired";
    mqtt_username: string | null;
    calibration_due_on: string | null;
    firmware: string | null;
    comms_module: string | null;
    deployment_id: string | null;
    installed_at: string | null;
    commissioning: string | null;
    point_id: string | null;
    point_name: string | null;
    point_role: string | null;
    project_id: string | null;
    project_name: string | null;
    tenant_name: string | null;
    last_seen: string | null;
    coverage_24h: string | number | null;
    /** The box's reporting interval (median sample spacing), seconds. */
    spacing_s: string | number | null;
    clock_drift_s: string | number | null;
    payload_bytes_24h: string | number | null;
}

export interface Project {
    id: string;
    tenant_id: string;
    tenant_name: string;
    name: string;
    end_client_name: string | null;
    address: string | null;
    status: "planned" | "active" | "completed" | "archived";
    starts_on: string | null;
    ends_on: string | null;
    live_data_visible: boolean;
    points: number;
    active_deployments: number;
    coverage_24h: string | number | null;
    last_report_end: string | null;
    reports_in_progress: number;
    timezone: string;
    notes: string | null;
}

export const SILENT_MIN = 15;

/**
 * Health of a box, for the fleet board.
 *   red:   deployed and silent for 15 min (or three reporting intervals, if
 *          longer), under 80 % coverage, drift ≥ 30 s,
 *          or a failed commissioning check
 *   amber: under 95 % coverage, drift ≥ 5 s, calibration due within 30 days
 *          (or overdue), or a commissioning warning
 *   grey:  not deployed
 */
export function deviceHealth(d: FleetRow, now = Date.now()): { rag: Rag; reasons: string[] } {
    const reasons: string[] = [];
    const cov = d.coverage_24h === null ? null : Number(d.coverage_24h);
    const drift = d.clock_drift_s === null ? null : Number(d.clock_drift_s);
    const silentMs = d.last_seen ? now - new Date(d.last_seen).getTime() : Infinity;
    const calDays = d.calibration_due_on ? (new Date(d.calibration_due_on).getTime() - now) / 86_400_000 : null;

    if (calDays !== null && calDays < 30) reasons.push(calDays < 0 ? "calibration overdue" : "calibration due soon");
    if (d.status !== "deployed") return { rag: reasons.length ? "amber" : "grey", reasons };

    let red = false, amber = calDays !== null && calDays < 30;
    const silentAfterMs = Math.max(SILENT_MIN * 60_000, 3 * (Number(d.spacing_s) || 0) * 1000);
    if (silentMs > silentAfterMs) { red = true; reasons.push(d.last_seen ? "silent" : "no data yet"); }
    if (cov !== null && cov < 0.8) { red = true; reasons.push(`coverage ${Math.round(cov * 100)} %`); }
    else if (cov !== null && cov < 0.95) { amber = true; reasons.push(`coverage ${Math.round(cov * 100)} %`); }
    if (drift !== null && drift >= 30) { red = true; reasons.push(`clock ${drift} s off`); }
    else if (drift !== null && drift >= 5) { amber = true; reasons.push(`clock ${drift} s off`); }
    if (d.commissioning === "fail") { red = true; reasons.push("commissioning failed"); }
    else if (d.commissioning === "warn" || d.commissioning === "pending") { amber = true; reasons.push(`commissioning ${d.commissioning}`); }
    return { rag: red ? "red" : amber ? "amber" : "green", reasons };
}

export function fmtBytes(v: unknown): string {
    const n = Number(v) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
    return `${n} B`;
}

export const pct = (v: unknown) => (v === null || v === undefined ? "–" : `${Math.round(Number(v) * 100)} %`);

export const ROLE_LABEL: Record<string, string> = {
    incomer: "Incomer", sub_load: "Sub-load", pv: "PV", bess: "Battery", generator: "Generator", other: "Other",
};

/** What needs attention on a project, for the list. */
export function projectFlags(p: Project, now = Date.now()): string[] {
    const flags: string[] = [];
    if (p.status !== "active") return flags;
    if (p.ends_on) {
        const days = (new Date(p.ends_on).getTime() - now) / 86_400_000;
        if (days < 0) flags.push("past end date");
        else if (days <= 14) flags.push(`ends in ${Math.ceil(days)} d`);
    }
    if (p.active_deployments > 0 && p.coverage_24h !== null && Number(p.coverage_24h) < 0.95) flags.push(`coverage ${pct(p.coverage_24h)}`);
    if (p.active_deployments === 0) flags.push("no box installed");
    const lastReport = p.last_report_end ? new Date(p.last_report_end).getTime() : null;
    if ((p.ends_on && new Date(p.ends_on).getTime() < now && (!lastReport || lastReport < new Date(p.ends_on).getTime()))
        || (!lastReport && p.starts_on && now - new Date(p.starts_on).getTime() > 35 * 86_400_000)
        || (lastReport && now - lastReport > 35 * 86_400_000)) flags.push("report due");
    return flags;
}
