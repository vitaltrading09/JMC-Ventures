// ─────────────────────────────────────────────────────────────────────────────
// Batch writer for meter_readings.
//
// Parsed rows are queued in memory and flushed every flushMs or once flushRows
// are waiting, whichever comes first. A flush is ONE multi-row
//   INSERT ... ON CONFLICT (meter_id, time) DO NOTHING RETURNING meter_id, time
// in a transaction. Rows not returned were conflicts (store-and-forward
// replays, or a stuck meter clock) and feed onConflict.
//
// Each row carries an ack(): the MQTT PUBACK for its message is only released
// after the transaction that wrote it commits. When a flush fails, nothing is
// acked and the rows stay at the head of the queue; the writer retries with
// backoff. If the process dies first, the broker redelivers the unacked
// messages (QoS 1, persistent session), so a reading is never lost between
// "received" and "committed".
//
// The queue is bounded (maxQueue). When it is full the caller stops taking
// messages (await whenNotFull()), which stalls the MQTT socket: backpressure,
// never dropping.
// ─────────────────────────────────────────────────────────────────────────────

export interface WriterClient {
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
    release(): void;
}
export interface WriterDb {
    connect(): Promise<WriterClient>;
}

export interface QueuedRow {
    meterId: string;
    time: Date;
    deviceTime: Date | null;
    source: string;
    /** column → value, for every column in the writer's `columns` */
    values: Record<string, number | null>;
    /** Releases the message's PUBACK. Called once, after commit. */
    ack: () => void;
    /** Date.now() when the message was received (for latency stats) */
    receivedAt: number;
}

export interface FlushInfo {
    rows: number;
    inserted: number;
    conflicts: number;
    ms: number;
}

export interface BatchWriterOptions {
    db: WriterDb;
    columns: readonly string[];
    flushMs?: number;
    flushRows?: number;
    maxQueue?: number;
    retryMinMs?: number;
    retryMaxMs?: number;
    onConflict?: (meterId: string) => void;
    /** Rows that were actually inserted (not conflicts), after commit. */
    onCommitted?: (inserted: QueuedRow[], info: FlushInfo) => void;
    log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

// PostgreSQL allows 65535 bind parameters per statement.
const MAX_PARAMS = 65_000;

export class BatchWriter {
    readonly flushMs: number;
    readonly flushRows: number;
    readonly maxQueue: number;
    private readonly retryMinMs: number;
    private readonly retryMaxMs: number;
    private readonly opts: BatchWriterOptions;
    private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
    private readonly perRowParams: number;
    private readonly maxBatch: number;

    private queue: QueuedRow[] = [];
    private flushing: Promise<void> | null = null;
    private timer: NodeJS.Timeout | null = null;
    private retryDelay = 0;
    private spaceWaiters: Array<() => void> = [];
    private stopped = true;

    /** Date.now() of the last successful flush (or construction). */
    lastSuccessAt = Date.now();
    lastError: string | null = null;
    totals = { flushes: 0, inserted: 0, conflicts: 0, failures: 0 };

    constructor(opts: BatchWriterOptions) {
        this.opts = opts;
        this.flushMs = opts.flushMs ?? 1000;
        this.flushRows = opts.flushRows ?? 500;
        this.maxQueue = opts.maxQueue ?? 50_000;
        this.retryMinMs = opts.retryMinMs ?? 1000;
        this.retryMaxMs = opts.retryMaxMs ?? 30_000;
        this.log = opts.log ?? console;
        // time, meter_id, <columns>, device_time, time_source
        this.perRowParams = opts.columns.length + 4;
        this.maxBatch = Math.max(1, Math.min(this.flushRows, Math.floor(MAX_PARAMS / this.perRowParams)));
    }

    get size(): number {
        return this.queue.length;
    }

    isFull(): boolean {
        return this.queue.length >= this.maxQueue;
    }

    /** Resolves as soon as the queue has room again. */
    whenNotFull(): Promise<void> {
        if (!this.isFull()) return Promise.resolve();
        return new Promise((resolve) => this.spaceWaiters.push(resolve));
    }

    enqueue(row: QueuedRow): void {
        this.queue.push(row);
        if (this.queue.length >= this.flushRows && !this.stopped && this.retryDelay === 0) {
            void this.flush();
        }
    }

    start(): void {
        this.stopped = false;
        this.schedule(this.flushMs);
    }

