"use client";

// Fleet map tile. Pins are the RECORDED installation coordinates of each
// deployed box's project (projects.gps_lat/lon), not live GPS, and never
// inferred from an IP address. Boxes at the same coordinates are grouped.
// A schematic South Africa frame (no external map provider, no cost); the
// table below lists every location and the boxes without coordinates.

import Link from "next/link";
import { useMemo, useState } from "react";
import type { FleetRow } from "@/lib/ops";
import { deviceHealth } from "@/lib/ops";
import { RagDot } from "@/components/ops/ui";

// Equirectangular frame around South Africa (and its neighbours' edges).
const LON0 = 16, LON1 = 33.5, LAT0 = -35.2, LAT1 = -21.8;
const W = 520, H = 400;
const x = (lon: number) => ((lon - LON0) / (LON1 - LON0)) * W;
const y = (lat: number) => ((LAT1 - lat) / (LAT1 - LAT0)) * H;

const CITIES: [string, number, number][] = [
    ["Cape Town", -33.92, 18.42], ["Johannesburg", -26.2, 28.05], ["Pretoria", -25.75, 28.19], ["Durban", -29.86, 31.03],
    ["Gqeberha", -33.96, 25.6], ["Bloemfontein", -29.12, 26.21], ["Polokwane", -23.9, 29.45], ["Mbombela", -25.47, 30.97],
    ["Kimberley", -28.74, 24.76], ["East London", -33.02, 27.91], ["Upington", -28.45, 21.25],
];

interface Group { key: string; lat: number; lon: number; rows: FleetRow[]; project: string; client: string | null }

export function FleetMap({ fleet }: { fleet: FleetRow[] }) {
    const [selected, setSelected] = useState<string | null>(null);
    const deployed = fleet.filter((d) => d.status === "deployed");
    const { groups, missing } = useMemo(() => {
        const m = new Map<string, Group>();
        const missing: FleetRow[] = [];
        for (const d of deployed) {
            if (d.gps_lat === null || d.gps_lon === null || d.gps_lat === undefined) { missing.push(d); continue; }
            const key = `${Number(d.gps_lat).toFixed(4)},${Number(d.gps_lon).toFixed(4)}`;
            const g = m.get(key) ?? { key, lat: Number(d.gps_lat), lon: Number(d.gps_lon), rows: [], project: d.project_name ?? "", client: d.tenant_name };
            g.rows.push(d);
            m.set(key, g);
        }
        return { groups: Array.from(m.values()), missing };
    }, [deployed]);
    const sel = groups.find((g) => g.key === selected) ?? null;
    const worst = (rows: FleetRow[]) => {
        const r = rows.map((d) => deviceHealth(d).rag);
        return r.includes("red") ? "#ef4444" : r.includes("amber") ? "#f59e0b" : "#34d399";
    };

    return (
        <div className="space-y-3">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto rounded-lg bg-slate-950 border border-slate-800" role="img"
                aria-label={`Schematic map: ${deployed.length} deployed boxes at ${groups.length} recorded locations`}>
                {/* graticule every 2° */}
                {Array.from({ length: 9 }, (_, i) => LON0 + 2 + i * 2).map((lon) => <line key={`lo${lon}`} x1={x(lon)} x2={x(lon)} y1={0} y2={H} stroke="#1e293b" strokeWidth={1} />)}
                {Array.from({ length: 7 }, (_, i) => -34 + i * 2).map((lat) => <line key={`la${lat}`} y1={y(lat)} y2={y(lat)} x1={0} x2={W} stroke="#1e293b" strokeWidth={1} />)}
                {CITIES.map(([n, lat, lon]) => (
                    <g key={n}><circle cx={x(lon)} cy={y(lat)} r={2} fill="#475569" />
                        <text x={x(lon) + 4} y={y(lat) - 4} fontSize={10} fill="#64748b">{n}</text></g>
                ))}
                {groups.map((g) => (
                    <g key={g.key} onClick={() => setSelected(g.key === selected ? null : g.key)} className="cursor-pointer">
                        <circle cx={x(g.lon)} cy={y(g.lat)} r={g.rows.length > 1 ? 9 : 6} fill={worst(g.rows)} fillOpacity={0.85}
                            stroke={g.key === selected ? "#fff" : "#0f172a"} strokeWidth={2}>
                            <title>{`${g.client ?? ""} · ${g.project}: ${g.rows.length} box(es)`}</title>
                        </circle>
                        {g.rows.length > 1 && <text x={x(g.lon)} y={y(g.lat) + 3.5} fontSize={10} fontWeight={700} textAnchor="middle" fill="#0f172a">{g.rows.length}</text>}
                    </g>
                ))}
            </svg>
            <p className="text-xs text-slate-500">Recorded installation coordinates of each project (not live tracking). Colour: worst box health at the location. Click a pin for its boxes.</p>
            {sel && (
                <div className="text-sm rounded-lg border border-slate-800 p-3">
                    <p className="text-slate-200 font-medium">{sel.client} · {sel.project} <span className="text-xs text-slate-500">({sel.lat.toFixed(4)}, {sel.lon.toFixed(4)})</span></p>
                    <ul className="mt-1 space-y-1">{sel.rows.map((d) => (
                        <li key={d.id} className="flex items-center gap-2"><RagDot rag={deviceHealth(d).rag} />
                            <Link href={`/ops/fleet/${d.id}`} className="text-blue-300 hover:underline">{d.code ?? d.name}</Link>
                            <span className="text-slate-500 text-xs">{d.point_name}</span></li>
                    ))}</ul>
                </div>
            )}
            <details className="text-sm">
                <summary className="cursor-pointer text-slate-400">Locations as a table ({groups.length} located, {missing.length} without coordinates)</summary>
                <table className="w-full mt-2 text-xs">
                    <thead><tr className="text-left text-slate-500"><th className="py-1">Client · site</th><th>Boxes</th><th>Location</th></tr></thead>
                    <tbody>
                        {groups.map((g) => <tr key={g.key} className="border-t border-slate-800"><td className="py-1 text-slate-300">{g.client} · {g.project}</td><td>{g.rows.map((d) => d.code ?? d.name).join(", ")}</td><td className="text-slate-500">{g.lat.toFixed(4)}, {g.lon.toFixed(4)}</td></tr>)}
                        {missing.map((d) => <tr key={d.id} className="border-t border-slate-800"><td className="py-1 text-slate-300">{d.tenant_name} · {d.project_name}</td><td>{d.code ?? d.name}</td><td className="text-amber-300">no coordinates recorded{d.project_address ? ` (${d.project_address})` : ""}</td></tr>)}
                    </tbody>
                </table>
            </details>
        </div>
    );
}
