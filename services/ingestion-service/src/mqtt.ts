import mqtt from 'mqtt';
import { Pool } from 'pg';

export async function initMqtt(pool: Pool) {
    console.log("Initializing MQTT Acuvim Telemetry Listener...");

    // Ensure Grid-X columns exist
    const client = await pool.connect();
    try {
        await client.query(`
            ALTER TABLE meter_readings 
            ADD COLUMN IF NOT EXISTS power_kw_draw DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS power_kw_gen DOUBLE PRECISION;
        `);
    } catch (e) {
        console.error("Failed to add Grid-X columns to meter_readings", e);
    } finally {
        client.release();
    }

    // Connect to the Mosquitto Broker (using the internal docker network or localhost)
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

    const mqttClient = mqtt.connect(brokerUrl, {
        username: 'acuvim_meter',
        password: 'secure_password123',
        reconnectPeriod: 5000,
    });

    mqttClient.on('connect', () => {
        console.log(`Connected to MQTT Broker at ${brokerUrl}`);
        // Subscribe to Acuvim telemetry data
        mqttClient.subscribe('acuvim/+/telemetry', (err) => {
            if (!err) {
                console.log('Subscribed to Acuvim telemetry topics (acuvim/+/telemetry)');
            } else {
                console.error('Failed to subscribe to MQTT topic:', err);
            }
        });
    });

    mqttClient.on('message', async (topic, message) => {
        try {
            // Topic format: acuvim/{meter_id}/telemetry
            const parts = topic.split('/');
            const meterId = parts[1];
            const payloadString = message.toString();
            const payload = JSON.parse(payloadString);

            // Log the raw payload once so we can see the exact names Acuvim uses
            console.log(`\n[MQTT DEBUG] Raw payload from ${meterId}:`, payloadString);

            // Extract the parameters (we check common Acuvim JSON keys for these types)
            // Note: If the Acuvim nests these inside a "Data" object, we check that too:
            const data = payload.Data || payload;

            const v_a = data.V_A || data.Voltage_LN || data.voltage_a || null;
            const i_a = data.I_A || data.Current || data.current_a || null;
            const p_total = data.P_Total || data.Active_Power || data.power_active_total || null;
            const q_total = data.Q_Total || data.Reactive_Power || data.power_reactive_total || null;
            const s_total = data.S_Total || data.Apparent_Power || data.power_apparent_total || null;
            const pf_total = data.PF || data.Power_Factor || data.power_factor_total || null;
            const freq = data.F || data.Freq || data.frequency || null;

            // Grid-X specific derivations (if the meter doesn't explicitly send them)
            const p_draw = data.power_kw_draw || (p_total && p_total > 0 ? p_total : 0);
            const p_gen = data.power_kw_gen || (p_total && p_total < 0 ? Math.abs(p_total) : 0);

            const insertQuery = `
                INSERT INTO meter_readings (
                    time, meter_id, voltage_a, current_a, power_active_total, 
                    power_reactive_total, power_apparent_total, power_factor_total, frequency,
                    power_kw_draw, power_kw_gen
                ) VALUES (
                    NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
                )
            `;

            await pool.query(insertQuery, [meterId, v_a, i_a, p_total, q_total, s_total, pf_total, freq, p_draw, p_gen]);

            console.log(`[MQTT INGEST] -> ${meterId} | V: ${v_a} | I: ${i_a} | Power: ${p_total}kW | PF: ${pf_total} | Hz: ${freq}`);

        } catch (error) {
            console.error('[MQTT] Error processing telemetry payload:', error);
        }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Client Error:', err);
    });
}
