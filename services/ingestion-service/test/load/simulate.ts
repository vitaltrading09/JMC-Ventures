// Ingest load test (plan Phase 3, tasks 7 and 8).
//
//   npx tsx services/ingestion-service/test/load/simulate.ts [options]
//
// Creates a throwaway tenant/site with N meters, then over MQTT (QoS 1):
//   - N live meters publish one reading per second for --minutes;
//   - one more meter replays a --backlog-hours store-and-forward backlog
//     (one reading per second of device time) as fast as the broker takes it;
//   - optionally, at --kill-at seconds, runs --kill-cmd (e.g. restart ingest).
// Then it waits for the database to settle and reports: rows/s, p95 publish →
// commit, conflicts and dead letters, DB CPU, and lost rows (expected vs
// actual per meter; acceptance is zero).
//
// Environment:
//   LOADTEST_DATABASE_URL   postgres URL of the stack's database (required)
//   LOADTEST_MQTT_URL       e.g. mqtts://127.0.0.1:8883 (required)
//   LOADTEST_MQTT_USERNAME / LOADTEST_MQTT_PASSWORD   a user allowed to write acuvim/+/telemetry
//   LOADTEST_MQTT_CA        CA file for mqtts (optional)
//   LOADTEST_MQTT_SERVERNAME  TLS server name when connecting by IP (e.g. mqtt.localhost)
//
// Options: --meters 20 --minutes 10 --backlog-hours 2 --kill-at <s> --kill-cmd "<cmd>"
//          --db-container <name> (docker stats for DB CPU) --logs-cmd "<cmd>" (ingest logs,
//          to sum conflicts) --out report.json

import { execSync, exec } from 'child_process';
import fs from 'fs';
import mqtt from 'mqtt';
import { Pool } from 'pg';

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
}
const METERS = Number(arg('meters', '20'));
const MINUTES = Number(arg('minutes', '10'));
const BACKLOG_HOURS = Number(arg('backlog-hours', '2'));
const KILL_AT = arg('kill-at') ? Number(arg('kill-at')) : null;
const KILL_CMD = arg('kill-cmd');
const DB_CONTAINER = arg('db-container');
const LOGS_CMD = arg('logs-cmd');
const OUT = arg('out');

const DB_URL = process.env.LOADTEST_DATABASE_URL;
const MQTT_URL = process.env.LOADTEST_MQTT_URL;
if (!DB_URL || !MQTT_URL) {
    console.error('Set LOADTEST_DATABASE_URL and LOADTEST_MQTT_URL (see the header of this file).');
    process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);

function mqttOptions(clientId: string): mqtt.IClientOptions {
    const o: mqtt.IClientOptions = {
        clientId,
        username: process.env.LOADTEST_MQTT_USERNAME,
        password: process.env.LOADTEST_MQTT_PASSWORD,
        clean: true,
        reconnectPeriod: 1000,
    };
    if (process.env.LOADTEST_MQTT_CA) o.ca = fs.readFileSync(process.env.LOADTEST_MQTT_CA);
    if (process.env.LOADTEST_MQTT_SERVERNAME) (o as any).servername = process.env.LOADTEST_MQTT_SERVERNAME;
    return o;
}

// Plausible 3-phase readings. Half the meters use the AXM-WEB2 array format,
// half the direct dict, so both parser paths are loaded.
function payload(i: number, tsMs: number): string {
    const j = (x: number, spread: number) => +(x + (Math.random() - 0.5) * spread).toFixed(3);
    const vals: Record<string, number> = {
        V1: j(230, 4), V2: j(230, 4), V3: j(230, 4), V12: j(398, 6), V23: j(398, 6), V31: j(398, 6),
        I1: j(50, 10), I2: j(50, 10), I3: j(50, 10), In: j(2, 1),
        P1: j(11, 2), P2: j(11, 2), P3: j(11, 2), Psum_kW: j(33, 6), Qsum_kvar: j(8, 2), Ssum_kVA: j(34, 6),
        PF1: j(0.96, 0.02), PF2: j(0.96, 0.02), PF3: j(0.96, 0.02), PF: j(0.96, 0.02), Freq_Hz: j(50, 0.05),
        THD_V1: j(2, 0.5), THD_V2: j(2, 0.5), THD_V3: j(2, 0.5), THD_I1: j(8, 2), THD_I2: j(8, 2), THD_I3: j(8, 2),
        Ep_imp: 100000 + tsMs / 3.6e6,
    };
    if (i % 2 === 0) {
        return JSON.stringify({
            timestamp: tsMs, gateway: { name: 'AXM-WEB2', serial: `LT-GW-${i}` },
            device: { model: 'Acuvim-II', serial: `LT-${run}-${i}`, readings: Object.entries(vals).map(([param, v]) => ({ param, value: String(v) })) },
        });
    }
    return JSON.stringify({ ...vals, timestamp: tsMs });
}

function connect(clientId: string): Promise<mqtt.MqttClient> {
    return new Promise((resolve, reject) => {
        const c = mqtt.connect(MQTT_URL!, mqttOptions(clientId));
        c.once('connect', () => resolve(c));
        c.once('error', reject);
    });
}

