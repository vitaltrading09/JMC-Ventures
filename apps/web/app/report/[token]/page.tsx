"use client";

import { useState, useEffect } from "react";
import { Loader2, Printer, ShieldOff, Clock, ShieldCheck } from "lucide-react";
import HealthCheckReport, {
    ComplianceReport, Branding, Forecast,
} from "@/components/report/HealthCheckReport";

// ─────────────────────────────────────────────────────────────────────────────
// Public, read-only view of a shared Power Quality Health Check.
//
// This route is deliberately OUTSIDE the middleware matcher in middleware.ts —
// the whole point is that a broker, underwriter or landlord can open it without
// an account. It renders the identical report component the owner sees, so the
// verification code on both copies matches.
//
// It shows the report and nothing else: no navigation, no account data, no
// links back into the dashboard, and no AI question box.
// ─────────────────────────────────────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL;

type FailureReason = "not_found" | "expired" | "revoked" | "rate_limited" | "error";

interface PublicPayload {
    report: ComplianceReport;
    summary: string | null;
    forecast: Forecast | null;
    branding: Branding;
    share: { expires_at: string };
}

const FAILURE_COPY: Record<FailureReason, { title: string; body: string; icon: React.ElementType }> = {
    not_found: {
        title: "This link isn't valid",
        body: "The link may have been mistyped or it may never have existed. Ask whoever sent it to issue a new one.",
        icon: ShieldOff,
    },
    expired: {
        title: "This link has expired",
        body: "Shared reports are time-limited for security. Ask whoever sent it to issue a fresh link.",
        icon: Clock,
    },
    revoked: {
        title: "This link has been revoked",
        body: "The owner of this report has withdrawn access. Please contact them directly.",
        icon: ShieldOff,
    },
    rate_limited: {
        title: "Too many requests",
        body: "This link has been opened many times in a short period. Please wait a minute and try again.",
        icon: Clock,
    },
    error: {
        title: "Report unavailable",
        body: "Something went wrong loading this report. Please try again shortly.",
        icon: ShieldOff,
    },
};

export default function PublicReportPage({ params }: { params: { token: string } }) {
    const [data,    setData]    = useState<PublicPayload | null>(null);
    const [failure, setFailure] = useState<FailureReason | null>(null);
    const [loading, setLoading] = useState(true);

    // Same print stylesheet as the owner's view — a recipient will very often
    // just want to save this as a PDF and forward it on.
    useEffect(() => {
        const el = document.createElement("style");
        el.id = "pq-print-public";
        el.innerHTML = `
            @media print {
                [data-noprint="true"] { display: none !important; }
                body { background: #fff !important; }
                .pq-page { box-shadow: none !important; margin: 0 !important; }
                .pq-break { break-inside: avoid; page-break-inside: avoid; }
                @page { margin: 14mm; size: A4 portrait; }
            }
        `;
        document.head.appendChild(el);
        return () => { el.remove(); };
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/ingestion/public/report/${params.token}`);
                if (res.ok) {
                    setData(await res.json());
                } else if (res.status === 429) {
                    setFailure("rate_limited");
                } else {
                    const body = await res.json().catch(() => null);
                    const reason = body?.error;
                    setFailure(
                        reason === "expired" || reason === "revoked" || reason === "not_found"
                            ? reason
                            : "error"
                    );
                }
            } catch {
                setFailure("error");
            } finally {
                setLoading(false);
            }
        })();
    }, [params.token]);

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-100 flex items-center justify-center">
                <div className="text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-500 mx-auto" />
                    <p className="text-sm text-slate-500 mt-3">Loading report…</p>
                </div>
            </div>
        );
    }

    if (failure || !data) {
        const f = FAILURE_COPY[failure ?? "error"];
        const FIcon = f.icon;
        return (
            <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
                <div className="bg-white rounded-xl shadow-sm max-w-md w-full p-8 text-center">
                    <FIcon className="h-10 w-10 text-slate-400 mx-auto" />
                    <h1 className="text-lg font-bold text-slate-900 mt-4">{f.title}</h1>
                    <p className="text-sm text-slate-600 mt-2 leading-relaxed">{f.body}</p>
                    <p className="text-[11px] text-slate-400 mt-6">GridIQ Power Quality Intelligence</p>
                </div>
            </div>
        );
    }

    const expires = new Date(data.share.expires_at);

    return (
        <div className="bg-slate-100 min-h-screen">
            {/* ── Recipient banner (never printed) ───────────────────────── */}
            <div data-noprint="true" className="bg-slate-900 border-b border-slate-800 px-6 py-4">
                <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-3">
                    <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
                    <div className="mr-auto">
                        <p className="text-sm font-semibold text-white">Shared power quality report — read only</p>
                        <p className="text-xs text-slate-400">
                            Issued by {data.branding.brand_name || "GridIQ"} ·
                            {" "}Access expires {expires.toLocaleDateString("en-ZA", {
                                day: "numeric", month: "long", year: "numeric",
                            })}
                        </p>
                    </div>
                    <button
                        onClick={() => window.print()}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
                    >
                        <Printer className="h-4 w-4" /> Print / PDF
                    </button>
                </div>
            </div>

            <HealthCheckReport
                report={data.report}
                brand={data.branding}
                forecast={data.forecast}
                summary={data.summary}
            />
        </div>
    );
}
