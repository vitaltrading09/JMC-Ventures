import mqtt from 'mqtt';
import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point — called once from main.ts after the DB pool is ready
// ─────────────────────────────────────────────────────────────────────────────
export async function initMqtt(pool: Pool) {
    console.log('[MQTT] Initializing Acuvim telemetry listener...');

    // ── Schema bootstrap ───────────────────────────────────────────────────
    const schemaClient = await pool.connect();
    try {
        // CT/PT ratio scaling columns (safe to run every startup)
        await schemaClient.query(`
            ALTER TABLE meters
            ADD COLUMN IF NOT EXISTS ct_ratio NUMERIC DEFAULT 1,
            ADD COLUMN IF NOT EXISTS pt_ratio NUMERIC DEFAULT 1;
        `);

        // Unique index required for idempotent ON CONFLICT inserts.
        // TimescaleDB hypertable unique indexes MUST include the time dimension.
        await schemaClient.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_meter_readings_unique
            ON meter_readings (meter_id, time);
        `);

        // Timestamp provenance. `time` carries the authoritative timestamp used
        // for all analysis; these record where it came from, so a reading's
        // origin is always auditable rather than assumed.
        await schemaClient.query(`
            ALTER TABLE meter_readings
            ADD COLUMN IF NOT EXISTS device_time TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS time_source VARCHAR(10);
        `);

        // Dead-letter table: captures payloads we cannot parse or map
        // so no telemetry is ever silently discarded.
        await schemaClient.query(`
            CREATE TABLE IF NOT EXISTS dead_letter_payloads (
                id          BIGSERIAL PRIMARY KEY,
                received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                topic       TEXT,
                raw_payload TEXT,
                error_msg   TEXT
            );
        `);

        console.log('[MQTT] Schema bootstrap complete.');
    } catch (e) {
        console.error('[MQTT] Schema bootstrap error (non-fatal):', e);
    } finally {
        schemaClient.release();
    }

    // ── Broker connection ──────────────────────────────────────────────────
    // All sensitive values come from environment — never hardcoded.
    // TLS: set MQTT_BROKER_URL=mqtts://host:8883 and optionally MQTT_CA_CERT
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    const mqttUser  = process.env.MQTT_USERNAME   || '';
    const mqttPass  = process.env.MQTT_PASSWORD   || '';

    const connectOptions: mqtt.IClientOptions = {
        username: mqttUser || undefined,
        password: mqttPass || undefined,
        reconnectPeriod: 5_000,
        connectTimeout: 10_000,
    };

    // Optional TLS configuration (mqtts:// scheme)
    if (brokerUrl.startsWith('mqtts')) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const caPath = process.env.MQTT_CA_CERT;
        if (caPath) {
            try {
                connectOptions.ca = fs.readFileSync(caPath);
                console.log('[MQTT] TLS CA certificate loaded.');
            } catch (e) {
                console.error('[MQTT] Cannot read CA certificate at', caPath, e);
            }
        }
        connectOptions.rejectUnauthorized =
            process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false';
    }

    const mqttClient = mqtt.connect(brokerUrl, connectOptions);

    mqttClient.on('connect', () => {
        console.log(`[MQTT] Connected to broker: ${brokerUrl}`);
        mqttClient.subscribe('acuvim/+/telemetry', (err) => {
            if (err) {
                console.error('[MQTT] Subscribe error:', err);
            } else {
                console.log('[MQTT] Subscribed to acuvim/+/telemetry');
            }
        });
    });

    mqttClient.on('reconnect', () => {
        console.warn('[MQTT] Reconnecting to broker...');
    });

    mqttClient.on('error', (err) => {
        console.error('[MQTT] Client error:', err);
    });

    mqttClient.on('offline', () => {
        console.warn('[MQTT] Client is offline.');
    });

    // ── Message handler ────────────────────────────────────────────────────
    mqttClient.on('message', async (topic, messageBuffer) => {
        // Strip null bytes and other non-printable control characters that
        // would break JSON.parse on some Acuvim firmware versions
        const rawPayload = messageBuffer
            .toString()
            .trim()
            .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');

        // Extract meter UUID from topic: acuvim/{meter_id}/telemetry
        const topicParts   = topic.split('/');
        const topicMeterId = topicParts[1] ?? 'unknown';

        console.log(
            `\n[MQTT ${new Date().toISOString()}] topic=${topic}` +
            ` | payload(200)=${rawPayload.slice(0, 200)}`
        );

        // ── JSON parsing ───────────────────────────────────────────────────
        let payload: any;
        try {
            payload = JSON.parse(rawPayload);
        } catch (parseError: any) {
            console.error(`[MQTT] JSON parse error from ${topicMeterId}: ${parseError.message}`);
            await deadLetter(pool, topic, rawPayload, `JSON parse: ${parseError.message}`);
            return;
        }

        // ── Format normalisation ───────────────────────────────────────────
        // Two supported formats:
        //   1. Direct dict:  { V1: 243.5, I1: 45.2, Psum_kW: 12.5, … }
        //   2. AXM-WEB2:     { device: { readings: [{ param:"V1", value:"243.5" }] } }
        let raw: Record<string, unknown> = payload.Data ?? payload;

        if (payload.device && Array.isArray(payload.device.readings)) {
            raw = {};
            for (const reading of payload.device.readings) {
                if (reading?.param) {
                    raw[reading.param] = reading.value;
                }
            }
        }

        // Firmware variants send numeric fields as JSON strings ("243.5") as
        // well as numbers. Only the AXM-WEB2 branch ever parsed them, so a
        // direct-dict meter sending strings reached evaluateAlerts and threw on
        // .toFixed() — readings still inserted, but EVERY alert for that meter
        // was silently skipped. Coerce once here so extraction, alert
        // evaluation and the DB driver all see real numbers.
        const toNum = (v: unknown): number | null => {
            if (typeof v === 'number') return Number.isFinite(v) ? v : null;
            if (typeof v === 'string') {
                const n = parseFloat(v.trim());
                return Number.isFinite(n) ? n : null;   // also rejects NaN
            }
            return null;
        };

        const data: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(raw)) data[k] = toNum(v);

        // Read the device clock from the PRE-coercion values: an ISO-8601
        // timestamp is a string, and coercion would have flattened it to null.
        const rawTimestamp =
            raw.timestamp ?? raw.Timestamp ?? raw.ts   ?? raw.time ??
            raw.datetime  ?? raw.DateTime  ?? raw.Time ??
            payload?.timestamp ?? payload?.device?.timestamp ?? payload?.gateway?.timestamp ?? null;

        const stamp = resolveReadingTime(rawTimestamp);

        // ── Parameter extraction (Acuvim II key variants) ──────────────────
        const v_a     = data.V1        ?? data.Va          ?? data.Vavg        ?? data.Vnavg_V     ?? data.V_A            ?? data.Voltage_LN          ?? data.voltage_a          ?? null;
        const v_b     = data.V2        ?? data.Vb          ?? data.voltage_b                                                                                               ?? null;
        const v_c     = data.V3        ?? data.Vc          ?? data.voltage_c                                                                                               ?? null;
        const i_a     = data.I1        ?? data.Ia          ?? data.Iavg        ?? data.Iavg_A      ?? data.I_A            ?? data.Current             ?? data.current_a          ?? null;
        const i_b     = data.I2        ?? data.Ib          ?? data.current_b                                                                                               ?? null;
        const i_c     = data.I3        ?? data.Ic          ?? data.current_c                                                                                               ?? null;
        const p_total = data.Psum_kW   ?? data.Psum        ?? data.P_Total     ?? data.Active_Power   ?? data.power_active_total   ?? null;
        const q_total = data.Qsum_kvar ?? data.Qsum        ?? data.Q_Total     ?? data.Reactive_Power ?? data.power_reactive_total ?? null;
        const s_total = data.Ssum_kVA  ?? data.Ssum        ?? data.S_Total     ?? data.Apparent_Power ?? data.power_apparent_total ?? null;
        const pf      = data.PF        ?? data.PFavg       ?? data.PF1         ?? data.Power_Factor   ?? data.power_factor_total   ?? null;
        const freq    = data.Freq_Hz   ?? data.F           ?? data.Freq        ?? data.frequency            ?? null;
        const energy  = data.Ep_imp    ?? data.kWh         ?? data.energy_import_total                         ?? null;
        const thd_v   = data.THD_V1    ?? data.THD_Va      ?? data.THD_V       ?? data.thd_voltage_a                               ?? null;
        const thd_i   = data.THD_I1    ?? data.THD_Ia      ?? data.THD_I       ?? data.thd_current_a                               ?? null;

        // Require at least one meaningful electrical parameter
        if (v_a === null && i_a === null && p_total === null) {
            console.warn(`[MQTT] No recognized parameters in payload from ${topicMeterId}`);
            await deadLetter(pool, topic, rawPayload, 'No recognized Acuvim parameters in payload');
            return;
        }

        // ── Meter ID resolution ────────────────────────────────────────────
        // Match by MQTT topic UUID first, then by serial number from device
        const serial = payload?.device?.serial ?? payload?.gateway?.serial ?? null;

        const dbClient = await pool.connect();
        try {
            const lookupRes = await dbClient.query<{
                id: string;
                tenant_id: string;
                alert_max_kw:       number | null;
                alert_min_v:        number | null;
                alert_max_v:        number | null;
                alert_max_thd:      number | null;
                alert_min_freq:     number | null;
                alert_max_freq:     number | null;
                contracted_mdi_kva: number | null;
            }>(`
                SELECT
                    m.id,
                    s.tenant_id,
                    ss.alert_max_kw,
                    ss.alert_min_v,
                    ss.alert_max_v,
                    ss.alert_max_thd,
                    ss.alert_min_freq,
                    ss.alert_max_freq,
                    ss.contracted_mdi_kva
                FROM meters m
                JOIN sites s ON m.site_id = s.id
                LEFT JOIN site_settings ss ON s.id = ss.site_id
                WHERE m.id::text = $1
                   OR (m.serial_number = $2 AND m.serial_number IS NOT NULL)
                LIMIT 1
            `, [topicMeterId, serial]);

            if (lookupRes.rows.length === 0) {
                console.warn(
                    `[MQTT] No meter found — topic-ID: "${topicMeterId}", serial: "${serial}" — discarding`
                );
                return;
            }

            const meter    = lookupRes.rows[0];
            const actualId = meter.id;

            // ── Idempotent insert ──────────────────────────────────────────
            // ON CONFLICT (meter_id, time) DO NOTHING prevents duplicate rows
            // if the AXM-WEB2 store-and-forward replays the same packet after
            // an internet outage.
            const ins = await dbClient.query(`
                INSERT INTO meter_readings (
                    time,       meter_id,
                    voltage_a,  voltage_b,  voltage_c,
                    current_a,  current_b,  current_c,
                    power_active_total,   power_reactive_total,   power_apparent_total,
                    power_factor_total,   frequency,
                    energy_import_total,  thd_voltage_a,  thd_current_a,
                    device_time, ingested_at, time_source
                ) VALUES (
                    $1,  $2,
                    $3,  $4,  $5,
                    $6,  $7,  $8,
                    $9,  $10, $11,
                    $12, $13,
                    $14, $15, $16,
                    $17, NOW(), $18
                )
                ON CONFLICT (meter_id, time) DO NOTHING
                RETURNING time
            `, [
                stamp.time, actualId,
                v_a,  v_b,  v_c,
                i_a,  i_b,  i_c,
                p_total, q_total, s_total,
                pf,   freq,
                energy, thd_v, thd_i,
                stamp.deviceTime, stamp.source,
            ]);

            // No row back means the timestamp already existed. Legitimate for a
            // replayed packet; a rising count points at a stalled meter clock.
            if (ins.rowCount === 0) noteConflict(actualId);

            console.log(
                `[MQTT ✓] ${actualId} | t=${stamp.time.toISOString()} (${stamp.source}${stamp.reason ? `: ${stamp.reason}` : ''})` +
                ` | Va: ${v_a} Vb: ${v_b} Vc: ${v_c} V` +
                ` | Ia: ${i_a} Ib: ${i_b} Ic: ${i_c} A` +
                ` | P: ${p_total} kW | Q: ${q_total} kvar` +
                ` | PF: ${pf} | THD_V: ${thd_v}% | THD_I: ${thd_i}% | E: ${energy} kWh`
            );

            // ── Alert threshold evaluation ─────────────────────────────────
            // NRS 048-2 South African grid voltage quality standards (used as
            // defaults when site_settings thresholds are not configured).
            await evaluateAlerts(dbClient, {
                meterId:        actualId,
                tenantId:       meter.tenant_id,
                power:          p_total as number | null,
                apparent:       s_total as number | null,
                voltage:        v_a     as number | null,
                thd:            thd_v   as number | null,
                freq:           freq    as number | null,
                // These are DECIMAL columns, which node-postgres returns as
                // STRINGS. Comparisons happened to work through JS coercion, but
                // the values must be real numbers before they reach any
                // arithmetic or .toFixed() in the message text.
                maxKw:          toNum(meter.alert_max_kw),
                minV:           toNum(meter.alert_min_v)        ?? 207,   // NRS 048: 230V − 10%
                maxV:           toNum(meter.alert_max_v)        ?? 253,   // NRS 048: 230V + 10%
                maxThd:         toNum(meter.alert_max_thd)      ?? 8.0,   // NRS 048-2 THD limit
                minFreq:        toNum(meter.alert_min_freq)     ?? 49.0,  // NRS 048: 50Hz − 2%
                maxFreq:        toNum(meter.alert_max_freq)     ?? 51.0,  // NRS 048: 50Hz + 2%
                contractedMdi:  toNum(meter.contracted_mdi_kva),
            });

        } catch (dbErr) {
            console.error(`[MQTT] DB error processing reading for ${topicMeterId}:`, dbErr);
        } finally {
            dbClient.release();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading timestamp resolution
//
// The device's own clock is preferred. AXM-WEB2 store-and-forward buffers
// telemetry through an internet outage and replays it on reconnect; stamping
// that batch with arrival time collapses hours of history into a burst at the
// wrong point on the timeline, and defeats the ON CONFLICT (meter_id, time)
// guard because every replayed packet looks new.
//
// But an unsynchronised meter clock is worse than no clock at all, so a device
// value is only trusted inside a sanity window. Outside it we fall back to
// arrival time and record which was used — the report is evidence, so the
// provenance of every timestamp has to be answerable.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BACKFILL_DAYS  = 30;       // store-and-forward buffers hold hours, not weeks
const MAX_CLOCK_SKEW_MS  = 120_000;  // tolerate 2 min of forward drift

export function parseDeviceTime(v: unknown): Date | null {
    if (v === null || v === undefined) return null;

    // Epoch value, as a number or a digit string
    if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,14}$/.test(v.trim()))) {
        const n = typeof v === 'number' ? v : parseInt(v.trim(), 10);
        if (!Number.isFinite(n) || n <= 0) return null;
        // Below 1e11 the value cannot plausibly be milliseconds (that would be
        // 1973), so treat it as seconds.
        const d = new Date(n < 1e11 ? n * 1000 : n);
        return isNaN(d.getTime()) ? null : d;
    }

    // ISO-8601 or any other Date-parseable string
    if (typeof v === 'string' && v.trim() !== '') {
        const d = new Date(v.trim());
        return isNaN(d.getTime()) ? null : d;
    }

    return null;
}

export function resolveReadingTime(rawTs: unknown, now: number = Date.now()): {
    time: Date; deviceTime: Date | null; source: 'DEVICE' | 'ARRIVAL'; reason?: string;
} {
    const parsed = parseDeviceTime(rawTs);
    if (parsed === null) {
        return { time: new Date(now), deviceTime: null, source: 'ARRIVAL', reason: 'no device timestamp' };
    }

    const ms = parsed.getTime();
    if (ms < now - MAX_BACKFILL_DAYS * 86_400_000) {
        return { time: new Date(now), deviceTime: parsed, source: 'ARRIVAL', reason: 'device clock too far behind' };
    }
    if (ms > now + MAX_CLOCK_SKEW_MS) {
        return { time: new Date(now), deviceTime: parsed, source: 'ARRIVAL', reason: 'device clock ahead of real time' };
    }
    return { time: parsed, deviceTime: parsed, source: 'DEVICE' };
}

// A meter whose clock is frozen would emit the same timestamp forever, and
// ON CONFLICT would silently discard everything after the first reading. Count
// conflicts per meter and warn, so silent data loss cannot go unnoticed.
const conflictCounts = new Map<string, number>();
function noteConflict(meterId: string): void {
    const n = (conflictCounts.get(meterId) ?? 0) + 1;
    conflictCounts.set(meterId, n);
    // Powers of ten keep the log readable while still escalating visibly.
    if (n === 10 || n === 100 || n === 1_000 || n % 10_000 === 0) {
        console.warn(
            `[MQTT] ${meterId}: ${n} readings dropped as duplicate timestamps. ` +
            `Expected after a store-and-forward replay; if it keeps climbing the meter clock is likely frozen.`
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert threshold evaluation
// Mirrors the BullMQ worker logic to keep threshold behaviour consistent.
// Deduplicates: at most 1 alert of the same type per meter per hour.
// ─────────────────────────────────────────────────────────────────────────────
interface AlertParams {
    meterId:       string;
    tenantId:      string;
    power:         number | null;
    apparent:      number | null;
    voltage:       number | null;
    thd:           number | null;
    freq:          number | null;
    maxKw:         number | null;
    minV:          number;        // NRS 048 default applied before call
    maxV:          number;        // NRS 048 default applied before call
    maxThd:        number;        // NRS 048 default applied before call
    minFreq:       number;        // NRS 048 default applied before call
    maxFreq:       number;        // NRS 048 default applied before call
    contractedMdi: number | null;
}

async function evaluateAlerts(client: any, p: AlertParams): Promise<void> {
    // ── Max demand (kW) ────────────────────────────────────────────────────────
    if (p.maxKw !== null && p.power !== null && p.power > Number(p.maxKw)) {
        await maybeInsertAlert(
            client, p.tenantId, p.meterId,
            'PEAK_DEMAND', 'WARNING',
            `Peak demand exceeded: ${p.power.toFixed(1)} kW (limit: ${p.maxKw} kW) — demand charge risk`
        );
    }

    // ── Contracted MDI (kVA) ───────────────────────────────────────────────────
    if (p.contractedMdi !== null && p.apparent !== null) {
        const pct = (p.apparent / Number(p.contractedMdi)) * 100;
        if (pct >= 100) {
            await maybeInsertAlert(
                client, p.tenantId, p.meterId,
                'MDI_EXCEEDED', 'CRITICAL',
                `Contracted MDI exceeded: ${p.apparent.toFixed(1)} kVA (contracted: ${p.contractedMdi} kVA / ${pct.toFixed(0)}%) — tariff penalty will apply`
            );
        } else if (pct >= 90) {
            await maybeInsertAlert(
                client, p.tenantId, p.meterId,
                'MDI_WARNING', 'WARNING',
                `Approaching contracted MDI: ${p.apparent.toFixed(1)} kVA = ${pct.toFixed(0)}% of ${p.contractedMdi} kVA limit`
            );
        }
    }

    // ── Voltage sag — NRS 048-2 Category A lower limit ────────────────────────
    if (p.voltage !== null && p.voltage < p.minV) {
        await maybeInsertAlert(
            client, p.tenantId, p.meterId,
            'VOLTAGE_SAG', 'CRITICAL',
            `Voltage sag: ${p.voltage.toFixed(1)} V L1 (NRS 048 min: ${p.minV} V) — equipment damage risk`
        );
    }

    // ── Overvoltage — NRS 048-2 Category A upper limit ────────────────────────
    if (p.voltage !== null && p.voltage > p.maxV) {
        await maybeInsertAlert(
            client, p.tenantId, p.meterId,
            'OVERVOLTAGE', 'CRITICAL',
            `Overvoltage: ${p.voltage.toFixed(1)} V L1 (NRS 048 max: ${p.maxV} V) — insulation and equipment risk`
        );
    }

    // ── Voltage THD — NRS 048-2 limit ─────────────────────────────────────────
    if (p.thd !== null && p.thd > p.maxThd) {
        await maybeInsertAlert(
            client, p.tenantId, p.meterId,
            'HIGH_THD', 'WARNING',
            `Voltage THD: ${p.thd.toFixed(2)}% (NRS 048 limit: ${p.maxThd}%) — harmonic distortion affecting equipment`
        );
    }

    // ── Frequency out of range — NRS 048 statutory limits ─────────────────────
    if (p.freq !== null && (p.freq < p.minFreq || p.freq > p.maxFreq)) {
        await maybeInsertAlert(
            client, p.tenantId, p.meterId,
            'FREQUENCY_DEVIATION', 'WARNING',
            `Frequency deviation: ${p.freq.toFixed(2)} Hz (NRS 048 range: ${p.minFreq}–${p.maxFreq} Hz)`
        );
    }
}

async function maybeInsertAlert(
    client: any,
    tenantId: string,
    meterId: string,
    type: string,
    severity: string,
    message: string
): Promise<void> {
    // One alert of this type per meter per hour to prevent notification floods
    const recent = await client.query(`
        SELECT id FROM alerts
        WHERE meter_id  = $1
          AND type      = $2
          AND created_at >= NOW() - INTERVAL '1 hour'
        LIMIT 1
    `, [meterId, type]);

    if (recent.rows.length === 0) {
        await client.query(`
            INSERT INTO alerts (tenant_id, meter_id, type, severity, message)
            VALUES ($1, $2, $3, $4, $5)
        `, [tenantId, meterId, type, severity, message]);
        console.log(`[MQTT ALERT] ${type} (${severity}) → meter ${meterId}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dead-letter store
// Any payload that cannot be parsed or lacks known parameters is written here
// instead of being silently dropped. Inspect dead_letter_payloads to diagnose
// firmware mismatches or misconfigured meters.
// ─────────────────────────────────────────────────────────────────────────────
async function deadLetter(
    pool: Pool,
    topic: string,
    rawPayload: string,
    errorMsg: string
): Promise<void> {
    try {
        const client = await pool.connect();
        try {
            await client.query(`
                INSERT INTO dead_letter_payloads (topic, raw_payload, error_msg)
                VALUES ($1, $2, $3)
            `, [topic, rawPayload.slice(0, 4_096), errorMsg]);
        } finally {
            client.release();
        }
    } catch (e) {
        // Swallow — dead-letter failures must never crash the main message loop
        console.error('[MQTT] Dead-letter insert failed:', e);
    }
}
