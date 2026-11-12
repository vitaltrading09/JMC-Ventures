import { PortalSidebar } from "@/components/portal/PortalSidebar";
import { QueryProvider } from "@/components/QueryProvider";
import { ChatWidget } from "@/components/dashboard/ChatWidget";
import { ThemeRoot } from "@/components/ThemeRoot";

// Client portal (Phase 8). The API scopes every call to the user's tenant;
// pages never render internal-only fields (defence in depth).
// Light reading surfaces by default (engineering UI brief §3); dark is optional.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
    return (
        <QueryProvider>
            <ThemeRoot initial="light" className="flex min-h-screen bg-canvas text-ink">
                <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
                <PortalSidebar />
                <div className="flex-1 lg:ml-60 min-w-0 pt-12 lg:pt-0 consultant-shift">
                    <main id="main" className="px-4 py-5 sm:p-6 lg:p-8 max-w-[1500px] text-[15px]">{children}</main>
                </div>
                {/* The consultant, bound to the site on screen (docked drawer). */}
                <ChatWidget />
            </ThemeRoot>
        </QueryProvider>
    );
}
