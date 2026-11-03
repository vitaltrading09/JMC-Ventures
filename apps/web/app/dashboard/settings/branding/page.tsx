"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Loader2, Palette, Save, CheckCircle2 } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL;

interface Branding {
    brand_name: string | null;
    brand_logo_url: string | null;
    brand_footer: string | null;
}

export default function BrandingSettingsPage() {
    const [form,    setForm]    = useState<Branding>({ brand_name: "", brand_logo_url: "", brand_footer: "" });
    const [loading, setLoading] = useState(true);
    const [saving,  setSaving]  = useState(false);
    const [saved,   setSaved]   = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/ingestion/branding`, { credentials: "include" });
                if (res.status === 401) { window.location.href = "/login"; return; }
                if (res.ok) {
                    const b = await res.json();
                    setForm({
                        brand_name: b.brand_name ?? "",
                        brand_logo_url: b.brand_logo_url ?? "",
                        brand_footer: b.brand_footer ?? "",
                    });
                }
            } catch { /* offline */ }
            finally { setLoading(false); }
        })();
    }, []);

    const save = async () => {
        setSaving(true); setSaved(false);
        try {
            const res = await fetch(`${API}/ingestion/branding`, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(form),
            });
            if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
        } catch { /* surfaced by the lack of a confirmation */ }
        finally { setSaving(false); }
    };

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in duration-500 max-w-3xl">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">Report Branding</h1>
                <p className="text-slate-400 mt-2">
                    Put your own identity on the Power Quality Health Check report. Installers and
                    consultants can hand the report to their own clients under their own name.
                </p>
            </div>

            <Card>
                <div className="p-6 border-b border-slate-800">
                    <h2 className="text-lg font-medium text-white flex items-center gap-2">
                        <Palette className="h-5 w-5 text-blue-500" />
                        White-label identity
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">
                        Leave blank to use Grid-IQ branding.
                    </p>
                </div>

                <div className="p-6 space-y-5">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-400">Company name</label>
                        <input
                            type="text"
                            value={form.brand_name ?? ""}
                            onChange={e => setForm({ ...form, brand_name: e.target.value })}
                            placeholder="e.g. Solar Eff Electrical"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-slate-600">Replaces “GRID-IQ” at the top of the report.</p>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-400">Logo URL</label>
                        <input
                            type="url"
                            value={form.brand_logo_url ?? ""}
                            onChange={e => setForm({ ...form, brand_logo_url: e.target.value })}
                            placeholder="https://yourcompany.co.za/logo.png"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-slate-600">
                            A publicly reachable image. Displayed at 40 px high; a transparent PNG works best.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-400">Footer contact line</label>
                        <input
                            type="text"
                            value={form.brand_footer ?? ""}
                            onChange={e => setForm({ ...form, brand_footer: e.target.value })}
                            placeholder="yourcompany.co.za · 012 345 6789"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                    </div>

                    {/* Live preview of the report letterhead */}
                    <div className="pt-2">
                        <p className="text-xs uppercase tracking-wider text-slate-500 mb-2">Preview</p>
                        <div className="bg-white rounded-lg p-5 border border-slate-300">
                            <div className="flex items-start justify-between border-b-2 border-slate-800 pb-3">
                                <div>
                                    {form.brand_logo_url ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={form.brand_logo_url} alt="Logo preview"
                                             className="h-10 max-w-[200px] object-contain object-left" />
                                    ) : (
                                        <p className="text-xl font-bold tracking-tight text-slate-900">
                                            {form.brand_name?.trim() || "GRID-IQ"}
                                        </p>
                                    )}
                                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-0.5">
                                        Power Quality Engineering Report
                                    </p>
                                </div>
                                <p className="text-[10px] text-slate-500">
                                    {new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}
                                </p>
                            </div>
                            <p className="text-[10px] text-slate-500 mt-3">
                                {form.brand_footer?.trim() || "grid-iq.co.za"} · Confidential
                            </p>
                        </div>
                    </div>
                </div>

                <div className="px-6 py-4 bg-slate-900/50 rounded-b-xl border-t border-slate-800 flex items-center justify-end gap-3">
                    {saved && (
                        <span className="flex items-center gap-1.5 text-sm text-emerald-400">
                            <CheckCircle2 className="h-4 w-4" /> Saved
                        </span>
                    )}
                    <button
                        onClick={save}
                        disabled={saving}
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save branding
                    </button>
                </div>
            </Card>
        </div>
    );
}
