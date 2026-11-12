"use client";

// The assessment consultant (engineering UI brief §9). A docked drawer bound
// to the assessment of the site on screen: on a site page it can only talk
// about that site; navigating to another site rebinds it, clears the
// conversation view and drops any answer still in flight for the old one.
// The server picks the data (the assessment's own dataset) and enforces access
// and budgets. Other components open it with askConsultant(text) (lib/portal).

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquare, X, Send, Lock } from "lucide-react";
import { apiGet, apiSend, fmtDateTime, TZ_LABEL } from "@/lib/api";
import { usePortalAssessments } from "@/components/portal/AssessmentBanner";

interface Msg { role: "user" | "assistant"; content: string; provider?: string | null; basis?: string; evidence?: string[] }

const SUGGESTIONS = [
    "When does this site use the most power, and why might that be?",
    "Is the voltage distortion concentrated in one phase or period?",
    "What does the power factor tell us here?",
    "What should we tell the feasibility engineer?",
];
const EVIDENCE_LABEL: Record<string, string> = {
    demand: "Demand", energy: "Energy", coverage: "Data coverage", executive: "Summary", patterns: "Operating pattern",
    "power_quality.thd_v": "Voltage THD", "power_quality.pf": "Power factor", "power_quality.voltage": "Voltage",
    feasibility_readiness: "Feasibility handover",
};

export function ChatWidget() {
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [msgs, setMsgs] = useState<Msg[]>([]);
    const [pending, setPending] = useState<string | null>(null);
    const [sel, setSel] = useState<string | null>(null);
    const end = useRef<HTMLDivElement>(null);
    const bound = useRef<string | null>(null);   // the assessment answers may be shown for
    const assessments = usePortalAssessments();
    const live = (assessments.data ?? []).filter((a) => a.live);
    // On a site page the consultant is bound to that site's assessment only.
    const pathname = usePathname();
    const onScreen = /^\/portal\/projects\/([0-9a-f-]{36})/.exec(pathname ?? "")?.[1] ?? null;
    const current = onScreen
        ? live.find((a) => a.project_id === onScreen) ?? null
        : live.find((a) => a.id === sel) ?? live[0] ?? null;

    // Rebind: a new context starts a clean view; late answers for the old one are dropped.
    useEffect(() => {
        bound.current = current?.id ?? null;
        setMsgs([]); setBusy(false);
        if (!open || !current) return;
        const id = current.id;
        apiGet<{ messages: Msg[] }>(`/ingestion/assessments/${id}/chat`)
            .then((r) => { if (bound.current === id) setMsgs(r.messages); })
            .catch(() => { if (bound.current === id) setMsgs([]); });
    }, [open, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const onAsk = (e: Event) => { const q = (e as CustomEvent<string>).detail; setOpen(true); if (q) setPending(q); };
        window.addEventListener("gridiq:ask", onAsk);
        return () => window.removeEventListener("gridiq:ask", onAsk);
    }, []);
    // Docked: the page makes room instead of being covered (globals.css, html[data-consultant]).
    useEffect(() => {
        document.documentElement.dataset.consultant = open ? "open" : "closed";
        return () => { delete document.documentElement.dataset.consultant; };
    }, [open]);
    useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);
    useEffect(() => { if (open && pending && current && !busy) { const q = pending; setPending(null); send(q); } }, [open, pending, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const send = async (text: string) => {
        if (!text.trim() || !current) return;
        const id = current.id;
        setInput("");
        setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
        setBusy(true);
        try {
            const r = await apiSend<{ answer: string; provider: string; basis: { period_from: string; period_to: string; provisional: boolean; coverage: { point: string; fraction: number | null }[] }; evidence: string[] }>(
                "POST", `/ingestion/assessments/${id}/chat`, { message: text });
            if (bound.current !== id) return;   // the user moved to another site meanwhile
            const cov = r.basis.coverage.map((c) => `${c.point} ${c.fraction === null ? "–" : Math.round(c.fraction * 100) + " %"}`).join(", ");
            const basis = `${fmtDateTime(r.basis.period_from)} → ${fmtDateTime(r.basis.period_to)} ${TZ_LABEL}${r.basis.provisional ? " · provisional" : ""} · data ${cov}`;
            setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: r.answer, provider: r.provider, basis, evidence: r.evidence }]);
        } catch (e: any) {
            if (bound.current !== id) return;
            setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: `Could not answer: ${e.message}` }]);
        } finally { if (bound.current === id) setBusy(false); }
    };

    if (!open) {
        // A site page has the Consultant button in its header: no floating button over the content.
        if (onScreen) return null;
        return (
            <button onClick={() => setOpen(true)} aria-label="Open the GridIQ consultant"
                className="fixed bottom-6 right-6 z-40 h-12 rounded-full bg-blue-600 px-4 text-white shadow-lg hover:bg-blue-500 flex items-center gap-2 print:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300">
                <MessageSquare className="h-5 w-5" aria-hidden /><span className="text-sm font-medium">Consultant</span>
            </button>
        );
    }

    return (
        <aside aria-label="GridIQ consultant"
            className="fixed z-50 inset-0 lg:inset-auto lg:top-0 lg:right-0 lg:h-screen lg:w-[400px] bg-surface border-l border-line-strong/60 flex flex-col print:hidden">
            <div className="px-4 py-3 border-b border-line flex items-start gap-2.5">
                <div className="flex-1 min-w-0">
                    <h2 className="font-semibold text-ink text-sm">GridIQ consultant</h2>
                    {!onScreen && live.length > 1 ? (
                        <select aria-label="Assessment" className="mt-1 bg-surface-2 rounded px-1.5 py-0.5 text-xs text-ink-2" value={current?.id ?? ""} onChange={(e) => setSel(e.target.value)}>
                            {live.map((a) => <option key={a.id} value={a.id}>{a.project_name} · {a.reference}</option>)}
                        </select>
                    ) : current ? (
                        <p className="mt-1 inline-flex flex-wrap gap-1 text-[11px]">
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-2">{current.project_name}</span>
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-3 tabular-nums">{current.reference}</span>
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">{fmtDateTime(current.start_at)} → now</span>
                        </p>
                    ) : null}
                </div>
                <button onClick={() => setOpen(false)} aria-label="Close the consultant" className="text-muted hover:text-ink p-1"><X className="w-4 h-4" /></button>
            </div>
            {!current ? (
                <div className="flex-1 p-6 text-sm text-ink-3 flex gap-3"><Lock className="w-5 h-5 text-faint shrink-0" aria-hidden />
                    {onScreen ? "This site has no live assessment, so the consultant is not available here." : "The consultant answers questions about an assessment while it is running. You have no live assessment right now."}</div>
            ) : (
                <>
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm" aria-live="polite">
                        {msgs.length === 0 && (
                            <div className="space-y-2">
                                <p className="text-muted">Questions about this site&apos;s measurements. Answers state the period and data they use, and separate what was measured from possible explanations. Advisory only: never work on live equipment yourself.</p>
                                {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="block text-left w-full text-accent hover:text-accent text-xs border border-line-strong rounded-lg px-3 py-2">{s}</button>)}
                            </div>
                        )}
                        {msgs.map((m, i) => m.role === "user" ? (
                            <div key={i} className="text-right"><div className="inline-block max-w-[90%] rounded-xl px-3 py-2 bg-blue-600 text-white text-left whitespace-pre-wrap">{m.content}</div></div>
                        ) : (
                            <div key={i}>
                                {m.content && <p className="text-[11px] uppercase tracking-wide text-faint mb-1">{m.provider === "none" ? "Measured-data summary" : m.provider ? "Consultant answer (AI, from the measured data)" : "Answer"}</p>}
                                <div className="rounded-xl px-4 py-3 bg-surface-2 text-ink">{m.content ? <Answer text={m.content} /> : <span className="text-faint">Working…</span>}</div>
                                {(m.basis || (m.evidence?.length ?? 0) > 0) && (
                                    <details className="mt-1 text-[11px] text-faint">
                                        <summary className="cursor-pointer">Evidence and basis</summary>
                                        {m.basis && <p className="mt-1">{m.basis}</p>}
                                        {!!m.evidence?.length && <p className="mt-1">Sections: {m.evidence.map((e) => EVIDENCE_LABEL[e] ?? e).join(", ")}</p>}
                                    </details>
                                )}
                            </div>
                        ))}
                        <div ref={end} />
                    </div>
                    <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="p-3 border-t border-line flex gap-2">
                        <label htmlFor="consultant-input" className="sr-only">Question</label>
                        <input id="consultant-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder={`Ask about ${current.project_name}…`} disabled={busy}
                            className="flex-1 bg-canvas border border-line-strong rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        <button disabled={busy || !input.trim()} aria-label="Send" className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg px-3"><Send className="w-4 h-4" /></button>
                    </form>
                </>
            )}
        </aside>
    );
}

