// Types and helpers for the client portal (Phase 8, PR 2).

import { useEffect, useState } from "react";

export interface PortalTiles {
    incomer_kw: number | null;
    incomer_at: string | null;
    today_kwh: number | null;
    coverage_24h: number | null;
    open_alerts: number;
}

export interface PortalProject {
    id: string;
    name: string;
    end_client_name: string | null;
    address: string | null;
    status: string;
    starts_on: string | null;
    ends_on: string | null;
    telemetry_visible: boolean;
    latest_report: { id: string; title: string | null; period_start: string; period_end: string } | null;
    points: number;
    tiles: PortalTiles | null;
}

export interface PortalPoint {
    id: string;
    name: string;
    role: string;
    parent_point_id: string | null;
    nominal_voltage_v: number | null;
    ct_primary_a: number | null;
    contracted_mdi_kva: number | null;
    metered: boolean;
    metered_since: string | null;
    device_id: string | null;
    live: { at: string; kw: number | null; pf: number | null; v: number | null } | null;
}

export interface PortalProjectDetail {
    id: string;
    name: string;
    end_client_name: string | null;
    address: string | null;
    status: string;
    starts_on: string | null;
    ends_on: string | null;
    telemetry_visible: boolean;
    points: PortalPoint[];
}

/** The signed-in user's role, for showing or hiding write controls (the API enforces it). */
export function useRole(): string | null {
    const [role, setRole] = useState<string | null>(null);
    useEffect(() => {
        try {
            const u = JSON.parse(localStorage.getItem("user") || "null");
            const r = u?.role ?? null;
            setRole(r === "admin" ? "client_admin" : r === "viewer" || r === "user" ? "client_viewer" : r);
        } catch { setRole(null); }
    }, []);
    return role;
}

export const canEdit = (role: string | null) => role === "client_admin" || role === "super_admin" || role === "engineer";

/** Points in tree order: each top-level point followed by its children. */
export function pointTree(points: PortalPoint[]): { point: PortalPoint; depth: number }[] {
    const byParent = new Map<string | null, PortalPoint[]>();
    const ids = new Set(points.map((p) => p.id));
    for (const p of points) {
        const parent = p.parent_point_id && ids.has(p.parent_point_id) ? p.parent_point_id : null;
        byParent.set(parent, [...(byParent.get(parent) ?? []), p]);
    }
    const out: { point: PortalPoint; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
        for (const p of byParent.get(parent) ?? []) {
            out.push({ point: p, depth });
            walk(p.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}

/** The default point for per-point tabs: the first top-level incomer, else the first metered point. */
export function defaultPoint(points: PortalPoint[]): PortalPoint | null {
    return points.find((p) => p.role === "incomer" && !p.parent_point_id && p.metered)
        ?? points.find((p) => p.metered) ?? points[0] ?? null;
}
