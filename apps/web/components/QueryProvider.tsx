"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/** TanStack Query for the Phase 8 pages. Older pages keep their own fetches until touched. */
export function QueryProvider({ children }: { children: React.ReactNode }) {
    const [client] = useState(() => new QueryClient({
        defaultOptions: {
            queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
        },
    }));
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
