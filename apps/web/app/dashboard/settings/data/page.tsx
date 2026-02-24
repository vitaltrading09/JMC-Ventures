"use client";

import { useState, useEffect, useRef } from "react";
import { UploadCloud, CheckCircle2, AlertTriangle, Loader2, ArrowRight, ArrowLeft, BarChart2, FileSpreadsheet, Plus, ChevronDown } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";

interface Site { id: string; name: string; }
interface Meter { id: string; name: string; site_id: string; }

const MEASUREMENT_MAP: Record<string, string> = {
    power_active_total: "Active Power (P) kW",
    power_reactive_total: "Reactive Power (Q) kVAr",
    power_apparent_total: "Apparent Power (S) kVA",
    power_factor_total: "Power Factor",
    voltage_a: "Voltage (V)",
    current_a: "Current (A)",
    thd_voltage_a: "THD Harmonics (%)",
    energy_import_total: "Energy Import (kWh)",
};

export default function DataImportPage() {
    const [step, setStep] = useState(1);
    const [sites, setSites] = useState<Site[]>([]);
    const [meters, setMeters] = useState<Meter[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [selectedMeterId, setSelectedMeterId] = useState("");
    const [newMeterName, setNewMeterName] = useState("");
    const [createNewMeter, setCreateNewMeter] = useState(false);
    const [creatingMeter, setCreatingMeter] = useState(false);

    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<{ headers: string[]; rows: any[]; detectedColumns: string[] } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [uploading, setUploading] = useState(false);
    const [result, setResult] = useState<{ count: number; skipped: number; meterId: string } | null>(null);
    const [error, setError] = useState("");

    const token = () => localStorage.getItem('token') || '';

    // Fetch sites
    useEffect(() => {
        fetch('http://localhost:8081/ingestion/sites', { headers: { Authorization: `Bearer ${token()}` } })
            .then(r => r.json()).then(setSites).catch(() => { });
    }, []);

    // Fetch meters for selected site
    useEffect(() => {
        if (!selectedSiteId) return;
        fetch('http://localhost:8081/ingestion/meters', { headers: { Authorization: `Bearer ${token()}` } })
            .then(r => r.json())
            .then((all: Meter[]) => setMeters(all.filter(m => m.site_id === selectedSiteId)))
            .catch(() => { });
    }, [selectedSiteId]);

    const handleCreateMeter = async () => {
        if (!newMeterName.trim() || !selectedSiteId) return;
        setCreatingMeter(true); setError("");
        try {
            const res = await fetch('http://localhost:8081/ingestion/meters', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ name: newMeterName.trim(), site_id: selectedSiteId, serial_number: 'IMPORTED', model: 'CSV Import' }),
            });
            if (!res.ok) throw new Error(await res.text());
            const meter = await res.json();
            setMeters(prev => [...prev, meter]);
            setSelectedMeterId(meter.id);
            setCreateNewMeter(false);
            setNewMeterName("");
        } catch (e: any) { setError(e.message); }
        finally { setCreatingMeter(false); }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (!f) return;
        setFile(f); setPreview(null); setError("");
        setPreviewLoading(true);
        try {
            const fd = new FormData(); fd.append('file', f);
            const res = await fetch('http://localhost:8081/ingestion/upload/preview', {
                method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd,
            });
            if (res.ok) setPreview(await res.json());
            else setError("Could not preview file — make sure it's a valid CSV.");
        } catch { setError("Preview failed."); }
        finally { setPreviewLoading(false); }
    };

    const handleUpload = async () => {
        if (!file || !selectedMeterId) { setError("Select a meter and file first."); return; }
        setUploading(true); setError("");
        const fd = new FormData(); fd.append('file', file); fd.append('meter_id', selectedMeterId);
        try {
            const res = await fetch('http://localhost:8081/ingestion/upload', {
                method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            setResult({ count: data.count, skipped: data.skipped || 0, meterId: selectedMeterId });
            setStep(3);
        } catch (e: any) { setError(e.message); }
        finally { setUploading(false); }
    };

    const canGoStep2 = selectedSiteId && selectedMeterId;

    const siteMeterCount = meters.length;

    return (
        <div className="space-y-6 animate-in fade-in duration-500 max-w-3xl mx-auto">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">Data Import</h1>
                <p className="text-slate-400 mt-1.5">Import historical or audit load data from a CSV file.</p>
            </div>

            {/* Step Indicator */}
            <div className="flex items-center gap-2">
                {[1, 2, 3].map((s, i) => (
                    <div key={s} className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all
                            ${step === s ? 'bg-blue-600 border-blue-500 text-white' :
                                step > s ? 'bg-emerald-600 border-emerald-500 text-white' :
                                    'bg-slate-900 border-slate-700 text-slate-500'}`}>
                            {step > s ? <CheckCircle2 className="w-4 h-4" /> : s}
                        </div>
                        <span className={`text-sm ${step === s ? 'text-white font-medium' : 'text-slate-500'}`}>
                            {['Select Meter', 'Upload CSV', 'Done'][i]}
                        </span>
                        {i < 2 && <div className="w-10 h-px bg-slate-700 mx-1" />}
                    </div>
                ))}
            </div>

            {error && (
                <div className="flex items-center gap-2 p-3 bg-red-950/50 border border-red-500/30 rounded-lg text-red-400 text-sm">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
                </div>
            )}

            {/* STEP 1: Site & Meter */}
            {step === 1 && (
                <Card className="p-6 space-y-5">
                    <CardHeader title="Step 1: Select Site & Meter" icon={BarChart2} />

                    <div>
                        <label className="text-sm text-slate-400 block mb-1.5">Site</label>
                        <select value={selectedSiteId} onChange={e => { setSelectedSiteId(e.target.value); setSelectedMeterId(""); }}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-blue-500/50 focus:outline-none">
                            <option value="">— Select a site —</option>
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        {sites.length === 0 && <p className="text-xs text-slate-500 mt-1.5">No sites yet — <a href="/dashboard/sites" className="text-blue-400 hover:underline">create one first</a>.</p>}
                    </div>

                    {selectedSiteId && (
                        <div>
                            <label className="text-sm text-slate-400 block mb-1.5">Meter (data source name)</label>
                            {!createNewMeter ? (
                                <div className="space-y-2">
                                    {meters.length > 0 && (
                                        <select value={selectedMeterId} onChange={e => setSelectedMeterId(e.target.value)}
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-blue-500/50 focus:outline-none">
                                            <option value="">— Select existing meter —</option>
                                            {meters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                                        </select>
                                    )}
                                    <button onClick={() => setCreateNewMeter(true)}
                                        className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition-colors">
                                        <Plus className="w-4 h-4" />
                                        {meters.length === 0 ? 'Create a new meter for this import' : 'Or create a new meter'}
                                    </button>
                                </div>
                            ) : (
                                <div className="flex gap-2">
                                    <input value={newMeterName} onChange={e => setNewMeterName(e.target.value)}
                                        placeholder="e.g. Main Incomer — Factory Floor"
                                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-blue-500/50 focus:outline-none" />
                                    <button onClick={handleCreateMeter} disabled={creatingMeter || !newMeterName.trim()}
                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5">
                                        {creatingMeter ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                        Create
                                    </button>
                                    <button onClick={() => setCreateNewMeter(false)} className="px-3 py-2 text-slate-400 hover:text-white text-sm">Cancel</button>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex justify-end pt-2">
                        <button onClick={() => { setStep(2); setError(""); }} disabled={!canGoStep2}
                            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg font-medium transition-colors">
                            Next: Upload CSV <ArrowRight className="w-4 h-4" />
                        </button>
                    </div>
                </Card>
            )}

            {/* STEP 2: Upload + Preview */}
            {step === 2 && (
                <div className="space-y-4">
                    <Card className="p-6 space-y-5">
                        <div className="flex items-center justify-between">
                            <CardHeader title="Step 2: Upload CSV File" icon={UploadCloud} />
                            <button onClick={() => setStep(1)} className="text-xs text-slate-500 hover:text-white flex items-center gap-1">
                                <ArrowLeft className="w-3 h-3" /> Change meter
                            </button>
                        </div>

                        <div className="bg-slate-800/40 rounded-xl border border-slate-700 p-3 text-sm text-slate-400">
                            <span className="text-white font-medium">Importing to:</span> {meters.find(m => m.id === selectedMeterId)?.name || selectedMeterId}
                        </div>

                        {/* CSV Format hint */}
                        <div className="bg-blue-950/30 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300 space-y-1">
                            <p className="font-semibold text-blue-200">Expected CSV columns (any name that matches is auto-detected):</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-blue-400">
                                {Object.entries(MEASUREMENT_MAP).map(([k, v]) => (
                                    <span key={k}>• <span className="text-blue-200 font-mono">{k.split('_')[0] === 'power' ? k : k.split('_')[0]}</span> → {v}</span>
                                ))}
                                <span>• <span className="text-blue-200 font-mono">time</span> / <span className="font-mono">timestamp</span> <span className="text-blue-500">(required)</span></span>
                            </div>
                            <p className="text-blue-500 pt-1">Supports: ISO date or DD/MM/YYYY HH:MM (SA Excel format)</p>
                        </div>

                        {/* Drop Zone */}
                        <div onClick={() => fileInputRef.current?.click()}
                            className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all
                                ${file ? 'border-blue-500/50 bg-blue-950/20' : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/30'}`}>
                            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
                            {previewLoading ? (
                                <div className="flex flex-col items-center gap-3 text-slate-400">
                                    <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
                                    <p className="text-sm">Analysing file...</p>
                                </div>
                            ) : file ? (
                                <div className="flex flex-col items-center gap-2">
                                    <FileSpreadsheet className="w-10 h-10 text-blue-400" />
                                    <p className="font-medium text-white">{file.name}</p>
                                    <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-slate-400">
                                    <UploadCloud className="w-10 h-10" />
                                    <p className="font-medium text-white">Click to select a CSV file</p>
                                    <p className="text-xs">or drag & drop here</p>
                                </div>
                            )}
                        </div>

                        {/* Column Preview */}
                        {preview && (
                            <div className="space-y-3">
                                <div>
                                    <p className="text-sm font-medium text-white mb-2">✅ Detected columns ({preview.detectedColumns.length} matched):</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {preview.detectedColumns.map(col => (
                                            <span key={col} className="px-2 py-0.5 bg-emerald-900/40 border border-emerald-500/30 text-emerald-400 text-xs rounded-full">
                                                {MEASUREMENT_MAP[col] || col}
                                            </span>
                                        ))}
                                        {preview.headers
                                            .filter(h => !preview.detectedColumns.some(d => d.toLowerCase().includes(h.trim().toLowerCase().split('/')[0])))
                                            .map(h => (
                                                <span key={h} className="px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-500 text-xs rounded-full">{h} (ignored)</span>
                                            ))}
                                    </div>
                                </div>

                                <div>
                                    <p className="text-sm font-medium text-white mb-2">Preview (first {preview.rows.length} rows):</p>
                                    <div className="overflow-x-auto rounded-lg border border-slate-700">
                                        <table className="text-xs w-full">
                                            <thead className="bg-slate-800">
                                                <tr>{preview.headers.map(h => <th key={h} className="px-2 py-1.5 text-left text-slate-400 font-medium whitespace-nowrap">{h}</th>)}</tr>
                                            </thead>
                                            <tbody>
                                                {preview.rows.map((row, i) => (
                                                    <tr key={i} className="border-t border-slate-800">
                                                        {preview.headers.map(h => <td key={h} className="px-2 py-1.5 text-slate-300 font-mono whitespace-nowrap">{row[h]}</td>)}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex justify-between pt-2">
                            <button onClick={() => setStep(1)} className="flex items-center gap-2 px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors">
                                <ArrowLeft className="w-4 h-4" /> Back
                            </button>
                            <button onClick={handleUpload} disabled={!file || uploading || !preview || preview.detectedColumns.length === 0}
                                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg font-medium transition-colors">
                                {uploading ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing...</> : <><UploadCloud className="w-4 h-4" /> Import Data</>}
                            </button>
                        </div>
                    </Card>
                </div>
            )}

            {/* STEP 3: Success */}
            {step === 3 && result && (
                <Card className="p-8 text-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-emerald-900/30 border border-emerald-500/40 flex items-center justify-center mx-auto">
                        <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-white">{result.count.toLocaleString()} rows imported</h2>
                        {result.skipped > 0 && <p className="text-slate-400 text-sm mt-1">{result.skipped} rows skipped (missing timestamp)</p>}
                    </div>
                    <p className="text-slate-400 text-sm">Your data is now available in the site chart. You can filter by date and measurement.</p>
                    <div className="flex items-center justify-center gap-3 pt-2">
                        <a href={`/dashboard/sites/${result.meterId}`}
                            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors">
                            View on Chart <ArrowRight className="w-4 h-4" />
                        </a>
                        <button onClick={() => { setStep(1); setFile(null); setPreview(null); setResult(null); setError(""); }}
                            className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-medium transition-colors">
                            Import Another
                        </button>
                    </div>
                </Card>
            )}
        </div>
    );
}
