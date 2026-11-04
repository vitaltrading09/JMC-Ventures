/** Anything with node-postgres' query() — a Pool or a PoolClient. */
export interface Queryable {
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** Device timestamps older than this fall back to arrival time (mqtt.ts). From MAX_BACKFILL_DAYS, default 14. */
export const MAX_BACKFILL_DAYS: number;
/** meter_readings compression and aggregate-refresh boundary; always > MAX_BACKFILL_DAYS. From COMPRESS_AFTER_DAYS, default 15. */
export const COMPRESSION_AFTER_DAYS: number;
export const DEFAULT_MAX_BACKFILL_DAYS: number;
export const DEFAULT_COMPRESS_AFTER_DAYS: number;
export const AGGREGATE_VIEWS: string[];

export interface RetentionConfig { maxBackfillDays: number; compressAfterDays: number }
export interface RetentionPolicies { compression: number | null; refresh: Record<string, number | null> }
export function retentionConfig(env?: Record<string, string | undefined>): RetentionConfig;
export function retentionPolicies(db: Queryable): Promise<RetentionPolicies>;
export function retentionMismatches(policies: RetentionPolicies, cfg: RetentionConfig): string[];
export function assertRetentionConsistent(db: Queryable, cfg?: RetentionConfig): Promise<void>;
export function reconcileRetention(db: Queryable, cfg?: RetentionConfig): Promise<string[]>;
export function refreshAggregates(db: Queryable, from?: Date | null, to?: Date | null): Promise<void>;
export function materialiseNewAggregates(db: Queryable): Promise<string[]>;
export class RetentionMismatchError extends Error {
    issues: string[];
    constructor(issues: string[]);
}

export const MIGRATIONS_DIR: string;
export const MIGRATIONS_TABLE: string;

export function listMigrations(dir?: string): string[];
export function appliedMigrations(db: Queryable): Promise<string[]>;
export function compareMigrations(expected: string[], applied: string[]): { pending: string[]; unknown: string[] };

export class SchemaBehindError extends Error {
    pending: string[];
    constructor(pending: string[]);
}

export function assertSchemaCurrent(
    db: Queryable,
    opts?: { expected?: string[]; log?: Pick<Console, 'warn'> },
): Promise<{ applied: number; unknown: string[] }>;
