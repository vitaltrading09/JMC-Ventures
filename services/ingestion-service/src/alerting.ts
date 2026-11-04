// ─────────────────────────────────────────────────────────────────────────────
// Alerting (jobs role), evaluated on aggregates and events, never per reading.
//
//   regulation   readings_10m: voltage (10-minute RMS) and voltage THD per phase
//                against site_settings limits (NRS 048-2 defaults). NRS 048-2
//                assesses 10-minute values, so that is what is compared.
//   demand       readings_30m: 30-minute average kVA against contracted MDI,
//                30-minute kW against alert_max_kw. Plus the instantaneous MDI
//                early warning (readings_1m max), worded as such.
//   events       pq_events (ingest's 1-second excursion detector) by type and
//                duration, per-site minimum duration.
//   data health  silent meters, coverage below 95 % in the last hour, clock
//                drift, rising duplicate-timestamp counts.
//   THD-I        against a site-declared limit (alert_max_thd_i); with none
//                configured, a week-on-week trend notice only. NRS 048-2 sets
//                no limit for current distortion, so none is claimed.
//
// Every message states its averaging basis. Dedupe: each alert carries a key
// for its window (the hour, the 30-minute interval, the event id, ...). It is
// unique per (meter, type, key) in the database (idx_alerts_dedupe) and also
// remembered in memory, so re-running a check never repeats an alert.
// ─────────────────────────────────────────────────────────────────────────────

import { Pool } from 'pg';
import { NRS048_DEFAULTS } from './ingest/meter-cache';

export interface AlertCandidate {
    tenantId: string;
    meterId: string;
    type: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    message: string;
    dedupeKey: string;
}

export const DEFAULT_THD_V_LIMIT = 8.0;               // NRS 048-2 LV voltage THD (%)
export const COVERAGE_MIN = 0.95;
export const CLOCK_DRIFT_MAX_S = 120;
const PHASES: Array<['a' | 'b' | 'c', string]> = [['a', 'L1'], ['b', 'L2'], ['c', 'L3']];

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const hourKey = (d: Date) => d.toISOString().slice(0, 13);

// ── Pure evaluation (unit-tested) ───────────────────────────────────────────

export interface TenMinuteRow {
    tenant_id: string; meter_id: string; bucket: Date | string;
    n_interrupt: number | string;
    v_rms_a: number | string | null; v_rms_b: number | string | null; v_rms_c: number | string | null;
    thd_v_a: number | string | null; thd_v_b: number | string | null; thd_v_c: number | string | null;
    thd_i_a: number | string | null; thd_i_b: number | string | null; thd_i_c: number | string | null;
    alert_min_v: number | string | null; alert_max_v: number | string | null;
    alert_max_thd: number | string | null; alert_max_thd_i: number | string | null;
}

