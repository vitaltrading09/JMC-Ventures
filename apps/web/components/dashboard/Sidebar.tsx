"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import {
    LayoutDashboard,
    Zap,
    PieChart,
    Settings,
    LineChart,
    Building2,
    Lightbulb,
    FileSpreadsheet,
    FileText,
    BadgeDollarSign,
    Menu,
    X,
    Sun,
    LogOut,
    AlertCircle,
    Bell,
    Network,
} from "lucide-react";

import { NotificationBell } from "./NotificationBell";

export function Sidebar() {
    const pathname = usePathname();
    const router = useRouter();
    const [isOpen, setIsOpen] = useState(false);
    const [user, setUser] = useState({ name: 'User', email: '', initials: 'U' });

    useEffect(() => {
        // Read user info from localStorage
        try {
            const stored = localStorage.getItem('user');
            if (stored) {
                const u = JSON.parse(stored);
                const name = u.name || u.email?.split('@')[0] || 'User';
                const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
                setUser({ name, email: u.email || '', initials });
            }
        } catch { }
    }, []);

    const handleLogout = async () => {
        // Ask the server to clear the HTTPOnly cookie (JS can't do it directly)
        try {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081'}/auth/logout`, {
                method: 'POST',
                credentials: 'include',
            });
        } catch { /* ignore — redirect anyway */ }

        // Clear non-sensitive display data
        localStorage.removeItem('user');

        // Force hard navigation to clear React state
        window.location.href = '/login';
    };

    // Close sidebar on mobile when route changes
    useEffect(() => {
        setIsOpen(false);
    }, [pathname]);

    const links = [
        { name: "Overview",        href: "/dashboard",                  icon: LayoutDashboard },
        { name: "Sites",           href: "/dashboard/sites",            icon: Building2 },
        { name: "SLD",             href: "/dashboard/sld",              icon: Network },
        { name: "Alerts",          href: "/dashboard/alerts",           icon: Bell },
        { name: "Recommendations", href: "/dashboard/recommendations",  icon: Lightbulb },
        { name: "Analytics",       href: "/dashboard/analytics",        icon: LineChart },
        { name: "Savings",         href: "/dashboard/savings",          icon: PieChart },
        { name: "Reports",         href: "/dashboard/reports",          icon: FileText },
        { name: "Settings",        href: "/dashboard/settings",         icon: Settings },
    ];

    return (
        <>
            {/* Mobile Nav Toggle */}
            <div className="print:hidden lg:hidden fixed top-0 left-0 w-full h-16 bg-slate-950 border-b border-slate-800 z-40 flex items-center px-4 justify-between">
                <Link href="/" className="flex items-center gap-2">
                    <Zap className="h-6 w-6 text-blue-500" />
                    <span className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                        Grid-IQ
                    </span>
                </Link>
                <div className="flex items-center gap-3">
                    <NotificationBell />
                    <button
                        onClick={() => setIsOpen(!isOpen)}
                        className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                    >
                        {isOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
                    </button>
                </div>
            </div>

            {/* Backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/60 z-40 lg:hidden backdrop-blur-sm transition-opacity"
                    onClick={() => setIsOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside className={`print:hidden fixed left-0 top-0 z-50 h-[100dvh] w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
                {/* Logo */}
                <div className="p-6 hidden lg:block">
                    <Link href="/" className="flex items-center gap-2">
                        <Zap className="h-8 w-8 text-blue-500" />
                        <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                            Grid-IQ
                        </span>
                    </Link>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-4 space-y-2 mt-4 overflow-y-auto">
                    <div className="mb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        Platform
                    </div>
                    {links.map((link) => {
                        const isActive = pathname === link.href;
                        return (
                            <Link
                                key={link.name}
                                href={link.href}
                                className={`flex items-center gap-3 px-4 py-2 rounded-lg transition-all duration-200 group ${isActive
                                    ? "bg-blue-600/10 text-blue-400 border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.15)]"
                                    : "text-slate-400 hover:bg-slate-900 hover:text-white"
                                    }`}
                            >
                                <link.icon
                                    className={`h-5 w-5 ${isActive
                                        ? "text-blue-400 drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                                        : "text-slate-500 group-hover:text-white transition-colors"
                                        }`}
                                />
                                <span className="font-medium text-sm">{link.name}</span>
                            </Link>
                        );
                    })}

                    <div className="mt-8 mb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        Tools & Utilities
                    </div>
                    <div className="px-2 space-y-1">
                        <Link
                            href="/dashboard/tools/pv-sizer"
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group ${pathname === "/dashboard/tools/pv-sizer"
                                ? "bg-blue-600/10 text-blue-400 border border-blue-500/20"
                                : "text-slate-400 hover:bg-slate-900 hover:text-white"
                                }`}
                        >
                            <Sun className="h-5 w-5 text-yellow-500 group-hover:text-yellow-400 transition-colors" />
                            <span className="font-medium text-sm">PV Sizer</span>
                        </Link>

                        <Link
                            href="/dashboard/settings/data"
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group ${pathname === "/dashboard/settings/data"
                                ? "bg-blue-600/10 text-blue-400 border border-blue-500/20"
                                : "text-slate-400 hover:bg-slate-900 hover:text-white"
                                }`}
                        >
                            <FileSpreadsheet className="h-5 w-5 text-emerald-500 group-hover:text-emerald-400 transition-colors" />
                            <span className="font-medium text-sm">Data Import</span>
                        </Link>

                        <Link
                            href="/dashboard/settings/tariffs"
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group ${pathname === "/dashboard/settings/tariffs"
                                ? "bg-blue-600/10 text-blue-400 border border-blue-500/20"
                                : "text-slate-400 hover:bg-slate-900 hover:text-white"
                                }`}
                        >
                            <BadgeDollarSign className="h-5 w-5 text-indigo-500 group-hover:text-indigo-400 transition-colors" />
                            <span className="font-medium text-sm">Tariff Config</span>
                        </Link>

                        <Link
                            href="/dashboard/settings/alerts"
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group ${pathname === "/dashboard/settings/alerts"
                                ? "bg-red-600/10 text-red-400 border border-red-500/20"
                                : "text-slate-400 hover:bg-slate-900 hover:text-white"
                                }`}
                        >
                            <AlertCircle className="h-5 w-5 text-red-500 group-hover:text-red-400 transition-colors" />
                            <span className="font-medium text-sm">Alerts Config</span>
                        </Link>
                    </div>
                </nav>

                <div className="p-4 border-t border-slate-800">
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-900/50 border border-slate-800">
                        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm">
                            {user.initials}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate">{user.name}</p>
                            <p className="text-xs text-slate-500 truncate">{user.email}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <NotificationBell />
                            <button
                                onClick={handleLogout}
                                title="Log out"
                                className="text-slate-400 hover:text-red-400 transition-colors p-2 rounded-lg hover:bg-red-500/10">
                                <LogOut className="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                </div>
            </aside>
        </>
    );
}
