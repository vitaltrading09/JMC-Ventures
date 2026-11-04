import { OpsSidebar } from "@/components/ops/OpsSidebar";
import { QueryProvider } from "@/components/QueryProvider";

// Internal ops console (Phase 8). Access is limited to internal roles by
// middleware.ts; the API checks again on every call.
export default function OpsLayout({ children }: { children: React.ReactNode }) {
    return (
        <QueryProvider>
            <div className="flex min-h-screen bg-slate-950 text-slate-50">
                <OpsSidebar />
                <div className="flex-1 ml-60 min-w-0">
                    <main className="p-6 lg:p-8 max-w-[1500px]">{children}</main>
                </div>
            </div>
        </QueryProvider>
    );
}
