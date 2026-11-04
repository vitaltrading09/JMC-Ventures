"use client";

// The measurement chart of the per-meter page (P/Q/S, PF, 3-phase V/I, THD,
// frequency, energy; NRS 048-2 reference lines; date range and presets;
// summary strip). Shared by /dashboard/sites/[id] (by meter) and the portal
// point page (by measurement point): the caller passes where readings come from.

import { useEffect, useState, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import { Loader2, BarChart2, Calendar, RefreshCw } from "lucide-react";
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Brush, Legend, ReferenceLine,
} from "recharts";

export const MEASUREMENTS = [
    { key: 'power_active_total',   label: 'P (kW)',      unit: 'kW',   color: '#3b82f6' },
    { key: 'power_reactive_total', label: 'Q (kVAr)',    unit: 'kVAr', color: '#a855f7' },
    { key: 'power_apparent_total', label: 'S (kVA)',     unit: 'kVA',  color: '#6366f1' },
    { key: 'power_factor_total',   label: 'PF',          unit: '',     color: '#10b981' },
    { key: 'voltage_a',            label: 'Voltage (V)', unit: 'V',    color: '#eab308' },
    { key: 'current_a',            label: 'Current (A)', unit: 'A',    color: '#f97316' },
    { key: 'thd_voltage_a',        label: 'THD-V (%)',   unit: '%',    color: '#ef4444' },
    { key: 'thd_current_a',        label: 'THD-I (%)',   unit: '%',    color: '#f97316' },
    { key: 'frequency',            label: 'Freq (Hz)',   unit: 'Hz',   color: '#22d3ee' },
    { key: 'energy_import_total',  label: 'Energy (kWh)', unit: 'kWh', color: '#06b6d4' },
];

// Measurements that support L1/L2/L3 phase selection
const PHASE_CONFIG: Record<string, { keys: string[]; labels: string[]; colors: string[] }> = {
    voltage_a: {
        keys:   ['voltage_a',  'voltage_b',  'voltage_c'],
        labels: ['L1', 'L2', 'L3'],
        colors: ['#eab308', '#f97316', '#a855f7'],
    },
    current_a: {
        keys:   ['current_a',  'current_b',  'current_c'],
        labels: ['L1', 'L2', 'L3'],
        colors: ['#f97316', '#f59e0b', '#10b981'],
    },
};

const toDateInput = (d: Date) => d.toISOString().slice(0, 10);

export interface ReadingsResult { rows: any[]; basis?: string | null }

