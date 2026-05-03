const payloadString = `{"timestamp":1771785069,"gateway":{"name":"AXM-WEB2","model":"AXM-WEB2","serial":"AN54072075"},"device":{"name":" Shoprite","model":"Acuvim-II","serial":"AHB55050856","online":true,"readings":[{"param":"V1","value":"243.538","unit":"V"},{"param":"V2","value":"241.173","unit":"V"},{"param":"V3","value":"242.855","unit":"V"},{"param":"Vnavg_V","value":"242.522","unit":"V"},{"param":"I1","value":"2.620","unit":"A"},{"param":"I2","value":"2.655","unit":"A"},{"param":"I3","value":"1.763","unit":"A"},{"param":"Iavg_A","value":"2.346","unit":"A"},{"param":"P1","value":"0.171","unit":"kW"},{"param":"P2","value":"-0.141","unit":"kW"},{"param":"P3","value":"-0.011","unit":"kW"},{"param":"Psum_kW","value":"0.019","unit":"kW"},{"param":"Q1","value":"-0.608","unit":"kvar"},{"param":"Q2","value":"-0.620","unit":"kvar"},{"param":"Q3","value":"-0.425","unit":"kvar"},{"param":"Qsum_kvar","value":"-1.652","unit":"kvar"},{"param":"S1","value":"0.638","unit":"kVA"},{"param":"S2","value":"0.641","unit":"kVA"},{"param":"S3","value":"0.429","unit":"kVA"},{"param":"Ssum_kVA","value":"1.708","unit":"kVA"},{"param":"PF1","value":"0.268","unit":""},{"param":"PF2","value":"-0.219","unit":""},{"param":"PF3","value":"-0.026","unit":""},{"param":"PF","value":"0.011","unit":""},{"param":"Freq_Hz","value":"50.054","unit":"Hz"}]}}`;

function extractAcuvimWeb2(payload) {
    if (!payload.device || !Array.isArray(payload.device.readings)) {
        return payload;
    }

    // Transform the array of {param: "V1", value: "243.538"} into a flat dictionary
    const data = {};
    for (const reading of payload.device.readings) {
        data[reading.param] = parseFloat(reading.value);
    }
    return data;
}

const payload = JSON.parse(payloadString);
const data = extractAcuvimWeb2(payload);

const v_a = data.V1 || data.Vnavg_V || data.V_A || data.Voltage_LN || data.voltage_a || null;
const i_a = data.I1 || data.Iavg_A || data.I_A || data.Current || data.current_a || null;
const p_total = data.Psum_kW || data.P_Total || data.Active_Power || data.power_active_total || null;
const q_total = data.Qsum_kvar || data.Q_Total || data.Reactive_Power || data.power_reactive_total || null;
const s_total = data.Ssum_kVA || data.S_Total || data.Apparent_Power || data.power_apparent_total || null;
const pf_total = data.PF || data.Power_Factor || data.power_factor_total || null;
const freq = data.Freq_Hz || data.F || data.Freq || data.frequency || null;

console.log({ v_a, i_a, p_total, q_total, s_total, pf_total, freq });