function publish(c: mqtt.MqttClient, topic: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => c.publish(topic, body, { qos: 1 }, (e) => (e ? reject(e) : resolve())));
}

async function main() {
    // A Pool, so a database restart during the test (outage test) costs a
    // failed poll, not the simulator.
    const db = new Pool({ connectionString: DB_URL, max: 2 });
    db.on('error', () => {});

    // Host vs DB clock, so publish → commit latency is not skewed.
    const t1 = Date.now();
    const dbNow = (await db.query(`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms`)).rows[0].ms;
    const skewMs = Number(dbNow) - (t1 + (Date.now() - t1) / 2);

    // ── Fixtures ──────────────────────────────────────────────────────────
    const tenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`Load test ${run}`])).rows[0].id;
    const site = (await db.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenant, `Load test ${run}`])).rows[0].id;
    const meterIds: string[] = [];
    for (let i = 0; i <= METERS; i++) {
        const r = await db.query(`INSERT INTO meters (site_id, name, serial_number) VALUES ($1, $2, $3) RETURNING id`,
            [site, i === METERS ? `LT replay ${run}` : `LT live ${i} ${run}`, `LT-${run}-${i}`]);
        meterIds.push(r.rows[0].id);
    }
    const live = meterIds.slice(0, METERS);
    const replay = meterIds[METERS];
    const deadBefore = Number((await db.query(`SELECT count(*) FROM dead_letter_payloads`)).rows[0].count);
    console.log(`[load] run ${run}: ${METERS} live meters + 1 replay meter, ${MINUTES} min, backlog ${BACKLOG_HOURS} h, clock skew ${skewMs.toFixed(0)} ms`);

    // ── DB CPU sampling ───────────────────────────────────────────────────
    const cpu: number[] = [];
    const cpuTimer = DB_CONTAINER ? setInterval(() => {
        exec(`docker stats --no-stream --format "{{.CPUPerc}}" ${DB_CONTAINER}`, (err, out) => {
            if (!err) cpu.push(parseFloat(out));
        });
    }, 10_000) : null;

    // ── Live meters ───────────────────────────────────────────────────────
    const clients = await Promise.all(live.map((_, i) => connect(`lt-${run}-${i}`)));
    const published = new Map<string, number>(meterIds.map((id) => [id, 0]));
    const startedAt = Date.now();
    const endAt = startedAt + MINUTES * 60_000;
    let publishErrors = 0;

    const liveLoops = live.map(async (id, i) => {
        const c = clients[i];
        // Spread meters across the second, as real meters are.
        await sleep((1000 / METERS) * i);
        let next = Date.now();
        while (next < endAt) {
            const ts = next;
            published.set(id, published.get(id)! + 1);
            publish(c, `acuvim/${id}/telemetry`, payload(i, ts)).catch(() => { publishErrors++; });
            next += 1000;
            await sleep(Math.max(0, next - Date.now()));
        }
    });

    // ── Store-and-forward replay (as fast as possible) ────────────────────
    const replayClient = await connect(`lt-${run}-replay`);
    const backlog = Math.round(BACKLOG_HOURS * 3600);
    const replayStart = Date.now();
    const replayLoop = (async () => {
        const base = replayStart - backlog * 1000;
        // Bounded window of outstanding QoS 1 publishes; no artificial delay.
        const inflight = new Set<Promise<void>>();
        for (let k = 0; k < backlog; k++) {
            published.set(replay, published.get(replay)! + 1);
            const p = publish(replayClient, `acuvim/${replay}/telemetry`, payload(METERS, base + k * 1000))
                .catch(() => { publishErrors++; })
                .finally(() => inflight.delete(p));
            inflight.add(p);
            if (inflight.size >= 200) await Promise.race(inflight);
        }
        await Promise.all(inflight);
        return Date.now() - replayStart;
    })();

    // ── Kill test ─────────────────────────────────────────────────────────
    // Without --kill-cmd, --kill-at only marks when an external restart happens
    // (e.g. a host-side `docker compose restart ingest` when this runs in a container).
    let killedAt: number | null = null;
    if (KILL_AT !== null) {
        setTimeout(() => {
            killedAt = Date.now();
            if (!KILL_CMD) return;
            console.log(`[load] t=${KILL_AT}s: ${KILL_CMD}`);
            try { execSync(KILL_CMD, { stdio: 'inherit' }); } catch (e: any) { console.error('[load] kill command failed:', e.message); }
            console.log(`[load] kill command done after ${((Date.now() - killedAt) / 1000).toFixed(1)} s`);
        }, KILL_AT * 1000);
    }

    const progress = setInterval(async () => {
        try {
            const n = (await db.query(`SELECT count(*) FROM meter_readings WHERE meter_id = ANY($1)`, [meterIds])).rows[0].count;
            console.log(`[load] t=${Math.round((Date.now() - startedAt) / 1000)}s committed rows: ${n}`);
        } catch (e: any) {
            console.log(`[load] t=${Math.round((Date.now() - startedAt) / 1000)}s database unavailable (${e.message})`);
        }
    }, 30_000);

    const replayMs = await replayLoop;
    console.log(`[load] replay of ${backlog} readings published in ${(replayMs / 1000).toFixed(1)} s`);
    await Promise.all(liveLoops);
    clearInterval(progress);
    const publishEndedAt = Date.now();

    // ── Settle: wait until every published row is committed (or 3 min) ─────
    const expectedTotal = [...published.values()].reduce((a, b) => a + b, 0);
    let actualTotal = 0;
    for (let i = 0; i < 180; i++) {
        try {
            actualTotal = Number((await db.query(`SELECT count(*) FROM meter_readings WHERE meter_id = ANY($1)`, [meterIds])).rows[0].count);
            if (actualTotal >= expectedTotal) break;
        } catch { /* database still coming back */ }
        await sleep(1000);
    }
    if (cpuTimer) clearInterval(cpuTimer);
    await Promise.all([...clients, replayClient].map((c) => new Promise((r) => c.end(false, {}, r))));

    // ── Report ────────────────────────────────────────────────────────────
    const perMeter = (await db.query(
        `SELECT meter_id, count(*)::int AS n, min(ingested_at) AS first, max(ingested_at) AS last FROM meter_readings WHERE meter_id = ANY($1) GROUP BY meter_id`,
        [meterIds])).rows;
    const actual = new Map(perMeter.map((r: any) => [String(r.meter_id), r]));
    const lost = meterIds.map((id) => ({ id, expected: published.get(id)!, actual: actual.get(id)?.n ?? 0 }))
        .filter((m) => m.actual !== m.expected);

    // publish → commit for live meters (time = device timestamp = publish time).
    const lat = (await db.query(`
        SELECT percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY ms) AS p, max(ms) AS max
        FROM (SELECT extract(epoch FROM ingested_at - time) * 1000 - $2 AS ms FROM meter_readings WHERE meter_id = ANY($1)) x`,
        [live, skewMs])).rows[0];
    let latNoKill: any = null;
    if (killedAt !== null) {
        latNoKill = (await db.query(`
            SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95
            FROM (SELECT extract(epoch FROM ingested_at - time) * 1000 - $2 AS ms FROM meter_readings
                  WHERE meter_id = ANY($1) AND time NOT BETWEEN to_timestamp($3 / 1000.0) - interval '5 s' AND to_timestamp($3 / 1000.0) + interval '60 s') x`,
            [live, skewMs, killedAt])).rows[0];
    }
    // Replay throughput: from the first replay publish to the commit of its last row.
    const r = actual.get(replay);
    const replayCommitS = r ? Math.max(0.001, (new Date(r.last).getTime() - skewMs - replayStart) / 1000) : null;
    const deadAfter = Number((await db.query(`SELECT count(*) FROM dead_letter_payloads`)).rows[0].count);
    const timeSources = (await db.query(
        `SELECT time_source, count(*)::int AS n FROM meter_readings WHERE meter_id = ANY($1) GROUP BY 1`, [meterIds])).rows;

    let conflicts: number | null = null;
    if (LOGS_CMD) {
        try {
            const logs = execSync(LOGS_CMD, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            conflicts = [...logs.matchAll(/(\d+) conflicts,/g)].reduce((a, m) => a + Number(m[1]), 0);
        } catch { /* optional */ }
    }

    const liveSeconds = (publishEndedAt - startedAt) / 1000;
    const liveRows = live.reduce((a, id) => a + (actual.get(id)?.n ?? 0), 0);
    const report = {
        run, meters: METERS, minutes: MINUTES, backlogReadings: backlog,
        published: expectedTotal, committed: actualTotal, lostRows: expectedTotal - actualTotal,
        metersWithMismatch: lost,
        liveRowsPerSecond: +(liveRows / liveSeconds).toFixed(1),
        replay: { readings: backlog, publishSeconds: +(replayMs / 1000).toFixed(1),
                  secondsUntilAllCommitted: replayCommitS === null ? null : +replayCommitS.toFixed(1),
                  rowsPerSecond: replayCommitS ? +(backlog / replayCommitS).toFixed(0) : null },
        publishToCommitMs: { p50: Math.round(lat.p[0]), p95: Math.round(lat.p[1]), p99: Math.round(lat.p[2]), max: Math.round(lat.max),
                             p95ExcludingKillWindow: latNoKill ? Math.round(latNoKill.p95) : undefined },
        timeSources, deadLetters: deadAfter - deadBefore, conflictsFromIngestLogs: conflicts, publishErrors,
        dbCpuPercent: cpu.length ? { avg: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1), max: Math.max(...cpu) } : null,
        killedAtSecond: KILL_AT, clockSkewMs: Math.round(skewMs),
    };
    console.log('\n' + JSON.stringify(report, null, 2));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await db.end();
    process.exit(report.lostRows === 0 ? 0 : 2);
}

main().catch((e) => {
    console.error('[load] FAILED:', e);
    process.exit(1);
});
