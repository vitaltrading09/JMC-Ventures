"use client";

import { useState, useEffect, useRef } from 'react';
import { Bell, AlertTriangle, Info, Zap } from 'lucide-react';
import Link from 'next/link';

interface Alert {
    id: string;
    type: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    message: string;
    meter_name: string;
    is_read: boolean;
    created_at: string;
}

export function NotificationBell() {
    const [alerts, setAlerts] = useState<Alert[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const unreadCount = alerts.filter(a => !a.is_read).length;

    useEffect(() => {
        const fetchAlerts = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/alerts`, {
                    credentials: 'include',
                });
                if (res.ok) {
                    const data = await res.json();
                    setAlerts(data);
                }
            } catch (error) {
                console.error("Failed to fetch alerts:", error);
            }
        };

        fetchAlerts();
        // Poll every 30 seconds
        const interval = setInterval(fetchAlerts, 30000);
        return () => clearInterval(interval);
    }, []);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [dropdownRef]);

    const markAsRead = async (id: string) => {
        try {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ingestion/alerts/${id}/read`, {
                method: 'POST',
                credentials: 'include',
            });
            setAlerts(alerts.map(a => a.id === id ? { ...a, is_read: true } : a));
        } catch (error) {
            console.error("Failed to mark alert as read:", error);
        }
    };

    const getSeverityStyles = (severity: string) => {
        switch (severity) {
            case 'CRITICAL': return 'bg-red-500/10 text-red-500 border-red-500/20';
            case 'WARNING': return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
            default: return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
        }
    };

    const getSeverityIcon = (severity: string) => {
        switch (severity) {
            case 'CRITICAL': return <AlertTriangle className="h-4 w-4" />;
            case 'WARNING': return <Zap className="h-4 w-4" />;
            default: return <Info className="h-4 w-4" />;
        }
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative p-2 rounded-lg bg-slate-900/50 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-all duration-200"
            >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 h-3 w-3 bg-red-500 rounded-full border-2 border-slate-900"></span>
                )}
            </button>

            {isOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-80 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden z-50">
                    <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/50">
                        <h3 className="font-semibold text-white">Notifications</h3>
                        {unreadCount > 0 && (
                            <span className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded-full border border-red-500/20">
                                {unreadCount} new
                            </span>
                        )}
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                        {alerts.length === 0 ? (
                            <div className="p-6 text-center text-slate-500 flex flex-col items-center gap-2">
                                <Bell className="h-8 w-8 text-slate-700" />
                                <p>No registered alerts.</p>
                            </div>
                        ) : (
                            <ul className="divide-y divide-slate-800">
                                {alerts.map(alert => (
                                    <li
                                        key={alert.id}
                                        className={`p-4 hover:bg-slate-800/50 transition-colors cursor-pointer ${!alert.is_read ? 'bg-slate-800/20' : ''}`}
                                        onClick={() => markAsRead(alert.id)}
                                    >
                                        <div className="flex gap-3">
                                            <div className={`mt-1 flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center border ${getSeverityStyles(alert.severity)}`}>
                                                {getSeverityIcon(alert.severity)}
                                            </div>
                                            <div>
                                                <p className="text-sm text-slate-200 line-clamp-2 leading-relaxed">
                                                    {alert.message}
                                                </p>
                                                <div className="flex justify-between items-center mt-2">
                                                    <span className="text-xs font-medium text-slate-400">
                                                        {alert.meter_name}
                                                    </span>
                                                    <span className="text-xs text-slate-500">
                                                        {new Date(alert.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="p-2 border-t border-slate-800 bg-slate-950/50">
                        <Link href="/portal/settings" className="block w-full text-center py-2 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                            Configure Thresholds
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}
