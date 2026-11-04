"use client";

// Small building blocks shared by the ops console pages (Phase 8). Same dark
// theme as the existing dashboard: slate-950 background, slate-900 panels.

import { Loader2, AlertTriangle } from "lucide-react";

export type Rag = "green" | "amber" | "red" | "grey";

const RAG_DOT: Record<Rag, string> = {
    green: "bg-emerald-400",
    amber: "bg-amber-400",
    red: "bg-red-500",
    grey: "bg-slate-500",
};

export function RagDot({ rag, title }: { rag: Rag; title?: string }) {
    return <span title={title} className={`inline-block h-2.5 w-2.5 rounded-full ${RAG_DOT[rag]}`} />;
}

const BADGE: Record<string, string> = {
    green: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
    amber: "text-amber-300 bg-amber-500/10 border-amber-500/30",
    red: "text-red-300 bg-red-500/10 border-red-500/30",
    blue: "text-blue-300 bg-blue-500/10 border-blue-500/30",
    grey: "text-slate-300 bg-slate-700/40 border-slate-600",
};

export function Badge({ tone = "grey", children }: { tone?: keyof typeof BADGE; children: React.ReactNode }) {
    return <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${BADGE[tone]}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4 mb-6">
            <div>
                <h1 className="text-2xl font-semibold text-white">{title}</h1>
                {subtitle && <p className="text-sm text-slate-400 mt-1">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
    );
}

export function Panel({ title, subtitle, children, actions, className = "" }:
    { title?: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
    return (
        <section className={`rounded-xl border border-slate-800 bg-slate-900/50 ${className}`}>
            {(title || actions) && (
                <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-800">
                    <div>
                        {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
                        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
                    </div>
                    {actions}
                </div>
            )}
            <div className="p-5">{children}</div>
        </section>
    );
}

export function Loading({ label = "Loading" }: { label?: string }) {
    return <div className="flex items-center gap-2 text-sm text-slate-400 py-6"><Loader2 className="h-4 w-4 animate-spin" />{label}…</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
    if (!error) return null;
    return (
        <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error instanceof Error ? error.message : String(error)}</span>
        </div>
    );
}

export function Empty({ children }: { children: React.ReactNode }) {
    return <p className="text-sm text-slate-500 py-4">{children}</p>;
}

export function Button({ children, variant = "primary", ...props }:
    React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
    const v = {
        primary: "bg-blue-600 hover:bg-blue-500 text-white",
        secondary: "bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700",
        danger: "bg-red-600/90 hover:bg-red-500 text-white",
    }[variant];
    return (
        <button {...props}
            className={`inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed ${v} ${props.className ?? ""}`}>
            {children}
        </button>
    );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="block text-xs font-medium text-slate-400 mb-1">{label}</span>
            {children}
            {hint && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
        </label>
    );
}

export const inputClass =
    "w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500";

export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                        {head.map((h, i) => <th key={i} className="py-2 pr-4 font-medium whitespace-nowrap">{h}</th>)}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">{children}</tbody>
            </table>
        </div>
    );
}

export function Stat({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone?: Rag; hint?: string }) {
    const colour = tone === "red" ? "text-red-400" : tone === "amber" ? "text-amber-300" : tone === "green" ? "text-emerald-300" : "text-white";
    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
            <p className="text-xs text-slate-500">{label}</p>
            <p className={`text-2xl font-semibold mt-1 ${colour}`}>{value}</p>
            {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
        </div>
    );
}
