// ─────────────────────────────────────────────────────────────────────────────
// In-memory power-quality event detector (ingest role).
//
// Per meter and channel it tracks excursions beyond the configured thresholds:
// each L-N voltage below min / above max, and frequency out of band. An event
// row (pq_events) is emitted:
//   - when an excursion has lasted >= minSeconds and is still ongoing
//     (ended_at null), and updated with the final figures when it ends;
//   - when an excursion ends, if it was not emitted as ongoing.
//
// LIMITATION: this sees 1-second telemetry only. It cannot resolve sub-second
// dips, swells or interruptions: a 100 ms dip either lands in one sample or
// is missed entirely. Those need the meter's own event log or waveform capture.
//
// Samples are taken in timestamp order per channel; a sample older than the
// last one seen (e.g. part of a store-and-forward replay interleaved with live
// data) is ignored for detection, and a gap longer than maxGapSeconds closes an
// open excursion at its last sample, since nothing is known about the gap.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'crypto';

export type EventType = 'UNDERVOLTAGE' | 'OVERVOLTAGE' | 'UNDERFREQUENCY' | 'OVERFREQUENCY';

export interface PqEvent {
    id: string;
    meterId: string;
    type: EventType;
    channel: string;
    startedAt: Date;
    endedAt: Date | null;
    durationS: number;
    extremeValue: number;
    threshold: number;
    samples: number;
}

export interface Thresholds {
    minV: number;
    maxV: number;
    minFreq: number;
    maxFreq: number;
}

interface Excursion {
    id: string;
    type: EventType;
    threshold: number;
    startedAt: Date;
    lastAt: Date;
    extreme: number;
    samples: number;
    emittedOngoing: boolean;
}

interface ChannelState {
    lastAt: number;
    open: Excursion | null;
}

const VOLTAGE_CHANNELS = ['voltage_a', 'voltage_b', 'voltage_c'] as const;

export class EventDetector {
    private readonly minSeconds: number;
    private readonly maxGapSeconds: number;
    private state = new Map<string, ChannelState>();

    constructor(opts: { minSeconds?: number; maxGapSeconds?: number } = {}) {
        this.minSeconds = opts.minSeconds ?? 3;
        this.maxGapSeconds = opts.maxGapSeconds ?? 60;
    }

    /** Feed one committed reading. Returns the events to write (inserts or updates by id). */
    feed(meterId: string, time: Date, values: Record<string, number | null>, t: Thresholds): PqEvent[] {
        const out: PqEvent[] = [];
        for (const ch of VOLTAGE_CHANNELS) {
            this.step(out, meterId, ch, time, values[ch], t.minV, t.maxV, 'UNDERVOLTAGE', 'OVERVOLTAGE');
        }
        this.step(out, meterId, 'frequency', time, values.frequency, t.minFreq, t.maxFreq, 'UNDERFREQUENCY', 'OVERFREQUENCY');
        return out;
    }

    /** Excursions currently open (for shutdown / tests). */
    get openCount(): number {
        let n = 0;
        for (const s of this.state.values()) if (s.open) n++;
        return n;
    }

    private step(
        out: PqEvent[], meterId: string, channel: string, time: Date, value: number | null | undefined,
        min: number, max: number, lowType: EventType, highType: EventType,
    ): void {
        if (value === null || value === undefined || !Number.isFinite(value)) return;
        const k = `${meterId}|${channel}`;
        let s = this.state.get(k);
        if (!s) {
            s = { lastAt: -Infinity, open: null };
            this.state.set(k, s);
        }
        const ms = time.getTime();
        if (ms <= s.lastAt) return; // out of order: ignored for detection

        // A long silence: close what was open at its last sample.
        if (s.open && (ms - s.open.lastAt.getTime()) / 1000 > this.maxGapSeconds) {
            out.push(this.close(meterId, channel, s.open));
            s.open = null;
        }
        s.lastAt = ms;

        const type: EventType | null = value < min ? lowType : value > max ? highType : null;

        if (s.open && s.open.type !== type) {
            // Back in band, or jumped straight to the other side: the excursion ends here.
            out.push(this.close(meterId, channel, s.open, time));
            s.open = null;
        }
        if (type === null) return;

        if (!s.open) {
            s.open = {
                id: randomUUID(), type, threshold: type === lowType ? min : max,
                startedAt: time, lastAt: time, extreme: value, samples: 1, emittedOngoing: false,
            };
        } else {
            s.open.lastAt = time;
            s.open.samples++;
            s.open.extreme = type === lowType ? Math.min(s.open.extreme, value) : Math.max(s.open.extreme, value);
        }

        const lasted = (s.open.lastAt.getTime() - s.open.startedAt.getTime()) / 1000;
        if (!s.open.emittedOngoing && lasted >= this.minSeconds) {
            s.open.emittedOngoing = true;
            out.push(this.toEvent(meterId, channel, s.open, null));
        }
    }

    /**
     * Ends an excursion. `endedAt` is the first in-band sample; with no such
     * sample (a gap), the last out-of-band one.
     */
    private close(meterId: string, channel: string, e: Excursion, endedAt: Date = e.lastAt): PqEvent {
        return this.toEvent(meterId, channel, e, endedAt);
    }

    private toEvent(meterId: string, channel: string, e: Excursion, endedAt: Date | null): PqEvent {
        const end = endedAt ?? e.lastAt;
        return {
            id: e.id,
            meterId,
            type: e.type,
            channel,
            startedAt: e.startedAt,
            endedAt,
            durationS: Math.max(0, (end.getTime() - e.startedAt.getTime()) / 1000),
            extremeValue: e.extreme,
            threshold: e.threshold,
            samples: e.samples,
        };
    }
}

/** Upsert for an emitted event (insert when new, update when an ongoing one ends). */
export const UPSERT_PQ_EVENT = `
    INSERT INTO pq_events (id, meter_id, type, channel, started_at, ended_at, duration_s, extreme_value, threshold, samples)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
        ended_at = EXCLUDED.ended_at,
        duration_s = EXCLUDED.duration_s,
        extreme_value = EXCLUDED.extreme_value,
        samples = EXCLUDED.samples`;

export function pqEventParams(e: PqEvent): unknown[] {
    return [e.id, e.meterId, e.type, e.channel, e.startedAt, e.endedAt, e.durationS, e.extremeValue, e.threshold, e.samples];
}
