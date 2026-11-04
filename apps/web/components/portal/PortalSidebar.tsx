"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap, LayoutDashboard, FolderKanban, Bell, Settings, LogOut } from "lucide-react";
import { apiGet } from "@/lib/api";

const LINKS = [
    { name: "Overview", href: "/portal",          icon: LayoutDashboard },
    { name: "Projects", href: "/portal/projects", icon: FolderKanban },
    { name: "Alerts",   href: "/portal/alerts",   icon: Bell },
    { name: "Settings", href: "/portal/settings", icon: Settings },
];

export function PortalSidebar() {
    const pathname = usePathname();
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
        <aside className="fixed left-0 top-0 z-20 h-screen w-60 bg-slate-950 border-r border-slate-800 flex flex-col justify-between print:hidden">
            <div className="p-5">
                <Link href="/portal" className="flex items-center gap-2">
                    {brand.data?.brand_logo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={brand.data.brand_logo_url} alt="" className="h-7 w-7 object-contain" />
                        : <Zap className="h-7 w-7 text-blue-500" />}
                    <span className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400 truncate">
                        {brand.data?.brand_name || "Grid-IQ"}
                    </span>
                </Link>
            </div>
            <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
                {LINKS.map((l) => {
                    const active = l.href === "/portal" ? pathname === "/portal" : pathname.startsWith(l.href);
                    return (
                        <Link key={l.href} href={l.href}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                                active ? "bg-blue-600/15 text-blue-300 border border-blue-500/20" : "text-slate-400 hover:bg-slate-900 hover:text-white"}`}>
                            <l.icon className="h-4 w-4" />
                            <span className="font-medium">{l.name}</span>
                        </Link>
                    );
                })}
            </nav>
            <div className="p-3 border-t border-slate-800">
                <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-900/50">
                    <div className="h-9 w-9 rounded-full bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center text-white text-xs font-bold shrink-0">{user.initials}</div>
                    <p className="flex-1 min-w-0 text-xs text-slate-400 truncate">{user.email}</p>
                    <button onClick={logout} title="Log out" className="text-slate-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10">
                        <LogOut className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </aside>
    );
}
