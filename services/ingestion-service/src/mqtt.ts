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
            let payloadString = message.toString().trim();
            // Strip any null bytes or weird unprintable control characters that break JSON.parse
            payloadString = payloadString.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "");

            // Log the raw payload FIRST so we always see what the meter sends
            console.log(`\n[MQTT TIMESTAMP: ${new Date().toISOString()}]`);
            console.log(`[MQTT DEBUG] Raw payload from ${meterId}:`, payloadString);

            let payload;
            try {
                payload = JSON.parse(payloadString);
            } catch (parseError: any) {
                console.error(`[MQTT ERROR] Could not parse payload as JSON from ${meterId}. Error: ${parseError.message}`);
                return; // Exit early if it's not JSON
            }

            // --- AXM-WEB2 Gateway Format Conversion ---
            // The meter sends data like: { device: { readings: [ {param: "V1", value: "243.5"} ] } }
            let data: any = payload.Data || payload; // Default assumption

            if (payload.device && Array.isArray(payload.device.readings)) {
                // Flatten the readings array into a dictionary object map
                data = {};
                for (const reading of payload.device.readings) {
                    if (reading && reading.param) {
                        data[reading.param] = parseFloat(reading.value);
                    }
                }
            }

            // Extract the parameters using standard Acuvim keys or the newly flattened AXM-WEB2 keys
            const v_a = data.V1 || data.Vnavg_V || data.V_A || data.Voltage_LN || data.voltage_a || null;
            const i_a = data.I1 || data.Iavg_A || data.I_A || data.Current || data.current_a || null;
            const p_total = data.Psum_kW || data.P_Total || data.Active_Power || data.power_active_total || null;
            const q_total = data.Qsum_kvar || data.Q_Total || data.Reactive_Power || data.power_reactive_total || null;
            const s_total = data.Ssum_kVA || data.S_Total || data.Apparent_Power || data.power_apparent_total || null;
            const pf_total = data.PF || data.Power_Factor || data.power_factor_total || data.PF1 || null;
            const freq = data.Freq_Hz || data.F || data.Freq || data.frequency || null;

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

            let actualMeterId = meterId;
            let insertSuccess = false;

            try {
                await pool.query(insertQuery, [actualMeterId, v_a, i_a, p_total, q_total, s_total, pf_total, freq, p_draw, p_gen]);
                insertSuccess = true;
            } catch (dbErr: any) {
                // 23503 = foreign_key_violation, 22P02 = invalid_text_representation (invalid UUID lookup)
                if (dbErr.code === '23503' || dbErr.code === '22P02') {
                    const serial = payload?.device?.serial || payload?.gateway?.serial;
                    if (serial) {
                        const lookup = await pool.query('SELECT id FROM meters WHERE serial_number = $1', [serial]);
                        if (lookup.rows.length > 0) {
                            actualMeterId = lookup.rows[0].id;
                            await pool.query(insertQuery, [actualMeterId, v_a, i_a, p_total, q_total, s_total, pf_total, freq, p_draw, p_gen]);
                            insertSuccess = true;
                        }
                    }
                }

                if (!insertSuccess) {
                    console.error(`[MQTT ERROR] Failed to insert reading for meterId: ${meterId}. Error: ${dbErr.message}`);
                }
            }

            if (insertSuccess) {
                console.log(`[MQTT INGEST] -> ${actualMeterId} | V: ${v_a} | I: ${i_a} | Power: ${p_total}kW | PF: ${pf_total} | Hz: ${freq}`);
            }

        } catch (error) {
            console.error('[MQTT] Error processing telemetry payload:', error);
        }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Client Error:', err);
    });
}
