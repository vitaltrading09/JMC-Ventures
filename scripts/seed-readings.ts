// ─────────────────────────────────────────────────────────────────────────────
// Synthetic meter readings for LOCAL DEVELOPMENT. Never run on a server.
//
// Fills meter_readings for the demo meters created by
// services/auth-service/src/seed.ts (found by their DEMO-* serials, nothing
// else is touched), so every page and engine has data to work on. The curves
// and the per-site problems are defined in
// services/ingestion-service/src/demo-profiles.ts.
//
//   ALLOW_DEMO_SEED=true DATABASE_URL=... npx tsx scripts/seed-readings.ts [options]
//
//   --days N        history to generate, ending now          (default 90)
//   --interval M    minutes between readings, 1..60          (default 5)
//   --end ISO       end of the window instead of now
//   --alert-days N  simulate real-time alerts for new readings in the last N days, 0 = none (default 7)
//   --only a,b      profile keys: hq, factory, durban, mall, datacentre
//   --dry-run       generate and report, write nothing
//
// Safe to re-run: readings go in with ON CONFLICT (meter_id, time) DO NOTHING
// and identical values for identical timestamps, so a re-run only tops the
// window up to now. Existing meter_readings rows are never updated or deleted.
// Every row carries time_source = 'SIMULATED'. Keep --interval the same across
// runs for a meter. New rows join the stored energy register even after a
// profile change (joinRegister), but stored rows keep the curve they had.
//
// Needs the schema the ingestion api role bootstraps (provenance columns,
// site_settings): start the stack once before running this.
// ─────────────────────────────────────────────────────────────────────────────

import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import {
    DEMO_PROFILES, DemoSiteProfile, DemoSiteSettings, SIMULATED_TIME_SOURCE,
    generateReadings, evaluateDemoAlerts, joinRegister,
} from '../services/ingestion-service/src/demo-profiles';

dotenv.config();

// Synthetic data must never land in a real database by accident.
if (process.env.ALLOW_DEMO_SEED !== 'true') {
    console.error('Refusing to seed: set ALLOW_DEMO_SEED=true to create demo data (local dev only).');
    process.exit(1);
}
if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set.');
    process.exit(1);
}

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const BATCH_ROWS = 5_000;

interface Options { days: number; interval: number; end: number; alertDays: number; only: string[] | null; dryRun: boolean }

