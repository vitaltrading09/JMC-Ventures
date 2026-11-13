"use client";

// Final delivery: the personal, expiring link emailed when an assessment ends.
// It lists only the frozen deliverables (reports and the data package); it
// never opens live data, history or the consultant.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Zap, FileText, FileSpreadsheet, FileJson, Lock, Loader2 } from "lucide-react";

interface Listing {
    assessment: { id: string; reference: string; link_expires_at: string | null };
    files: { name: string; title: string; sha256: string | null; url: string }[];
    pending_review: string[];
}

export default function DeliveryPage() {
    const { token } = useParams<{ token: string }>();
    const [data, setData] = useState<Listing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const api = process.env.NEXT_PUBLIC_API_URL;
    useEffect(() => {
        fetch(`${api}/ingestion/delivery/${encodeURIComponent(token)}`)
            .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Not available"); setData(j); })
            .catch((e) => setError(e.message));
    }, [api, token]);
    // The API answers with paths under /api; the files are on the same host.
    const href = (u: string) => (api && !api.startsWith("/") ? new URL(api).origin : "") + u;
    const icon = (n: string) => n.endsWith(".pdf") ? <FileText className="h-5 w-5 text-red-300" /> : n.endsWith(".json") ? <FileJson className="h-5 w-5 text-amber-300" /> : <FileSpreadsheet className="h-5 w-5 text-emerald-300" />;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 p-6 md:p-12">
            <div className="max-w-2xl mx-auto space-y-6">
                <div className="flex items-center gap-2"><Zap className="h-7 w-7 text-blue-500" /><span className="text-lg font-bold text-white">GridIQ</span></div>
                {error ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 flex gap-3">
                        <Lock className="h-5 w-5 text-amber-300 shrink-0" />
                        <div><p className="font-medium text-white">This link is no longer valid.</p><p className="text-sm text-slate-400 mt-1">{error}. Ask GridIQ to send a new one if you still need the files.</p></div>
                    </div>
                ) : !data ? <Loader2 className="h-5 w-5 animate-spin" /> : (
                    <>
                        <div>
                            <h1 className="text-2xl font-semibold text-white">Assessment {data.assessment.reference}: deliverables</h1>
                            <p className="text-sm text-slate-400 mt-1">
                                These files are frozen: a correction would arrive as a new revision.
                                {data.assessment.link_expires_at && <> This personal link works until {new Date(data.assessment.link_expires_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST.</>}
                            </p>
                        </div>
                        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                            {data.files.map((f) => (
                                <li key={f.name} className="flex items-center gap-3 p-4">
                                    {icon(f.name)}
                                    <div className="flex-1 min-w-0">
                                        <a className="text-blue-300 hover:underline" href={href(f.url)}>{f.name}</a>
                                        <p className="text-xs text-slate-500 truncate">{f.title}{f.sha256 ? ` · SHA-256 ${f.sha256.slice(0, 16)}…` : ""}</p>
                                    </div>
                                </li>
                            ))}
                        </ul>
                        {data.pending_review.length > 0 && <p className="text-sm text-slate-400">Still in engineering review: {data.pending_review.join(", ")}. You will receive it by email when it is issued.</p>}
                        <p className="text-xs text-slate-500">Start with manifest.json: it lists every file with its units, time convention and checksum.</p>
                    </>
                )}
            </div>
        </div>
    );
}
