import { AdminSidebar } from "@/components/dashboard/AdminSidebar";

export default function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-h-screen bg-slate-950 text-slate-50">
            <AdminSidebar />
            <div className="flex-1 ml-64 flex flex-col min-h-screen">
                {/* Main Content Area */}
                <main className="flex-1 p-8 overflow-y-auto">
                    {children}
                </main>
            </div>
        </div>
    );
}
