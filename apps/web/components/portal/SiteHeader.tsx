"use client";

// The persistent context strip of a site workspace (engineering UI brief §4):
// site and assessment, measurement point, observed window and time zone, data
// freshness and completeness, provisional/final, time remaining, and the
// report and consultant actions. Long expiry/retention text sits behind
// "Assessment details" instead of dominating the page.

import { FileText, MessageSquare, Clock } from "lucide-react";
import { apiUrl, fmtAgo, fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { askConsultant } from "@/lib/portal";
import type { Assessment } from "@/lib/assessments";
import { elapsedFraction } from "@/lib/assessments";
import type { Summary } from "@/lib/summary";
import { inputClass } from "@/components/ops/ui";

export function SiteHeader({ a, summary, pointId, onPoint, showTime = true }: {
    a: Assessment; summary: Summary | undefined; pointId: string | null; onPoint: (id: string) => void; showTime?: boolean;
}) {
    const c = summary?.context;
    const cov = c?.coverage?.fraction;
    const pct = Math.round(elapsedFraction(a) * 100);
    const fresh = c?.last_data_at ? Date.now() - new Date(c.last_data_at).getTime() : null;
    return (
        <section aria-label="Assessment context" className="rounded-xl border border-line bg-surface/60">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-[13px]">
                <div>
                    <p className="text-faint text-xs">Assessment</p>
                    <p className="text-ink font-medium tabular-nums">{a.reference}{c?.provisional !== false && <span className="ml-2 rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-normal text-accent">Provisional</span>}</p>
                </div>
                <div>
                    <p className="text-faint text-xs">Measurement point</p>
                    {c && c.points.length > 1 ? (
                        <select aria-label="Measurement point" className={`${inputClass} !py-1 !text-[13px] max-w-[220px]`} value={pointId ?? c.point?.id ?? ""} onChange={(e) => onPoint(e.target.value)}>
                            {c.points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    ) : <p className="text-ink">{c?.point?.name ?? "–"}</p>}
                </div>
                <div>
                    <p className="text-faint text-xs">Observed window ({TZ_LABEL})</p>
                    <p className="text-ink tabular-nums">{c ? `${fmtDateTime(c.period_from)} → ${fmtDateTime(c.period_to)}` : "…"}
                        {c && <span className="text-muted"> · {c.observed_days < 1 ? `${Math.round(c.observed_days * 24)} h` : `${c.observed_days.toFixed(1)} days`}</span>}</p>
                </div>
                <div>
                    <p className="text-faint text-xs">Data</p>
                    <p className="text-ink tabular-nums">
                        {cov == null ? "–" : `${Math.round(cov * 100)} % complete`}
                        <span className={ fresh !== null && fresh > 2 * 3_600_000 ? " text-warn font-medium" : " text-muted"}> · {c?.last_data_at ? `last data ${fmtAgo(new Date(new Date(c.last_data_at).getTime() + 3_600_000))}` : "no data yet"}</span>
                    </p>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                    {showTime && <span className="inline-flex items-center gap-1 text-ink-3 tabular-nums" title={`${pct} % of the assessment elapsed`}>
                        <Clock className="h-4 w-4 text-faint" aria-hidden />{a.remaining} left
                    </span>}
                    <a className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1.5 text-ink-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
                        href={apiUrl(`/ingestion/assessments/${a.id}/preview.pdf?kind=overview`)} target="_blank" rel="noreferrer">
                        <FileText className="h-4 w-4" aria-hidden />Report preview
                    </a>
                    <button type="button" onClick={() => askConsultant("")}
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300">
                        <MessageSquare className="h-4 w-4" aria-hidden />Consultant
                    </button>
                </div>
            </div>
            <details className="px-4 py-2 text-xs text-muted">
                <summary className="cursor-pointer text-muted hover:text-ink-2">Assessment details</summary>
                <p className="mt-2">{a.package_name ?? `${a.duration_days}-day assessment`}: {fmtDateTime(a.start_at)} → {fmtDateTime(a.effective_end_at)} {TZ_LABEL}.
                    Live data, history, exports and the consultant end exactly at the end time. The final reports and data package follow;
                    the data is kept until {a.retention_until ? fmtDate(a.retention_until) : `${a.retention_months} months after the end`}, then deleted.</p>
                {c?.coverage?.mixed_cadence && <p className="mt-1">The meter reported at more than one interval in this window; completeness is counted per 10-minute slot at each slot&apos;s own interval.</p>}
            </details>
        </section>
    );
}
