// ─────────────────────────────────────────────────────────────────────────────
// Payload → meter_readings columns.
//
// The mapping is data: each column lists the parameter names that can feed it,
// in priority order (the first one present with a numeric value wins). One
// parameter may feed more than one column (e.g. PF1 is phase A's power factor
// and, when no total is sent, the total's last-resort fallback, as before).
//
// The first 15 columns keep exactly the candidate lists the old chain of `??`
// in mqtt.ts used, so nothing that was stored before changes. The rest are the
// AXM-WEB2 1-second parameters added in Phase 3. Names seen in real payloads
// are in test/fixtures/; firmware that sends anything else shows up in the
// "unknown parameter" log (stats.ts), and the name is then added here.
// ─────────────────────────────────────────────────────────────────────────────

export interface Channel {
    column: string;
    params: readonly string[];
}

export const CHANNELS: readonly Channel[] = [
    // ── Stored since before Phase 3 (candidate lists unchanged) ─────────────
    { column: 'voltage_a',            params: ['V1', 'Va', 'Vavg', 'Vnavg_V', 'V_A', 'Voltage_LN', 'voltage_a'] },
    { column: 'voltage_b',            params: ['V2', 'Vb', 'voltage_b'] },
    { column: 'voltage_c',            params: ['V3', 'Vc', 'voltage_c'] },
    { column: 'current_a',            params: ['I1', 'Ia', 'Iavg', 'Iavg_A', 'I_A', 'Current', 'current_a'] },
    { column: 'current_b',            params: ['I2', 'Ib', 'current_b'] },
    { column: 'current_c',            params: ['I3', 'Ic', 'current_c'] },
    { column: 'power_active_total',   params: ['Psum_kW', 'Psum', 'P_Total', 'Active_Power', 'power_active_total'] },
    { column: 'power_reactive_total', params: ['Qsum_kvar', 'Qsum', 'Q_Total', 'Reactive_Power', 'power_reactive_total'] },
    { column: 'power_apparent_total', params: ['Ssum_kVA', 'Ssum', 'S_Total', 'Apparent_Power', 'power_apparent_total'] },
    { column: 'power_factor_total',   params: ['PF', 'PFavg', 'PF1', 'Power_Factor', 'power_factor_total'] },
    { column: 'frequency',            params: ['Freq_Hz', 'F', 'Freq', 'frequency'] },
    { column: 'energy_import_total',  params: ['Ep_imp', 'kWh', 'energy_import_total'] },
    { column: 'energy_export_total',  params: ['Ep_exp', 'kWh_exp', 'energy_export_total'] },
    { column: 'thd_voltage_a',        params: ['THD_V1', 'THD_Va', 'THD_V', 'thd_voltage_a'] },
    { column: 'thd_current_a',        params: ['THD_I1', 'THD_Ia', 'THD_I', 'thd_current_a'] },

    // ── Phase 3: AXM-WEB2 1-second set ──────────────────────────────────────
    { column: 'voltage_ab',  params: ['V12', 'Vab', 'V_AB', 'voltage_ab'] },
    { column: 'voltage_bc',  params: ['V23', 'Vbc', 'V_BC', 'voltage_bc'] },
    { column: 'voltage_ca',  params: ['V31', 'Vca', 'V_CA', 'voltage_ca'] },
    { column: 'current_n',   params: ['In', 'I4', 'I_N', 'current_n'] },

    { column: 'power_active_a',   params: ['P1', 'Pa', 'P_A', 'power_active_a'] },
    { column: 'power_active_b',   params: ['P2', 'Pb', 'P_B', 'power_active_b'] },
    { column: 'power_active_c',   params: ['P3', 'Pc', 'P_C', 'power_active_c'] },
    { column: 'power_reactive_a', params: ['Q1', 'Qa', 'Q_A', 'power_reactive_a'] },
    { column: 'power_reactive_b', params: ['Q2', 'Qb', 'Q_B', 'power_reactive_b'] },
    { column: 'power_reactive_c', params: ['Q3', 'Qc', 'Q_C', 'power_reactive_c'] },
    { column: 'power_apparent_a', params: ['S1', 'Sa', 'S_A', 'power_apparent_a'] },
    { column: 'power_apparent_b', params: ['S2', 'Sb', 'S_B', 'power_apparent_b'] },
    { column: 'power_apparent_c', params: ['S3', 'Sc', 'S_C', 'power_apparent_c'] },
    { column: 'power_factor_a',   params: ['PF1', 'PFa', 'PF_A', 'power_factor_a'] },
    { column: 'power_factor_b',   params: ['PF2', 'PFb', 'PF_B', 'power_factor_b'] },
    { column: 'power_factor_c',   params: ['PF3', 'PFc', 'PF_C', 'power_factor_c'] },

    { column: 'thd_voltage_b', params: ['THD_V2', 'THD_Vb', 'thd_voltage_b'] },
    { column: 'thd_voltage_c', params: ['THD_V3', 'THD_Vc', 'thd_voltage_c'] },
    { column: 'thd_current_b', params: ['THD_I2', 'THD_Ib', 'thd_current_b'] },
    { column: 'thd_current_c', params: ['THD_I3', 'THD_Ic', 'thd_current_c'] },

    { column: 'voltage_unbalance', params: ['V_unbl', 'U_unbl', 'Vunbal', 'Voltage_Unbalance', 'voltage_unbalance'] },
    { column: 'current_unbalance', params: ['I_unbl', 'Iunbal', 'Current_Unbalance', 'current_unbalance'] },

    { column: 'energy_reactive_import_total', params: ['Eq_imp', 'kvarh', 'kvarh_imp', 'energy_reactive_import_total'] },
    { column: 'energy_reactive_export_total', params: ['Eq_exp', 'kvarh_exp', 'energy_reactive_export_total'] },

    { column: 'demand_active',   params: ['Dmd_P', 'DMD_P', 'Demand_kW', 'demand_active'] },
    { column: 'demand_reactive', params: ['Dmd_Q', 'DMD_Q', 'Demand_kvar', 'demand_reactive'] },
    { column: 'demand_apparent', params: ['Dmd_S', 'DMD_S', 'Demand_kVA', 'demand_apparent'] },
];

