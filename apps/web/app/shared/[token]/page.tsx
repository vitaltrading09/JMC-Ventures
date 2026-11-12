"use client";

// A shared provisional report (link made by the client in Reports and data).
// Public: no login. The API decides validity on every open (revoked, expired or
// assessment ended → 410). The PDF itself is marked PROVISIONAL.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Zap, FileText } from "lucide-react";
import { apiUrl } from "@/lib/api";

export default function SharedReport() {
    const { token } = useParams<{ token: string }>();
    const src = apiUrl(`/ingestion/public/preview/${encodeURIComponent(token)}`);
    const [state, setState] = useState<"loading" | "ok" | "gone" | "missing">("loading");
    useEffect(() => {
        fetch(`${src}?check=1`).then((r) => setState(r.ok ? "ok" : r.status === 410 ? "gone" : "missing")).catch(() => setState("missing"));
    }, [src]);
    return (
        <div data-theme="light" className="min-h-screen bg-canvas text-ink">
            <header className="flex items-center gap-2 border-b border-line bg-surface px-6 py-4">
                <Zap className="h-6 w-6 text-blue-600" aria-hidden /><span className="text-lg font-bold">GridIQ</span>
                <span className="ml-3 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Provisional report</span>
                {state === "ok" && <a href={src} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"><FileText className="h-4 w-4" aria-hidden />Open PDF</a>}
            </header>
            <main className="mx-auto max-w-5xl p-6">
                {state === "loading" && <p className="text-muted">Preparing the report…</p>}
                {state === "gone" && <p className="text-[15px] text-ink-2">This link is no longer active: it was stopped, it expired, or the assessment has ended. Ask the person who sent it for the final report.</p>}
                {state === "missing" && <p className="text-[15px] text-ink-2">This link is not valid.</p>}
                {state === "ok" && (
                    <>
                        <p className="mb-4 text-[15px] text-muted">This report covers the measurements so far. It is provisional: the final, reviewed report follows the end of the assessment.</p>
                        <iframe src={src} title="Provisional report" className="h-[80vh] w-full rounded-xl bg-white ring-1 ring-line" />
                    </>
                )}
            </main>
        </div>
    );
}
