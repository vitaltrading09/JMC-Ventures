"use client";

// Custom React Flow node representing a meter pinned on the SLD.
// Live data + alert state are passed in via `data` (React Flow convention).

import { memo } from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { Activity, AlertTriangle, Zap } from "lucide-react";

export interface MeterNodeData {
    label:         string;
    meterId:       string;
    powerKw?:      number | null;
    voltage?:      number | null;
    pf?:           number | null;
    isLive?:       boolean;
    alertSeverity?: "INFO" | "WARNING" | "CRITICAL" | null;
    alertCount?:   number;
    isEditing?:    boolean;
}

const SEVERITY_RING: Record<string, string> = {
    CRITICAL: "ring-2 ring-red-500/80 shadow-[0_0_20px_rgba(239,68,68,0.5)] animate-pulse",
    WARNING:  "ring-2 ring-amber-500/80 shadow-[0_0_20px_rgba(245,158,11,0.4)]",
    INFO:     "ring-2 ring-blue-500/60",
};

function MeterNodeImpl({ data, selected }: NodeProps<MeterNodeData>) {
    const ringClass = data.alertSeverity ? SEVERITY_RING[data.alertSeverity] : "";
    const liveDot   = data.isLive
        ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
        : "bg-slate-600";

    return (
        <div
            className={`relative rounded-xl border bg-slate-900/95 backdrop-blur-sm text-white px-3 py-2 min-w-[140px] shadow-xl transition-all
                ${selected ? "border-blue-400" : "border-slate-700"}
                ${ringClass}
                ${data.isEditing ? "cursor-move" : ""}`}
        >
            {/* Hidden connection handles — kept so edges can attach in future */}
            <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

            {/* Header row: live dot + name */}
            <div className="flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${liveDot}`} />
                <p className="text-xs font-semibold truncate flex-1">{data.label}</p>
                {data.alertSeverity && (
                    <div className="flex items-center gap-0.5 text-amber-300">
                        <AlertTriangle className="w-3 h-3" />
                        {data.alertCount && data.alertCount > 1 && (
                            <span className="text-[10px] font-bold">{data.alertCount}</span>
                        )}
                    </div>
                )}
            </div>

            {/* Live data row */}
            <div className="mt-1.5 flex items-baseline gap-3 text-[11px] font-mono">
                {data.powerKw != null ? (
                    <span className="flex items-center gap-1 text-blue-300">
                        <Zap className="w-2.5 h-2.5" />
                        {data.powerKw.toFixed(1)}<span className="text-slate-500">kW</span>
                    </span>
                ) : (
                    <span className="text-slate-600 italic">no data</span>
                )}
                {data.pf != null && (
                    <span className={data.pf < 0.85 ? "text-red-300" : "text-emerald-300"}>
                        pf {data.pf.toFixed(2)}
                    </span>
                )}
            </div>

            {data.voltage != null && (
                <div className="mt-0.5 text-[10px] text-slate-500 font-mono">
                    V<sub>L-N</sub> {data.voltage.toFixed(0)} V
                </div>
            )}
        </div>
    );
}

export default memo(MeterNodeImpl);
