// ─────────────────────────────────────────────────────────────────────────────
// Investigation workspace, saved evidence and finding cases (engineering UI
// brief §7B–C).
//
//   GET  /points/:id/investigate?from&to          aligned channels for one window,
//                                                  with min/max kept (decimation never
//                                                  hides extrema) and the events in it
//   GET  /points/:id/compare?a_from&a_to&b_from&b_to   before/after on matched windows
//   GET  /points/:id/explore?from&to&interval&channels  data explorer: any channel, raw/1m/10m/1h
//   GET  /points/:id/moments?kind&from&to&limit    close-ups: the worst moments reading by reading (moments.ts)
//   GET  /assessments/:id/evidence                 saved evidence windows
//   POST /assessments/:id/evidence                 save one (staff, client_admin)
//   POST /evidence/:id/remove                      remove one (kept, marked removed)
//   GET  /assessments/:id/cases                    finding cases of the site
//   PATCH /recommendations/:id/case                owner, status, next step, due, verification;
//                                                  "investigating" starts a finding watch (finding-watch.ts)
//   POST /recommendations/:id/watch/stop           stop the running watch (staff, client_admin)
//   POST /recommendations/:id/watch/conclude       conclude it now (staff)
//   POST /recommendations/:id/watch/review         staff review note on the conclusion (staff)
//
// Access as everywhere: points through findPoint (live assessment grant, ranges
// clamped and aligned to whole buckets); assessments through the live grant;
// findings through findOwned. Every case change is written to audit_log.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import type { Pool } from 'pg';
import { withScope, findPoint, findOwned, liveAssessmentSql, telemetrySql, clampToAccess, alignInward, canWrite, seesUnpublishedFindings, NO_ACCESS } from './scope';
import { percentile } from './reports/dataset';
import { startWatch, concludeWatch, watchForConclusion } from './finding-watch';
import { MOMENT_KINDS, MOMENT_RANK, momentFacts, spread, type MomentKind } from './moments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const r = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** The view and its bucket width for a window: about 150–700 buckets. */
export function viewFor(ms: number): { view: string; widthMs: number; label: string } {
    const h = ms / 3_600_000;
    if (h <= 6) return { view: 'point_readings_1m', widthMs: 60_000, label: '1-minute' };
    if (h <= 96) return { view: 'point_readings_10m', widthMs: 600_000, label: '10-minute' };
    return { view: 'point_readings_1h', widthMs: 3_600_000, label: 'hourly' };
}

