import { PortalSidebar } from "@/components/portal/PortalSidebar";
import { QueryProvider } from "@/components/QueryProvider";
import { ChatWidget } from "@/components/dashboard/ChatWidget";

// Client portal (Phase 8). The API scopes every call to the user's tenant;
// pages never render internal-only fields (defence in depth).
export default function PortalLayout({ children }: { children: React.ReactNode }) {
    return (
        <QueryProvider>
            <div className="flex min-h-screen bg-slate-950 text-slate-50">
                <PortalSidebar />
                <div className="flex-1 ml-60 min-w-0 consultant-shift">
                    <main className="p-6 lg:p-8 max-w-[1500px]">{children}</main>
                </div>
                {/* The consultant, bound to the site on screen (docked drawer). */}
                <ChatWidget />
            </div>
        </QueryProvider>
    );
}
