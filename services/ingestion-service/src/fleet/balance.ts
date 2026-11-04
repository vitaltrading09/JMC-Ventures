// ─────────────────────────────────────────────────────────────────────────────
// Energy balance per project (plan Phase 6, item 5). Computed, never stored.
//
//   grid import / export   top-level incomer points (several are summed:
//                          a site can have more than one supply)
//   PV generation          pv points
//   BESS                   discharge − charge
//   generator              generator points
//   site consumption       import − export + PV + (discharge − charge) + generator
//   unmetered remainder    consumption − Σ top-level sub_load points
//
// Sign convention, after each deployment's power_sign: an incomer and a
// sub_load are positive when consuming (import register = consumption); a
// pv, bess or generator point is positive when delivering into the site
// (its import register = generation / discharge, export = charge).
//
// Energy per point comes from the corrected point views, the same register
// logic as /monthly (src/energy.ts), per deployment so a register never
// bridges from one device to the next. A component whose point has no data at
// all in the period is null ("not available"), never zero.
// ─────────────────────────────────────────────────────────────────────────────

import { periodEnergy, EnergyHour, EnergyMethod, combinedMethod, PeriodEnergy } from '../energy';

export interface PointEnergy {
    id: string;
    name: string;
    role: string;
    parentPointId: string | null;
    parentRole: string | null;
    importKwh: number;
    exportKwh: number;
    /** Share of the period's hours with any data at this point (0–1). */
    coverage: number;
    method: EnergyMethod;
    dataQuality: PeriodEnergy['data_quality'];
}

export interface EnergyBalance {
    grid_import_kwh: number | null;
    grid_export_kwh: number | null;
    pv_generation_kwh: number | null;
    bess_discharge_kwh: number | null;
    bess_charge_kwh: number | null;
    generator_kwh: number | null;
    site_consumption_kwh: number | null;
    sub_loads_kwh: number | null;
    unmetered_kwh: number | null;
    /** Every point the balance uses has ≥ 95 % coverage. */
    complete: boolean;
    not_available: string[];
}

const COMPLETE_COVERAGE = 0.95;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function energyBalance(points: PointEnergy[]): EnergyBalance {
    const notAvailable: string[] = [];
    let complete = true;
    // Σ of one quantity over a set of points; null when any of them has no data.
    const sum = (pts: PointEnergy[], label: string, f: (p: PointEnergy) => number): number | null => {
        let total = 0;
        for (const p of pts) {
            if (p.coverage === 0) {
                notAvailable.push(`${label}: no data at ${p.name}`);
                return null;
            }
            if (p.coverage < COMPLETE_COVERAGE) complete = false;
            total += f(p);
        }
        return round1(total);
    };

    const incomers = points.filter((p) => p.role === 'incomer' && !p.parentPointId);
    const pv = points.filter((p) => p.role === 'pv');
    const bess = points.filter((p) => p.role === 'bess');
    const gens = points.filter((p) => p.role === 'generator');
    // Top-level sub-loads only: a sub_load under another sub_load is already inside its parent.
    const subs = points.filter((p) => p.role === 'sub_load' && (!p.parentPointId || p.parentRole === 'incomer'));

    let gridImport: number | null = null, gridExport: number | null = null;
    if (incomers.length === 0) {
        notAvailable.push('grid: the project has no incomer point');
        complete = false;
    } else {
        gridImport = sum(incomers, 'grid import', (p) => p.importKwh);
        gridExport = gridImport === null ? null : sum(incomers, 'grid export', (p) => p.exportKwh);
    }
    const pvGen = sum(pv, 'PV generation', (p) => p.importKwh);
    const discharge = sum(bess, 'BESS', (p) => p.importKwh);
    const charge = discharge === null ? null : sum(bess, 'BESS', (p) => p.exportKwh);
    const generator = sum(gens, 'generator', (p) => p.importKwh);

    const parts = [gridImport, gridExport, pvGen, discharge, charge, generator];
    const consumption = parts.some((v) => v === null) ? null
        : round1(gridImport! - gridExport! + pvGen! + (discharge! - charge!) + generator!);
    const subLoads = sum(subs, 'sub-loads', (p) => p.importKwh - p.exportKwh);
    const unmetered = consumption === null || subLoads === null ? null : round1(consumption - subLoads);

    return {
        grid_import_kwh: gridImport,
        grid_export_kwh: gridExport,
        pv_generation_kwh: pv.length ? pvGen : 0,
        bess_discharge_kwh: bess.length ? discharge : 0,
        bess_charge_kwh: bess.length ? charge : 0,
        generator_kwh: gens.length ? generator : 0,
        site_consumption_kwh: consumption,
        sub_loads_kwh: subLoads,
        unmetered_kwh: unmetered,
        complete: complete && notAvailable.length === 0,
        not_available: notAvailable,
    };
}

// ── Database side ───────────────────────────────────────────────────────────

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Import and export energy at one point over [from, to), from the corrected
 * point views: hourly register values, power integration (1-minute averages,
 * 900 s gap cap, as src/energy.ts) where a register is missing.
 */