export function MeasurementChart({ title, load, onReadings }: {
    /** Shown in the chart heading, e.g. the meter or point name. */
    title: string;
    /** Fetches readings for [from, to] (ISO local dates, whole days). */
    load: (from: string, to: string) => Promise<ReadingsResult>;
    /** Called with the rows after each load (the simulation tab uses them). */
    onReadings?: (rows: any[]) => void;
}) {
    const [readings,     setReadings]     = useState<any[]>([]);
    const [basis,        setBasis]        = useState<string | null>(null);
    const [chartLoading, setChartLoading] = useState(false);
    const [selectedMeasurement, setSelectedMeasurement] = useState(MEASUREMENTS[0]);
    const [activePhases, setActivePhases] = useState({ l1: true, l2: true, l3: true });

    // Date range — default last 7 days
    const [fromDate, setFromDate] = useState(() => toDateInput(new Date(Date.now() - 7 * 86400000)));
    const [toDate,   setToDate]   = useState(() => toDateInput(new Date()));

    const fetchReadings = useCallback(async () => {
        setChartLoading(true);
        try {
            const res = await load(fromDate, toDate);
            const rows = res.rows.map((r: any) => ({
                ...r,
                _time: new Date(r.time).toLocaleString('en-ZA', {
                    timeZone: 'Africa/Johannesburg', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                }),
            }));
            setReadings(rows);
            setBasis(res.basis ?? null);
            onReadings?.(rows);
        } catch {
            setReadings([]);
        } finally { setChartLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load, fromDate, toDate]);

    useEffect(() => { fetchReadings(); }, [fetchReadings]);

    // Reset phases to all-on when measurement changes
    const handleMeasurementChange = (m: typeof MEASUREMENTS[0]) => {
        setSelectedMeasurement(m);
        setActivePhases({ l1: true, l2: true, l3: true });
    };

    const phaseConfig  = PHASE_CONFIG[selectedMeasurement.key];
    const isMultiPhase = !!phaseConfig;

    // Summary stats — always use primary key (L1)
    const values = readings.map(r => r[selectedMeasurement.key]).filter((v: any) => v != null && !isNaN(v));
    const statMin = values.length ? Math.min(...values) : null;
    const statMax = values.length ? Math.max(...values) : null;
    const statAvg = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : null;
    const latest  = readings.length ? readings[readings.length - 1] : null;
    const measurement = selectedMeasurement;
    const [source, bucket] = (basis ?? "").split("; bucket=");

    return (
        <div className="space-y-5">
            {/* Controls */}
            <Card className="p-4">
                <div className="flex flex-wrap items-center gap-4">
                    {/* Date range */}
                    <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-slate-500" />
                        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:ring-2 focus:ring-blue-500/50 focus:outline-none" />
                        <span className="text-slate-500 text-sm">to</span>
                        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:ring-2 focus:ring-blue-500/50 focus:outline-none" />
                        <button onClick={fetchReadings} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
                            <RefreshCw className={`w-4 h-4 ${chartLoading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                    {/* Quick range buttons */}
                    <div className="flex gap-1.5">
                        {[{ label: '24h', days: 1 }, { label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }]
                            .map(({ label, days }) => (
                                <button key={label}
                                    onClick={() => { setFromDate(toDateInput(new Date(Date.now() - days * 86400000))); setToDate(toDateInput(new Date())); }}
                                    className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-md transition-colors">
                                    {label}
                                </button>
                            ))}
                    </div>
                </div>

                {/* Measurement tabs */}
                <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-800">
                    {MEASUREMENTS.map(m => (
                        <button key={m.key} onClick={() => handleMeasurementChange(m)}
                            style={selectedMeasurement.key === m.key ? { borderColor: m.color + '60', backgroundColor: m.color + '15', color: m.color } : {}}
                            className={`px-3 py-1 text-xs rounded-full border transition-all font-medium
                                ${selectedMeasurement.key === m.key ? '' : 'border-slate-700 text-slate-400 hover:text-white hover:border-slate-600'}`}>
                            {m.label}
                        </button>
                    ))}
                </div>

                {/* Phase toggles — only for Voltage and Current */}
                {isMultiPhase && (
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-slate-800">
                        <span className="text-xs text-slate-500 font-medium">Phases:</span>
                        {phaseConfig.labels.map((label, i) => {
                            const phaseKey = ['l1', 'l2', 'l3'][i] as 'l1' | 'l2' | 'l3';
                            const active   = activePhases[phaseKey];
                            return (
                                <button key={label}
                                    onClick={() => setActivePhases(p => ({ ...p, [phaseKey]: !p[phaseKey] }))}
                                    className={`px-3 py-1 text-xs font-semibold rounded-full border transition-all ${
                                        active ? 'text-white border-transparent' : 'bg-transparent text-slate-500 border-slate-700 hover:border-slate-500'
                                    }`}
                                    style={active ? { backgroundColor: phaseConfig.colors[i], borderColor: phaseConfig.colors[i] } : {}}>
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                )}
            </Card>

            {/* Stats summary */}
            {values.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                        { label: isMultiPhase ? 'L1 Latest' : 'Latest',  val: latest?.[measurement.key] },
                        { label: isMultiPhase ? 'L1 Average' : 'Average', val: statAvg },
                        { label: isMultiPhase ? 'L1 Maximum' : 'Maximum', val: statMax },
                        { label: isMultiPhase ? 'L1 Minimum' : 'Minimum', val: statMin },
                    ].map(({ label, val }) => (
                        <Card key={label} className="p-4">
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
                            <p className="text-xl font-bold text-white mt-1">
                                {val != null ? Number(val).toFixed(measurement.key === 'power_factor_total' ? 3 : 1) : '—'}
                                <span className="text-sm text-slate-400 ml-1">{measurement.unit}</span>
                            </p>
                        </Card>
                    ))}
                </div>
            )}

            {/* Main Chart */}
            <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="font-semibold text-white">
                            {measurement.label}
                            {isMultiPhase && <span className="text-slate-400 font-normal text-sm ml-2">— 3-phase</span>}
                            {' '}— {title}
                        </h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                            {fromDate} to {toDate} · {readings.length} data points
                            {bucket ? ` · ${bucket} averages from ${source}` : ''} · times SAST
                        </p>
                    </div>
                    {chartLoading && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
                </div>

                {readings.length === 0 ? (
                    <div className="h-64 flex flex-col items-center justify-center text-slate-500 gap-3">
                        <BarChart2 className="w-10 h-10 text-slate-700" />
                        <p className="text-sm">No data in this date range.</p>
                    </div>
                ) : (
                    <div className="h-72 md:h-96">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={readings} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis dataKey="_time" stroke="#475569" fontSize={10} tickLine={false}
                                    tick={{ fill: '#64748b' }}
                                    interval={Math.max(0, Math.floor(readings.length / 8))} />
                                <YAxis stroke="#475569" fontSize={11} tickLine={false} tick={{ fill: '#64748b' }}
                                    unit={measurement.unit ? ` ${measurement.unit}` : ''} width={60} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '0.75rem', fontSize: '12px' }}
                                    labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                                    formatter={(val: any, name: string) => [
                                        `${Number(val).toFixed(measurement.key === 'power_factor_total' ? 3 : 2)} ${measurement.unit}`,
                                        isMultiPhase ? name : measurement.label,
                                    ]}
                                />
                                {isMultiPhase && <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />}

                                {/* Reference lines: the limits. NRS 048-2 assesses 10-minute values, so a
                                    chart point beyond a line is a prompt to check the Health Check, not a breach. */}
                                {measurement.key === 'power_factor_total' && <ReferenceLine y={0.85} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'Min PF 0.85', fontSize: 10, fill: '#ef4444', position: 'insideBottomRight' }} />}
                                {measurement.key === 'thd_voltage_a'      && <ReferenceLine y={8}    stroke="#ef4444" strokeDasharray="4 4" label={{ value: '8% limit',   fontSize: 10, fill: '#ef4444', position: 'insideTopRight' }} />}
                                {measurement.key === 'thd_current_a'      && <ReferenceLine y={25}   stroke="#f97316" strokeDasharray="4 4" label={{ value: '25% guide',  fontSize: 10, fill: '#f97316', position: 'insideTopRight' }} />}
                                {measurement.key === 'voltage_a'          && <ReferenceLine y={207}  stroke="#f97316" strokeDasharray="4 4" label={{ value: '207 V', fontSize: 10, fill: '#f97316', position: 'insideBottomRight' }} />}
                                {measurement.key === 'voltage_a'          && <ReferenceLine y={253}  stroke="#f97316" strokeDasharray="4 4" label={{ value: '253 V', fontSize: 10, fill: '#f97316', position: 'insideTopRight' }} />}
                                {measurement.key === 'frequency'          && <ReferenceLine y={49}   stroke="#f97316" strokeDasharray="4 4" label={{ value: '49 Hz', fontSize: 10, fill: '#f97316', position: 'insideBottomRight' }} />}
                                {measurement.key === 'frequency'          && <ReferenceLine y={51}   stroke="#f97316" strokeDasharray="4 4" label={{ value: '51 Hz', fontSize: 10, fill: '#f97316', position: 'insideTopRight' }} />}

                                {/* Single line (non-phase measurements) */}
                                {!isMultiPhase && (
                                    <Line type="monotone" dataKey={measurement.key} name={measurement.label}
                                        stroke={measurement.color} strokeWidth={2} dot={false}
                                        activeDot={{ r: 5, fill: measurement.color, stroke: '#0f172a', strokeWidth: 2 }} />
                                )}

                                {/* Multi-phase lines */}
                                {isMultiPhase && phaseConfig.keys.map((key, i) => {
                                    const phaseKey = ['l1', 'l2', 'l3'][i] as 'l1' | 'l2' | 'l3';
                                    if (!activePhases[phaseKey]) return null;
                                    return (
                                        <Line key={key} type="monotone" dataKey={key}
                                            name={phaseConfig.labels[i]}
                                            stroke={phaseConfig.colors[i]} strokeWidth={2}
                                            dot={false} connectNulls
                                            activeDot={{ r: 5, fill: phaseConfig.colors[i], stroke: '#0f172a', strokeWidth: 2 }} />
                                    );
                                })}

                                {readings.length > 50 && (
                                    <Brush dataKey="_time" height={24} stroke="#334155" fill="#0f172a" tickFormatter={() => ''} />
                                )}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </Card>
        </div>
    );
}
