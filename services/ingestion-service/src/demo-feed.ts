// Live demo feed (local dev only): the five demo meters publish over MQTT like
// real boxes, so the portal's live tiles, alerts and charts move.
//
//   docker compose --profile demo up -d demo-feed
//
// Refuses to run without ALLOW_DEMO_SEED=true. Publishes only for the demo
// meters (found by their DEMO-* serials, src/demo-profiles.ts) on
// acuvim/<meter id>/telemetry, every DEMO_FEED_INTERVAL_S seconds (default 5),
// as broker user DEMO_FEED_MQTT_USERNAME (default demo-feed), which the local
// ACL lets write to any telemetry topic. Values come from the same profiles as
// scripts/seed-readings.ts; the energy register continues from the meter's
// last stored value so it stays monotonic.
//
// Rows arrive through the real ingest path, so they are tagged like any MQTT
// reading (time_source from the payload/server), not SIMULATED. They belong
// to demo meters only.

import mqtt from 'mqtt';
import fs from 'fs';
import { Pool } from 'pg';
import { DEMO_PROFILES, instantReading, type DemoSiteProfile } from './demo-profiles';

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** NEMA-style unbalance: largest deviation from the mean, % of the mean. */
export function unbalancePct(xs: number[]): number {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (m <= 0) return 0;
    return r2(Math.max(...xs.map((x) => Math.abs(x - m))) / m * 100);
}

/** The JSON a demo meter publishes at `ms` (column names are accepted by src/ingest/channels.ts). */
export function demoPayload(p: DemoSiteProfile, ms: number, energyKwh: number) {
    const x = instantReading(p, ms);
    return {
        ts: new Date(ms).toISOString(),
        voltage_a: x.voltage_a, voltage_b: x.voltage_b, voltage_c: x.voltage_c,
        current_a: x.current_a, current_b: x.current_b, current_c: x.current_c,
        power_active_total: x.power_active_total, power_reactive_total: x.power_reactive_total,
        power_apparent_total: x.power_apparent_total, power_factor_total: x.power_factor_total,
        frequency: x.frequency,
        thd_voltage_a: x.thd_voltage_a, thd_voltage_b: r2(x.thd_voltage_a * 0.97), thd_voltage_c: r2(x.thd_voltage_a * 1.02),
        thd_current_a: x.thd_current_a, thd_current_b: r2(x.thd_current_a * 1.03), thd_current_c: r2(x.thd_current_a * 0.98),
        voltage_unbalance: unbalancePct([x.voltage_a, x.voltage_b, x.voltage_c]),
        current_unbalance: unbalancePct([x.current_a, x.current_b, x.current_c]),
        energy_import_total: r2(energyKwh),
    };
}

async function main() {
    if (process.env.ALLOW_DEMO_SEED !== 'true') {
        console.error('Refusing to run: set ALLOW_DEMO_SEED=true (local dev only).');
        process.exit(1);
    }
    for (const k of ['DATABASE_URL', 'MQTT_BROKER_URL', 'DEMO_FEED_MQTT_PASSWORD']) {
        if (!process.env[k]) { console.error(`FATAL: ${k} is not set.`); process.exit(1); }
    }
    const intervalS = Math.max(1, Number(process.env.DEMO_FEED_INTERVAL_S || 5));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

    const meters = (await pool.query(
        `SELECT id, serial_number FROM devices WHERE serial_number = ANY($1) AND archived_at IS NULL`,
        [DEMO_PROFILES.map((p) => p.meterSerial)])).rows;
    const feeds: { id: string; profile: DemoSiteProfile; energy: number }[] = [];
    for (const m of meters) {
        const profile = DEMO_PROFILES.find((p) => p.meterSerial === m.serial_number)!;
        const last = (await pool.query(
            `SELECT energy_import_total FROM meter_readings WHERE meter_id = $1 AND energy_import_total IS NOT NULL
             ORDER BY time DESC LIMIT 1`, [m.id])).rows[0];
        feeds.push({ id: m.id as string, profile, energy: Number(last?.energy_import_total ?? profile.energyStartKwh) });
    }
    await pool.end();
    if (feeds.length === 0) { console.error('No demo meters (DEMO-* serials). Run the demo seed first.'); process.exit(1); }

    const ca = process.env.MQTT_CA_CERT && fs.existsSync(process.env.MQTT_CA_CERT) ? fs.readFileSync(process.env.MQTT_CA_CERT) : undefined;
    const client = mqtt.connect(process.env.MQTT_BROKER_URL!, {
        username: process.env.DEMO_FEED_MQTT_USERNAME || 'demo-feed',
        password: process.env.DEMO_FEED_MQTT_PASSWORD,
        clientId: `demo-feed-${process.pid}`,
        ca,
        rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
        reconnectPeriod: 5000,
    });
    client.on('connect', () => console.log(`[demo-feed] connected; ${feeds.length} meters every ${intervalS} s: ${feeds.map((f) => f.profile.key).join(', ')}`));
    client.on('error', (e) => console.error('[demo-feed] MQTT error:', e.message));

    let lastMs = Date.now();
    const tick = () => {
        if (!client.connected) return;
        const now = Date.now();
        const hours = (now - lastMs) / 3_600_000;
        lastMs = now;
        for (const f of feeds) {
            f.energy += instantReading(f.profile, now).power_active_total * hours;
            client.publish(`acuvim/${f.id}/telemetry`, JSON.stringify(demoPayload(f.profile, now, f.energy)), { qos: 1 });
        }
    };
    const timer = setInterval(tick, intervalS * 1000);
    const stop = () => { clearInterval(timer); client.end(false, {}, () => process.exit(0)); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    console.log(`[demo-feed] energy registers start at ${feeds.map((f) => `${f.profile.key} ${r1(f.energy)} kWh`).join(', ')}`);
}

if (require.main === module) {
    main().catch((e) => { console.error('[demo-feed] fatal:', e); process.exit(1); });
}
