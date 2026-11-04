// ─────────────────────────────────────────────────────────────────────────────
// Meter lookup cache for the ingest path.
//
// Replaces the per-message meters ⋈ sites ⋈ site_settings query. Refreshed
// every refreshMs (60 s) and on a cache miss (rate-limited, so a stream of
// messages for an unknown meter cannot hammer the database).
//
// Keyed by the topic segment of acuvim/{segment}/telemetry. A segment matches,
// in order: the meter id, its serial_number, its mqtt_username (column added
// in Phase 6; tolerated if absent). Failing all three, the serial number inside
// the payload is tried, as the per-message query did before.
// ─────────────────────────────────────────────────────────────────────────────

import { toNum } from './channels';

export interface MeterInfo {
    id: string;
    tenantId: string;
    serial: string | null;
    /** NRS 048 thresholds for the event detector (site_settings or defaults). */
    thresholds: {
        minV: number;
        maxV: number;
        minFreq: number;
        maxFreq: number;
    };
}

// NRS 048-2 defaults, used when site_settings has no value.
export const NRS048_DEFAULTS = { minV: 207, maxV: 253, minFreq: 49.0, maxFreq: 51.0 } as const;

export interface CacheDb {
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export class MeterCache {
    private byId = new Map<string, MeterInfo>();
    private bySerial = new Map<string, MeterInfo>();
    private byUsername = new Map<string, MeterInfo>();
    private refreshing: Promise<void> | null = null;
    private lastRefreshAt = 0;
    private timer: NodeJS.Timeout | null = null;
    private hasUsernameColumn = false;
    private hasArchiveColumns = false;

    constructor(
        private readonly db: CacheDb,
        private readonly opts: { refreshMs?: number; minMissRefreshMs?: number; now?: () => number } = {},
    ) {}

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    get size(): number {
        return this.byId.size;
    }

    start(): void {
        const every = this.opts.refreshMs ?? 60_000;
        this.timer = setInterval(() => {
            this.refresh().catch((e) => console.error('[ingest] Meter cache refresh failed:', e?.message || e));
        }, every);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    refresh(): Promise<void> {
        if (this.refreshing) return this.refreshing;
        this.refreshing = this.load().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    private async load(): Promise<void> {
        const col = await this.db.query(`
            SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name = 'meters'
                             AND column_name = 'mqtt_username') AS present`);
        this.hasUsernameColumn = !!col.rows[0]?.present;
        const arch = await this.db.query(`
            SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name = 'meters'
                             AND column_name = 'archived_at') AS present`);
        this.hasArchiveColumns = !!arch.rows[0]?.present;
        const r = await this.db.query(`
            SELECT m.id, m.serial_number, ${this.hasUsernameColumn ? 'm.mqtt_username' : 'NULL::text AS mqtt_username'},
                   s.tenant_id,
                   ss.alert_min_v, ss.alert_max_v, ss.alert_min_freq, ss.alert_max_freq
            FROM meters m
            JOIN sites s ON m.site_id = s.id
            LEFT JOIN site_settings ss ON ss.site_id = s.id
            -- An archived meter stops ingesting: its messages are dead-lettered as unknown.
            WHERE ${this.hasArchiveColumns ? 'm.archived_at IS NULL AND s.archived_at IS NULL' : 'TRUE'}`);
        const byId = new Map<string, MeterInfo>();
        const bySerial = new Map<string, MeterInfo>();
        const byUsername = new Map<string, MeterInfo>();
        for (const row of r.rows) {
            const info: MeterInfo = {
                id: String(row.id),
                tenantId: String(row.tenant_id),
                serial: row.serial_number ?? null,
                thresholds: {
                    // DECIMAL columns arrive as strings from node-postgres.
                    minV:    toNum(row.alert_min_v)    ?? NRS048_DEFAULTS.minV,
                    maxV:    toNum(row.alert_max_v)    ?? NRS048_DEFAULTS.maxV,
                    minFreq: toNum(row.alert_min_freq) ?? NRS048_DEFAULTS.minFreq,
                    maxFreq: toNum(row.alert_max_freq) ?? NRS048_DEFAULTS.maxFreq,
                },
            };
            byId.set(info.id, info);
            if (row.serial_number) bySerial.set(String(row.serial_number), info);
            if (row.mqtt_username) byUsername.set(String(row.mqtt_username), info);
        }
        this.byId = byId;
        this.bySerial = bySerial;
        this.byUsername = byUsername;
        this.lastRefreshAt = this.now();
    }

    /** Cache only, no database access. */
    peek(segment: string, payloadSerial: string | null = null): MeterInfo | null {
        return this.byId.get(segment)
            ?? this.bySerial.get(segment)
            ?? this.byUsername.get(segment)
            ?? (payloadSerial ? this.bySerial.get(payloadSerial) ?? null : null);
    }

    /**
     * Cached lookup; on a miss, refreshes once (at most every minMissRefreshMs,
     * default 5 s) and tries again. Null means the meter is unknown.
     */
    async lookup(segment: string, payloadSerial: string | null = null): Promise<MeterInfo | null> {
        const hit = this.peek(segment, payloadSerial);
        if (hit) return hit;
        const minGap = this.opts.minMissRefreshMs ?? 5_000;
        if (this.refreshing || this.now() - this.lastRefreshAt >= minGap) {
            await this.refresh();
            return this.peek(segment, payloadSerial);
        }
        return null;
    }
}
