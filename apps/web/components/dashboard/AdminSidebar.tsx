"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
    LayoutDashboard,
    Zap,
    Users,
    Building2,
    Settings,
    LogOut,
    Briefcase,
    Star,
} from "lucide-react";

export function AdminSidebar() {
    const pathname = usePathname();
    const [user, setUser] = useState({ name: "Platform Admin", email: "admin@powerguard.co.za", initials: "PG" });

    useEffect(() => {
        try {
            const stored = localStorage.getItem("user");
            if (stored) {
                const u = JSON.parse(stored);
                const name = u.name || u.email?.split("@")[0] || "Admin";
                const initials = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                setUser({ name, email: u.email || "", initials });
            }
        } catch { }
    }, []);

    const handleLogout = () => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        document.cookie = "token=; path=/; max-age=0; SameSite=Strict";
        window.location.href = "/login";
    };

    const links = [
        { name: "Overview",          href: "/admin",             icon: LayoutDashboard },
        { name: "Client Portfolios", href: "/admin/clients",     icon: Users },
        { name: "Leads Queue",       href: "/admin/leads",       icon: Briefcase },
        { name: "Site Provisioning", href: "/admin/sites",       icon: Building2 },
        { name: "Platform Settings", href: "/admin/settings",    icon: Settings },
    ];

    return (
        <aside className="fixed left-0 top-0 z-20 h-screen w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between">
            {/* Logo */}
            <div className="p-6">
                <Link href="/admin" className="flex items-center gap-2">
                    <Zap className="h-8 w-8 text-blue-500" />
                    <div>
                        <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                            PowerGuard
                        </span>
                        <span className="ml-1.5 text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded uppercase tracking-wider">
                            Operator
                        </span>
                    </div>
                </Link>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto">
                <div className="mb-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Operator Portal
                </div>
                {links.map((link) => {
                    const isActive = pathname === link.href || (link.href !== "/admin" && pathname.startsWith(link.href));
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 group ${
                                isActive
                                    ? "bg-red-600/10 text-red-400 border border-red-500/20 shadow-[0_0_12px_rgba(239,68,68,0.12)]"
                                    : "text-slate-400 hover:bg-slate-900 hover:text-white"
                            }`}
                        >
                            <link.icon
                                className={`h-5 w-5 ${
                                    isActive
                                        ? "text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                                        : "text-slate-500 group-hover:text-white transition-colors"
                                }`}
                            />
                            <span className="font-medium text-sm">{link.name}</span>
                        </Link>
                    );
                })}

                <div className="mt-8 mb-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Quick Links
                </div>
                <Link
                    href="/dashboard"
                    className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-white transition-all group"
                >
                    <Star className="h-5 w-5 text-slate-500 group-hover:text-yellow-400 transition-colors" />
                    <span className="font-medium text-sm">Client View</span>
                </Link>
            </nav>

            {/* User */}
            <div className="p-4 border-t border-slate-800">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-900/50 border border-slate-800">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                        {user.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{user.name}</p>
                        <p className="text-xs text-slate-500 truncate">{user.email}</p>
                    </div>
                    <button
                        onClick={handleLogout}
                        title="Log out"
                        className="text-slate-400 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-red-500/10"
                    >
                        <LogOut className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </aside>
    );
}