/** A DATE column as YYYY-MM-DD (node-pg parses DATE as local midnight). */
const localDate = (d: any): string | null => {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const CASE_STATUSES = ['open', 'investigating', 'action_planned', 'action_done', 'verified', 'not_needed'] as const;
const RESULTS = ['improved', 'no_change', 'worse', 'inconclusive'];

/** Window statistics for before/after comparison (from 10-minute values). */
export function windowStats(rows: any[]) {
    const col = (k: string) => rows.map((x) => num(x[k])).filter((x): x is number => x !== null);
    const kw = col('power_active_total_avg');
    const loadedPf = rows.filter((x) => (num(x.power_active_total_avg) ?? 0) > 0 && num(x.power_factor_total_avg) !== null).map((x) => Math.abs(num(x.power_factor_total_avg)!));
    const thd = ['a', 'b', 'c'].map((p) => r(percentile(col(`thd_voltage_${p}_avg`), 95), 2));
    return {
        values: rows.length,
        kw_avg: r(kw.length ? kw.reduce((a, b) => a + b, 0) / kw.length : null),
        kw_p95: r(percentile(kw, 95)),
        kw_max: r(col('power_active_total_max').reduce((a, b) => Math.max(a, b), -Infinity)),
        pf_loaded_avg: r(loadedPf.length ? loadedPf.reduce((a, b) => a + b, 0) / loadedPf.length : null, 3),
        thd_v_p95: { A: thd[0], B: thd[1], C: thd[2] },
        v_min: r(Math.min(...['a', 'b', 'c'].flatMap((p) => col(`voltage_${p}_min`).filter((v) => v >= 23)))),
        current_unbalance_p95: r(percentile(col('current_unbalance_avg'), 95), 1),
    };
}


// ── Data explorer: any channel, any resolution ──────────────────────────────

type Corr = 'none' | 'scale' | 'sign' | 'signscale';
/** Every channel a client may plot. `agg` = stored in the 1m/10m/1h aggregates (avg/min/max); others are raw only. */
export const EXPLORE_CHANNELS: { key: string; label: string; unit: string; group: string; corr: Corr; agg: boolean }[] = [
    ...['a', 'b', 'c'].map((p) => ({ key: `voltage_${p}`, label: `Voltage ${p.toUpperCase()}-N`, unit: 'V', group: 'Voltage', corr: 'none' as Corr, agg: true })),
    ...['ab', 'bc', 'ca'].map((p) => ({ key: `voltage_${p}`, label: `Voltage ${p.toUpperCase()}`, unit: 'V', group: 'Voltage', corr: 'none' as Corr, agg: false })),
    ...['a', 'b', 'c'].map((p) => ({ key: `current_${p}`, label: `Current ${p.toUpperCase()}`, unit: 'A', group: 'Current', corr: 'scale' as Corr, agg: true })),
    { key: 'current_n', label: 'Current N', unit: 'A', group: 'Current', corr: 'scale', agg: false },
    { key: 'power_active_total', label: 'Active power total', unit: 'kW', group: 'Power', corr: 'signscale', agg: true },
    { key: 'power_reactive_total', label: 'Reactive power total', unit: 'kvar', group: 'Power', corr: 'signscale', agg: true },
    { key: 'power_apparent_total', label: 'Apparent power total', unit: 'kVA', group: 'Power', corr: 'scale', agg: true },
    ...['a', 'b', 'c'].map((p) => ({ key: `power_active_${p}`, label: `Active power ${p.toUpperCase()}`, unit: 'kW', group: 'Power per phase', corr: 'signscale' as Corr, agg: false })),
    ...['a', 'b', 'c'].map((p) => ({ key: `power_reactive_${p}`, label: `Reactive power ${p.toUpperCase()}`, unit: 'kvar', group: 'Power per phase', corr: 'signscale' as Corr, agg: false })),
    ...['a', 'b', 'c'].map((p) => ({ key: `power_apparent_${p}`, label: `Apparent power ${p.toUpperCase()}`, unit: 'kVA', group: 'Power per phase', corr: 'scale' as Corr, agg: false })),
    { key: 'power_factor_total', label: 'Power factor total', unit: 'PF', group: 'Power factor', corr: 'sign', agg: true },
    ...['a', 'b', 'c'].map((p) => ({ key: `power_factor_${p}`, label: `Power factor ${p.toUpperCase()}`, unit: 'PF', group: 'Power factor', corr: 'sign' as Corr, agg: false })),
    { key: 'frequency', label: 'Frequency', unit: 'Hz', group: 'Frequency', corr: 'none', agg: true },
    ...['a', 'b', 'c'].map((p) => ({ key: `thd_voltage_${p}`, label: `THD-V ${p.toUpperCase()}`, unit: '%', group: 'Distortion', corr: 'none' as Corr, agg: true })),
    ...['a', 'b', 'c'].map((p) => ({ key: `thd_current_${p}`, label: `THD-I ${p.toUpperCase()}`, unit: '%', group: 'Distortion', corr: 'none' as Corr, agg: true })),
    { key: 'voltage_unbalance', label: 'Voltage unbalance', unit: '%', group: 'Unbalance', corr: 'none', agg: true },
    { key: 'current_unbalance', label: 'Current unbalance', unit: '%', group: 'Unbalance', corr: 'none', agg: true },
];
const BY_KEY = new Map(EXPLORE_CHANNELS.map((c) => [c.key, c]));

export const EXPLORE_INTERVALS: Record<string, { view: string | null; seconds: number; maxMs: number; label: string }> = {
    raw: { view: null, seconds: 1, maxMs: 6 * 3_600_000, label: 'every reading' },
    '1m': { view: 'point_readings_1m', seconds: 60, maxMs: 3 * 86_400_000, label: '1-minute' },
    '10m': { view: 'point_readings_10m', seconds: 600, maxMs: 31 * 86_400_000, label: '10-minute' },
    '1h': { view: 'point_readings_1h', seconds: 3600, maxMs: 400 * 86_400_000, label: 'hourly' },
};
/** The finest interval that fits a window (auto). */
export function autoInterval(ms: number): string {
    return ms <= 2 * 3_600_000 ? 'raw' : ms <= 2 * 86_400_000 ? '1m' : ms <= 14 * 86_400_000 ? '10m' : '1h';
}
/** Raw expression with the deployment's corrections (same as the point views and the public API). */
const rawExpr = (c: { key: string; corr: Corr }) =>
    c.corr === 'scale' ? `r.${c.key} * d.scale_correction` : c.corr === 'sign' ? `r.${c.key} * d.power_sign`
        : c.corr === 'signscale' ? `r.${c.key} * d.power_sign * d.scale_correction` : `r.${c.key}`;

export function investigateRouter(pool: Pool, authenticateJwt: (req: any, res: any, next: any) => void): Router {
    const r0 = Router();
    const auth = withScope(authenticateJwt);

    const point = async (req: any, res: any) => {
        const p = await findPoint(pool, req.scope, req.params.id);
        if (!p) { res.status(403).json({ error: 'Forbidden' }); return null; }
        if (!p.telemetry_visible) { res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' }); return null; }
        return p;
    };
    const range = (p: any, fromS: unknown, toS: unknown, widthMs: number) => {
        const from = new Date(String(fromS)), to = new Date(String(toS));
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
        const c = clampToAccess(from, to, p);
        return c ? alignInward(c, widthMs, p) : null;
    };
    /** The assessment if the caller may read it now (staff: any started one). */
    const assessmentFor = async (req: any, id: string) => {
        if (!UUID.test(id) || req.scope.apiKey) return null;
        if (req.scope.isInternal) return (await pool.query(`SELECT * FROM assessments WHERE id = $1 AND start_at IS NOT NULL`, [id])).rows[0] ?? null;
        return (await pool.query(`SELECT a.* FROM assessments a WHERE a.id = $1 AND a.tenant_id = $2 AND ${liveAssessmentSql(req.scope, 'a')}`,
            [id, req.scope.tenantId])).rows[0] ?? null;
    };
    const handle = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
        try { await fn(req, res); } catch (e) { console.error('[investigate]', e); res.status(500).json({ error: 'Server error' }); }
    };

    r0.get('/points/:id/investigate', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const asked = new Date(String(req.query.to)).getTime() - new Date(String(req.query.from)).getTime();
        if (!(asked > 0)) return res.status(400).json({ error: 'from must be before to' });
        if (asked > 31 * 86_400_000) return res.status(400).json({ error: 'An investigation window covers at most 31 days' });
        const v = viewFor(asked);
        const w = range(p, req.query.from, req.query.to, v.widthMs);
        if (!w) return res.json({ point_id: p.id, rows: [], events: [], resolution: v.label, basis: 'nothing inside the assessment window' });
        const rows = (await pool.query(`
            SELECT bucket AS t, n,
                   power_active_total_avg AS kw, power_active_total_min AS kw_min, power_active_total_max AS kw_max,
                   power_reactive_total_avg AS kvar, power_apparent_total_avg AS kva,
                   power_factor_total_avg AS pf, power_factor_total_min AS pf_min,
                   voltage_a_avg AS va, voltage_b_avg AS vb, voltage_c_avg AS vc,
                   voltage_a_min AS va_min, voltage_b_min AS vb_min, voltage_c_min AS vc_min,
                   voltage_a_max AS va_max, voltage_b_max AS vb_max, voltage_c_max AS vc_max,
                   current_a_avg AS ia, current_b_avg AS ib, current_c_avg AS ic,
                   current_a_max AS ia_max, current_b_max AS ib_max, current_c_max AS ic_max,
                   thd_voltage_a_avg AS thd_va, thd_voltage_b_avg AS thd_vb, thd_voltage_c_avg AS thd_vc,
                   thd_voltage_a_max AS thd_va_max, thd_voltage_b_max AS thd_vb_max, thd_voltage_c_max AS thd_vc_max,
                   thd_current_a_avg AS thd_ia, frequency_min AS f_min, frequency_max AS f_max
            FROM ${v.view} WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [p.id, w.from, w.to])).rows;
        const events = (await pool.query(`
            SELECT e.type, e.channel AS phase, e.started_at, e.ended_at, e.duration_s, e.extreme_value
            FROM pq_events e JOIN deployments d ON d.device_id = e.meter_id
            WHERE d.measurement_point_id = $1 AND e.started_at >= GREATEST($2, d.installed_at)
              AND e.started_at < LEAST($3, COALESCE(d.removed_at, 'infinity'::timestamptz))
            ORDER BY e.started_at LIMIT 200`, [p.id, w.from, w.to])).rows;
        const round = (x: any) => Object.fromEntries(Object.entries(x).map(([k, val]) => [k, k === 't' ? val : typeof val === 'string' || typeof val === 'number' ? r(Number(val), k.startsWith('pf') ? 3 : 2) : val]));
        res.json({
            point_id: p.id, from: w.from, to: w.to, resolution: v.label, bucket_seconds: v.widthMs / 1000, timezone: 'Africa/Johannesburg',
            basis: `${v.label} averages with the minimum and maximum inside each bucket (extremes are kept, not smoothed away); not a recorded waveform`,
            rows: rows.map(round),
            events: events.map((e) => ({ type: e.type, phase: e.phase, started_at: e.started_at, ended_at: e.ended_at, duration_s: num(e.duration_s), extreme: num(e.extreme_value) })),
            events_basis: 'inferred from the sampled RMS trend unless the meter records events itself',
        });
    }));

    // Data explorer: up to 8 channels at raw / 1m / 10m / 1h for one window (clamped to the
    // assessment; aggregate windows aligned to whole buckets). Raw rows carry the deployment's
    // corrections, aggregate rows come from the corrected point views with min and max.
    // Close-ups: the 1-minute values find the worst moments; each comes back with every
    // stored reading around it and what those readings show (moments.ts).
    r0.get('/points/:id/moments', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const kind = String(req.query.kind ?? '') as MomentKind;
        if (!MOMENT_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${MOMENT_KINDS.join(', ')}` });
        const to0 = req.query.to ? new Date(String(req.query.to)) : new Date();
        const from0 = req.query.from ? new Date(String(req.query.from)) : new Date(to0.getTime() - 7 * 86_400_000);
        if (Number.isNaN(from0.getTime()) || Number.isNaN(to0.getTime()) || from0 >= to0) return res.status(400).json({ error: 'from must be before to' });
        if (to0.getTime() - from0.getTime() > 31 * 86_400_000) return res.status(400).json({ error: 'A window covers at most 31 days' });
        const limit = Math.min(5, Math.max(1, Number(req.query.limit) || 3));
        const c = clampToAccess(from0, to0, p);
        const w = c && alignInward(c, 60_000, p);
        const meta = (await pool.query(`SELECT name, nominal_voltage_v, contracted_mdi_kva FROM measurement_points WHERE id = $1`, [p.id])).rows[0];
        const nominalV = Number(meta?.nominal_voltage_v) || 230;
        if (!w) return res.json({ point_id: p.id, kind, moments: [] });
        const rank = MOMENT_RANK[kind];
        const cands = (await pool.query(`
            SELECT bucket, ${rank.expr} AS v FROM point_readings_1m
            WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 AND ${rank.where} AND ${rank.expr} IS NOT NULL
            ORDER BY v ${rank.order} LIMIT 200`, [p.id, w.from, w.to])).rows.map((x) => ({ t: new Date(x.bucket).getTime(), v: Number(x.v) }));
        const moments: any[] = [];
        for (const m of spread(cands, limit)) {
            const load = async (beforeMs: number, afterMs: number) => {
                const cw = clampToAccess(new Date(m.t - beforeMs), new Date(m.t + 60_000 + afterMs), p);
                if (!cw) return [];
                return (await pool.query(`
                    SELECT r.time AS t, r.voltage_a, r.voltage_b, r.voltage_c,
                           r.current_a * d.scale_correction AS current_a, r.current_b * d.scale_correction AS current_b, r.current_c * d.scale_correction AS current_c,
                           r.power_active_total * d.power_sign * d.scale_correction AS kw, r.power_apparent_total * d.scale_correction AS kva,
                           r.power_factor_total * d.power_sign AS pf, r.thd_voltage_a AS thd_a, r.thd_voltage_b AS thd_b, r.thd_voltage_c AS thd_c,
                           r.current_unbalance AS unbalance
                    FROM deployments d JOIN meter_readings r ON r.meter_id = d.device_id AND r.time >= d.installed_at AND (d.removed_at IS NULL OR r.time < d.removed_at)
                    WHERE d.measurement_point_id = $1 AND r.time >= $2 AND r.time < $3 ORDER BY r.time LIMIT 2000`, [p.id, cw.from, cw.to])).rows;
            };
            // Two minutes before to three after; a meter that reports rarely gets a wider frame.
            let rows = await load(120_000, 120_000);
            if (rows.length < 12) rows = await load(45 * 60_000, 45 * 60_000);
            const opts = { nominalV, mdiKva: meta?.contracted_mdi_kva != null ? Number(meta.contracted_mdi_kva) : null };
            let facts = momentFacts(kind, rows, opts);
            // An excursion that runs off the frame gets a wider one, once.
            if (facts?.clipped) { rows = await load(15 * 60_000, 15 * 60_000); facts = momentFacts(kind, rows, opts); }
            if (!facts) continue;
            // After the first, only moments that are beyond the level that matters are worth a card.
            if (moments.length && !facts.crossed) continue;
            if (moments.length && !moments[0].crossed) break;
            const rd = (v: any, d = 1) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
            moments.push({
                ...facts, from: new Date(rows[0].t).toISOString(), to: new Date(rows[rows.length - 1].t).toISOString(),
                series: rows.map((x) => ({ t: new Date(x.t).toISOString(), voltage_a: rd(x.voltage_a), voltage_b: rd(x.voltage_b), voltage_c: rd(x.voltage_c),
                    current_a: rd(x.current_a), current_b: rd(x.current_b), current_c: rd(x.current_c), kw: rd(x.kw), kva: rd(x.kva), pf: rd(x.pf, 3),
                    thd_a: rd(x.thd_a, 2), thd_b: rd(x.thd_b, 2), thd_c: rd(x.thd_c, 2), unbalance: rd(x.unbalance) })),
            });
        }
        res.json({ point_id: p.id, point: meta?.name ?? null, kind, nominal_voltage_v: nominalV, from: w.from, to: w.to, timezone: 'Africa/Johannesburg',
            basis: 'The worst 1-minute values of the period, each shown with every stored reading around it (installation corrections applied). The reading of site or supply is a pointer to verify, not a conclusion.',
            moments });
    }));

    r0.get('/points/:id/explore', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const from0 = new Date(String(req.query.from)), to0 = new Date(String(req.query.to));
        if (Number.isNaN(from0.getTime()) || Number.isNaN(to0.getTime()) || from0 >= to0) return res.status(400).json({ error: 'from must be before to' });
        const asked = String(req.query.interval ?? 'auto');
        const interval = asked === 'auto' ? autoInterval(to0.getTime() - from0.getTime()) : asked;
        const iv = EXPLORE_INTERVALS[interval];
        if (!iv) return res.status(400).json({ error: `interval must be auto, ${Object.keys(EXPLORE_INTERVALS).join(', ')}` });
        if (to0.getTime() - from0.getTime() > iv.maxMs) return res.status(400).json({ error: `At ${iv.label} resolution a window covers at most ${Math.round(iv.maxMs / 3_600_000)} hours`, code: 'window_too_long', max_hours: Math.round(iv.maxMs / 3_600_000) });
        const keys = String(req.query.channels ?? 'power_active_total').split(',').map((k) => k.trim()).filter((k) => BY_KEY.has(k));
        if (!keys.length || keys.length > 8) return res.status(400).json({ error: 'Choose 1 to 8 channels' });
        const c = clampToAccess(from0, to0, p);
        const w = c && (interval === 'raw' ? c : alignInward(c, iv.seconds * 1000, p));
        const channels = keys.map((k) => { const ch = BY_KEY.get(k)!; return { key: k, label: ch.label, unit: ch.unit, available: interval === 'raw' || ch.agg }; });
        if (!w) return res.json({ point_id: p.id, interval, channels, rows: [], basis: 'nothing inside the assessment window' });
        let rows: any[];
        if (interval === 'raw') {
            const cols = keys.map((k) => `${rawExpr(BY_KEY.get(k)!)} AS ${k}`).join(', ');
            rows = (await pool.query(`
                SELECT r.time AS t, ${cols}
                FROM deployments d JOIN meter_readings r ON r.meter_id = d.device_id AND r.time >= d.installed_at AND (d.removed_at IS NULL OR r.time < d.removed_at)
                WHERE d.measurement_point_id = $1 AND r.time >= $2 AND r.time < $3 ORDER BY r.time LIMIT 30000`, [p.id, w.from, w.to])).rows;
        } else {
            const agg = keys.filter((k) => BY_KEY.get(k)!.agg);
            const cols = agg.map((k) => `${k}_avg AS ${k}, ${k}_min AS ${k}_min, ${k}_max AS ${k}_max`).join(', ');
            rows = (await pool.query(`
                SELECT bucket AS t, n${cols ? `, ${cols}` : ''} FROM ${iv.view}
                WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket`, [p.id, w.from, w.to])).rows;
        }
        const dec = (k: string) => (k.startsWith('power_factor') ? 3 : k.startsWith('frequency') ? 3 : 2);
        res.json({
            point_id: p.id, interval, interval_label: iv.label, bucket_seconds: iv.seconds, from: w.from, to: w.to, timezone: 'Africa/Johannesburg',
            channels, truncated: interval === 'raw' && rows.length >= 30000,
            basis: interval === 'raw'
                ? 'every stored reading (the meter\'s own interval), with the installation corrections applied'
                : `${iv.label} averages with the lowest and highest reading inside each ${iv.label} period; times are the start of the period`,
            rows: rows.map((x) => {
                const o: any = { t: new Date(x.t).toISOString() };
                if (x.n != null) o.n = Number(x.n);
                for (const [k, v] of Object.entries(x)) if (k !== 't' && k !== 'n') o[k] = v == null ? null : Math.round(Number(v) * 10 ** dec(k)) / 10 ** dec(k);
                return o;
            }),
        });
    }));

    r0.get('/points/:id/compare', auth, handle(async (req, res) => {
        const p = await point(req, res);
        if (!p) return;
        const a = range(p, req.query.a_from, req.query.a_to, 600_000);
        const b = range(p, req.query.b_from, req.query.b_to, 600_000);
        if (!a || !b) return res.status(400).json({ error: 'Both windows must lie inside the assessment', code: 'outside_assessment' });
        const q = (w: { from: Date; to: Date }) => pool.query(`
            SELECT power_active_total_avg, power_active_total_max, power_factor_total_avg, current_unbalance_avg,
                   thd_voltage_a_avg, thd_voltage_b_avg, thd_voltage_c_avg, voltage_a_min, voltage_b_min, voltage_c_min
            FROM point_readings_10m WHERE measurement_point_id = $1 AND bucket >= $2 AND bucket < $3`, [p.id, w.from, w.to]).then((x) => x.rows);
        const [ra, rb] = await Promise.all([q(a), q(b)]);
        const sa = windowStats(ra), sb = windowStats(rb);
        const hours = (w: { from: Date; to: Date }) => r((w.to.getTime() - w.from.getTime()) / 3_600_000, 1);
        res.json({
            point_id: p.id,
            before: { from: a.from, to: a.to, hours: hours(a), ...sa },
            after: { from: b.from, to: b.to, hours: hours(b), ...sb },
            basis: '10-minute values of each window. A difference coincides with the intervention only if operation was comparable; state changed conditions (production, weather, tariff period) before drawing a conclusion.',
            comparable: Math.abs((hours(a) ?? 0) - (hours(b) ?? 0)) <= Math.max(1, 0.1 * Math.max(hours(a) ?? 0, hours(b) ?? 0)),
        });
    }));

    r0.get('/assessments/:id/evidence', auth, handle(async (req, res) => {
        const a = await assessmentFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
        const rows = (await pool.query(`
            SELECT e.id, e.measurement_point_id, mp.name AS point_name, e.recommendation_id, e.from_at, e.to_at, e.title, e.note,
                   e.channels, e.include_in_report, e.created_at
            FROM evidence_refs e JOIN measurement_points mp ON mp.id = e.measurement_point_id
            WHERE e.assessment_id = $1 AND e.removed_at IS NULL ORDER BY e.from_at`, [a.id])).rows;
        res.json(rows);
    }));

    r0.post('/assessments/:id/evidence', auth, handle(async (req, res) => {
        if (!canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
        const a = await assessmentFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
        const b = req.body ?? {};
        const inA = (await pool.query(`SELECT 1 FROM assessment_points WHERE assessment_id = $1 AND measurement_point_id = $2`, [a.id, b.point_id])).rows.length > 0;
        if (!UUID.test(String(b.point_id)) || !inA) return res.status(400).json({ error: 'point_id must be a point of this assessment' });
        const from = new Date(String(b.from)), to = new Date(String(b.to));
        const end = Math.min(new Date(a.end_at).getTime(), a.closed_at ? new Date(a.closed_at).getTime() : Infinity);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to || from.getTime() < new Date(a.start_at).getTime() || to.getTime() > end)
            return res.status(400).json({ error: 'The window must lie inside the assessment period' });
        const title = String(b.title ?? '').trim().slice(0, 200);
        if (!title) return res.status(400).json({ error: 'title is required' });
        let rec: string | null = null;
        if (b.recommendation_id) {
            const f = await findOwned(pool, req.scope, 'recommendations', String(b.recommendation_id));
            if (!f) return res.status(400).json({ error: 'Unknown finding' });
            rec = f.id;
        }
        const channels = Array.isArray(b.channels) ? b.channels.map(String).filter((c: string) => /^[a-z_]{1,20}$/.test(c)).slice(0, 12) : [];
        const row = (await pool.query(`
            INSERT INTO evidence_refs (assessment_id, measurement_point_id, recommendation_id, from_at, to_at, title, note, channels, include_in_report, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [a.id, b.point_id, rec, from, to, title, b.note ? String(b.note).slice(0, 2000) : null, channels, b.include_in_report !== false, req.scope.userId])).rows[0];
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'evidence.create', 'evidence_ref', $2, $3)`,
            [req.scope.userId, row.id, JSON.stringify({ title, from, to, point: b.point_id })]);
        res.status(201).json(row);
    }));

    r0.post('/evidence/:id/remove', auth, handle(async (req, res) => {
        if (!canWrite(req.scope) || !UUID.test(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
        const e = (await pool.query(`SELECT assessment_id FROM evidence_refs WHERE id = $1 AND removed_at IS NULL`, [req.params.id])).rows[0];
        const a = e && await assessmentFor(req, e.assessment_id);
        if (!a) return res.status(403).json({ error: 'Forbidden' });
        await pool.query(`UPDATE evidence_refs SET removed_at = NOW() WHERE id = $1`, [req.params.id]);
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id) VALUES ($1, 'evidence.remove', 'evidence_ref', $2)`, [req.scope.userId, req.params.id]);
        res.json({ ok: true });
    }));

    r0.get('/assessments/:id/cases', auth, handle(async (req, res) => {
        const a = await assessmentFor(req, req.params.id);
        if (!a) return res.status(403).json({ error: NO_ACCESS, code: 'no_active_assessment' });
        const rows = (await pool.query(`
            SELECT c.recommendation_id, c.owner, c.status, c.next_step, c.due_on, c.verification, c.updated_at,
                   (SELECT count(*)::int FROM evidence_refs e WHERE e.recommendation_id = c.recommendation_id AND e.removed_at IS NULL) AS evidence_count,
                   (SELECT json_build_object('id', w.id, 'status', w.status, 'kind', w.kind, 'started_at', w.started_at, 'until_at', w.until_at,
                                             'notes', w.notes, 'conclusion', w.conclusion, 'concluded_at', w.concluded_at,
                                             'reviewed_at', w.reviewed_at, 'staff_note', w.staff_note, 'point', mp.name)
                    FROM finding_watches w JOIN measurement_points mp ON mp.id = w.measurement_point_id
                    WHERE w.recommendation_id = c.recommendation_id AND w.status <> 'cancelled'
                    ORDER BY w.started_at DESC LIMIT 1) AS watch
            FROM finding_cases c JOIN recommendations r ON r.id = c.recommendation_id
            WHERE r.site_id = $1 AND r.status = 'ACTIVE'`, [a.project_id])).rows;
        res.json(rows);
    }));

    r0.patch('/recommendations/:id/case', auth, handle(async (req, res) => {
        if (!canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
        const visible = req.scope.isInternal ? 'TRUE'
            : `x.review_status <> 'dismissed' AND (x.review_status = 'published' OR ${seesUnpublishedFindings(req.scope) ? 'TRUE' : 'FALSE'})
               AND EXISTS (SELECT 1 FROM projects pj WHERE pj.id = x.site_id AND ${telemetrySql(req.scope, 'pj')})`;
        const f = await findOwned(pool, req.scope, 'recommendations', req.params.id, visible);
        if (!f) return res.status(403).json({ error: 'Forbidden' });
        const b = req.body ?? {};
        if (b.status !== undefined && !(CASE_STATUSES as readonly string[]).includes(b.status)) return res.status(400).json({ error: `status must be one of ${CASE_STATUSES.join(', ')}` });
        if (b.due_on && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_on))) return res.status(400).json({ error: 'due_on must be YYYY-MM-DD' });
        let verification: any = undefined;
        if (b.verification !== undefined) {
            const v = b.verification ?? {};
            if (v.result && !RESULTS.includes(v.result)) return res.status(400).json({ error: `verification.result must be one of ${RESULTS.join(', ')}` });
            verification = { before: v.before ?? null, after: v.after ?? null, result: v.result ?? null, note: v.note ? String(v.note).slice(0, 2000) : null };
        }
        if (b.status === 'verified' && !(verification?.result ?? (await pool.query(`SELECT verification FROM finding_cases WHERE recommendation_id = $1`, [f.id])).rows[0]?.verification?.result))
            return res.status(400).json({ error: 'Verified needs a before/after comparison result' });
        const before = (await pool.query(`SELECT * FROM finding_cases WHERE recommendation_id = $1`, [f.id])).rows[0] ?? null;
        const row = (await pool.query(`
            INSERT INTO finding_cases (recommendation_id, owner, status, next_step, due_on, verification, updated_by, updated_at)
            VALUES ($1, $2, COALESCE($3, 'open'), $4, $5, $6, $7, NOW())
            ON CONFLICT (recommendation_id) DO UPDATE SET
                owner = CASE WHEN $8 THEN EXCLUDED.owner ELSE finding_cases.owner END,
                status = COALESCE($3, finding_cases.status),
                next_step = CASE WHEN $9 THEN EXCLUDED.next_step ELSE finding_cases.next_step END,
                due_on = CASE WHEN $10 THEN EXCLUDED.due_on ELSE finding_cases.due_on END,
                verification = COALESCE(EXCLUDED.verification, finding_cases.verification),
                updated_by = EXCLUDED.updated_by, updated_at = NOW()
            RETURNING *`,
            [f.id, b.owner ? String(b.owner).slice(0, 120) : null, b.status ?? null, b.next_step ? String(b.next_step).slice(0, 1000) : null,
             b.due_on || null, verification === undefined ? null : JSON.stringify(verification), req.scope.userId,
             b.owner !== undefined, b.next_step !== undefined, b.due_on !== undefined])).rows[0];
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after) VALUES ($1, 'finding_case.update', 'recommendation', $2, $3, $4)`,
            [req.scope.userId, f.id, before ? JSON.stringify(before) : null, JSON.stringify(row)]);
        // Investigating starts a watch of the finding; closing it as not needed stops one.
        let watch = null;
        if (b.status === 'investigating' && before?.status !== 'investigating') watch = await startWatch(pool, f, req.scope.userId, localDate(row.due_on));
        if (b.status === 'not_needed' || b.status === 'open') await stopWatch(f.id, req.scope.userId);
        res.json({ ...row, watch });
    }));

    const ownedFinding = (req: any) => findOwned(pool, req.scope, 'recommendations', req.params.id, req.scope.isInternal ? 'TRUE'
        : `x.review_status <> 'dismissed' AND (x.review_status = 'published' OR ${seesUnpublishedFindings(req.scope) ? 'TRUE' : 'FALSE'})
           AND EXISTS (SELECT 1 FROM projects pj WHERE pj.id = x.site_id AND ${telemetrySql(req.scope, 'pj')})`);
    async function stopWatch(recId: string, userId: string | null) {
        const w = (await pool.query(`UPDATE finding_watches SET status = 'cancelled', cancelled_at = NOW() WHERE recommendation_id = $1 AND status = 'watching' RETURNING id`, [recId])).rows[0];
        if (w) await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'finding_watch.stop', 'recommendation', $2, $3)`,
            [userId, recId, JSON.stringify({ watch: w.id })]);
        return w ?? null;
    }

    r0.post('/recommendations/:id/watch/stop', auth, handle(async (req, res) => {
        if (!canWrite(req.scope)) return res.status(403).json({ error: 'Read-only role' });
        const f = await ownedFinding(req);
        if (!f) return res.status(403).json({ error: 'Forbidden' });
        const w = await stopWatch(f.id, req.scope.userId);
        if (!w) return res.status(404).json({ error: 'No watch is running for this finding' });
        res.json({ ok: true });
    }));

    r0.post('/recommendations/:id/watch/conclude', auth, handle(async (req, res) => {
        if (!req.scope.isInternal) return res.status(403).json({ error: 'Forbidden' });
        const f = await ownedFinding(req);
        if (!f) return res.status(403).json({ error: 'Forbidden' });
        const w = await watchForConclusion(pool, f.id);
        if (!w) return res.status(404).json({ error: 'No watch is running for this finding' });
        res.json(await concludeWatch(pool, w));
    }));

    r0.post('/recommendations/:id/watch/review', auth, handle(async (req, res) => {
        if (!req.scope.isInternal) return res.status(403).json({ error: 'Forbidden' });
        const f = await ownedFinding(req);
        if (!f) return res.status(403).json({ error: 'Forbidden' });
        const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
        const w = (await pool.query(`
            UPDATE finding_watches SET reviewed_by = $2, reviewed_at = NOW(), staff_note = $3
            WHERE id = (SELECT id FROM finding_watches WHERE recommendation_id = $1 AND status = 'concluded' ORDER BY concluded_at DESC LIMIT 1)
            RETURNING id, reviewed_at, staff_note`, [f.id, req.scope.userId, note])).rows[0];
        if (!w) return res.status(404).json({ error: 'No concluded watch for this finding' });
        await pool.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after) VALUES ($1, 'finding_watch.review', 'recommendation', $2, $3)`,
            [req.scope.userId, f.id, JSON.stringify(w)]);
        res.json(w);
    }));

    return r0;
}
