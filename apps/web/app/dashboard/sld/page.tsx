"use client";

// SLD page wrapper — dynamic imports the editor so pdfjs/reactflow only
// load client-side (they touch window/document which break SSR).

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const SldEditor = dynamic(() => import("./SldEditor"), {
    ssr: false,
    loading: () => (
        <div className="flex items-center justify-center h-[60vh] text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Loading diagram editor…
        </div>
    ),
});

export default function SldPage() {
    return <SldEditor />;
}
