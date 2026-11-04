// ─────────────────────────────────────────────────────────────────────────────
// Ingest observability that the fleet plan needs:
//   - unknown parameter names, logged once per meter per hour, so we learn
//     what each firmware actually sends (then add it to channels.ts);
//   - average bytes per message per meter, logged hourly, for the cellular
//     data budget of the portable fleet (plan Part E).
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

export class IngestStats {
    private unknownLoggedAt = new Map<string, number>(); // meter → last log time
    private unknownSeen = new Map<string, Set<string>>(); // meter → names since last log
    private payload = new Map<string, { messages: number; bytes: number }>();
    private windowStartedAt: number;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly opts: {
            now?: () => number;
            log?: (msg: string) => void;
            intervalMs?: number;
        } = {},
    ) {
        this.windowStartedAt = this.now();
    }

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    private log(msg: string): void {
        (this.opts.log ?? console.log)(msg);
    }

    /** Count one message's size for its meter (topic segment if the meter is unknown). */
    notePayload(meter: string, bytes: number): void {
        const p = this.payload.get(meter) ?? { messages: 0, bytes: 0 };
        p.messages++;
        p.bytes += bytes;
        this.payload.set(meter, p);
    }

    /** Record unknown parameter names; logs at most once per meter per hour. */
    noteUnknownParams(meter: string, names: string[]): void {
        if (names.length === 0) return;
        const seen = this.unknownSeen.get(meter) ?? new Set<string>();
        for (const n of names) seen.add(n);
        this.unknownSeen.set(meter, seen);
        const last = this.unknownLoggedAt.get(meter);
        const interval = this.opts.intervalMs ?? HOUR_MS;
        if (last === undefined || this.now() - last >= interval) {
            this.unknownLoggedAt.set(meter, this.now());
            this.log(`[ingest] Meter ${meter} sends ${seen.size} unmapped parameter(s): ${[...seen].sort().join(', ')}`);
            this.unknownSeen.set(meter, new Set());
        }
    }

    /** Logs and resets the payload-size window. Returns what was logged (for tests). */
    reportPayloadSizes(): Array<{ meter: string; messages: number; avgBytes: number }> {
        const mins = Math.max(1, Math.round((this.now() - this.windowStartedAt) / 60_000));
        const rows = [...this.payload.entries()]
            .map(([meter, p]) => ({ meter, messages: p.messages, avgBytes: Math.round(p.bytes / p.messages) }))
            .sort((a, b) => a.meter.localeCompare(b.meter));
        for (const r of rows) {
            this.log(`[ingest] Payload size ${r.meter}: ${r.messages} msgs in ${mins} min, avg ${r.avgBytes} B/msg`);
        }
        this.payload.clear();
        this.windowStartedAt = this.now();
        return rows;
    }

    start(): void {
        this.timer = setInterval(() => this.reportPayloadSizes(), this.opts.intervalMs ?? HOUR_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