/** Voltage, voltage THD and (declared-limit) current THD on 10-minute values. */
export function evaluateTenMinute(row: TenMinuteRow): AlertCandidate[] {
    const out: AlertCandidate[] = [];
    // An interval containing an interruption is not a voltage-quality value.
    if (Number(row.n_interrupt) > 0) return out;
    const start = new Date(row.bucket);
    const span = `${hhmm(start)}–${hhmm(new Date(start.getTime() + 600_000))} UTC`;
    const minV = num(row.alert_min_v) ?? NRS048_DEFAULTS.minV;
    const maxV = num(row.alert_max_v) ?? NRS048_DEFAULTS.maxV;
    const maxThd = num(row.alert_max_thd) ?? DEFAULT_THD_V_LIMIT;
    const maxThdI = num(row.alert_max_thd_i);
    const base = { tenantId: row.tenant_id, meterId: row.meter_id };
    const key = hourKey(start); // at most one of each type per meter per hour

    const v = PHASES.map(([p, l]) => [l, num((row as any)[`v_rms_${p}`])] as const).filter(([, x]) => x !== null) as Array<readonly [string, number]>;
    const low = v.filter(([, x]) => x < minV).sort((a, b) => a[1] - b[1]);
    const high = v.filter(([, x]) => x > maxV).sort((a, b) => b[1] - a[1]);
    if (low.length) {
        out.push({ ...base, type: 'VOLTAGE_SAG', severity: 'CRITICAL', dedupeKey: key,
            message: `10-minute RMS voltage below the ${minV} V limit on ${low.map(([l, x]) => `${l} ${x.toFixed(1)} V`).join(', ')} (${span}). `
                + `NRS 048-2 assesses voltage on 10-minute values; sustained undervoltage risks motor overheating and drive trips.` });
    }
    if (high.length) {
        out.push({ ...base, type: 'OVERVOLTAGE', severity: 'CRITICAL', dedupeKey: key,
            message: `10-minute RMS voltage above the ${maxV} V limit on ${high.map(([l, x]) => `${l} ${x.toFixed(1)} V`).join(', ')} (${span}). `
                + `NRS 048-2 assesses voltage on 10-minute values; sustained overvoltage stresses insulation and shortens equipment life.` });
    }

    const thd = PHASES.map(([p, l]) => [l, num((row as any)[`thd_v_${p}`])] as const)
        .filter(([, x]) => x !== null && (x as number) > maxThd) as Array<readonly [string, number]>;
    if (thd.length) {
        out.push({ ...base, type: 'HIGH_THD', severity: 'WARNING', dedupeKey: key,
            message: `10-minute average voltage THD above the ${maxThd}% limit on ${thd.map(([l, x]) => `${l} ${x.toFixed(2)}%`).join(', ')} (${span}). `
                + `NRS 048-2 harmonic limits apply to 10-minute values.` });
    }

    if (maxThdI !== null) {
        const thdI = PHASES.map(([p, l]) => [l, num((row as any)[`thd_i_${p}`])] as const)
            .filter(([, x]) => x !== null && (x as number) > maxThdI) as Array<readonly [string, number]>;
        if (thdI.length) {
            out.push({ ...base, type: 'HIGH_THD_I', severity: 'WARNING', dedupeKey: key,
                message: `10-minute average current THD above this site's declared ${maxThdI}% limit on ${thdI.map(([l, x]) => `${l} ${x.toFixed(1)}%`).join(', ')} (${span}). `
                    + `Current distortion limits come from IEEE 519 / NRS 048-4 and the site's supply agreement, not NRS 048-2; THD-I at light load overstates distortion.` });
        }
    }
    return out;
}

export interface DemandRow {
    tenant_id: string; meter_id: string; bucket: Date | string; minutes: number | string;
    kva_demand: number | string | null; kw_demand: number | string | null;
    contracted_mdi_kva: number | string | null; alert_max_kw: number | string | null;
}

/** Billed-demand alerts on 30-minute averages. */
export function evaluateDemand(row: DemandRow): AlertCandidate[] {
    const out: AlertCandidate[] = [];
    // Under 80 % of the interval covered: the average is not the billed figure.
    if (Number(row.minutes) < 24) return out;
    const start = new Date(row.bucket);
    const span = `${hhmm(start)}–${hhmm(new Date(start.getTime() + 1_800_000))} UTC`;
    const base = { tenantId: row.tenant_id, meterId: row.meter_id, dedupeKey: start.toISOString() };
    const kva = num(row.kva_demand), mdi = num(row.contracted_mdi_kva);
    if (kva !== null && mdi !== null && mdi > 0) {
        const pct = (kva / mdi) * 100;
        if (pct >= 100) {
            out.push({ ...base, type: 'MDI_EXCEEDED', severity: 'CRITICAL',
                message: `30-minute average demand of ${kva.toFixed(1)} kVA (${span}) exceeded the ${mdi} kVA contracted MDI (${pct.toFixed(0)}%). `
                    + `Utilities bill the highest 30-minute average, so this interval can set this month's demand charge.` });
        } else if (pct >= 90) {
            out.push({ ...base, type: 'MDI_WARNING', severity: 'WARNING',
                message: `30-minute average demand of ${kva.toFixed(1)} kVA (${span}) reached ${pct.toFixed(0)}% of the ${mdi} kVA contracted MDI.` });
        }
    }
    const kw = num(row.kw_demand), maxKw = num(row.alert_max_kw);
    if (kw !== null && maxKw !== null && kw > maxKw) {
        out.push({ ...base, type: 'PEAK_DEMAND', severity: 'WARNING',
            message: `30-minute average demand of ${kw.toFixed(1)} kW (${span}) exceeded the ${maxKw} kW limit set for this site — demand charge risk.` });
    }
    return out;
}