/** Every reading column ingest writes, in CHANNELS order. */
export const CHANNEL_COLUMNS: readonly string[] = CHANNELS.map((c) => c.column);

// Device-clock keys: read from the raw (pre-coercion) values, in this order.
const TIMESTAMP_KEYS = ['timestamp', 'Timestamp', 'ts', 'time', 'datetime', 'DateTime', 'Time'] as const;

// Known keys that are not measurements, so they are not reported as unknown.
// Vnavg_V / Iavg_A are averages that only feed phase A as a fallback.
const NON_MEASUREMENT_KEYS = new Set<string>([...TIMESTAMP_KEYS, 'serial', 'name', 'model', 'online', 'unit']);

const KNOWN_PARAMS = new Set<string>(CHANNELS.flatMap((c) => c.params));

/** Numbers, or numeric strings ("243.5" — some firmware sends those). Anything else is null. */
export function toNum(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const n = parseFloat(v.trim());
        return Number.isFinite(n) ? n : null; // also rejects NaN
    }
    return null;
}

export interface ParsedTelemetry {
    /** One entry per CHANNEL_COLUMNS column; null when the payload did not carry it. */
    values: Record<string, number | null>;
    /** The device clock value as sent (before coercion), or null. */
    rawTimestamp: unknown;
    /** Serial number in the payload (AXM-WEB2 device, then gateway), or null. */
    serial: string | null;
    /** Parameter names present in the payload that no channel maps. */
    unknownParams: string[];
}

export class PayloadError extends Error {}

/** Strip null bytes and other control characters that break JSON.parse on some Acuvim firmware. */
export function cleanPayload(buf: Buffer | string): string {
    return buf.toString().trim().replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
}

/**
 * Parses a telemetry message. Two formats:
 *   1. Direct dict:  { V1: 243.5, I1: 45.2, Psum_kW: 12.5, ... }  (optionally under `Data`)
 *   2. AXM-WEB2:     { device: { readings: [{ param: "V1", value: "243.5" }, ...] } }
 * Throws PayloadError for invalid JSON or a payload with no usable measurement.
 */
export function parseTelemetry(text: string): ParsedTelemetry {
    let payload: any;
    try {
        payload = JSON.parse(text);
    } catch (e: any) {
        throw new PayloadError(`JSON parse: ${e.message}`);
    }
    // A JSON scalar ("5", "null") has no parameters: it falls through to the
    // "no recognized parameters" dead-letter below, as before.
    if (payload === null || typeof payload !== 'object') payload = {};

    let raw: Record<string, unknown> = payload.Data ?? payload;
    if (payload.device && Array.isArray(payload.device.readings)) {
        raw = {};
        for (const reading of payload.device.readings) {
            if (reading?.param) raw[reading.param] = reading.value;
        }
    }
    if (raw === null || typeof raw !== 'object') raw = {};

    const values: Record<string, number | null> = {};
    for (const ch of CHANNELS) {
        let v: number | null = null;
        for (const p of ch.params) {
            v = toNum(raw[p]);
            if (v !== null) break;
        }
        values[ch.column] = v;
    }

    // Same requirement as before Phase 3: at least one core measurement.
    if (values.voltage_a === null && values.current_a === null && values.power_active_total === null) {
        throw new PayloadError('No recognized Acuvim parameters in payload');
    }

    // Device clock from the PRE-coercion values: an ISO-8601 timestamp is a
    // string, and coercion would flatten it to null. Order unchanged.
    let rawTimestamp: unknown = null;
    for (const k of TIMESTAMP_KEYS) {
        if (raw[k] !== undefined && raw[k] !== null) { rawTimestamp = raw[k]; break; }
    }
    rawTimestamp = rawTimestamp ?? payload?.timestamp ?? payload?.device?.timestamp ?? payload?.gateway?.timestamp ?? null;

    const serial = payload?.device?.serial ?? payload?.gateway?.serial ?? null;

    const unknownParams = Object.keys(raw).filter((k) => !KNOWN_PARAMS.has(k) && !NON_MEASUREMENT_KEYS.has(k));

    return { values, rawTimestamp, serial: serial === null ? null : String(serial), unknownParams };
}
