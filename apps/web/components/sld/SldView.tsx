"use client";

// The single-line diagram of a project, loaded client-side only (pdfjs and
// reactflow touch window/document, which break SSR). Editable in ops,
// read-only in the client portal.

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const SldEditor = dynamic(() => import("./SldEditor"), {
    ssr: false,
    loading: () => (
        <div className="flex items-center justify-center h-[40vh] text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Loading the single-line diagram…
        </div>
    ),
});

export function SldView({ projectId, editable = false }: { projectId: string; editable?: boolean }) {
    return <SldEditor projectId={projectId} editable={editable} />;
}