export interface InstantRow {
    tenant_id: string; meter_id: string; bucket: Date | string;
    kva_max: number | string | null; contracted_mdi_kva: number | string | null;
}

/** The instantaneous MDI early warning, with its original careful wording. */
export function evaluateInstantMdi(row: InstantRow): AlertCandidate[] {
    const kva = num(row.kva_max), mdi = num(row.contracted_mdi_kva);
    if (kva === null || mdi === null || mdi <= 0 || kva < mdi) return [];
    const start = new Date(row.bucket);
    return [{
        tenantId: row.tenant_id, meterId: row.meter_id, type: 'MDI_INSTANT', severity: 'WARNING',
        dedupeKey: hourKey(start),
        message: `Instantaneous load reached ${kva.toFixed(1)} kVA at ${hhmm(start)} UTC (highest 1-second reading in that minute) — above the ${mdi} kVA contracted MDI (${((kva / mdi) * 100).toFixed(0)}%). `
            + `Billed demand is the highest 30-minute average, so check whether this was sustained.`,
    }];
}

export interface EventRow {
    tenant_id: string; meter_id: string; id: string; type: string; channel: string;
    started_at: Date | string; ended_at: Date | string | null;
    duration_s: number | string; extreme_value: number | string; threshold: number | string;
    event_alert_min_s: number | string | null;
}

const EVENT_LABEL: Record<string, string> = {
    UNDERVOLTAGE: 'Undervoltage', OVERVOLTAGE: 'Overvoltage', UNDERFREQUENCY: 'Underfrequency', OVERFREQUENCY: 'Overfrequency',
};
const CHANNEL_LABEL: Record<string, string> = { voltage_a: 'L1', voltage_b: 'L2', voltage_c: 'L3', frequency: 'frequency' };

/** pq_events → alerts, by type and duration (per-site minimum). */
export function evaluateEvent(row: EventRow, defaultMinS: number): AlertCandidate[] {
    const dur = Number(row.duration_s);
    const minS = num(row.event_alert_min_s) ?? defaultMinS;
    if (dur < minS) return [];
    const unit = row.type.endsWith('FREQUENCY') ? 'Hz' : 'V';
    const low = row.type.startsWith('UNDER');
    const ongoing = row.ended_at === null;
    return [{
        tenantId: row.tenant_id, meterId: row.meter_id, type: `EVENT_${row.type}`,
        severity: dur >= 300 ? 'CRITICAL' : 'WARNING',
        // An ongoing event that later ends is still the same event: one alert.
        dedupeKey: row.id,
        message: `${EVENT_LABEL[row.type] ?? row.type} on ${CHANNEL_LABEL[row.channel] ?? row.channel} ${ongoing ? 'ongoing for' : 'lasting'} ${formatDuration(dur)} `
            + `from ${hhmm(new Date(row.started_at))} UTC: ${low ? 'lowest' : 'highest'} ${Number(row.extreme_value).toFixed(unit === 'Hz' ? 2 : 1)} ${unit} `
            + `against the ${Number(row.threshold)} ${unit} limit (event duration from 1-second readings; sub-second dips are not resolved).`,
    }];
}

export function formatDuration(s: number): string {
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
}

// ── Database side ───────────────────────────────────────────────────────────

const remembered = new Set<string>();
const REMEMBER_MAX = 20_000;

/** Inserts alerts not seen before; returns how many were new. */
export async function writeAlerts(pool: Pool, alerts: AlertCandidate[]): Promise<number> {
    let inserted = 0;
    for (const a of alerts) {
        const k = `${a.meterId}|${a.type}|${a.dedupeKey}`;
        if (remembered.has(k)) continue;
        const r = await pool.query(`
            INSERT INTO alerts (tenant_id, meter_id, type, severity, message, dedupe_key)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (meter_id, type, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
            RETURNING id`, [a.tenantId, a.meterId, a.type, a.severity, a.message, a.dedupeKey]);
        if (remembered.size >= REMEMBER_MAX) remembered.clear();
        remembered.add(k);
        if (r.rows.length) {
            inserted++;
            console.log(`[alerts] ${a.type} (${a.severity}) → meter ${a.meterId}`);
        }
    }
    return inserted;
}

