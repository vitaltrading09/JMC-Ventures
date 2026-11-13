"use client";

// The building blocks of every client view (client-experience plan):
//   InsightCard  headline sentence → one chart → takeaway → one action, with the
//                method folded away ("How we measured this")
//   Sparkline    a tiny trend line for a number tile
//   BulletBar    measured value against a limit or band (instead of a gauge)
//   Skeleton     calm loading placeholders instead of spinners
// Colour: one accent (blue) for the subject, grey for context, amber/red only
// when something needs attention.

import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const ACCENT = "#2563eb";
export const CONTEXT = "#94a3b8";
export const WARN = "#d97706";
export const BAD = "#dc2626";

export function InsightCard({ eyebrow, headline, children, takeaway, action, method, id }: {
    eyebrow?: string; headline: React.ReactNode; children?: React.ReactNode; takeaway?: React.ReactNode;
    action?: { label: string; href?: string; onClick?: () => void } | null; method?: React.ReactNode; id?: string;
}) {
    return (
        <section id={id} className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            {eyebrow && <p className="text-xs font-semibold uppercase tracking-wider text-faint">{eyebrow}</p>}
            <h3 className="mt-1 text-lg font-semibold leading-snug text-ink max-w-3xl">{headline}</h3>
            {children && <div className="mt-5">{children}</div>}
            {(takeaway || action) && (
                <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
                    {takeaway && <p className="flex-1 min-w-[240px] text-[15px] text-ink-3">{takeaway}</p>}
                    {action && (action.href
                        ? <Link href={action.href} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">{action.label}<ArrowRight className="h-4 w-4" aria-hidden /></Link>
                        : <button type="button" onClick={action.onClick} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">{action.label}<ArrowRight className="h-4 w-4" aria-hidden /></button>)}
                </div>
            )}
            {method && (
                <details className="mt-4 text-sm text-faint">
                    <summary className="cursor-pointer select-none hover:text-ink-3">How we measured this</summary>
                    <div className="mt-2 space-y-1">{method}</div>
                </details>
            )}
        </section>
    );
}

/** A tiny trend line (no axes). Null values break the line. */
export function Sparkline({ values, color = ACCENT, height = 32, label }: { values: (number | null)[]; color?: string; height?: number; label?: string }) {
    const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
    if (v.length < 2) return null;
    const w = 120, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    let d = "", pen = false;
    values.forEach((x, i) => {
        if (x === null || !Number.isFinite(x)) { pen = false; return; }
        const px = (i / (values.length - 1)) * w, py = height - 3 - ((x - lo) / span) * (height - 6);
        d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`; pen = true;
    });
    const last = values.length - 1, lv = values[last];
    return (
        <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} role="img" aria-label={label ?? "trend"}>
            <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
            {lv != null && <circle cx={w} cy={height - 3 - ((lv - lo) / span) * (height - 6)} r={2.5} fill={color} />}
        </svg>
    );
}

/**
 * A bullet bar: the measured range (or value) on a scale with the acceptable band
 * shaded and the limit marked. Status colour only when outside or close.
 */
export function BulletBar({ min, max, band, value, range, unit, decimals = 1, ariaLabel }: {
    min: number; max: number; band: [number, number]; value?: number | null; range?: [number, number] | null;
    unit: string; decimals?: number; ariaLabel: string;
}) {
    const pos = (x: number) => `${Math.min(100, Math.max(0, ((x - min) / (max - min)) * 100))}%`;
    const out = (x: number) => x < band[0] || x > band[1];
    const bad = (value != null && out(value)) || (range && (out(range[0]) || out(range[1])));
    const color = bad ? WARN : ACCENT;
    return (
        <div className="relative h-7" role="img" aria-label={ariaLabel}>
            <div className="absolute inset-x-0 top-3 h-1.5 rounded-full bg-surface-3" />
            <div className="absolute top-3 h-1.5 rounded-full bg-emerald-500/25" style={{ left: pos(band[0]), width: `calc(${pos(band[1])} - ${pos(band[0])})` }} />
            {range && <div className="absolute top-2 h-3.5 rounded-full" style={{ left: pos(range[0]), width: `max(4px, calc(${pos(range[1])} - ${pos(range[0])}))`, background: color }} />}
            {value != null && <div className="absolute top-1 h-5 w-1.5 -ml-[3px] rounded-full" style={{ left: pos(value), background: color }} />}
            {[band[0], band[1]].filter((b) => b > min && b < max).map((b) => (
                <div key={b} className="absolute top-0 h-7 border-l border-dashed border-faint" style={{ left: pos(b) }}>
                    <span className="absolute top-5 -translate-x-1/2 text-[10px] text-faint whitespace-nowrap tabular-nums">{b.toFixed(decimals)} {unit}</span>
                </div>
            ))}
        </div>
    );
}

export function Skeleton({ className = "" }: { className?: string }) {
    return <div className={`animate-pulse rounded-xl bg-surface-2 ${className}`} aria-hidden />;
}
export function SkeletonPage() {
    return (
        <div className="space-y-6" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-40" />
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}</div>
            <Skeleton className="h-72" />
        </div>
    );
}