export async function loadPointEnergy(db: Queryable, pointId: string, from: Date, to: Date) {
    const [reg, pow] = await Promise.all([
        db.query(`
            SELECT deployment_id, bucket AS hour, n,
                   energy_import_total_first AS imp_first, energy_import_total_last AS imp_last,
                   energy_export_total_first AS exp_first, energy_export_total_last AS exp_last,
                   t_first, t_last, power_active_total_max AS p_max, power_active_total_min AS p_min
            FROM point_readings_1h
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3`, [pointId, from, to]),
        db.query(`
            WITH m AS (
                SELECT deployment_id, bucket, power_active_total_avg AS p,
                       LEAST(EXTRACT(EPOCH FROM (LEAD(bucket) OVER (PARTITION BY deployment_id ORDER BY bucket) - bucket)), 900) AS dt_s
                FROM point_readings_1m
                WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND power_active_total_avg IS NOT NULL
            )
            SELECT deployment_id, time_bucket('1 hour', bucket) AS hour,
                   SUM(GREATEST(p, 0) * COALESCE(dt_s, 60)) / 3600.0 AS imp_kwh,
                   SUM(GREATEST(-p, 0) * COALESCE(dt_s, 60)) / 3600.0 AS exp_kwh
            FROM m GROUP BY 1, 2`, [pointId, from, to]),
    ]);

    // Per deployment, per direction: EnergyHour rows for periodEnergy.
    type Dir = 'imp' | 'exp';
    const groups = new Map<string, Record<Dir, Map<number, EnergyHour>>>();
    const hoursWithData = new Set<number>();
    const slot = (dep: string, dir: Dir, hour: Date) => {
        let g = groups.get(dep);
        if (!g) { g = { imp: new Map(), exp: new Map() }; groups.set(dep, g); }
        const k = hour.getTime();
        let h = g[dir].get(k);
        if (!h) {
            h = { hour, regFirst: null, regLast: null, tFirst: null, tLast: null, pMaxKw: null, powerKwh: null };
            g[dir].set(k, h);
        }
        return h;
    };
    for (const r of reg.rows) {
        const hour = new Date(r.hour);
        if (Number(r.n) > 0) hoursWithData.add(hour.getTime());
        const pMax = num(r.p_max), pMin = num(r.p_min);
        for (const [dir, first, last, peak] of [
            ['imp', r.imp_first, r.imp_last, pMax],
            ['exp', r.exp_first, r.exp_last, pMin === null ? null : -pMin],
        ] as Array<[Dir, any, any, number | null]>) {
            const h = slot(r.deployment_id, dir, hour);
            h.regFirst = num(first); h.regLast = num(last);
            h.tFirst = r.t_first ? new Date(r.t_first) : null;
            h.tLast = r.t_last ? new Date(r.t_last) : null;
            h.pMaxKw = peak;
        }
    }
    for (const r of pow.rows) {
        const hour = new Date(r.hour);
        hoursWithData.add(hour.getTime());
        slot(r.deployment_id, 'imp', hour).powerKwh = num(r.imp_kwh);
        slot(r.deployment_id, 'exp', hour).powerKwh = num(r.exp_kwh);
    }

    const total = (dir: Dir) => {
        const per = [...groups.values()].map((g) => periodEnergy([...g[dir].values()], () => 'total')[0])
            .filter((p): p is PeriodEnergy => !!p);
        const q = { register_resets: 0, implausible_jumps: 0, register_hours: 0, power_hours: 0 };
        for (const p of per) for (const k of Object.keys(q) as Array<keyof typeof q>) q[k] += p.data_quality[k];
        return { kwh: round1(per.reduce((a, p) => a + p.kwh, 0)), method: combinedMethod(per.map((p) => p.method)), quality: q };
    };
    const imp = total('imp'), exp = total('exp');
    const periodHours = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 3_600_000));
    return {
        importKwh: imp.kwh,
        exportKwh: exp.kwh,
        coverage: Math.min(1, hoursWithData.size / periodHours),
        // Both directions: a reversed CT puts a point's energy on the export side.
        method: combinedMethod([imp.method, exp.method]),
        dataQuality: {
            register_resets: imp.quality.register_resets + exp.quality.register_resets,
            implausible_jumps: imp.quality.implausible_jumps + exp.quality.implausible_jumps,
            register_hours: Math.max(imp.quality.register_hours, exp.quality.register_hours),
            power_hours: Math.max(imp.quality.power_hours, exp.quality.power_hours),
        },
    };
}

/** The balance for a project over [from, to), with the per-point figures it used. */
export async function projectEnergyBalance(db: Queryable, projectId: string, from: Date, to: Date) {
    const pts = await db.query(`
        SELECT p.id, p.name, p.role, p.parent_point_id, pp.role AS parent_role
        FROM measurement_points p LEFT JOIN measurement_points pp ON pp.id = p.parent_point_id
        WHERE p.project_id = $1 AND (p.archived_at IS NULL OR p.archived_at > $2)
        ORDER BY p.sort_order, p.name`, [projectId, from]);
    const points: PointEnergy[] = [];
    for (const p of pts.rows) {
        const e = await loadPointEnergy(db, p.id, from, to);
        points.push({
            id: p.id, name: p.name, role: p.role, parentPointId: p.parent_point_id, parentRole: p.parent_role,
            ...e,
        });
    }
    return {
        project_id: projectId,
        from: from.toISOString(),
        to: to.toISOString(),
        ...energyBalance(points),
        points: points.map((p) => ({
            id: p.id, name: p.name, role: p.role, parent_point_id: p.parentPointId,
            import_kwh: p.coverage === 0 ? null : p.importKwh,
            export_kwh: p.coverage === 0 ? null : p.exportKwh,
            coverage: Math.round(p.coverage * 1000) / 1000,
            method: p.method,
            data_quality: p.dataQuality,
        })),
    };
}
