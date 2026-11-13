"use client";

// The project energy balance (GET /projects/:id/energy-balance), shared by the
// ops project page and the portal's Energy balance tab. A component with no
// data at a required point shows "not available", never 0.

import { num } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/ops";
import { Table } from "@/components/ops/ui";

export interface Balance {
    from: string; to: string; complete: boolean; not_available: string[];
    grid_import_kwh: number | null; grid_export_kwh: number | null; pv_generation_kwh: number | null;
    bess_discharge_kwh: number | null; bess_charge_kwh: number | null; generator_kwh: number | null;
    site_consumption_kwh: number | null; sub_loads_kwh: number | null; unmetered_kwh: number | null;
    points: { id: string; name: string; role: string; import_kwh: number | null; export_kwh: number | null; coverage: number; method: string }[];
}

export function BalanceView({ b }: { b: Balance }) {
    const kwh = (v: number | null) => (v === null ? <span className="text-warn">not available</span> : `${num(v)} kWh`);
    const rows: [string, number | null][] = [
        ["Grid import", b.grid_import_kwh], ["Grid export", b.grid_export_kwh], ["PV generation", b.pv_generation_kwh],
        ["Battery discharge", b.bess_discharge_kwh], ["Battery charge", b.bess_charge_kwh], ["Generator", b.generator_kwh],
        ["Site consumption", b.site_consumption_kwh], ["Metered sub-loads", b.sub_loads_kwh], ["Unmetered remainder", b.unmetered_kwh],
    ];
    return (
        <div className="grid lg:grid-cols-2 gap-6">
            <div>
                <dl className="divide-y divide-line text-sm">
                    {rows.map(([l, v]) => <div key={l} className="flex justify-between py-1.5"><dt className="text-muted">{l}</dt><dd className="text-ink">{kwh(v)}</dd></div>)}
                </dl>
                {!b.complete && <p className="text-xs text-warn mt-2">Incomplete: {b.not_available.length ? b.not_available.join("; ") : "a point has under 95 % coverage"}.</p>}
            </div>
            <Table head={["Point", "Import", "Export", "Coverage", "Basis"]}>
                {b.points.map((x) => (
                    <tr key={x.id}>
                        <td className="py-1.5 pr-3">{x.name} <span className="text-faint text-xs">{ROLE_LABEL[x.role] ?? x.role}</span></td>
                        <td className="py-1.5 pr-3">{x.import_kwh === null ? "–" : num(x.import_kwh)}</td>
                        <td className="py-1.5 pr-3">{x.export_kwh === null ? "–" : num(x.export_kwh)}</td>
                        <td className="py-1.5 pr-3">{Math.round(x.coverage * 100)} %</td>
                        <td className="py-1.5 pr-3 text-xs text-faint">{x.method.replace("_", " ")}</td>
                    </tr>
                ))}
            </Table>
        </div>
    );
}
