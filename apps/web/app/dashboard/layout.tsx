import { Sidebar } from "@/components/dashboard/Sidebar";

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-h-screen bg-slate-950 text-slate-50 relative">
            <Sidebar />
            <div className="flex-1 flex flex-col min-h-screen w-full lg:ml-64 print:ml-0 transition-all duration-300">
                {/* Main Content Area */}
                <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-y-auto w-full max-w-[100vw]">
                    {children}
                </main>
            </div>

            {/* Global Chat Widget */}
        </div>
    );
}
