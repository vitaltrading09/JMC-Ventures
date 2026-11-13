// Sections of a site workspace (/portal/projects/<id>?view=…). The portal
// sidebar switches to these when a site is open, so the site page needs no
// tab row of its own.

import { LayoutDashboard, ListChecks, BarChart3, Activity, Search, FileText, Info, LineChart } from "lucide-react";

export const SITE_VIEWS = [
    { key: "overview", label: "Overview", icon: LayoutDashboard, live: false },
    { key: "findings", label: "Findings", icon: ListChecks, live: true },
    { key: "energy", label: "Energy and demand", icon: BarChart3, live: true },
    { key: "pq", label: "Power quality", icon: Activity, live: true },
    { key: "investigate", label: "Investigation", icon: Search, live: true },
    { key: "data", label: "Data explorer", icon: LineChart, live: true },
    { key: "reports", label: "Reports and data", icon: FileText, live: false },
    { key: "site", label: "Site details", icon: Info, live: true },
] as const;

export type SiteView = (typeof SITE_VIEWS)[number]["key"] | "finding";

// Old links (?tab=…) still land somewhere sensible.
const ALIAS: Record<string, SiteView> = {
    summary: "overview", balance: "energy", load: "energy", demand: "energy", layout: "site", exports: "reports",
};

export function viewFrom(params: URLSearchParams | null): SiteView {
    const v = params?.get("view") ?? params?.get("tab") ?? "overview";
    if (v === "finding" || SITE_VIEWS.some((x) => x.key === v)) return v as SiteView;
    return ALIAS[v] ?? "overview";
}

export const siteHref = (id: string, view: SiteView, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ ...(view === "overview" ? {} : { view }), ...extra }).toString();
    return `/portal/projects/${id}${q ? `?${q}` : ""}`;
};

export const SITE_PATH = /^\/portal\/projects\/([0-9a-f-]{36})(?:\/|$)/;
