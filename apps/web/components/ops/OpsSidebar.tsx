"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
    Zap, LayoutDashboard, Radio, Wrench, ClipboardCheck, FolderKanban, HeartPulse, Users, LogOut, FileSpreadsheet, CalendarClock, Tags,
} from "lucide-react";

const LINKS = [
    { name: "Home",        href: "/ops",             icon: LayoutDashboard },
    { name: "Assessments", href: "/ops/assessments", icon: CalendarClock },
    { name: "Fleet",       href: "/ops/fleet",       icon: Radio },
    { name: "Deploy meter", href: "/ops/install",    icon: Wrench },
    { name: "Review",      href: "/ops/review",      icon: ClipboardCheck },
    { name: "Projects",    href: "/ops/projects",    icon: FolderKanban },
    { name: "Data health", href: "/ops/data-health", icon: HeartPulse },
    { name: "CSV import",  href: "/ops/import",      icon: FileSpreadsheet },
    { name: "Clients",     href: "/ops/clients",     icon: Users },
    { name: "Packages",    href: "/ops/packages",    icon: Tags },
];

export function OpsSidebar() {
    const pathname = usePathname();
    const [user, setUser] = useState({ name: "GridIQ ops", email: "", initials: "GQ" });

    useEffect(() => {
        try {
            const stored = localStorage.getItem("user");
            if (stored) {
                const u = JSON.parse(stored);
                const name = u.name || u.email?.split("@")[0] || "Ops";
                const initials = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                setUser({ name, email: u.email || "", initials });
            }
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
                <Link href="/ops" className="flex items-center gap-2">
                    <Zap className="h-7 w-7 text-blue-500" />
                    <span className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">GridIQ</span>
                    <span className="text-[10px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded uppercase tracking-wider">Ops</span>
                </Link>
            </div>
            <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
                {LINKS.map((l) => {
                    const active = l.href === "/ops" ? pathname === "/ops" : pathname.startsWith(l.href)
                        || (l.href === "/ops/install" && pathname.startsWith("/ops/deployments"));
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
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{user.name}</p>
                        <p className="text-xs text-slate-500 truncate">{user.email}</p>
                    </div>
                    <button onClick={logout} title="Log out" className="text-slate-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10">
                        <LogOut className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </aside>
    );
}