function parseArgs(argv: string[]): Options {
    const opts: Options = { days: 90, interval: 5, end: Date.now(), alertDays: 7, only: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a} needs a value`);
            return v;
        };
        const num = (v: string) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) throw new Error(`${a}: "${v}" is not a non-negative number`);
            return n;
        };
        switch (a) {
            case '--days':       opts.days = num(next()); break;
            case '--interval':   opts.interval = num(next()); break;
            case '--alert-days': opts.alertDays = num(next()); break;
            case '--end': {
                const v = next();
                opts.end = new Date(v).getTime();
                if (Number.isNaN(opts.end)) throw new Error(`--end: "${v}" is not a date`);
                break;
            }
            case '--only':       opts.only = next().split(',').map(s => s.trim()).filter(Boolean); break;
            case '--dry-run':    opts.dryRun = true; break;
            default: throw new Error(`Unknown option ${a}`);
        }
    }
    if (!Number.isInteger(opts.interval) || opts.interval < 1 || opts.interval > 60) throw new Error('--interval must be an integer 1..60');
    if (opts.days <= 0) throw new Error('--days must be > 0');
    if (opts.only) {
        const known = DEMO_PROFILES.map(p => p.key);
        const bad = opts.only.filter(k => !known.includes(k));
        if (bad.length) throw new Error(`--only: unknown profile(s) ${bad.join(', ')}. Known: ${known.join(', ')}`);
    }
    return opts;
}

/** Same objects ingest waits for (roles.ts ingestSchemaReady), plus the meter profile columns. */
async function schemaReady(client: PoolClient): Promise<boolean> {
    const r = await client.query(`
        SELECT
            to_regclass('public.idx_meter_readings_unique') IS NOT NULL AS has_unique,
            EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'meter_readings' AND column_name = 'time_source') AS has_provenance,
            EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'site_settings' AND column_name = 'demand_interval_min') AS has_settings,
            EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'meters' AND column_name = 'site_type') AS has_meter_profile
    `);
    const row = r.rows[0];
    return !!(row.has_unique && row.has_provenance && row.has_settings && row.has_meter_profile);
}

const SETTINGS_COLUMNS: (keyof DemoSiteSettings)[] = [
    'tariff_type', 'tariff_peak', 'tariff_standard', 'tariff_offpeak',
    'peak_times', 'standard_times', 'offpeak_times', 'tariff_demand',
    'contracted_mdi_kva', 'demand_interval_min',
    'alert_max_kw', 'alert_min_v', 'alert_max_v', 'alert_max_thd', 'alert_min_freq', 'alert_max_freq',
];

/**
 * Fills blank site_settings with the profile's values and returns the
 * effective settings. Values someone has set (e.g. in the tariff page) win.
 */
async function applySettings(client: PoolClient, siteId: string, s: DemoSiteSettings): Promise<DemoSiteSettings> {
    const cols = SETTINGS_COLUMNS.join(', ');
    const params = SETTINGS_COLUMNS.map((_, i) => `$${i + 2}`).join(', ');
    const fill = SETTINGS_COLUMNS.map(c => `${c} = COALESCE(site_settings.${c}, EXCLUDED.${c})`).join(',\n                ');
    const r = await client.query(`
        INSERT INTO site_settings (site_id, ${cols})
        VALUES ($1, ${params})
        ON CONFLICT (site_id) DO UPDATE SET
                ${fill},
                updated_at = CURRENT_TIMESTAMP
        RETURNING ${cols}
    `, [siteId, ...SETTINGS_COLUMNS.map(c => s[c])]);
    const row = r.rows[0];
    // DECIMAL columns arrive as strings.
    const out: any = { ...s };
    for (const c of SETTINGS_COLUMNS) {
        if (row[c] === null || row[c] === undefined) continue;
        out[c] = typeof s[c] === 'number' ? Number(row[c]) : row[c];
    }
    return out;
}

/** Fills a blank meter profile (site type, loads) so recommendations have context. */
async function applyMeterProfile(client: PoolClient, meterId: string, p: DemoSiteProfile): Promise<void> {
    await client.query(`
        UPDATE meters SET
            site_type        = COALESCE(site_type, $2),
            load_types       = CASE WHEN cardinality(load_types) = 0 THEN $3::text[] ELSE load_types END,
            load_description = COALESCE(load_description, $4)
        WHERE id = $1
    `, [meterId, p.meta.site_type, p.meta.load_types, p.meta.load_description]);
}

/**
 * Decompresses any chunk the window overlaps, as CSV import does
 * (ensureRangeWritable in main.ts): TimescaleDB does not enforce the unique
 * index on compressed chunks, so ON CONFLICT would not protect them. Lossless;
 * the compression policy re-compresses on its next run.
 */
async function ensureRangeWritable(client: PoolClient, from: Date, to: Date): Promise<number> {
    const q = await client.query(`
        SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
        FROM timescaledb_information.chunks
        WHERE hypertable_name = 'meter_readings'
          AND is_compressed
          AND range_start < $2 AND range_end > $1
    `, [from, to]);
    for (const row of q.rows) {
        await client.query(`SELECT decompress_chunk($1::regclass, if_compressed => true)`, [row.chunk]);
    }
    return q.rows.length;
}

const READING_COLUMNS = [
    'voltage_a', 'voltage_b', 'voltage_c', 'current_a', 'current_b', 'current_c',
    'power_active_total', 'power_reactive_total', 'power_apparent_total',
    'power_factor_total', 'frequency', 'energy_import_total', 'thd_voltage_a', 'thd_current_a',
] as const;

async function insertReadings(client: PoolClient, meterId: string, rows: ReturnType<typeof generateReadings>): Promise<number> {
    let inserted = 0;
    const cols = READING_COLUMNS.join(', ');
    const arrays = READING_COLUMNS.map((_, i) => `$${i + 3}::float8[]`).join(', ');
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
        const batch = rows.slice(i, i + BATCH_ROWS);
        const r = await client.query(`
            INSERT INTO meter_readings (time, meter_id, ${cols}, device_time, ingested_at, time_source)
            SELECT u.time, $2::uuid, ${READING_COLUMNS.map(c => `u.${c}`).join(', ')}, u.time, NOW(), $${READING_COLUMNS.length + 3}
            FROM unnest($1::timestamptz[], ${arrays}) AS u(time, ${cols})
            ON CONFLICT (meter_id, time) DO NOTHING
        `, [
            batch.map(r => r.time),
            meterId,
            ...READING_COLUMNS.map(c => batch.map(r => r[c])),
            SIMULATED_TIME_SOURCE,
        ]);
        inserted += r.rowCount ?? 0;
    }
    return inserted;
}

/**
 * The alerts mqtt.ts would have raised for these readings, backdated to the
 * reading and deduplicated the same way (one per type per meter per hour),
 * including against alerts already stored. Older than 24 h are marked read.
 */
async function insertAlerts(
    client: PoolClient, meterId: string, tenantId: string,
    rows: ReturnType<typeof generateReadings>, settings: DemoSiteSettings, endMs: number, dryRun: boolean,
): Promise<number> {
    if (rows.length === 0) return 0;
    const from = rows[0].time;
    const existing = await client.query(`
        SELECT type, created_at FROM alerts
        WHERE meter_id = $1 AND created_at >= $2::timestamptz - INTERVAL '1 hour'
    `, [meterId, from]);
    const last = new Map<string, number[]>();
    for (const a of existing.rows) {
        const list = last.get(a.type) ?? [];
        list.push(new Date(a.created_at).getTime());
        last.set(a.type, list);
    }
    const clashes = (type: string, t: number) => (last.get(type) ?? []).some(x => Math.abs(x - t) < 3_600_000);

    const out: { type: string; severity: string; message: string; at: Date }[] = [];
    for (const r of rows) {
        const t = r.time.getTime();
        for (const a of evaluateDemoAlerts(r, settings)) {
            if (clashes(a.type, t)) continue;
            out.push({ ...a, at: r.time });
            last.set(a.type, [...(last.get(a.type) ?? []), t]);
        }
    }
    if (dryRun || out.length === 0) return out.length;
    await client.query(`
        INSERT INTO alerts (tenant_id, meter_id, type, severity, message, created_at, is_read)
        SELECT $1, $2, u.type, u.severity, u.message, u.at, u.at < $7::timestamptz - INTERVAL '24 hours'
        FROM unnest($3::text[], $4::text[], $5::text[], $6::timestamptz[]) AS u(type, severity, message, at)
    `, [tenantId, meterId, out.map(a => a.type), out.map(a => a.severity), out.map(a => a.message), out.map(a => a.at), new Date(endMs)]);
    return out.length;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const step = opts.interval * MIN_MS;
    const endMs = Math.floor(opts.end / step) * step;
    const fromMs = endMs - opts.days * DAY_MS;
    const profiles = DEMO_PROFILES.filter(p => !opts.only || opts.only.includes(p.key));

    console.log(`Synthetic readings ${new Date(fromMs).toISOString()} → ${new Date(endMs).toISOString()}, every ${opts.interval} min`
        + `${opts.dryRun ? ' (dry run)' : ''}`);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
        if (!(await schemaReady(client))) {
            throw new Error('Schema not bootstrapped. Start the stack once (the ingestion api role creates the '
                + 'provenance columns and site_settings), then re-run.');
        }
        let missing = 0;
        for (const p of profiles) {
            const m = await client.query(`
                SELECT m.id, m.site_id, s.tenant_id
                FROM meters m JOIN sites s ON s.id = m.site_id
                WHERE m.serial_number = $1 AND s.name = $2
            `, [p.meterSerial, p.siteName]);
            if (m.rows.length === 0) {
                console.warn(`  ${p.key}: no meter ${p.meterSerial} on site '${p.siteName}' — run services/auth-service/src/seed.ts first. Skipped.`);
                missing++;
                continue;
            }
            const { id: meterId, site_id: siteId, tenant_id: tenantId } = m.rows[0];

            const rows = generateReadings(p, fromMs, endMs, opts.interval);
            // Only timestamps not yet stored need writing, so a top-up run does
            // not decompress the whole window. ON CONFLICT still guards the insert.
            // The nearest stored readings either side of the window are included
            // so a new segment's energy register can join them (joinRegister).
            const have = await client.query(`
                SELECT time, energy_import_total FROM meter_readings
                WHERE meter_id = $1 AND time >= $2 AND time <= $3 AND energy_import_total IS NOT NULL
                UNION
                (SELECT time, energy_import_total FROM meter_readings
                 WHERE meter_id = $1 AND time < $2 AND energy_import_total IS NOT NULL ORDER BY time DESC LIMIT 1)
                UNION
                (SELECT time, energy_import_total FROM meter_readings
                 WHERE meter_id = $1 AND time > $3 AND energy_import_total IS NOT NULL ORDER BY time ASC LIMIT 1)
                ORDER BY time
            `, [meterId, new Date(fromMs), new Date(endMs)]);
            const stored = have.rows.map(r => ({ time: new Date(r.time).getTime(), energy: Number(r.energy_import_total) }));
            const storedTimes = new Set(stored.map(s => s.time));
            const generated = new Map(rows.map(r => [r.time.getTime(), r.energy_import_total]));
            const registerAt = (ms: number) =>
                generated.get(ms) ?? generateReadings(p, ms, ms + step, opts.interval)[0].energy_import_total;
            const fresh = joinRegister(rows.filter(r => !storedTimes.has(r.time.getTime())), stored, registerAt);

            let inserted = 0;
            let settings = p.settings;
            if (!opts.dryRun) {
                settings = await applySettings(client, siteId, p.settings);
                await applyMeterProfile(client, meterId, p);
                if (fresh.length > 0) {
                    const n = await ensureRangeWritable(client, fresh[0].time, new Date(fresh[fresh.length - 1].time.getTime() + 1));
                    if (n > 0) console.log(`  ${p.key}: decompressed ${n} chunk(s) to write into.`);
                    inserted = await insertReadings(client, meterId, fresh);
                    // The demo meter's deployment (opened when the seed created it) covers
                    // the generated history too, as a CSV import does (fleet model, Phase 6).
                    // No commissioning result over synthetic data.
                    await client.query(`
                        UPDATE deployments SET installed_at = LEAST(installed_at, $2),
                               commissioning = COALESCE(commissioning, '{"final": true, "overall": "not_evaluated", "note": "Demo meter: synthetic readings", "checks": []}'::jsonb)
                        WHERE id = (SELECT id FROM deployments WHERE device_id = $1 ORDER BY installed_at LIMIT 1)`,
                        [meterId, fresh[0].time]).catch(() => { /* pre-Phase-6 schema */ });
                }
            }
            // Alerts only for readings this run writes, as MQTT raises them on insert.
            const alertFrom = endMs - opts.alertDays * DAY_MS;
            const alertRows = opts.alertDays > 0 ? fresh.filter(r => r.time.getTime() > alertFrom) : [];
            const alerts = await insertAlerts(client, meterId, tenantId, alertRows, settings, endMs, opts.dryRun);

            const problems = p.problems.length ? p.problems.join(', ') : 'healthy';
            console.log(`  ${p.key.padEnd(10)} ${p.meterSerial}  ${rows.length} readings, ${opts.dryRun ? `${fresh.length} would be` : inserted} new, `
                + `${alerts} alert(s)${opts.dryRun ? ' would be' : ''} written  [${problems}]`);
        }
        if (missing > 0) process.exitCode = 1;
        console.log('Done. The jobs role scores sites every 5 min and runs the predictive scan every 30 min.');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((e) => {
    console.error('seed-readings failed:', e.message || e);
    process.exit(1);
});
