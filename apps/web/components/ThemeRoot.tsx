"use client";

// Theme root for an area of the site (app/globals.css tokens). The client portal
// defaults to light reading surfaces; a viewer may choose dark, remembered in
// this browser only. Rendering is correct without storage (private windows).

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const KEY = "gridiq-theme";
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });
export const useTheme = () => useContext(Ctx);

export function ThemeRoot({ initial = "light", className = "", children }: { initial?: Theme; className?: string; children: React.ReactNode }) {
    const [theme, setTheme] = useState<Theme>(initial);
    useEffect(() => {
        try { const t = localStorage.getItem(KEY); if (t === "light" || t === "dark") setTheme(t); } catch { /* no storage */ }
    }, []);
    const toggle = () => setTheme((t) => {
        const next = t === "light" ? "dark" : "light";
        try { localStorage.setItem(KEY, next); } catch { /* no storage */ }
        return next;
    });
    return (
        <Ctx.Provider value={{ theme, toggle }}>
            <div data-theme={theme} className={className}>{children}</div>
        </Ctx.Provider>
    );
}
