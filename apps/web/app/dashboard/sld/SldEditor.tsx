"use client";

// Interactive Single-Line Diagram editor.
//
// - PDF backdrop: clients upload their existing electrical SLD PDF; we render
//   the first page as a static image behind the canvas. The builder drops meter
//   pins on top to align with the PDF.
// - Meter pins (custom React Flow node) display live kW/V/PF and alert state.
// - Edit mode toggles palette + drag-to-position + Save Layout.
// - View mode is read-only; perfect for client login.

import { useCallback, useEffect, useRef, useState } from "react";
import { pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import ReactFlow, {
    Background, Controls, MiniMap,
    Node, Edge, NodeChange, applyNodeChanges,
    ReactFlowProvider,
    useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import {
    Save, Upload, Trash2, Edit, Eye, MapPin, Loader2, Plus,
    AlertTriangle, FileText, RefreshCw, X,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import MeterNode, { MeterNodeData } from "./MeterNode";
import PdfBackdropNode from "./PdfBackdropNode";

// pdf.js worker — load from CDN matching the installed pdfjs-dist version.
// Avoids the build-time bundler dance for the worker file.
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

interface Site  { id: string; name: string; }
interface Meter {
    id: string; name: string; site_id: string; is_active?: boolean;
    latest_reading?: {
        power_active_total?: number; voltage_a?: number;
        power_factor_total?: number; time: string;
    } | null;
}
interface Alert {
    id: string; meter_id: string; severity: "INFO" | "WARNING" | "CRITICAL";
    is_read: boolean; type: string; message: string; created_at: string;
}

// Register custom node types with React Flow. Defined outside component so
// the reference is stable — React Flow warns if nodeTypes changes per render.
const nodeTypes = { meter: MeterNode, "pdf-backdrop": PdfBackdropNode };

function Inner() {
    const rf = useReactFlow();

    const [sites,        setSites]        = useState<Site[]>([]);
    const [siteId,       setSiteId]       = useState<string>("");
    const [meters,       setMeters]       = useState<Meter[]>([]);
    const [alerts,       setAlerts]       = useState<Alert[]>([]);

    const [nodes,        setNodes]        = useState<Node<MeterNodeData>[]>([]);
    const [editMode,     setEditMode]     = useState(false);
    const [loading,      setLoading]      = useState(true);
    const [saving,       setSaving]       = useState(false);
    const [hasPdf,       setHasPdf]       = useState(false);
    const [pdfUrl,       setPdfUrl]       = useState<string | null>(null);
    const [pdfDim,       setPdfDim]       = useState<{ w: number; h: number } | null>(null);
    const [uploadingPdf, setUploadingPdf] = useState(false);
    const [dirty,        setDirty]        = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Fetch sites + meters + alerts ─────────────────────────────────────────
    useEffect(() => {
        (async () => {
            const [s, m, a] = await Promise.all([
                fetch(`${API}/ingestion/sites`,   { credentials: 'include' }).then(r => r.ok ? r.json() : []),
                fetch(`${API}/ingestion/meters`,  { credentials: 'include' }).then(r => r.ok ? r.json() : []),
                fetch(`${API}/ingestion/alerts`,  { credentials: 'include' }).then(r => r.ok ? r.json() : []),
            ]);
            setSites(Array.isArray(s) ? s : []);
            setMeters(Array.isArray(m) ? m : []);
            setAlerts(Array.isArray(a) ? a : []);
            if (Array.isArray(s) && s.length > 0) setSiteId(s[0].id);
            setLoading(false);
        })();
    }, []);

    // Refresh live data (meters + alerts) every 12s while page is open
    useEffect(() => {
        const iv = setInterval(async () => {
            const [m, a] = await Promise.all([
                fetch(`${API}/ingestion/meters`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
                fetch(`${API}/ingestion/alerts`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
            ]);
            if (Array.isArray(m)) setMeters(m);
            if (Array.isArray(a)) setAlerts(a);
        }, 12_000);
        return () => clearInterval(iv);
    }, []);

    // ── Load diagram for selected site ─────────────────────────────────────────
    useEffect(() => {
        if (!siteId) return;
        (async () => {
            const res = await fetch(`${API}/ingestion/sites/${siteId}/diagram`, { credentials: 'include' });
            if (!res.ok) { setNodes([]); setHasPdf(false); setPdfUrl(null); return; }
            const data = await res.json();
            const layoutNodes = (data.layout?.nodes ?? []) as Node<MeterNodeData>[];
            setNodes(layoutNodes);
            setHasPdf(!!data.has_pdf);
            // Build a one-time auth'd object URL for the PDF stream.
            // ReactPDF needs either a URL string or Uint8Array; we use a blob URL.
            if (data.has_pdf) {
                const pdfRes = await fetch(`${API}/ingestion/sites/${siteId}/diagram/pdf`, { credentials: 'include' });
                if (pdfRes.ok) {
                    const blob = await pdfRes.blob();
                    setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
                }
            } else {
                setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
            }
            if (data.background_width && data.background_height) {
                setPdfDim({ w: data.background_width, h: data.background_height });
            } else {
                setPdfDim(null);
            }
            setDirty(false);
            setTimeout(() => rf.fitView({ padding: 0.15 }), 300);
        })();
    }, [siteId, rf]);

    // Re-fit once the PDF has reported its rendered dimensions — the first
    // fitView often fires before the PDF canvas exists, leaving it overshoot.
    useEffect(() => {
        if (!pdfDim) return;
        const id = setTimeout(() => rf.fitView({ padding: 0.15 }), 150);
        return () => clearTimeout(id);
    }, [pdfDim, rf]);

    // ── Merge live data + alerts into the displayed nodes ────────────────────
    // Decouples layout state from the per-tick data refresh — we keep positions
    // from `nodes` but always replace the `data` payload from the live sources.

    // PDF backdrop is a special non-draggable node placed at (0,0) behind everything.
    const backdropNode: Node | null = pdfUrl ? {
        id:         "__pdf_backdrop__",
        type:       "pdf-backdrop",
        position:   { x: 0, y: 0 },
        data:       {
            pdfUrl,
            width: 1400,
            onPageRendered: (d: { width: number; height: number }) => {
                if (!pdfDim || pdfDim.w !== d.width || pdfDim.h !== d.height) setPdfDim({ w: d.width, h: d.height });
            },
        },
        draggable:  false,
        selectable: false,
        deletable:  false,
        zIndex:     -1,
    } : null;

    const meterNodes: Node<MeterNodeData>[] = nodes.map(n => {
        const meter = meters.find(m => m.id === n.data.meterId);
        const meterAlerts = alerts.filter(a => a.meter_id === n.data.meterId && !a.is_read);
        const worst = meterAlerts.find(a => a.severity === "CRITICAL")
            ?? meterAlerts.find(a => a.severity === "WARNING")
            ?? meterAlerts[0];
        const isLive = !!meter?.latest_reading?.time
            && (Date.now() - new Date(meter.latest_reading.time).getTime()) < 180_000;
        return {
            ...n,
            type: "meter",
            draggable: editMode,
            // Always selectable so view-mode users can click a pin to expand its details.
            selectable: true,
            data: {
                label:         meter?.name ?? n.data.label ?? "Unknown",
                meterId:       n.data.meterId,
                powerKw:       meter?.latest_reading?.power_active_total ?? null,
                voltage:       meter?.latest_reading?.voltage_a ?? null,
                pf:            meter?.latest_reading?.power_factor_total ?? null,
                isLive,
                alertSeverity: worst?.severity ?? null,
                alertCount:    meterAlerts.length,
                isEditing:     editMode,
            },
        };
    });
    // Combined for React Flow: backdrop first so meter nodes layer on top.
    const liveNodes: Node[] = backdropNode ? [backdropNode, ...meterNodes] : meterNodes;

    // ── Edit mode handlers ────────────────────────────────────────────────────
    const onNodesChange = useCallback((changes: NodeChange[]) => {
        if (!editMode) return;
        // Filter out any changes to the synthetic backdrop node — it's never in
        // the persisted `nodes` array so applyNodeChanges would just drop it,
        // but skipping early avoids an unnecessary state churn.
        const realChanges = changes.filter(c => (c as any).id !== "__pdf_backdrop__");
        if (realChanges.length === 0) return;
        setNodes(prev => applyNodeChanges(realChanges, prev) as Node<MeterNodeData>[]);
        if (realChanges.some(c => c.type === "position" && (c as any).dragging === false)) setDirty(true);
    }, [editMode]);

    const handleAddMeter = (meterId: string) => {
        const meter = meters.find(m => m.id === meterId);
        if (!meter) return;
        // Drop in the centre of the current viewport
        const center = rf.screenToFlowPosition({
            x: window.innerWidth / 2 - 70,
            y: window.innerHeight / 2,
        });
        const newNode: Node<MeterNodeData> = {
            id: `meter-${meter.id}`,
            type: "meter",
            position: center,
            data: { label: meter.name, meterId: meter.id },
        };
        setNodes(prev => [...prev.filter(n => n.id !== newNode.id), newNode]);
        setDirty(true);
    };

    const handleRemoveSelected = () => {
        const selectedIds = nodes.filter(n => (n as any).selected).map(n => n.id);
        if (selectedIds.length === 0) return;
        setNodes(prev => prev.filter(n => !selectedIds.includes(n.id)));
        setDirty(true);
    };

    const handleSave = async () => {
        if (!siteId) return;
        setSaving(true);
        try {
            // Strip the runtime-only `data` keys before persisting — keep only
            // what's actually layout: position + meter binding.
            const payload = {
                nodes: nodes.map(n => ({
                    id:       n.id,
                    type:     n.type ?? "meter",
                    position: n.position,
                    data:     { label: n.data.label, meterId: n.data.meterId },
                })),
                edges: [] as Edge[],
            };
            const res = await fetch(`${API}/ingestion/sites/${siteId}/diagram`, {
                method:  "PUT",
                credentials: 'include',
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({
                    layout: payload,
                    // PDF.js reports float dimensions but the DB column is INTEGER.
                    background_width:  pdfDim ? Math.round(pdfDim.w) : undefined,
                    background_height: pdfDim ? Math.round(pdfDim.h) : undefined,
                }),
            });
            if (res.ok) setDirty(false);
            else alert(`Save failed: ${res.status}`);
        } finally {
            setSaving(false);
        }
    };

    const handleUploadPdf = async (file: File) => {
        if (!siteId) return;
        setUploadingPdf(true);
        try {
            const form = new FormData();
            form.append("pdf", file);
            const res = await fetch(`${API}/ingestion/sites/${siteId}/diagram/pdf`, {
                method:  "POST",
                credentials: 'include',
                body:    form,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(`Upload failed: ${err.error ?? res.status}`);
                return;
            }
            // Reload the PDF and the diagram metadata
            const pdfRes  = await fetch(`${API}/ingestion/sites/${siteId}/diagram/pdf`, { credentials: 'include' });
            if (pdfRes.ok) {
                const blob = await pdfRes.blob();
                setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
                setHasPdf(true);
            }
        } finally {
            setUploadingPdf(false);
        }
    };

    const handleDeletePdf = async () => {
        if (!siteId || !confirm("Remove the PDF backdrop for this site? Your meter positions stay in place.")) return;
        const res = await fetch(`${API}/ingestion/sites/${siteId}/diagram/pdf`, {
            method:  "DELETE",
            credentials: 'include',
        });
        if (res.ok) {
            setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
            setHasPdf(false);
            setPdfDim(null);
        }
    };

    // Meters available to add — only those for the current site that aren't on the diagram yet
    const placedMeterIds = new Set(nodes.map(n => n.data.meterId));
    const availableMeters = meters.filter(m => m.site_id === siteId && m.is_active !== false && !placedMeterIds.has(m.id));

    if (loading) return (
        <div className="flex items-center justify-center h-[60vh] text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading…
        </div>
    );

    if (sites.length === 0) return (
        <Card className="p-12 text-center">
            <MapPin className="w-10 h-10 text-slate-700 mx-auto mb-3" />
            <p className="text-slate-400">No sites yet — create a site first.</p>
        </Card>
    );

    return (
        <div className="space-y-4 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Single-Line Diagram</h1>
                    <p className="text-slate-400 mt-1 text-sm">
                        Pin meters onto your existing SLD. Live kW + alerts overlay automatically.
                    </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <select
                        value={siteId}
                        onChange={e => setSiteId(e.target.value)}
                        className="bg-slate-900 border border-slate-800 text-slate-300 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    >
                        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <button
                        onClick={() => setEditMode(m => !m)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                            editMode
                                ? "bg-blue-600/30 border-blue-500/40 text-blue-300"
                                : "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200"
                        }`}
                    >
                        {editMode ? <Eye className="w-4 h-4" /> : <Edit className="w-4 h-4" />}
                        {editMode ? "View mode" : "Edit"}
                    </button>
                </div>
            </div>

            {/* Edit mode toolbar */}
            {editMode && (
                <Card className="p-3 border-blue-500/20 bg-blue-950/30">
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-semibold uppercase tracking-wider text-blue-300">Edit toolbar</span>

                        {/* Add meter */}
                        <div className="flex items-center gap-2">
                            <select
                                value=""
                                onChange={e => { if (e.target.value) handleAddMeter(e.target.value); e.target.value = ""; }}
                                disabled={availableMeters.length === 0}
                                className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-40"
                            >
                                <option value="">
                                    {availableMeters.length === 0 ? "All meters placed" : "+ Add meter…"}
                                </option>
                                {availableMeters.map(m => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </div>

                        {/* PDF upload */}
                        {!hasPdf ? (
                            <>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="application/pdf"
                                    onChange={e => {
                                        const f = e.target.files?.[0];
                                        if (f) handleUploadPdf(f);
                                        e.target.value = "";
                                    }}
                                    className="hidden"
                                />
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={uploadingPdf}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm rounded-lg border border-slate-700 disabled:opacity-50"
                                >
                                    {uploadingPdf ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                                    Upload client SLD PDF
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={handleDeletePdf}
                                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-red-900/50 text-slate-200 hover:text-red-300 text-sm rounded-lg border border-slate-700"
                            >
                                <X className="w-4 h-4" /> Remove PDF backdrop
                            </button>
                        )}

                        {/* Remove selected */}
                        <button
                            onClick={handleRemoveSelected}
                            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-red-900/50 text-slate-200 hover:text-red-300 text-sm rounded-lg border border-slate-700"
                        >
                            <Trash2 className="w-4 h-4" /> Remove selected
                        </button>

                        <div className="flex-1" />

                        {/* Save */}
                        <button
                            onClick={handleSave}
                            disabled={saving || !dirty}
                            className="flex items-center gap-2 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg font-medium disabled:opacity-40"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {dirty ? "Save layout" : "No changes"}
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-2">
                        Drop meters from the dropdown, drag to align with your PDF, click to select then Remove.
                        Click <strong>Save layout</strong> to persist. Pan/zoom with the canvas controls (bottom-left).
                    </p>
                </Card>
            )}

            {/* Canvas — PDF backdrop layer + React Flow on top */}
            <div className="relative h-[78vh] rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
                <ReactFlow
                    nodes={liveNodes}
                    edges={[]}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    nodesDraggable={editMode}
                    nodesConnectable={false}
                    elementsSelectable={true}
                    fitView
                    fitViewOptions={{ padding: 0.15 }}
                    minZoom={0.1}
                    maxZoom={4}
                    proOptions={{ hideAttribution: true }}
                    panOnDrag
                    selectionOnDrag={false}
                >
                    <Background gap={32} size={1.5} color="#1e293b" />
                    <Controls position="bottom-left" showInteractive={false} className="!bg-slate-900 !border-slate-700" />
                    <MiniMap
                        position="bottom-right"
                        pannable zoomable
                        nodeColor={(n) => (n.data as any)?.alertSeverity ? "#f59e0b" : "#3b82f6"}
                        maskColor="rgba(2, 6, 23, 0.7)"
                        className="!bg-slate-900 !border-slate-700"
                    />

                </ReactFlow>

                {/* Empty-state hint */}
                {!pdfUrl && nodes.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="text-center text-slate-500 max-w-md">
                            <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
                            <p className="text-sm">
                                {editMode
                                    ? "Upload your client's SLD PDF, then drop meter pins on top to match the topology."
                                    : "No diagram drawn yet. Click Edit to upload your SLD and add meters."}
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-5 text-xs text-slate-500 flex-wrap pt-1">
                <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-emerald-400" /> Live</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-slate-600" /> Stale / no data</span>
                <span className="flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 text-amber-400" /> Active alert</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded ring-2 ring-red-500/80" /> Critical</span>
                <span>•</span>
                <span>Updates every 12s</span>
            </div>
        </div>
    );
}

// React Flow requires a Provider context. We supply it here so all
// useReactFlow hooks (fitView, screenToFlowPosition) work inside <Inner>.
export default function SldEditor() {
    return (
        <ReactFlowProvider>
            <Inner />
        </ReactFlowProvider>
    );
}
