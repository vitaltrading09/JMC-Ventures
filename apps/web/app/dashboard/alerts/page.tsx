"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import {
    XCircle, ShieldAlert, Info, CheckCheck, RefreshCw,
    Loader2, Bell, Filter,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";

interface Alert {
    id: string;
    type: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
    message: string;
    meter_name: string;
    created_at: string;
    is_read: boolean;
}

const TYPE_LABELS: Record<string, string> = {
    PEAK_DEMAND:          "Peak Demand",
    MDI_EXCEEDED:         "MDI Exceeded",
    MDI_WARNING:          "MDI Warning",
    VOLTAGE_SAG:          "Voltage Sag",
    OVERVOLTAGE:          "Overvoltage",
    HIGH_THD:             "High THD",
    FREQUENCY_DEVIATION:  "Frequency Deviation",
    PREDICTIVE_WARNING:   "Predictive Warning",
    PREDICTIVE_MAINTENANCE: "Predictive Maintenance",
};

function formatType(type: string) {
    return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)     return `${Math.floor(diff / 1_000)}s ago`;
    if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function SeverityIcon({ sev }: { sev: string }) {
    if (sev === "CRITICAL") return <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />;
    if (sev === "WARNING")  return <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-yellow-400" />;
    return <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-400" />;
}

function severityBorder(sev: string) {
    if (sev === "CRITICAL") return "border-red-500/20 bg-red-500/5";
    if (sev === "WARNING")  return "border-yellow-500/20 bg-yellow-500/5";
    return "border-blue-500/20 bg-blue-500/5";
}

export default function AlertsPage() {
    const [alerts,   setAlerts]   = useState<Alert[]>([]);
    const [loading,  setLoading]  = useState(true);
    const [filter,   setFilter]   = useState<"all" | "unread" | "CRITICAL" | "WARNING">("unread");
    const [marking,  setMarking]  = useState<string | null>(null);

    const token = () => localStorage.getItem("token") ?? "";

    const fetchAlerts = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API}/ingestion/alerts`, {
                headers: { Authorization: `Bearer ${token()}` },
            });
            if (res.ok) setAlerts(await res.json());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

    const markRead = async (id: string) => {
        setMarking(id);
        try {
            await fetch(`${API}/ingestion/alerts/${id}/read`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token()}` },
            });
            setAlerts(a => a.map(x => x.id === id ? { ...x, is_read: true } : x));
        } finally {
            setMarking(null);
        }
    };

    const markAllRead = async () => {
        const unread = alerts.filter(a => !a.is_read);
        for (const a of unread) {
            await fetch(`${API}/ingestion/alerts/${a.id}/read`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token()}` },
            });
        }
        setAlerts(a => a.map(x => ({ ...x, is_read: true })));
    };

    const filtered = alerts.filter(a => {
        if (filter === "unread")   return !a.is_read;
        if (filter === "CRITICAL") return a.severity === "CRITICAL";
        if (filter === "WARNING")  return a.severity === "WARNING";
        return true;
    });

    const unreadCount    = alerts.filter(a => !a.is_read).length;
    const criticalCount  = alerts.filter(a => a.severity === "CRITICAL" && !a.is_read).length;

    return (
        <div className="space-y-6 animate-in fade-in duration-500">

            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
                        Live Alerts
                        {unreadCount > 0 && (
                            <span className="text-sm font-semibold px-2.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/20">
                                {unreadCount} unread
                            </span>
                        )}
                    </h1>
                    <p className="text-slate-400 mt-1">
                        {criticalCount > 0
                            ? `${criticalCount} critical alert${criticalCount !== 1 ? "s" : ""} require attention`
                            : "All critical systems nominal"}
                    </p>
                </div>
                <div className="flex gap-2">
                    {unreadCount > 0 && (
                        <button
                            onClick={markAllRead}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                        >
                            <CheckCheck className="h-4 w-4" />
                            Mark all read
                        </button>
                    )}
                    <button
                        onClick={fetchAlerts}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                        Refresh
                    </button>
                </div>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-2 flex-wrap">
                {([
                    { key: "unread",   label: `Unread (${unreadCount})` },
                    { key: "CRITICAL", label: `Critical (${alerts.filter(a => a.severity === "CRITICAL" && !a.is_read).length})` },
                    { key: "WARNING",  label: `Warning (${alerts.filter(a => a.severity === "WARNING"  && !a.is_read).length})` },
                    { key: "all",      label: `All (${alerts.length})` },
                ] as const).map(({ key, label }) => (
                    <button
                        key={key}
                        onClick={() => setFilter(key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                            filter === key
                                ? "bg-blue-600/20 text-blue-300 border-blue-500/30"
                                : "bg-slate-800/50 text-slate-400 border-slate-700 hover:text-white hover:border-slate-600"
                        }`}
                    >
                        <Filter className="w-3 h-3" />
                        {label}
                    </button>
                ))}
            </div>

            {/* Alert list */}
            {loading ? (
                <div className="flex justify-center py-20">
                    <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                </div>
            ) : filtered.length === 0 ? (
                <Card className="p-12">
                    <div className="flex flex-col items-center gap-3 text-center">
                        <Bell className="w-12 h-12 text-slate-700" />
                        <p className="text-slate-400 font-medium">
                            {filter === "unread" ? "No unread alerts — all clear" : "No alerts match this filter"}
                        </p>
                        <p className="text-sm text-slate-600">
                            Alerts are generated automatically when meter readings breach NRS 048 thresholds
                        </p>
                    </div>
                </Card>
            ) : (
                <div className="space-y-2">
                    {filtered.map(alert => (
                        <div
                            key={alert.id}
                            className={`flex items-start gap-3 p-4 rounded-xl border transition-all ${severityBorder(alert.severity)} ${alert.is_read ? "opacity-50" : ""}`}
                        >
                            <SeverityIcon sev={alert.severity} />

                            <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-3 flex-wrap">
                                    <div>
                                        <span className="text-sm font-semibold text-white">
                                            {formatType(alert.type)}
                                        </span>
                                        <span className={`ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                                            alert.severity === "CRITICAL"
                                                ? "bg-red-500/20 text-red-400"
                                                : alert.severity === "WARNING"
                                                ? "bg-yellow-500/20 text-yellow-400"
                                                : "bg-blue-500/20 text-blue-400"
                                        }`}>
                                            {alert.severity}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                        <span className="text-xs text-slate-500">{timeAgo(alert.created_at)}</span>
                                        {!alert.is_read && (
                                            <button
                                                onClick={() => markRead(alert.id)}
                                                disabled={marking === alert.id}
                                                className="text-xs text-slate-500 hover:text-blue-400 transition-colors flex items-center gap-1 disabled:opacity-50"
                                            >
                                                {marking === alert.id
                                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                                    : <CheckCheck className="w-3 h-3" />}
                                                Acknowledge
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <p className="text-sm text-slate-300 mt-1.5 leading-relaxed">{alert.message}</p>
                                <p className="text-xs text-slate-500 mt-1">{alert.meter_name}</p>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
