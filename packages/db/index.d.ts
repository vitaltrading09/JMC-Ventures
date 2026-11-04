/** Anything with node-postgres' query() — a Pool or a PoolClient. */
export interface Queryable {
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** Device timestamps older than this fall back to arrival time (mqtt.ts). */
export const MAX_BACKFILL_DAYS: number;
/** meter_readings compression boundary; always > MAX_BACKFILL_DAYS. */
export const COMPRESSION_AFTER_DAYS: number;

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
