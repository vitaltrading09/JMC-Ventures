import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "PowerGuard | Intelligent Energy Optimization",
    description: "Enterprise Multi-Tenant SaaS Platform for Energy Intelligence",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className="bg-slate-950 text-slate-50 antialiased">{children}</body>
        </html>
    );
}
