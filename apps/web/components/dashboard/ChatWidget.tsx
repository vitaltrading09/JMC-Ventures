"use client";

// The assessment consultant (GridIQ prompt section 12). Available while the
// caller holds a live assessment; the server picks the data (the assessment's
// own dataset) and enforces access and budgets. Answers state their basis.
// Other components open it with a question: window.dispatchEvent(new
// CustomEvent("gridiq:ask", { detail: "..." })) (lib/portal.ts askConsultant).

import { useEffect, useRef, useState } from "react";
import { MessageSquare, X, Send, Sparkles, Lock } from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { usePortalAssessments } from "@/components/portal/AssessmentBanner";

interface Msg { role: "user" | "assistant"; content: string; basis?: string }

const SUGGESTIONS = [
    "What caused the highest demand peak, and what evidence do we have?",
    "Is the harmonic distortion concentrated in one phase or period?",
    "Why is the power factor lower at night?",
    "What should we tell the feasibility engineer?",
];

export function ChatWidget() {
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [msgs, setMsgs] = useState<Msg[]>([]);
    const [pending, setPending] = useState<string | null>(null);
    const [sel, setSel] = useState<string | null>(null);
    const end = useRef<HTMLDivElement>(null);
    const assessments = usePortalAssessments();
    const live = (assessments.data ?? []).filter((a) => a.live);
    const current = live.find((a) => a.id === sel) ?? live[0] ?? null;

    useEffect(() => {
        const onAsk = (e: Event) => { const q = (e as CustomEvent<string>).detail; if (q) { setOpen(true); setPending(q); } };
        window.addEventListener("gridiq:ask", onAsk);
        return () => window.removeEventListener("gridiq:ask", onAsk);
    }, []);
    useEffect(() => {
        if (!open || !current) return;
        apiGet<{ messages: Msg[] }>(`/ingestion/assessments/${current.id}/chat`).then((r) => setMsgs(r.messages)).catch(() => setMsgs([]));
    }, [open, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
    useEffect(() => { if (open && pending && current && !busy) { const q = pending; setPending(null); send(q); } }, [open, pending, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const send = async (text: string) => {
        if (!text.trim() || !current) return;
        setInput("");
        setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
        setBusy(true);
        try {
            const r = await apiSend<{ answer: string; provider: string; basis: { period_from: string; period_to: string; provisional: boolean; coverage: { point: string; fraction: number | null }[] }; evidence: string[] }>(
                "POST", `/ingestion/assessments/${current.id}/chat`, { message: text });
            const cov = r.basis.coverage.map((c) => `${c.point} ${c.fraction === null ? "–" : Math.round(c.fraction * 100) + " %"}`).join(", ");
            const basis = `Data ${r.basis.period_from.slice(0, 10)} → ${r.basis.period_to.slice(0, 10)}${r.basis.provisional ? " (provisional)" : ""} · coverage ${cov}${r.evidence.length ? ` · sections: ${r.evidence.join(", ")}` : ""}${r.provider === "none" ? " · no AI model used" : ""}`;
            setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: r.answer, basis }]);
        } catch (e: any) {
            setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: `Could not answer: ${e.message}` }]);
        } finally { setBusy(false); }
    };

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end print:hidden">
            {open && (
                <div className="w-[360px] sm:w-[440px] h-[560px] max-h-[80vh] bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl flex flex-col mb-4 overflow-hidden">
                    <div className="px-4 py-3 bg-gradient-to-r from-blue-900/50 to-indigo-900/50 border-b border-slate-700/60 flex items-center gap-2.5">
                        <Sparkles className="w-4 h-4 text-blue-400" />
                        <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-white text-sm">GridIQ consultant</h3>
                            {live.length > 1 ? (
                                <select className="bg-transparent text-xs text-slate-300" value={current?.id ?? ""} onChange={(e) => setSel(e.target.value)}>
                                    {live.map((a) => <option key={a.id} value={a.id} className="bg-slate-900">{a.reference} · {a.project_name}</option>)}
                                </select>
                            ) : <p className="text-xs text-slate-400 truncate">{current ? `${current.reference} · ${current.project_name}` : "No live assessment"}</p>}
                        </div>
                        <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
                    </div>
                    {!current ? (
                        <div className="flex-1 p-6 text-sm text-slate-300 flex gap-3"><Lock className="w-5 h-5 text-slate-500 shrink-0" />
                            The consultant answers questions about an assessment while it is running. You have no live assessment right now.</div>
                    ) : (
                        <>
                            <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
                                {msgs.length === 0 && (
                                    <div className="space-y-2">
                                        <p className="text-slate-400">Ask about this assessment's measurements. Answers cite the data they use; general explanations are labelled as such. Advisory only: never work on live equipment yourself.</p>
                                        {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="block text-left w-full text-blue-300 hover:text-blue-200 text-xs border border-slate-700 rounded-lg px-3 py-2">{s}</button>)}
                                    </div>
                                )}
                                {msgs.map((m, i) => (
                                    <div key={i} className={m.role === "user" ? "text-right" : ""}>
                                        <div className={`inline-block max-w-[90%] rounded-xl px-3 py-2 whitespace-pre-wrap text-left ${m.role === "user" ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-100"}`}>
                                            {m.content || <span className="text-slate-500">…</span>}
                                        </div>
                                        {m.basis && <p className="text-[11px] text-slate-500 mt-1">{m.basis}</p>}
                                    </div>
                                ))}
                                <div ref={end} />
                            </div>
                            <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="p-3 border-t border-slate-800 flex gap-2">
                                <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about this assessment…" disabled={busy}
                                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                <button disabled={busy || !input.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg px-3"><Send className="w-4 h-4" /></button>
                            </form>
                        </>
                    )}
                </div>
            )}
            <button onClick={() => setOpen((v) => !v)} className="w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-lg flex items-center justify-center" aria-label="Open the GridIQ consultant">
                {open ? <X className="w-6 h-6" /> : <MessageSquare className="w-6 h-6" />}
            </button>
        </div>
    );
}
