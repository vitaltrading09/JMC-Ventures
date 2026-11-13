"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap, LayoutDashboard, Bell, Settings, LogOut, Menu, X, Sun, Moon, ArrowLeft } from "lucide-react";
import { useTheme } from "@/components/ThemeRoot";
import { apiGet } from "@/lib/api";
import { SITE_VIEWS, SITE_PATH, siteHref, viewFrom } from "@/lib/siteNav";
import { usePortalAssessments } from "@/components/portal/AssessmentBanner";

const LINKS = [
    { name: "My sites", href: "/portal",          icon: LayoutDashboard },
    { name: "Alerts",   href: "/portal/alerts",   icon: Bell },
    { name: "Settings", href: "/portal/settings", icon: Settings },
];
const linkClass = (active: boolean) => `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
    active ? "bg-blue-600/10 text-accent font-semibold" : "text-muted hover:bg-surface-2 hover:text-ink"}`;

/** Inside a site: its own sections replace the portal links. */
function SiteNav({ id, onNavigate }: { id: string; onNavigate: () => void }) {
    const params = useSearchParams();
    const view = viewFrom(params);
    const project = useQuery({ queryKey: ["portal-project", id], queryFn: () => apiGet<{ name: string }>(`/ingestion/portal/projects/${id}`) });
    const live = (usePortalAssessments().data ?? []).some((a) => a.project_id === id && a.live);
    return (
        <nav aria-label="Site sections" className="flex-1 px-3 overflow-y-auto">
            <Link href="/portal" className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />All sites</Link>
            <p className="px-3 pt-2 pb-3 text-base font-semibold text-ink leading-snug">{project.data?.name ?? "…"}</p>
            <div className="space-y-1">
                {SITE_VIEWS.filter((v) => live || !v.live).map((v) => {
                    const active = view === v.key || (v.key === "findings" && view === "finding");
                    return (
                        <Link key={v.key} href={siteHref(id, v.key)} onClick={onNavigate} aria-current={active ? "page" : undefined} className={linkClass(active)}>
                            <v.icon className="h-4 w-4" /><span>{v.label}</span>
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}

export function PortalSidebar() {
    const pathname = usePathname();
    const siteId = SITE_PATH.exec(pathname ?? "")?.[1] ?? null;
    const { theme, toggle } = useTheme();
    // Below 1024 px the sidebar is a drawer behind a menu button (brief §3: one column on mobile).
    const [open, setOpen] = useState(false);
    useEffect(() => { setOpen(false); }, [pathname]);
    const [user, setUser] = useState({ email: "", initials: "" });
    // The client's own brand (Settings → Branding), when set.
    const brand = useQuery({ queryKey: ["branding"], queryFn: () => apiGet<{ brand_name: string | null; brand_logo_url: string | null }>("/ingestion/branding") });

    useEffect(() => {
        try {
            const u = JSON.parse(localStorage.getItem("user") || "null");
            if (u) setUser({ email: u.email || "", initials: (u.email || "?").slice(0, 2).toUpperCase() });
        } catch { /* no stored user */ }
    }, []);

    const logout = async () => {
        try {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/logout`, { method: "POST", credentials: "include" });
        } catch { /* redirect anyway */ }
        localStorage.removeItem("user");
        window.location.href = "/login";
    };

    return (
        <>
        <div className="lg:hidden fixed top-0 inset-x-0 z-30 h-12 flex items-center gap-3 px-4 bg-canvas border-b border-line print:hidden">
            <button type="button" onClick={() => setOpen(true)} aria-label="Open the menu" aria-expanded={open} className="p-1.5 -ml-1.5 text-ink"><Menu className="h-5 w-5" /></button>
            <span className="font-semibold text-ink truncate">{brand.data?.brand_name || "GridIQ"}</span>
        </div>
        {open && <div className="lg:hidden fixed inset-0 z-30 bg-black/40" onClick={() => setOpen(false)} aria-hidden />}
        <aside aria-label="Main navigation" className={`fixed left-0 top-0 z-40 h-screen w-60 bg-canvas border-r border-line flex flex-col justify-between print:hidden transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close the menu" className="lg:hidden absolute right-3 top-4 p-1 text-muted"><X className="h-5 w-5" /></button>
            <div className="p-5">
                <Link href="/portal" className="flex items-center gap-2">
                    {brand.data?.brand_logo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={brand.data.brand_logo_url} alt="" className="h-7 w-7 object-contain" />
                        : <Zap className="h-7 w-7 text-blue-500" />}
                    <span className="text-lg font-bold text-ink truncate">{brand.data?.brand_name || "GridIQ"}</span>
                </Link>
            </div>
            {siteId ? <Suspense fallback={<div className="flex-1" />}><SiteNav id={siteId} onNavigate={() => setOpen(false)} /></Suspense> : (
                <nav aria-label="Main" className="flex-1 px-3 space-y-1 overflow-y-auto">
                    {LINKS.map((l) => {
                        const active = l.href === "/portal" ? pathname === "/portal" || pathname === "/portal/projects" : pathname.startsWith(l.href);
                        return (
                            <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={linkClass(active)}>
                                <l.icon className="h-4 w-4" /><span>{l.name}</span>
                            </Link>
                        );
                    })}
                </nav>
            )}
            <div className="p-3 border-t border-line space-y-2">
                <button type="button" onClick={toggle} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted hover:bg-surface-2 hover:text-ink">
                    {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}{theme === "light" ? "Dark mode" : "Light mode"}
                </button>
                <div className="flex items-center gap-3 p-2 rounded-lg bg-surface/50">
                    <div className="h-9 w-9 rounded-full bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center text-white text-xs font-bold shrink-0">{user.initials}</div>
                    <p className="flex-1 min-w-0 text-xs text-muted truncate">{user.email}</p>
                    <button onClick={logout} title="Log out" className="text-muted hover:text-bad p-1.5 rounded-lg hover:bg-red-500/10">
                        <LogOut className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </aside>
        </>
    );
}
