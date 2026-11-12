"use client";

// One finding, start to finish (engineering UI brief §7C): what was measured,
// why it can matter, what to check and do, the follow-up and its
// verification, then the evidence: the investigation charts open on the
// finding's own window with the channels that explain it.

import Link from "next/link";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { fmtDate, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { zar } from "@/lib/format";
import { askConsultant, isDraftFinding, findingSource, type PortalProjectDetail } from "@/lib/portal";
import { canEdit } from "@/lib/portal";
import { kindOf, severityOf, CASE_STATUS } from "@/lib/findings";
import { siteHref } from "@/lib/siteNav";
import type { Assessment } from "@/lib/assessments";
import { InvestigateView } from "@/components/portal/InvestigateView";
import { NextStep } from "@/components/portal/NextStep";
import { WatchPanel } from "@/components/portal/WatchPanel";
import { Empty } from "@/components/ops/ui";

export function FindingDetail({ f, c, project, live, role, findings }: {
    f: any | null; c: any | null; project: PortalProjectDetail; live: Assessment | null; role: string | null; findings: any[];
}) {
    if (!f) return <Empty>This finding is no longer available. <Link className="text-accent hover:underline" href={siteHref(project.id, "findings")}>All findings</Link></Empty>;
    const k = kindOf(f.type), sev = severityOf(f.priority);
    const point = project.points.find((p) => p.device_id === f.meter_id) ?? project.points.find((p) => p.metered) ?? null;
    const window = f.evidence?.from ? { from: f.evidence.from, to: f.evidence.to } : null;
    const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
        <section className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">{n}. {title}</h3>
            <div className="mt-2 text-[15px] leading-relaxed text-ink-2">{children}</div>
        </section>
    );
    return (
        <div className="space-y-6">
            <Link href={siteHref(project.id, "findings")} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />All findings</Link>

            <header className="flex flex-wrap items-start gap-4">
                <span className="rounded-xl bg-surface-2 p-3"><k.icon className="h-6 w-6 text-ink-3" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-muted">{k.label}{point ? ` · ${point.name}` : ""}</p>
                    <h2 className="text-2xl font-semibold text-ink leading-tight">{f.title}</h2>
                    <p className="mt-1 text-sm">
                        <span className={`font-medium ${sev.text}`}>{sev.label}</span>
                        <span className="text-muted"> · {String(f.confidence ?? "–").toLowerCase()} confidence · {findingSource(f.type)}</span>
                        {isDraftFinding(f.review_status) ? <span className="text-muted"> · not yet reviewed by GridIQ</span> : f.reviewed_at ? <span className="text-muted"> · reviewed {fmtDate(f.reviewed_at)}</span> : null}
                    </p>
                </div>
                <button type="button" onClick={() => askConsultant(`Explain this finding for ${project.name} and what we should verify first: "${f.title}". ${f.problem ?? ""}`)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm text-ink-2 hover:bg-surface-2">
                    <MessageSquare className="h-4 w-4" aria-hidden />Ask the consultant
                </button>
            </header>

            <Track status={c?.status ?? "open"} />
            <NextStep f={f} c={c} assessmentId={live?.id ?? null} project={project} role={role} suggested={suggestedAction(c?.watch)} />
            <WatchPanel f={f} w={c?.watch} role={role} assessmentId={live?.id ?? null} />

            <div className="grid gap-4 lg:grid-cols-3">
                <Step n={1} title="What we measured">
                    <p className="whitespace-pre-line">{f.problem}</p>
                    {window && <p className="mt-2 text-sm text-faint">{fmtDateTime(window.from)} – {fmtDateTime(window.to)} {TZ_LABEL}{f.standard_reference ? ` · ${f.standard_reference}` : ""}</p>}
                </Step>
                <Step n={2} title="Why it can matter">
                    <p>{k.why || "See the measured values and the recommendation."}</p>
                </Step>
                <Step n={3} title="What to check and do">
                    <p className="whitespace-pre-line">{f.solution}</p>
                    {Number(f.estimated_monthly_saving_zar) > 0 && <p className="mt-2 text-sm text-muted">Indicative {zar(f.estimated_monthly_saving_zar)}/month from the declared demand tariff; confirm against the bill before relying on it.</p>}
                </Step>
            </div>

            <section className="rounded-2xl border border-line bg-surface p-5">
                <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">4. Follow-up</h3>
                    <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink-3">{CASE_STATUS[c?.status ?? "open"]}</span>
                </div>
                {c ? (
                    <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 text-[15px] text-ink-2">
                        <div><dt className="inline text-faint">Owner: </dt><dd className="inline">{c.owner ?? "not assigned"}</dd></div>
                        {c.due_on && <div><dt className="inline text-faint">Due: </dt><dd className="inline">{fmtDate(c.due_on)}</dd></div>}
                        {c.next_step && <div className="sm:col-span-2"><dt className="inline text-faint">Next: </dt><dd className="inline">{c.next_step}</dd></div>}
                        {c.verification?.result && <div className="sm:col-span-2"><dt className="inline text-faint">Verification: </dt><dd className="inline">{String(c.verification.result).replace(/_/g, " ")}{c.verification.note ? `: ${c.verification.note}` : ""}</dd></div>}
                    </dl>
                ) : <p className="mt-2 text-[15px] text-muted">Not tracked yet. Assign an owner and a next step so it gets done, then verify the result with a before/after comparison.</p>}
            </section>

            <section aria-labelledby="evidence-h">
                <h3 id="evidence-h" className="text-lg font-semibold text-ink mb-1">5. The evidence</h3>
                <p className="text-sm text-muted mb-4">The charts open on the period this finding is based on, with the channels that explain it. Zoom in, step before or after, and save a window as evidence.</p>
                {live && point ? (
                    <InvestigateView assessment={live} pointId={point.id} points={project.points} role={role}
                        initial={window} initialGroups={k.channels} findings={findings.map((x) => ({ id: x.id, title: x.title }))} />
                ) : <Empty>The detailed charts are available while the assessment is running.</Empty>}
            </section>
        </div>
    );
}

/** The watch's suggested action, to start the "Decide on an action" step from. */
function suggestedAction(w: any): string | undefined {
    if (w?.status !== "concluded" || !["persists", "intermittent"].includes(w.conclusion?.verdict)) return undefined;
    const sec = String(w.conclusion.text ?? "").split(/\n(?=###\s)/).find((b) => /^###\s*Suggested next step/i.test(b));
    const t = sec?.split("\n").slice(1).join(" ").replace(/^[-•*]\s*/, "").replace(/\*\*/g, "").replace(/^Move to Action:\s*/i, "").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1, 1000) : undefined;
}

/** Where the finding is on its way: Found → Investigating → Action → Verified. */
function Track({ status }: { status: string }) {
    if (status === "not_needed") return <p className="text-[15px] text-muted">Closed: no action needed.</p>;
    const steps = ["Found", "Investigating", "Action", "Verified"];
    const at = status === "verified" ? 3 : status === "action_planned" || status === "action_done" ? 2 : status === "investigating" ? 1 : 0;
    return (
        <ol className="flex items-center gap-2" aria-label="Progress of this finding">
            {steps.map((label, i) => (
                <li key={label} className="flex flex-1 items-center gap-2" aria-current={i === at ? "step" : undefined}>
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${i <= at ? "bg-blue-600 text-white" : "bg-surface-3 text-muted"}`}>{i + 1}</span>
                    <span className={`text-sm ${i === at ? "font-semibold text-ink" : i < at ? "text-ink-3" : "text-faint"}`}>{label}</span>
                    {i < steps.length - 1 && <span className={`h-0.5 flex-1 rounded ${i < at ? "bg-blue-600" : "bg-surface-3"}`} />}
                </li>
            ))}
        </ol>
    );
}
