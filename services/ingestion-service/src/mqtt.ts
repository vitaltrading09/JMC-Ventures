import mqtt from 'mqtt';
import { Pool } from 'pg';
import { MAX_BACKFILL_DAYS } from '@gridiq/db';
import { CHANNEL_COLUMNS, cleanPayload, parseTelemetry, PayloadError } from './ingest/channels';
import { BatchWriter, QueuedRow } from './ingest/batch-writer';
import { installAckGate } from './ingest/ack-gate';
import { MeterCache } from './ingest/meter-cache';
import { EventDetector, PqEvent, UPSERT_PQ_EVENT, pqEventParams } from './ingest/event-detector';
import { IngestStats } from './ingest/stats';

// ─────────────────────────────────────────────────────────────────────────────
// MQTT → meter_readings (ingest role).
//
//   broker ──QoS 1, persistent session──▶ parse ─▶ meter cache ─▶ batch writer
//                                                                    │ commit
//                                       PUBACK released ◀────────────┤
//                                       event detector ◀─────────────┘
//
// - Durable: clientId MQTT_CLIENT_ID (default gridiq-ingest), clean: false,
//   QoS 1 subscription. A message's PUBACK is sent only after the batch that
//   wrote it commits (ingest/ack-gate.ts). On a DB failure nothing is acked
//   and the writer retries; if ingest dies, the broker redelivers.
// - Batched: one multi-row INSERT ... ON CONFLICT DO NOTHING per flush
//   (INGEST_FLUSH_MS / INGEST_FLUSH_ROWS), bounded queue (INGEST_MAX_QUEUE)
//   with backpressure instead of dropping (ingest/batch-writer.ts).
// - No per-message queries: meters come from an in-memory cache, unknown
//   meters are dead-lettered. Alert evaluation is no longer done here (Phase 4
//   moves it to aggregates); ingest only writes readings and feeds the
//   in-memory event detector (pq_events).
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestRuntime {
    client: mqtt.MqttClient;
    health(): { ok: boolean; [k: string]: unknown };
    /** Stop taking messages, flush and ack what is queued, disconnect. */
    shutdown(): Promise<void>;
}

const envInt = (name: string, def: number) => {
    const n = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : def;
};