    /** Stops the timer. Queued rows stay queued (and unacked) until drain(). */
    stop(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    /** Flushes until the queue is empty, retrying failures, for at most timeoutMs. */
    async drain(timeoutMs = 30_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (this.queue.length > 0 && Date.now() < deadline) {
            const ok = await this.flush();
            if (!ok && this.queue.length > 0) {
                await sleep(Math.min(this.retryDelay || this.retryMinMs, Math.max(0, deadline - Date.now())));
            }
        }
        return this.queue.length === 0;
    }

    private schedule(ms: number): void {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(async () => {
            this.timer = null;
            await this.flush();
            this.schedule(this.retryDelay > 0 ? this.retryDelay : this.flushMs);
        }, ms);
    }

    /** One flush (or joins the one in progress). Resolves true if the queue head was written. */
    flush(): Promise<boolean> {
        if (this.flushing) return this.flushing.then(() => this.retryDelay === 0);
        if (this.queue.length === 0) return Promise.resolve(true);
        let ok = false;
        this.flushing = this.writeBatch()
            .then(() => { ok = true; })
            .catch((e) => this.onFailure(e))
            .finally(() => { this.flushing = null; });
        return this.flushing.then(() => {
            // More than a batch waiting: keep going rather than waiting a tick.
            if (ok && !this.stopped && this.queue.length >= this.flushRows) void this.flush();
            return ok;
        });
    }

    private async writeBatch(): Promise<void> {
        const batch = this.queue.slice(0, this.maxBatch);
        const started = Date.now();
        const { text, values } = this.buildInsert(batch);

        const client = await this.opts.db.connect();
        let returned: any[];
        try {
            await client.query('BEGIN');
            try {
                returned = (await client.query(text, values)).rows;
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            }
        } finally {
            client.release();
        }

        // Committed: the rows are durable. Remove them, then ack.
        this.queue.splice(0, batch.length);
        this.retryDelay = 0;
        this.lastSuccessAt = Date.now();
        this.lastError = null;

        const insertedKeys = new Map<string, number>();
        for (const r of returned) {
            const k = key(String(r.meter_id), new Date(r.time));
            insertedKeys.set(k, (insertedKeys.get(k) ?? 0) + 1);
        }
        const inserted: QueuedRow[] = [];
        let conflicts = 0;
        for (const row of batch) {
            const k = key(row.meterId, row.time);
            const n = insertedKeys.get(k) ?? 0;
            if (n > 0) {
                insertedKeys.set(k, n - 1);
                inserted.push(row);
            } else {
                conflicts++;
                this.opts.onConflict?.(row.meterId);
            }
        }
        for (const row of batch) {
            try { row.ack(); } catch (e) { this.log.error('[ingest] ack failed:', e); }
        }

        this.totals.flushes++;
        this.totals.inserted += inserted.length;
        this.totals.conflicts += conflicts;
        this.releaseWaiters();
        this.opts.onCommitted?.(inserted, { rows: batch.length, inserted: inserted.length, conflicts, ms: Date.now() - started });
    }

    private onFailure(e: unknown): void {
        this.totals.failures++;
        this.retryDelay = this.retryDelay === 0 ? this.retryMinMs : Math.min(this.retryDelay * 2, this.retryMaxMs);
        this.lastError = (e as any)?.message || String(e);
        this.log.error(
            `[ingest] Flush of ${Math.min(this.queue.length, this.maxBatch)} row(s) failed; nothing acked, ` +
            `retrying in ${this.retryDelay} ms (${this.queue.length} queued): ${this.lastError}`
        );
    }

    private releaseWaiters(): void {
        if (this.isFull()) return;
        const waiters = this.spaceWaiters;
        this.spaceWaiters = [];
        for (const w of waiters) w();
    }

    buildInsert(batch: QueuedRow[]): { text: string; values: unknown[] } {
        const cols = ['time', 'meter_id', ...this.opts.columns, 'device_time', 'time_source'];
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const row of batch) {
            const ph: string[] = [];
            const push = (v: unknown) => { values.push(v); ph.push(`$${values.length}`); };
            push(row.time);
            push(row.meterId);
            for (const c of this.opts.columns) push(row.values[c] ?? null);
            push(row.deviceTime);
            push(row.source);
            tuples.push(`(${ph.join(', ')}, NOW())`);
        }
        const text =
            `INSERT INTO meter_readings (${cols.map(quoteIdent).join(', ')}, ingested_at) VALUES ${tuples.join(', ')} ` +
            `ON CONFLICT (meter_id, time) DO NOTHING RETURNING meter_id, time`;
        return { text, values };
    }
}

function key(meterId: string, time: Date): string {
    return `${meterId}|${time.getTime()}`;
}

function quoteIdent(s: string): string {
    return `"${s.replace(/"/g, '""')}"`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
