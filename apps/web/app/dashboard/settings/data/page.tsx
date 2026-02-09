"use client";

import { Card, CardHeader } from "@/components/ui/Card";
import { UploadCloud, FileSpreadsheet, CheckCircle2, AlertTriangle, X } from "lucide-react";
import Link from "next/link";

const recentUploads = [
    { name: "Site_A_Load_Profile_Jan2024.csv", size: "2.4 MB", status: "success", date: "2 mins ago" },
    { name: "Factory_B_Meters.xlsx", size: "1.1 MB", status: "processing", date: "1 hour ago" },
    { name: "Unit_5_Corrupt_Data.csv", size: "0.5 MB", status: "error", date: "Yesterday" },
];

export default function DataImportPage() {
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <Link href="/dashboard/settings" className="text-sm text-slate-400 hover:text-white mb-2 inline-block">
                        &larr; Back to Settings
                    </Link>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Data Management</h1>
                    <p className="text-slate-400 mt-2">
                        Upload load profiles and manage historical data ingestion.
                    </p>
                </div>
            </div>

            <div className="grid gap-8 md:grid-cols-2">
                {/* Upload Zone */}
                <Card className="border-dashed border-2 border-slate-700 bg-slate-900/30 hover:bg-slate-900/50 transition-colors cursor-pointer group">
                    <div className="h-64 flex flex-col items-center justify-center text-center p-8">
                        <div className="p-4 rounded-full bg-blue-500/10 text-blue-500 mb-4 group-hover:scale-110 transition-transform">
                            <UploadCloud className="h-8 w-8" />
                        </div>
                        <h3 className="text-lg font-medium text-white">Click to upload or drag and drop</h3>
                        <p className="text-slate-400 mt-2 text-sm max-w-xs">
                            Supported formats: CSV, Excel (.xlsx), XML (Green Button). Max file size: 50MB.
                        </p>
                    </div>
                </Card>

                {/* Recent Activity */}
                <Card>
                    <CardHeader title="Recent Imports" subtitle="Status of data ingestion tasks" />
                    <div className="divide-y divide-slate-800 mt-4">
                        {recentUploads.map((file, idx) => (
                            <div key={idx} className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 rounded bg-slate-800 text-slate-400">
                                        <FileSpreadsheet className="h-5 w-5" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium text-white">{file.name}</p>
                                        <p className="text-xs text-slate-500">{file.size} • {file.date}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {file.status === 'success' && (
                                        <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                            <CheckCircle2 className="h-3 w-3" /> Imported
                                        </span>
                                    )}
                                    {file.status === 'processing' && (
                                        <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                            <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" /> Processing
                                        </span>
                                    )}
                                    {file.status === 'error' && (
                                        <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                                            <AlertTriangle className="h-3 w-3" /> Failed
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-6 pt-4 border-t border-slate-800">
                        <button className="text-sm text-blue-400 hover:text-blue-300 font-medium">
                            View All Activity &rarr;
                        </button>
                    </div>
                </Card>
            </div>

            {/* Templates & Support */}
            <Card className="bg-slate-900/50">
                <div className="p-6 md:flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-medium text-white">Need a template?</h3>
                        <p className="text-sm text-slate-400 mt-1">
                            Download our standard CSV format to ensure seamless data parsing.
                        </p>
                    </div>
                    <div className="mt-4 md:mt-0 flex gap-3">
                        <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors border border-slate-700">
                            Download Template
                        </button>
                        <button className="px-4 py-2 text-slate-400 hover:text-white text-sm">
                            View Documentation
                        </button>
                    </div>
                </div>
            </Card>
        </div>
    );
}