const SETTINGS_JOIN = `
    JOIN meters m ON v.meter_id = m.id
    JOIN sites s ON m.site_id = s.id
    LEFT JOIN site_settings ss ON ss.site_id = s.id`;

/** Completed 10-minute intervals of the last 2 h. */
export async function checkTenMinute(pool: Pool): Promise<number> {
    const r = await pool.query(`
        SELECT s.tenant_id, v.meter_id, v.bucket, v.n_interrupt,
               sqrt(v.voltage_a_ms) AS v_rms_a, sqrt(v.voltage_b_ms) AS v_rms_b, sqrt(v.voltage_c_ms) AS v_rms_c,
               v.thd_voltage_a_avg AS thd_v_a, v.thd_voltage_b_avg AS thd_v_b, v.thd_voltage_c_avg AS thd_v_c,
               v.thd_current_a_avg AS thd_i_a, v.thd_current_b_avg AS thd_i_b, v.thd_current_c_avg AS thd_i_c,
               ss.alert_min_v, ss.alert_max_v, ss.alert_max_thd, ss.alert_max_thd_i
        FROM readings_10m v ${SETTINGS_JOIN}
        WHERE v.bucket >= NOW() - INTERVAL '2 hours' AND v.bucket <= NOW() - INTERVAL '10 minutes'
          AND m.is_active`);
    return writeAlerts(pool, r.rows.flatMap(evaluateTenMinute));
}

/** Completed 30-minute intervals of the last 2 h, and the instantaneous MDI warning. */
export async function checkDemand(pool: Pool): Promise<number> {
    const d = await pool.query(`
        SELECT s.tenant_id, v.meter_id, v.bucket, v.minutes, v.kva_demand, v.kw_demand,
               ss.contracted_mdi_kva, ss.alert_max_kw
        FROM readings_30m v ${SETTINGS_JOIN}
        WHERE v.bucket >= NOW() - INTERVAL '2 hours' AND v.bucket <= NOW() - INTERVAL '30 minutes'
          AND m.is_active AND (ss.contracted_mdi_kva IS NOT NULL OR ss.alert_max_kw IS NOT NULL)`);
    const i = await pool.query(`
        SELECT DISTINCT ON (v.meter_id) s.tenant_id, v.meter_id, v.bucket,
               v.power_apparent_total_max AS kva_max, ss.contracted_mdi_kva
        FROM readings_1m v ${SETTINGS_JOIN}
        WHERE v.bucket >= NOW() - INTERVAL '10 minutes' AND m.is_active AND ss.contracted_mdi_kva IS NOT NULL
          AND v.power_apparent_total_max >= ss.contracted_mdi_kva
        ORDER BY v.meter_id, v.power_apparent_total_max DESC`);
    return writeAlerts(pool, [...d.rows.flatMap(evaluateDemand), ...i.rows.flatMap(evaluateInstantMdi)]);
}

/** pq_events from the last day long enough to alert on. */
export async function checkEvents(pool: Pool, defaultMinS: number): Promise<number> {
    const r = await pool.query(`
        SELECT s.tenant_id, e.meter_id, e.id, e.type, e.channel, e.started_at, e.ended_at,
               e.duration_s, e.extreme_value, e.threshold, ss.event_alert_min_s
        FROM pq_events e
        JOIN meters m ON e.meter_id = m.id
        JOIN sites s ON m.site_id = s.id
        LEFT JOIN site_settings ss ON ss.site_id = s.id
        WHERE e.started_at >= NOW() - INTERVAL '1 day'`);
    return writeAlerts(pool, r.rows.flatMap((row: EventRow) => evaluateEvent(row, defaultMinS)));
}

export interface HealthRow {
    tenant_id: string; meter_id: string; meter_name: string;
    last_reading: Date | string | null;
    hour_samples: number | string | null;      // raw readings in the last full hour
    typical_spacing_s: number | string | null; // median sample spacing over the last day
    drift_s: number | string | null;           // median per-minute freshest |ingested_at − device_time|, last hour
    drift_prev_s: number | string | null;      // same, the hour before
    conflicts: number | string | null;         // duplicate timestamps in the last full hour
    conflicts_prev: number | string | null;
}

