"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
    LayoutDashboard,
    Zap,
    Users,
    Server,
    Settings,
    LogOut,
} from "lucide-react";

export function AdminSidebar() {
    const pathname = usePathname();
    const router = useRouter();

    const handleLogout = () => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        document.cookie = "token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        router.push("/login");
    };

    const links = [
        { name: "Global Overview", href: "/admin", icon: LayoutDashboard },
        { name: "Client Management", href: "/admin/clients", icon: Users },
        { name: "Site Provisioning", href: "/admin/sites", icon: Server },
        { name: "Platform Settings", href: "/admin/settings", icon: Settings },
    ];

    return (
        <aside className="fixed left-0 top-0 z-20 h-screen w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between">
            {/* Logo */}
            <div className="p-6">
                <Link href="/admin" className="flex items-center gap-2">
                    <Zap className="h-8 w-8 text-blue-500" />
                    <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                        PowerGuard <span className="text-xs text-red-500 align-top">ADMIN</span>
                    </span>
                </Link>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-4 space-y-2 mt-4 overflow-y-auto">
                <div className="mb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Super Admin
                </div>
                {links.map((link) => {
                    const isActive = pathname === link.href;
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            className={`flex items-center gap-3 px-4 py-2 rounded-lg transition-all duration-200 group ${isActive
                                ? "bg-red-600/10 text-red-400 border border-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.15)]"
                                : "text-slate-400 hover:bg-slate-900 hover:text-white"
                                }`}
                        >
                            <link.icon
                                className={`h-5 w-5 ${isActive
                                    ? "text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                                    : "text-slate-500 group-hover:text-white transition-colors"
                                    }`}
                            />
                            <span className="font-medium text-sm">{link.name}</span>
                        </Link>
                    );
                })}
            </nav>

            {/* Footer / User Profile */}
            <div className="p-4 border-t border-slate-800">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-900/50 border border-slate-800">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white font-bold">
                        PGA
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">
                            Platform Admin
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                            admin@powerguard.com
                        </p>
                    </div>
                    <button onClick={handleLogout} className="text-slate-400 hover:text-red-400 transition-colors">
                        <LogOut className="h-5 w-5" />
                    </button>
                </div>
            </div>
        </aside>
    );
}