const SECTION_STYLE: Record<string, string> = {
    "in short": "text-[15px] font-medium text-ink",
    "what you can expect to find on site": "",
    basis: "text-xs text-faint",
};

/**
 * Renders an answer written in "### Heading" sections with "- " bullets (the
 * consultant's fixed structure). Plain text without headings renders as is.
 * No HTML is interpreted: text only.
 */
function Answer({ text }: { text: string }) {
    const blocks = text.split(/\n(?=###\s)/).map((b) => b.trim()).filter(Boolean);
    if (!blocks.some((b) => b.startsWith("### "))) return <p className="whitespace-pre-wrap">{text}</p>;
    return (
        <div className="space-y-3">
            {blocks.map((b, i) => {
                if (!b.startsWith("### ")) return <p key={i} className="whitespace-pre-wrap text-sm text-ink-3">{b}</p>;
                const [head, ...rest] = b.split("\n");
                const title = head.replace(/^###\s*/, "").trim();
                const lines = rest.map((l) => l.trim()).filter(Boolean);
                const bullets = lines.filter((l) => /^[-•*]\s/.test(l)).map((l) => l.replace(/^[-•*]\s+/, "").replace(/\*\*/g, ""));
                const prose = lines.filter((l) => !/^[-•*]\s/.test(l)).join(" ").replace(/\*\*/g, "");
                const key = title.toLowerCase();
                return (
                    <section key={i} className={key === "basis" ? "border-t border-line pt-2" : ""}>
                        <h4 className={`text-[11px] font-semibold uppercase tracking-wide ${key === "what you can expect to find on site" ? "text-accent" : "text-faint"}`}>{title}</h4>
                        {prose && <p className={`mt-0.5 ${SECTION_STYLE[key] ?? "text-sm text-ink-2"}`}>{prose}</p>}
                        {bullets.length > 0 && (
                            <ul className={`mt-1 space-y-1 text-sm ${key === "what you can expect to find on site" ? "text-ink-2" : "text-ink-3"}`}>
                                {bullets.map((x, j) => <li key={j} className="flex gap-2"><span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-current opacity-60" /><span>{x}</span></li>)}
                            </ul>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
