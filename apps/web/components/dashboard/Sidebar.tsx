"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    LayoutDashboard,
    Zap,
    PieChart,
    Settings,
    ShoppingCart,
    LineChart,
    LogOut,
    Building2,
    Sun,
} from "lucide-react";

export function Sidebar() {
    const pathname = usePathname();

    const links = [
        { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
        { name: "Sites", href: "/dashboard/sites", icon: Building2 },
        { name: "Analytics", href: "/dashboard/analytics", icon: LineChart },
        { name: "Savings", href: "/dashboard/savings", icon: PieChart },
        { name: "Marketplace", href: "/dashboard/marketplace", icon: ShoppingCart },
        { name: "Settings", href: "/dashboard/settings", icon: Settings },
    ];

    return (
        <aside className="fixed left-0 top-0 z-20 h-screen w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between">
            {/* Logo */}
            <div className="p-6">
                <Link href="/" className="flex items-center gap-2">
                    <Zap className="h-8 w-8 text-blue-500" />
                    <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                        PowerGuard
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
                <Link
                    href="/dashboard/tools/pv-sizer"
                    className={`flex items-center gap-3 px-4 py-2 rounded-lg transition-all duration-200 group ${pathname === "/dashboard/tools/pv-sizer"
                        ? "bg-blue-600/10 text-blue-400 border border-blue-500/20"
                        : "text-slate-400 hover:bg-slate-900 hover:text-white"
                        }`}
                >
                    <Sun className="h-5 w-5 text-yellow-500 group-hover:text-yellow-400 transition-colors" />
                    <span className="font-medium text-sm">PV Sizer</span>
                </Link>
            </nav>

            {/* Footer / User Profile */}
            <div className="p-4 border-t border-slate-800">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-900/50 border border-slate-800">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold">
                        JS
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">
                            John Smith
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                            admin@powerguard.com
                        </p>
                    </div>
                    <button className="text-slate-400 hover:text-red-400 transition-colors">
                        <LogOut className="h-5 w-5" />
                    </button>
                </div>
            </div>
        </aside>
    );
}
