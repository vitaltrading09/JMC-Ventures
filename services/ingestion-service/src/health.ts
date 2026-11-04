// ─────────────────────────────────────────────────────────────────────────────
// GET /health/deep (reached as /api/health/deep through Caddy and the gateway)
// for an external uptime monitor. Protected by a static token header
// (x-health-token = HEALTH_TOKEN); without HEALTH_TOKEN set, it is disabled.
//
// 200 when everything that must hold does, 503 otherwise, with the detail:
//   db          reachable
//   migrations  none pending
//   ingest      heartbeat fresh (ingest container alive) and, while meters are
//               reporting, the last committed flush recent
//   backup      a successful backup within HEALTH_MAX_BACKUP_AGE_H
//               (skipped when HEALTH_REQUIRE_BACKUP=false, e.g. local dev)
//   meters      how many active meters are silent (reported, not failing:
//               one meter on a dead SIM is a meter alert, not an outage)
// ─────────────────────────────────────────────────────────────────────────────

import { timingSafeEqual } from 'crypto';

export interface DeepHealthFacts {
    dbOk: boolean;
    dbError?: string;
    pendingMigrations: number | null;      // null when the DB is unreachable
    ingestAliveAgeS: number | null;        // null: no heartbeat ever
    ingestFlushAgeS: number | null;        // null: never flushed rows
    metersReportingRecently: number;       // active meters with data in the last day
    metersSilent: number;
    backupAgeS: number | null;             // null: no successful backup ever
}

export interface DeepHealthConfig {
    maxIngestAliveAgeS: number;  // heartbeat every 30 s
    maxFlushAgeS: number;
    maxBackupAgeS: number;
    requireBackup: boolean;
    silentMinutes: number;
}

export function deepHealthConfig(env: NodeJS.ProcessEnv = process.env): DeepHealthConfig {
    const pos = (name: string, def: number) => {
        const n = Number(env[name]);
        return Number.isFinite(n) && n > 0 ? n : def;
    };
    return {
        maxIngestAliveAgeS: 120,
        maxFlushAgeS: pos('HEALTH_MAX_FLUSH_AGE_S', 300),
        maxBackupAgeS: pos('HEALTH_MAX_BACKUP_AGE_H', 26) * 3600,
        requireBackup: env.HEALTH_REQUIRE_BACKUP !== 'false',
        silentMinutes: pos('METER_SILENT_MINUTES', 5),
    };
}

type Check = { ok: boolean; [k: string]: unknown };

export function evaluateDeepHealth(f: DeepHealthFacts, cfg: DeepHealthConfig) {
    const round = (n: number | null) => (n === null ? null : Math.round(n));
    const checks: Record<string, Check> = {};

    checks.db = f.dbOk ? { ok: true } : { ok: false, error: f.dbError ?? 'unreachable' };
    checks.migrations = { ok: f.pendingMigrations === 0, pending: f.pendingMigrations };

    const alive = f.ingestAliveAgeS !== null && f.ingestAliveAgeS <= cfg.maxIngestAliveAgeS;
    // Flush age only matters while meters are actually reporting; a fresh
    // install with no meters must not page anyone.
    const flushRequired = f.metersReportingRecently > 0;
    const flushFresh = !flushRequired || (f.ingestFlushAgeS !== null && f.ingestFlushAgeS <= cfg.maxFlushAgeS);
    checks.ingest = {
        ok: alive && flushFresh,
        heartbeat_age_s: round(f.ingestAliveAgeS),
        last_flush_age_s: round(f.ingestFlushAgeS),
        max_flush_age_s: cfg.maxFlushAgeS,
        ...(alive ? {} : { problem: f.ingestAliveAgeS === null ? 'no ingest heartbeat yet' : 'ingest heartbeat stale (container down?)' }),
        ...(alive && !flushFresh ? { problem: 'no readings committed recently while meters are active' } : {}),
    };

    const backupFresh = f.backupAgeS !== null && f.backupAgeS <= cfg.maxBackupAgeS;
    checks.backup = cfg.requireBackup
        ? { ok: backupFresh, last_success_age_s: round(f.backupAgeS), max_age_s: cfg.maxBackupAgeS,
            ...(backupFresh ? {} : { problem: f.backupAgeS === null ? 'no successful backup recorded' : 'last successful backup too old' }) }
        : { ok: true, skipped: 'HEALTH_REQUIRE_BACKUP=false', last_success_age_s: round(f.backupAgeS) };

    checks.meters = { ok: true, reporting: f.metersReportingRecently, silent: f.metersSilent, silent_after_minutes: cfg.silentMinutes };

    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? 'ok' : 'degraded', ok, checks };
}

/** Constant-time token check. False when no token is configured. */
export function healthTokenValid(expected: string | undefined, given: unknown): boolean {
    if (!expected || typeof given !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}
