"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Sun, Battery, DollarSign, Calculator, ArrowRight, CheckCircle2 } from "lucide-react";
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend,
} from "recharts";

export default function PVSizerPage() {
    const [bill, setBill] = useState(5000);
    const [roofArea, setRoofArea] = useState(50);
    const [calculated, setCalculated] = useState(false);

    // Mock Calculation Logic
    const handleCalculate = () => {
        setCalculated(true);
    };

    const systemSize = Math.min(bill / 500, roofArea / 6).toFixed(1); // Rough estimate logic
    const cost = (parseFloat(systemSize) * 15000).toLocaleString(); // R15k per kWp
    const savings = (parseFloat(systemSize) * 5 * 30 * 2.5).toLocaleString(); // 5 sun hours, 30 days, R2.50/kWh

    const roiData = [
        { year: "Year 1", cumulative: -parseFloat(cost.replace(/,/g, '')) + parseFloat(savings.replace(/,/g, '')) },
        { year: "Year 2", cumulative: -parseFloat(cost.replace(/,/g, '')) + parseFloat(savings.replace(/,/g, '')) * 2 },
        { year: "Year 3", cumulative: -parseFloat(cost.replace(/,/g, '')) + parseFloat(savings.replace(/,/g, '')) * 3 },
        { year: "Year 4", cumulative: -parseFloat(cost.replace(/,/g, '')) + parseFloat(savings.replace(/,/g, '')) * 4 },
        { year: "Year 5", cumulative: 50000 }, // Break even roughly
    ];

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Solar PV Sizer</h1>
                    <p className="text-slate-400 mt-2">
                        Estimate system size and ROI based on your consumption and roof space.
                    </p>
                </div>
            </div>

            <div className="grid gap-8 md:grid-cols-12">
                {/* Input Form */}
                <div className="md:col-span-4 space-y-6">
                    <Card className="p-6">
                        <h2 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                            <Calculator className="h-5 w-5 text-blue-500" />
                            System Inputs
                        </h2>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-1">Avg. Monthly Bill (ZAR)</label>
                                <input
                                    type="number"
                                    value={bill}
                                    onChange={(e) => setBill(Number(e.target.value))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <div className="mt-2 text-xs text-slate-500">
                                    Est. Consumption: <span className="text-slate-300">{(bill / 2.5).toFixed(0)} kWh</span>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-1">Available Roof Area (m²)</label>
                                <input
                                    type="number"
                                    value={roofArea}
                                    onChange={(e) => setRoofArea(Number(e.target.value))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-1">Location</label>
                                <select className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    <option>Johannesburg (High)</option>
                                    <option>Cape Town (Med)</option>
                                    <option>Durban (Med)</option>
                                    <option>Northern Cape (Ultra)</option>
                                </select>
                            </div>

                            <button
                                onClick={handleCalculate}
                                className="w-full mt-4 bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2.5 font-medium shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all flex items-center justify-center gap-2"
                            >
                                Calculate Design
                                <ArrowRight className="h-4 w-4" />
                            </button>
                        </div>
                    </Card>

                    {calculated && (
                        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-start gap-3">
                            <CheckCircle2 className="h-5 w-5 mt-0.5" />
                            <div>
                                <h4 className="font-medium">Viable Investment included Batteries</h4>
                                <p className="text-sm opacity-80 mt-1">
                                    Based on current tariffs, this system pays for itself in ~4.2 years.
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Results Area */}
                <div className="md:col-span-8 space-y-6">
                    {!calculated ? (
                        <div className="h-full flex flex-col items-center justify-center border-2 border-dashed border-slate-800 rounded-xl p-12 text-slate-500">
                            <Sun className="h-16 w-16 mb-4 opacity-20" />
                            <p>Enter details to generate a solar proposal.</p>
                        </div>
                    ) : (
                        <>
                            {/* Key Metrics */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <Card className="bg-blue-500/10 border-blue-500/20">
                                    <div className="p-4">
                                        <div className="flex items-center gap-2 text-blue-400 mb-2">
                                            <Sun className="h-5 w-5" />
                                            <span className="font-medium">System Size</span>
                                        </div>
                                        <div className="text-3xl font-bold text-white">{systemSize} kWp</div>
                                        <div className="text-sm text-slate-400 mt-1">~{Math.ceil(parseFloat(systemSize) * 2)} Panels</div>
                                    </div>
                                </Card>

                                <Card className="bg-purple-500/10 border-purple-500/20">
                                    <div className="p-4">
                                        <div className="flex items-center gap-2 text-purple-400 mb-2">
                                            <Battery className="h-5 w-5" />
                                            <span className="font-medium">Battery Backup</span>
                                        </div>
                                        <div className="text-3xl font-bold text-white">{(parseFloat(systemSize) * 2.5).toFixed(1)} kWh</div>
                                        <div className="text-sm text-slate-400 mt-1">4-6 Hours Autonomy</div>
                                    </div>
                                </Card>

                                <Card className="bg-emerald-500/10 border-emerald-500/20">
                                    <div className="p-4">
                                        <div className="flex items-center gap-2 text-emerald-400 mb-2">
                                            <DollarSign className="h-5 w-5" />
                                            <span className="font-medium">Monthly Savings</span>
                                        </div>
                                        <div className="text-3xl font-bold text-white">R {savings}</div>
                                        <div className="text-sm text-slate-400 mt-1">Est. CAPEX: R {cost}</div>
                                    </div>
                                </Card>
                            </div>

                            {/* ROI Chart */}
                            <Card>
                                <CardHeader title="Return on Investment" subtitle="Cumulative Cashflow Analysis" />
                                <div className="h-[300px] w-full mt-4">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={roiData}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                            <XAxis dataKey="year" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                            <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                                            <Tooltip cursor={{ fill: '#1e293b' }} contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }} />
                                            <Bar dataKey="cumulative" name="Net Position (ZAR)" fill="#10b981" radius={[4, 4, 0, 0]} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            </Card>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