/** Data-health alerts for one meter. */
export function evaluateHealth(row: HealthRow, now: Date, silentMinutes: number): AlertCandidate[] {
    const out: AlertCandidate[] = [];
    const base = { tenantId: row.tenant_id, meterId: row.meter_id };
    const last = row.last_reading ? new Date(row.last_reading) : null;
    const lastHour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 3_600_000);

    if (last && now.getTime() - last.getTime() > silentMinutes * 60_000) {
        const mins = Math.round((now.getTime() - last.getTime()) / 60_000);
        out.push({ ...base, type: 'METER_SILENT', severity: 'WARNING',
            // One alert per silence: keyed on the last reading before it.
            dedupeKey: `silent:${last.toISOString()}`,
            message: `${row.meter_name} has sent no readings for ${formatDuration(mins * 60)} (last reading ${last.toISOString().slice(0, 16).replace('T', ' ')} UTC). `
                + `Check the meter's power, network/SIM and MQTT credentials.` });
        return out; // coverage and drift say nothing new about a silent meter
    }

    const samples = num(row.hour_samples), spacing = num(row.typical_spacing_s);
    if (samples !== null && samples > 0 && spacing !== null && spacing > 0) {
        const expected = 3600 / spacing;
        const coverage = samples / expected;
        if (coverage < COVERAGE_MIN && expected >= 10) {
            out.push({ ...base, type: 'LOW_COVERAGE', severity: 'WARNING', dedupeKey: hourKey(lastHour),
                message: `${row.meter_name}: ${(coverage * 100).toFixed(0)}% data coverage in the hour from ${hhmm(lastHour)} UTC `
                    + `(${Math.round(samples)} of about ${Math.round(expected)} readings at its usual ${spacing.toFixed(spacing < 10 ? 1 : 0)} s interval). `
                    + `Gaps reduce the accuracy of demand and compliance figures.` });
        }
    }

    const drift = num(row.drift_s), driftPrev = num(row.drift_prev_s);
    if (drift !== null && (drift > CLOCK_DRIFT_MAX_S || (driftPrev !== null && drift > 30 && drift - driftPrev > 30))) {
        out.push({ ...base, type: 'CLOCK_DRIFT', severity: 'WARNING', dedupeKey: now.toISOString().slice(0, 10),
            message: `${row.meter_name}: the meter clock is ${Math.round(drift)} s off real time (median over the last hour`
                + `${driftPrev !== null ? `, ${Math.round(driftPrev)} s the hour before` : ''}). `
                + `Readings are placed on the timeline by the meter's clock, so they sit that far off; enable NTP on the meter.` });
    }

    const c = num(row.conflicts) ?? 0, cPrev = num(row.conflicts_prev) ?? 0;
    if (c >= 60 && c > 2 * cPrev) {
        out.push({ ...base, type: 'CONFLICTS_RISING', severity: 'WARNING', dedupeKey: hourKey(lastHour),
            message: `${row.meter_name}: ${c} readings in the hour from ${hhmm(lastHour)} UTC were discarded as duplicate timestamps (previous hour: ${cPrev}). `
                + `Expected after a store-and-forward replay; if it keeps rising, the meter clock may be frozen.` });
    }
    return out;
}