export async function initMqtt(pool: Pool): Promise<IngestRuntime> {
    console.log('[MQTT] Initializing Acuvim telemetry listener...');

    const logMessages = process.env.INGEST_LOG_MESSAGES === 'true';
    const stats = new IngestStats();
    const detector = new EventDetector({ minSeconds: envInt('EVENT_MIN_SECONDS', 3) });
    const meters = new MeterCache(pool);
    await meters.refresh();
    meters.start();
    stats.start();
    console.log(`[MQTT] Meter cache loaded: ${meters.size} meter(s)`);

    // Rolling numbers for the once-a-minute summary.
    let windowRows = 0, windowConflicts = 0, windowDeadLetters = 0;
    let windowLatencies: number[] = [];

    // Per-meter counters persisted to ingest_stats once a minute: the jobs
    // role alerts on rising duplicate-timestamp counts, which only ingest sees.
    let perMeter = new Map<string, { rows: number; conflicts: number }>();
    const count = (meterId: string, field: 'rows' | 'conflicts') => {
        const c = perMeter.get(meterId) ?? { rows: 0, conflicts: 0 };
        c[field]++;
        perMeter.set(meterId, c);
    };
    const flushCounters = async () => {
        if (perMeter.size === 0) return;
        const batch = perMeter;
        perMeter = new Map();
        try {
            for (const [meterId, c] of batch) {
                await pool.query(`
                    INSERT INTO ingest_stats (meter_id, hour, rows_written, conflicts)
                    VALUES ($1, date_trunc('hour', NOW()), $2, $3)
                    ON CONFLICT (meter_id, hour) DO UPDATE SET
                        rows_written = ingest_stats.rows_written + EXCLUDED.rows_written,
                        conflicts    = ingest_stats.conflicts + EXCLUDED.conflicts`,
                    [meterId, c.rows, c.conflicts]);
            }
        } catch (e: any) {
            // Observability only: never let it affect ingestion. Counts are lost, not retried.
            console.error('[ingest] ingest_stats write failed:', e?.message || e);
        }
    };
    const countersTimer = setInterval(() => { void flushCounters(); }, 60_000);
    countersTimer.unref();

    const writer = new BatchWriter({
        db: pool,
        columns: CHANNEL_COLUMNS,
        flushMs: envInt('INGEST_FLUSH_MS', 1000),
        flushRows: envInt('INGEST_FLUSH_ROWS', 500),
        maxQueue: envInt('INGEST_MAX_QUEUE', 50_000),
        onConflict: (meterId) => {
            noteConflict(meterId);
            count(meterId, 'conflicts');
        },
        onCommitted: (inserted, info) => {
            const now = Date.now();
            for (const row of inserted) count(row.meterId, 'rows');
            windowRows += info.inserted;
            windowConflicts += info.conflicts;
            for (const row of inserted) windowLatencies.push(now - row.receivedAt);
            const events: PqEvent[] = [];
            for (const row of inserted) {
                const m = meters.peek(row.meterId);
                if (m) events.push(...detector.feed(row.meterId, row.time, row.values, m.thresholds));
            }
            for (const e of events) {
                pool.query(UPSERT_PQ_EVENT, pqEventParams(e)).catch((err) =>
                    console.error(`[ingest] pq_event ${e.type} ${e.meterId} not written:`, err?.message || err));
            }
        },
    });
    writer.start();

    const summary = setInterval(() => {
        if (windowRows + windowConflicts + windowDeadLetters === 0 && writer.size === 0) return;
        windowLatencies.sort((a, b) => a - b);
        const p95 = windowLatencies.length ? windowLatencies[Math.floor(windowLatencies.length * 0.95)] : 0;
        console.log(
            `[ingest] last 60 s: ${windowRows} rows, ${windowConflicts} conflicts, ${windowDeadLetters} dead letters, ` +
            `receive→commit p95 ${p95} ms, queue ${writer.size}`
        );
        windowRows = 0; windowConflicts = 0; windowDeadLetters = 0; windowLatencies = [];
    }, 60_000);
    summary.unref();

    // ── Broker connection ──────────────────────────────────────────────────
    // All sensitive values come from environment — never hardcoded.
    // TLS: set MQTT_BROKER_URL=mqtts://host:8883 and optionally MQTT_CA_CERT
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    const mqttUser  = process.env.MQTT_USERNAME   || '';
    const mqttPass  = process.env.MQTT_PASSWORD   || '';

    const connectOptions: mqtt.IClientOptions = {
        username: mqttUser || undefined,
        password: mqttPass || undefined,
        // Persistent session: the broker keeps the subscription and queues
        // QoS 1 messages while ingest is down (mosquitto max_queued_messages).
        clientId: process.env.MQTT_CLIENT_ID || 'gridiq-ingest',
        clean: false,
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

    // manualConnect: the message handler and ack gate must be in place before
    // the persistent session starts delivering its queued messages.
    const mqttClient = mqtt.connect(brokerUrl, { ...connectOptions, manualConnect: true });
    const gate = installAckGate(mqttClient as any);
    let closing = false;

    mqttClient.on('connect', (connack) => {
        console.log(`[MQTT] Connected to broker: ${brokerUrl} (session present: ${!!connack?.sessionPresent})`);
        mqttClient.subscribe('acuvim/+/telemetry', { qos: 1 }, (err) => {
            if (err) {
                console.error('[MQTT] Subscribe error:', err);
            } else {
                console.log('[MQTT] Subscribed to acuvim/+/telemetry (QoS 1)');
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
    // mqtt.js calls this once per incoming PUBLISH and waits for `callback`
    // before reading the next packet. The callback is delayed only while the
    // writer's queue is full (backpressure). The PUBACK itself waits for the
    // commit through the ack gate.
    (mqttClient as any).handleMessage = (packet: any, callback: (err?: Error) => void) => {
        if (closing) return; // not acked: the broker redelivers after restart
        const messageId: number | undefined = packet.qos > 0 ? packet.messageId : undefined;
        if (messageId !== undefined) gate.hold(messageId);
        const ack = messageId !== undefined ? () => gate.release(messageId) : () => {};

        handleTelemetry(packet.topic, packet.payload as Buffer, ack)
            .then(() => writer.whenNotFull())
            .then(() => callback(), (e) => {
                // Unexpected: log, leave the message unacked, keep the loop alive.
                console.error('[MQTT] Message handling failed:', e);
                callback();
            });
    };

    async function handleTelemetry(topic: string, payloadBuf: Buffer, ack: () => void): Promise<void> {
        const receivedAt = Date.now();
        const rawPayload = cleanPayload(payloadBuf);

        // Extract meter UUID from topic: acuvim/{meter_id}/telemetry
        const topicMeterId = topic.split('/')[1] ?? 'unknown';
        stats.notePayload(topicMeterId, payloadBuf.length);

        if (logMessages) {
            console.log(`[MQTT ${new Date().toISOString()}] topic=${topic} | payload(200)=${rawPayload.slice(0, 200)}`);
        }

        let parsed;
        try {
            parsed = parseTelemetry(rawPayload);
        } catch (e) {
            if (!(e instanceof PayloadError)) throw e;
            console.warn(`[MQTT] ${topicMeterId}: ${e.message}`);
            windowDeadLetters++;
            await deadLetterDurable(pool, topic, rawPayload, e.message, () => closing);
            ack();
            return;
        }

        const meter = await meters.lookup(topicMeterId, parsed.serial);
        if (!meter) {
            console.warn(`[MQTT] No meter found — topic-ID: "${topicMeterId}", serial: "${parsed.serial}" — dead-lettered`);
            windowDeadLetters++;
            await deadLetterDurable(pool, topic, rawPayload, 'unknown meter', () => closing);
            ack();
            return;
        }
        stats.noteUnknownParams(meter.id, parsed.unknownParams);

        const stamp = resolveReadingTime(parsed.rawTimestamp);
        const row: QueuedRow = {
            meterId: meter.id,
            time: stamp.time,
            deviceTime: stamp.deviceTime,
            source: stamp.source,
            values: parsed.values,
            ack,
            receivedAt,
        };
        writer.enqueue(row);

        if (logMessages) {
            const v = parsed.values;
            console.log(
                `[MQTT queued] ${meter.id} | t=${stamp.time.toISOString()} (${stamp.source}${stamp.reason ? `: ${stamp.reason}` : ''})` +
                ` | Va: ${v.voltage_a} Vb: ${v.voltage_b} Vc: ${v.voltage_c} V | P: ${v.power_active_total} kW`
            );
        }
    }

    mqttClient.connect();

    return {
        client: mqttClient,
        health() {
            const connected = mqttClient.connected;
            // Rows waiting and no successful flush for a minute: the DB path is stuck.
            const stalled = writer.size > 0 && Date.now() - writer.lastSuccessAt > 60_000;
            return {
                ok: connected && !stalled,
                mqtt: connected ? 'connected' : 'disconnected',
                queue: writer.size,
                unacked: gate.pending,
                lastFlushAgoMs: Date.now() - writer.lastSuccessAt,
                ...(writer.lastError ? { lastError: writer.lastError } : {}),
            };
        },
        async shutdown() {
            closing = true;
            meters.stop();
            stats.stop();
            writer.stop();
            const drained = await writer.drain(20_000);
            clearInterval(countersTimer);
            await flushCounters();
            console.log(drained
                ? `[MQTT] Shutdown: queue flushed and acked (${writer.totals.inserted} rows written this run)`
                : `[MQTT] Shutdown: ${writer.size} row(s) not flushed; left unacked, the broker redelivers them`);
            await new Promise<void>((resolve) => mqttClient.end(false, {}, () => resolve()));
        },
    };
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

// Store-and-forward buffers hold hours, not weeks. MAX_BACKFILL_DAYS (30,
// imported from @gridiq/db) is also a hard constraint on the meter_readings
// compression policy: compression must start strictly LATER than this,
// because TimescaleDB does not enforce unique indexes on compressed chunks and
// a backfilled reading landing in one would bypass the ON CONFLICT guard and
// silently duplicate. Both values live in packages/db/index.js, and
// packages/db/test/constants.test.js fails if compression <= backfill.
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
): Promise<boolean> {
    try {
        const client = await pool.connect();
        try {
            await client.query(`
                INSERT INTO dead_letter_payloads (topic, raw_payload, error_msg)
                VALUES ($1, $2, $3)
            `, [topic, rawPayload.slice(0, 4_096), errorMsg]);
            return true;
        } finally {
            client.release();
        }
    } catch (e) {
        // Swallow — dead-letter failures must never crash the main message loop
        console.error('[MQTT] Dead-letter insert failed:', e);
        return false;
    }
}

// The message is only acked once its dead letter is written. While the DB is
// down this retries (and, by holding up the message loop, applies
// backpressure). On shutdown it gives up; the unacked message is redelivered.
async function deadLetterDurable(
    pool: Pool, topic: string, rawPayload: string, errorMsg: string, closing: () => boolean,
): Promise<void> {
    let delay = 1_000;
    while (!(await deadLetter(pool, topic, rawPayload, errorMsg))) {
        if (closing()) throw new Error('shutting down before the dead letter was written');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
    }
}
