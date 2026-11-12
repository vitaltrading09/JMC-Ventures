"use client";

// The assessment as a journey: day X of N, what each milestone unlocks, and
// what comes next. Milestones are real (they follow the data rules: a daily
// profile needs 24 h, a weekly pattern and the power-quality screening 7 days,
// the final report comes after the end), never decorative.

import { Check } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/api";
import type { Assessment } from "@/lib/assessments";

const DAY = 86_400_000;

export function milestones(a: Assessment) {
    const start = new Date(a.start_at ?? Date.now()).getTime();
    const end = new Date(a.effective_end_at ?? a.end_at ?? start).getTime();
    const list = [
        { at: start + DAY, label: "First daily profile", detail: "the site's operating day becomes visible" },
        ...(end - start >= 7 * DAY ? [{ at: start + 7 * DAY, label: "Weekly pattern", detail: "weekdays vs weekends and the power-quality screening" }] : []),
        { at: end, label: "Assessment ends", detail: "live data closes" },
        { at: end + 2 * DAY, label: "Final report", detail: "reviewed report and data package" },
    ];
    return list.map((m) => ({ ...m, done: Date.now() >= m.at }));
}

export function Journey({ a, compact }: { a: Assessment; compact?: boolean }) {
    const start = new Date(a.start_at ?? Date.now()).getTime();
    const end = new Date(a.effective_end_at ?? a.end_at ?? start).getTime();
    const total = Math.max(1, Math.round((end - start) / DAY));
    const day = Math.min(total, Math.max(1, Math.ceil((Date.now() - start) / DAY)));
    const pct = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
    const ms = milestones(a).filter((m) => m.at <= end);
    const next = milestones(a).find((m) => !m.done);
    if (compact) {
        return (
            <div aria-label="Assessment progress" className="lg:border-l lg:border-line lg:pl-8">
                <p className="text-xs font-semibold uppercase tracking-wider text-faint">Assessment</p>
                <p className="mt-2 text-[32px] leading-tight font-semibold text-ink tabular-nums">Day {day}<span className="text-base font-normal text-muted"> of {total}</span></p>
                <p className="text-sm text-muted">{a.remaining} left · ends {fmtDate(a.effective_end_at)}</p>
                <div className="mt-4 h-2 rounded-full bg-surface-3"><div className="h-2 rounded-full bg-blue-500" style={{ width: `${pct}%` }} /></div>
                <ol className="mt-4 space-y-2 text-sm">
                    {milestones(a).map((m) => (
                        <li key={m.label} className="flex items-center gap-2">
                            <span className={`flex h-4 w-4 items-center justify-center rounded-full ${m.done ? "bg-blue-500 text-white" : "ring-2 ring-surface-3"}`}>{m.done && <Check className="h-3 w-3" aria-hidden />}</span>
                            <span className={m.done ? "text-ink-3" : m.label === next?.label ? "font-medium text-ink" : "text-faint"}>{m.label}</span>
                            <span className="ml-auto text-xs text-faint tabular-nums">{fmtDate(new Date(m.at))}</span>
                        </li>
                    ))}
                </ol>
            </div>
        );
    }
    return (
        <section aria-label="Assessment progress" className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <p className="text-2xl font-semibold text-ink tabular-nums">Day {day} <span className="text-base font-normal text-muted">of {total}</span></p>
                <p className="text-[15px] text-muted">{a.remaining} left · ends {fmtDateTime(a.effective_end_at)}</p>
                {next && <p className="ml-auto text-[15px] text-ink-2"><span className="text-faint">Next: </span>{next.label} <span className="text-faint">· {fmtDate(new Date(next.at))}</span></p>}
            </div>
            <div className="relative mt-6 mb-10">
                <div className="h-2 rounded-full bg-surface-3" />
                <div className="absolute left-0 top-0 h-2 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                {ms.map((m) => {
                    const left = Math.min(100, ((m.at - start) / (end - start)) * 100);
                    return (
                        <div key={m.label} className="absolute top-1 -translate-x-1/2" style={{ left: `${left}%` }}>
                            <span className={`-mt-2.5 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-surface ${m.done ? "bg-blue-500 text-white" : "bg-surface-3 text-transparent"}`}>
                                <Check className="h-3 w-3" aria-hidden />
                            </span>
                            <span className={`absolute top-4 whitespace-nowrap text-xs ${left > 85 ? "right-0" : left < 10 ? "left-0" : "left-1/2 -translate-x-1/2"} ${m.done ? "text-ink-2" : "text-faint"}`} title={m.detail}>{m.label}</span>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