export async function checkDataHealth(pool: Pool, silentMinutes: number): Promise<number> {
    const r = await pool.query(`
        WITH active AS (
            SELECT m.id AS meter_id, m.name AS meter_name, s.tenant_id
            FROM meters m JOIN sites s ON m.site_id = s.id
            WHERE m.is_active
        ), last AS (
            SELECT a.meter_id, (SELECT max(time) FROM meter_readings r
                                WHERE r.meter_id = a.meter_id AND r.time >= NOW() - INTERVAL '7 days') AS last_reading
            FROM active a
        ), cover AS (
            SELECT meter_id,
                   SUM(n) FILTER (WHERE bucket = date_trunc('hour', NOW()) - INTERVAL '1 hour') AS hour_samples,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t_last - t_first)) / NULLIF(n - 1, 0))
                       FILTER (WHERE n > 1) AS typical_spacing_s
            FROM readings_1h
            WHERE bucket >= NOW() - INTERVAL '25 hours'
            GROUP BY meter_id
        ), lag AS (
            -- Per ingest minute, the freshest reading's lag. A drifted clock
            -- offsets every reading; a store-and-forward replay only adds old
            -- ones next to prompt ones, so it does not move this figure.
            SELECT meter_id, date_trunc('minute', ingested_at) AS minute,
                   min(abs(extract(epoch FROM ingested_at - device_time))) AS lag_s
            FROM meter_readings
            WHERE time >= NOW() - INTERVAL '2 hours 15 minutes' AND device_time IS NOT NULL
              AND ingested_at >= NOW() - INTERVAL '2 hours'
            GROUP BY 1, 2
        ), drift AS (
            SELECT meter_id,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_s) FILTER (WHERE minute >= NOW() - INTERVAL '1 hour') AS drift_s,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_s) FILTER (WHERE minute <  NOW() - INTERVAL '1 hour') AS drift_prev_s
            FROM lag
            GROUP BY meter_id
        ), conf AS (
            SELECT meter_id,
                   SUM(conflicts) FILTER (WHERE hour = date_trunc('hour', NOW()) - INTERVAL '1 hour') AS conflicts,
                   SUM(conflicts) FILTER (WHERE hour = date_trunc('hour', NOW()) - INTERVAL '2 hours') AS conflicts_prev
            FROM ingest_stats
            WHERE hour >= date_trunc('hour', NOW()) - INTERVAL '2 hours'
            GROUP BY meter_id
        )
        SELECT a.*, l.last_reading, c.hour_samples, c.typical_spacing_s, d.drift_s, d.drift_prev_s, f.conflicts, f.conflicts_prev
        FROM active a
        JOIN last l USING (meter_id)
        LEFT JOIN cover c USING (meter_id)
        LEFT JOIN drift d USING (meter_id)
        LEFT JOIN conf f USING (meter_id)
        -- never-reporting or long-decommissioned meters are not "silent"
        WHERE l.last_reading IS NOT NULL`);
    const now = new Date();
    return writeAlerts(pool, r.rows.flatMap((row: HealthRow) => evaluateHealth(row, now, silentMinutes)));
}

/**
 * THD-I trend for sites WITHOUT a declared limit: p95 of 10-minute values this
 * week vs last week. Information only; no limit is implied.
 */
export async function checkThdITrend(pool: Pool): Promise<number> {
    const r = await pool.query(`
        SELECT s.tenant_id, v.meter_id, m.name AS meter_name,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY v.thd_current_a_avg) FILTER (WHERE v.bucket >= NOW() - INTERVAL '7 days')  AS p95_now,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY v.thd_current_a_avg) FILTER (WHERE v.bucket <  NOW() - INTERVAL '7 days')  AS p95_prev
        FROM readings_10m v ${SETTINGS_JOIN}
        WHERE v.bucket >= NOW() - INTERVAL '14 days' AND m.is_active AND ss.alert_max_thd_i IS NULL
          AND v.thd_current_a_avg IS NOT NULL
        GROUP BY s.tenant_id, v.meter_id, m.name`);
    const week = new Date().toISOString().slice(0, 10);
    const alerts: AlertCandidate[] = [];
    for (const row of r.rows) {
        const now = num(row.p95_now), prev = num(row.p95_prev);
        if (now === null || prev === null || prev <= 0) continue;
        if (now - prev >= 5 && now / prev >= 1.5) {
            alerts.push({ tenantId: row.tenant_id, meterId: row.meter_id, type: 'THD_I_TREND', severity: 'INFO', dedupeKey: week,
                message: `${row.meter_name}: current THD (95th percentile of 10-minute values, phase L1) rose from ${prev.toFixed(1)}% to ${now.toFixed(1)}% week on week. `
                    + `No current-distortion limit is configured for this site, so this is a trend only; set one in site settings for threshold alerts.` });
        }
    }
    return writeAlerts(pool, alerts);
}
