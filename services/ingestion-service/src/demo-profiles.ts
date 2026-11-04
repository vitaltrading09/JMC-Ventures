// ─────────────────────────────────────────────────────────────────────────────
// Synthetic meter data — LOCAL DEVELOPMENT ONLY
//
// Pure maths behind scripts/seed-readings.ts, which writes these rows into
// meter_readings so the UI and the scoring / predictive / recommendation
// engines can be exercised without production data. Nothing in the service
// imports this file; it lives here so the build and `npm test` cover it.
//
// Every value is a pure function of (profile, timestamp). Noise comes from a
// hash of the meter seed and the minute, not from Math.random, so a re-run
// reproduces identical rows for timestamps that already exist (and ON CONFLICT
// skips them), and the energy register integrates from a fixed epoch, so it
// keeps increasing across runs that cover different windows.
//
// Times: South Africa has no DST, so local time is UTC+2 all year.
// ─────────────────────────────────────────────────────────────────────────────

/** Marks every synthetic row in meter_readings.time_source (VARCHAR(10)). */
export const SIMULATED_TIME_SOURCE = 'SIMULATED';

/** Prefix on synthetic alert messages: the alerts table has no source column. */
export const SIMULATED_ALERT_PREFIX = '[SIMULATED] ';

/** The energy register integrates from here, so it is independent of the run window. */
export const ENERGY_EPOCH_MS = Date.UTC(2024, 0, 1);

const SAST_OFFSET_MS = 2 * 3_600_000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

// NRS 048-2 limits, matching the defaults in mqtt.ts and the analytics pages.
export const NRS048 = {
    minV: 207, maxV: 253, maxThd: 8.0, minFreq: 49.0, maxFreq: 51.0, minPf: 0.85,
} as const;

export type DemoProblem = 'LOW_PF' | 'HIGH_THD' | 'PHASE_IMBALANCE' | 'VOLTAGE_SAG' | 'MDI_EXCEEDED';
export type LoadShape = 'office' | 'factory' | 'cold_store' | 'retail' | 'datacentre';

export interface DemoSiteSettings {
    tariff_type:         'MEGAFLEX' | 'TOU' | 'FLAT';
    tariff_peak:         number;   // R/kWh
    tariff_standard:     number;
    tariff_offpeak:      number;
    peak_times:          string;
    standard_times:      string;
    offpeak_times:       string;
    tariff_demand:       number;   // R/kVA/month
    contracted_mdi_kva:  number;
    demand_interval_min: number;
    alert_max_kw:        number;
    alert_min_v:         number;
    alert_max_v:         number;
    alert_max_thd:       number;
    alert_min_freq:      number;
    alert_max_freq:      number;
}

export interface DemoSiteProfile {
    key:          string;
    /** Must match the site name in services/auth-service/src/seed.ts. */
    siteName:     string;
    /** Must match the meter serial in seed.ts; the generator only writes to these meters. */
    meterSerial:  string;
    seed:         number;
    shape:        LoadShape;
    baseKw:       number;      // overnight / idle load
    peakKw:       number;      // typical weekday peak, before demand spikes
    /** Power factor at no load and at full load; it improves as motors load up. */
    pfIdle:       number;
    pfFull:       number;
    /** Voltage THD % at no load / full load; rises steeply near full load (lf³). */
    thdV:         [number, number];
    /** Current THD % at no load / full load, linear. A light load reads high (small fundamental). */
    thdI:         [number, number];
    /** Phase current shares, mean 1. Unequal shares model single-phase loads on one phase. */
    currentSplit: [number, number, number];
    /** Phase-neutral voltage at no load, before the diurnal swing. */
    vNominal:     [number, number, number];
    /** Volts lost at full load (supply impedance). */
    vDropFull:    number;
    sags?:        { minDepthV: number; maxDepthV: number; extraEventChance: number };
    demandSpikes?: { weekdayChance: number; minExtra: number; maxExtra: number };
    energyStartKwh: number;
    problems:     DemoProblem[];
    meta:         { site_type: string; load_types: string[]; load_description: string };
    settings:     DemoSiteSettings;
}

// Eskom Megaflex-style schedule, as the tariff settings page pre-fills it.
const ESKOM_TIMES = {
    peak_times:     '07:00 - 10:00, 18:00 - 20:00',
    standard_times: '06:00 - 07:00, 10:00 - 18:00, 20:00 - 22:00',
    offpeak_times:  '22:00 - 06:00',
};
// R/kWh, matching the constants in CLAUDE.md.
const ESKOM_RATES = { tariff_peak: 5.80, tariff_standard: 2.40, tariff_offpeak: 1.40 };
const NRS_ALERTS = {
    alert_min_v: NRS048.minV, alert_max_v: NRS048.maxV, alert_max_thd: NRS048.maxThd,
    alert_min_freq: NRS048.minFreq, alert_max_freq: NRS048.maxFreq,
};

export const DEMO_PROFILES: DemoSiteProfile[] = [
    {
        // The control: an office with a working PFC bank and clean supply.
        key: 'hq', siteName: 'Headquarters', meterSerial: 'DEMO-HQ-001', seed: 1101,
        shape: 'office', baseKw: 35, peakKw: 180,
        pfIdle: 0.955, pfFull: 0.985, thdV: [1.6, 2.6], thdI: [9, 3.5],
        currentSplit: [1.02, 0.99, 0.99], vNominal: [232, 231.5, 232.5], vDropFull: 2.5,
        energyStartKwh: 412_000, problems: [],
        meta: {
            site_type: 'Office Building',
            load_types: ['hvac_chiller', 'lighting_led', 'office_equipment', 'it_servers'],
            load_description: 'Head office, 4 floors. Chiller plant, LED lighting, small server room. PFC bank serviced last year.',
        },
        settings: {
            tariff_type: 'TOU', ...ESKOM_RATES, ...ESKOM_TIMES, tariff_demand: 245,
            contracted_mdi_kva: 300, demand_interval_min: 30, alert_max_kw: 260, ...NRS_ALERTS,
        },
    },
    {
        // Degraded capacitor bank: sustained PF ~0.75 inflates kVA, and the
        // weekday furnace + compressor starts push billed demand over the NMD.
        key: 'factory', siteName: 'Cape Town Factory', meterSerial: 'DEMO-CPT-001', seed: 2203,
        shape: 'factory', baseKw: 60, peakKw: 620,
        pfIdle: 0.70, pfFull: 0.785, thdV: [2.4, 3.6], thdI: [9, 14],
        currentSplit: [1.03, 0.98, 0.99], vNominal: [231, 230.5, 231.5], vDropFull: 6,
        demandSpikes: { weekdayChance: 0.6, minExtra: 0.35, maxExtra: 0.55 },
        energyStartKwh: 1_850_000, problems: ['LOW_PF', 'MDI_EXCEEDED'],
        meta: {
            site_type: 'Industrial / Manufacturing',
            load_types: ['motors_dol', 'compressor_air', 'ovens_industrial', 'conveyors', 'welding'],
            load_description: 'Two-shift metal fabrication. DOL motors, 2 x 75 kW air compressors, induction furnace. PFC bank installed 2014, two stages tripped.',
        },
        settings: {
            tariff_type: 'MEGAFLEX', ...ESKOM_RATES, ...ESKOM_TIMES, tariff_demand: 265,
            contracted_mdi_kva: 1000, demand_interval_min: 30, alert_max_kw: 800, ...NRS_ALERTS,
        },
    },
    {
        // Single-phase loads bunched on L1 (offices, chargers, lighting) leave
        // L3 lightly loaded: >20 % current imbalance, a little voltage unbalance.
        key: 'durban', siteName: 'Durban Distribution Ctr', meterSerial: 'DEMO-DBN-001', seed: 3307,
        shape: 'cold_store', baseKw: 140, peakKw: 360,
        pfIdle: 0.90, pfFull: 0.93, thdV: [2.0, 3.2], thdI: [8, 13],
        currentSplit: [1.30, 0.98, 0.72], vNominal: [227.5, 230.5, 233], vDropFull: 4,
        energyStartKwh: 960_000, problems: ['PHASE_IMBALANCE'],
        meta: {
            site_type: 'Cold Storage',
            load_types: ['refrig_coldroom', 'refrig_freezer', 'compressor_refrigeration', 'lighting_hid', 'ev_charging'],
            load_description: 'Cold-chain DC. Freezer and chiller rooms, forklift charging bay and offices fed from L1.',
        },
        settings: {
            // eThekwini municipal tariff integrates demand over 15 minutes.
            tariff_type: 'TOU', ...ESKOM_RATES, ...ESKOM_TIMES, tariff_demand: 210,
            contracted_mdi_kva: 500, demand_interval_min: 15, alert_max_kw: 450, ...NRS_ALERTS,
        },
    },
    {
        // Unfiltered VSDs on the HVAC plant: voltage THD above the 8 % NRS 048-2
        // limit whenever the mall is trading.
        key: 'mall', siteName: 'Sandton Mall', meterSerial: 'DEMO-SDT-001', seed: 4409,
        shape: 'retail', baseKw: 120, peakKw: 900,
        pfIdle: 0.92, pfFull: 0.945, thdV: [4.5, 9.6], thdI: [24, 42],
        currentSplit: [1.01, 1.00, 0.99], vNominal: [231.5, 231, 232], vDropFull: 4,
        energyStartKwh: 3_400_000, problems: ['HIGH_THD'],
        meta: {
            site_type: 'Retail / Supermarket',
            load_types: ['hvac_chiller', 'hvac_ahu', 'motors_vfd', 'lighting_led', 'refrig_displays'],
            load_description: 'Regional mall. Chiller plant and AHUs on VSDs without harmonic filters, tenant lighting, anchor supermarket.',
        },
        settings: {
            tariff_type: 'MEGAFLEX', ...ESKOM_RATES, ...ESKOM_TIMES, tariff_demand: 255,
            contracted_mdi_kva: 1400, demand_interval_min: 30, alert_max_kw: 1150, ...NRS_ALERTS,
        },
    },
    {
        // Flat 24/7 UPS load at the end of a weak municipal feeder: daily sags
        // below 207 V. Everything else is clean.
        key: 'datacentre', siteName: 'Pretoria Data Center', meterSerial: 'DEMO-PTA-001', seed: 5501,
        shape: 'datacentre', baseKw: 380, peakKw: 460,
        pfIdle: 0.98, pfFull: 0.99, thdV: [2.2, 2.9], thdI: [5, 8],
        currentSplit: [1.01, 1.00, 0.99], vNominal: [226, 225.5, 226.5], vDropFull: 3,
        sags: { minDepthV: 186, maxDepthV: 203, extraEventChance: 0.35 },
        energyStartKwh: 5_200_000, problems: ['VOLTAGE_SAG'],
        meta: {
            site_type: 'Other',
            load_types: ['it_servers', 'hvac_split_ac', 'battery_storage'],
            load_description: 'Tier III colocation hall. Double-conversion UPS, CRAC units, diesel standby.',
        },
        settings: {
            tariff_type: 'MEGAFLEX', ...ESKOM_RATES, ...ESKOM_TIMES, tariff_demand: 245,
            contracted_mdi_kva: 650, demand_interval_min: 30, alert_max_kw: 560, ...NRS_ALERTS,
        },
    },
];

export interface DemoReading {
    time:                 Date;
    voltage_a:            number;
    voltage_b:            number;
    voltage_c:            number;
    current_a:            number;
    current_b:            number;
    current_c:            number;
    power_active_total:   number;   // kW
    power_reactive_total: number;   // kvar
    power_apparent_total: number;   // kVA
    power_factor_total:   number;
    frequency:            number;
    energy_import_total:  number;   // kWh register
    thd_voltage_a:        number;
    thd_current_a:        number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic noise
// ─────────────────────────────────────────────────────────────────────────────

/** Uniform [0, 1) from integer inputs (a murmur3-style finaliser). */
export function hash01(...parts: number[]): number {
    let h = 0x9e3779b9;
    for (const p of parts) {
        h = Math.imul(h ^ (p | 0), 0x85ebca6b);
        h = Math.imul(h ^ Math.floor(p / 4_294_967_296), 0xc2b2ae35);
        h ^= h >>> 16;
    }
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4_294_967_296;
}

/** Standard normal, Box–Muller over two hashes. */
function gauss(...parts: number[]): number {
    const u = Math.max(hash01(...parts, 1), 1e-12);
    const v = hash01(...parts, 2);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** 0 → 1 between a and b, smoothed. Handles a > b as a falling edge. */
function smooth(x: number, a: number, b: number): number {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
}
const window01 = (h: number, on0: number, on1: number, off0: number, off1: number) =>
    smooth(h, on0, on1) * (1 - smooth(h, off0, off1));

// Channels keep each noise stream independent of the others.
const CH = { kw: 1, pf: 2, va: 3, vb: 4, vc: 5, freq: 6, thdV: 7, thdI: 8, day: 9, sag: 10, spike: 11, ia: 12 };

// ─────────────────────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalTime { hour: number; dow: number; day: number }

/** SAST hour (fractional), day of week (0 = Sunday) and day number since the Unix epoch. */
export function localTime(ms: number): LocalTime {
    const local = ms + SAST_OFFSET_MS;
    const day = Math.floor(local / DAY_MS);
    return { hour: (local - day * DAY_MS) / 3_600_000, dow: (day + 4) % 7, day };
}

export type TouPeriod = 'PEAK' | 'STANDARD' | 'OFFPEAK';

/** Eskom Megaflex time-of-use period (weekday peaks 07–10 and 18–20). */
export function touPeriod(ms: number): TouPeriod {
    const { hour, dow } = localTime(ms);
    if (dow === 0) return 'OFFPEAK';
    if (dow === 6) return (hour >= 7 && hour < 12) || (hour >= 18 && hour < 20) ? 'STANDARD' : 'OFFPEAK';
    if ((hour >= 7 && hour < 10) || (hour >= 18 && hour < 20)) return 'PEAK';
    if ((hour >= 6 && hour < 7) || (hour >= 10 && hour < 18) || (hour >= 20 && hour < 22)) return 'STANDARD';
    return 'OFFPEAK';
}

// ─────────────────────────────────────────────────────────────────────────────
// Load shapes: fraction of (peak − base) in use, 0..1
// ─────────────────────────────────────────────────────────────────────────────

export function loadShape(shape: LoadShape, hour: number, dow: number): number {
    const weekday = dow >= 1 && dow <= 5;
    switch (shape) {
        case 'office': {
            if (!weekday) return dow === 6 ? 0.12 * window01(hour, 8, 9, 13, 14) : 0.03;
            // Arrivals ramp straight into the 07:00 peak window; chiller load
            // tops out mid-afternoon; lunch dips a little.
            const occupied = window01(hour, 6, 8.5, 17, 19.5);
            const lunch = 1 - 0.08 * window01(hour, 12, 12.5, 13.5, 14);
            const cooling = 0.12 * window01(hour, 11, 14, 16, 18);
            return clamp(occupied * 0.88 * lunch + cooling, 0, 1);
        }
        case 'factory': {
            if (dow === 0) return 0.02;
            if (dow === 6) return 0.6 * window01(hour, 5.5, 6.5, 12.5, 13.5);
            // Two shifts 06:00–22:00 with a changeover dip at 14:00.
            const shifts = window01(hour, 5.5, 6.5, 21.5, 22.5);
            const changeover = 1 - 0.35 * window01(hour, 13.75, 14, 14.25, 14.75);
            return 0.95 * shifts * changeover;
        }
        case 'cold_store': {
            // Refrigeration is in baseKw; this is picking, loading and charging.
            const ops = weekday ? window01(hour, 5, 6.5, 17, 18.5)
                : dow === 6 ? 0.5 * window01(hour, 5, 6.5, 11.5, 12.5) : 0;
            // Afternoon compressor duty rises with ambient temperature.
            const heat = 0.15 * window01(hour, 10, 13, 16, 19);
            return clamp(0.8 * ops + heat, 0, 1);
        }
        case 'retail': {
            const [open, close] = dow === 0 ? [9, 17] : [9, 21];
            const trading = window01(hour, open - 2, open, close, close + 1.5);
            const afternoonHvac = 0.2 * window01(hour, 12, 14, 15.5, 17.5);
            return clamp(0.78 * trading + afternoonHvac * trading, 0, 1);
        }
        case 'datacentre':
            // IT load is flat; cooling follows the day a little.
            return 0.55 + 0.35 * window01(hour, 9, 13, 16, 20);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Events: voltage sags and demand spikes, fixed per local day
// ─────────────────────────────────────────────────────────────────────────────

export interface DemoEvent { startMs: number; endMs: number; magnitude: number }

/** Day start (00:00 SAST) in UTC ms, for a local day number. */
const dayStartMs = (day: number) => day * DAY_MS - SAST_OFFSET_MS;

/** Sag events on one local day. Each lasts 6–20 min, so a 5-minute grid always samples it. */
export function sagEvents(p: DemoSiteProfile, day: number): DemoEvent[] {
    if (!p.sags) return [];
    const n = 1 + (hash01(p.seed, CH.sag, day, 0) < p.sags.extraEventChance ? 1 : 0);
    const out: DemoEvent[] = [];
    for (let i = 0; i < n; i++) {
        const start = dayStartMs(day) + Math.floor(hash01(p.seed, CH.sag, day, i, 1) * 1380) * MIN_MS;
        const dur = 6 + Math.floor(hash01(p.seed, CH.sag, day, i, 2) * 15);
        const depth = p.sags.minDepthV + hash01(p.seed, CH.sag, day, i, 3) * (p.sags.maxDepthV - p.sags.minDepthV);
        out.push({ startMs: start, endMs: start + dur * MIN_MS, magnitude: depth });
    }
    return out;
}

/** Demand spike on a weekday: 45–75 min during the day shift, magnitude = extra load as a fraction of peakKw. */
export function spikeEvents(p: DemoSiteProfile, day: number): DemoEvent[] {
    if (!p.demandSpikes) return [];
    const dow = (day + 4) % 7;
    if (dow === 0 || dow === 6) return [];
    if (hash01(p.seed, CH.spike, day, 0) >= p.demandSpikes.weekdayChance) return [];
    const startMin = 8 * 60 + Math.floor(hash01(p.seed, CH.spike, day, 1) * 7 * 60);   // 08:00–15:00
    const dur = 45 + Math.floor(hash01(p.seed, CH.spike, day, 2) * 31);
    const { minExtra, maxExtra } = p.demandSpikes;
    const start = dayStartMs(day) + startMin * MIN_MS;
    return [{ startMs: start, endMs: start + dur * MIN_MS, magnitude: minExtra + hash01(p.seed, CH.spike, day, 3) * (maxExtra - minExtra) }];
}

const inEvent = (events: DemoEvent[], ms: number) => events.find(e => ms >= e.startMs && ms < e.endMs);

// ─────────────────────────────────────────────────────────────────────────────
// One reading (everything except the energy register)
// ─────────────────────────────────────────────────────────────────────────────

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

type InstantReading = Omit<DemoReading, 'energy_import_total' | 'time'>;

export function instantReading(p: DemoSiteProfile, ms: number): InstantReading {
    const { hour, dow, day } = localTime(ms);
    const minute = Math.floor(ms / MIN_MS);

    // Load: base + shaped share of the swing, a per-day factor (weather,
    // production volume) and 1.5 % sample noise.
    const dayFactor = 1 + 0.05 * clamp(gauss(p.seed, CH.day, day), -2.5, 2.5);
    const frac = clamp(loadShape(p.shape, hour, dow) * dayFactor, 0, 1.15);
    let kw = p.baseKw + (p.peakKw - p.baseKw) * frac;
    const spike = inEvent(spikeEvents(p, day), ms);
    if (spike) kw += spike.magnitude * p.peakKw;
    kw = Math.max(0.5, kw * (1 + 0.015 * gauss(p.seed, CH.kw, minute)));
    const loadPu = clamp(kw / p.peakKw, 0, 1.5);

    const pf = clamp(p.pfIdle + (p.pfFull - p.pfIdle) * Math.min(loadPu, 1) + 0.006 * gauss(p.seed, CH.pf, minute), 0.5, 0.999);
    const kva = kw / pf;
    const kvar = Math.sqrt(Math.max(kva * kva - kw * kw, 0));

    // Voltage: supply drops with load, grid runs slightly high overnight.
    const diurnal = 1.5 * Math.cos(((hour - 3) / 24) * 2 * Math.PI);
    const sag = inEvent(sagEvents(p, day), ms);
    const vPhase = (i: 0 | 1 | 2, ch: number) => {
        const v = p.vNominal[i] - p.vDropFull * Math.min(loadPu, 1.2) + diurnal + 0.6 * gauss(p.seed, ch, minute);
        // A sag hits all three phases; L2/L3 dip a little less.
        return sag ? Math.min(v, sag.magnitude + [0, 3, 5][i] + 0.4 * gauss(p.seed, ch, minute, 9)) : v;
    };
    const va = vPhase(0, CH.va), vb = vPhase(1, CH.vb), vc = vPhase(2, CH.vc);

    // Phase currents from apparent power and the phase split.
    const iMean = (kva * 1000) / (va + vb + vc);
    const iPhase = (i: 0 | 1 | 2) => Math.max(0, iMean * p.currentSplit[i] * (1 + 0.01 * gauss(p.seed, CH.ia + i, minute)));

    const freq = clamp(50 + 0.03 * Math.sin(minute / 47) + 0.035 * gauss(p.seed, CH.freq, minute), 49.8, 50.2);
    const lf = Math.min(loadPu, 1);
    const thdV = Math.max(0.3, p.thdV[0] + (p.thdV[1] - p.thdV[0]) * lf ** 3 + 0.25 * gauss(p.seed, CH.thdV, minute));
    const thdI = Math.max(1, (p.thdI[0] + (p.thdI[1] - p.thdI[0]) * lf) * (1 + 0.08 * gauss(p.seed, CH.thdI, minute)));

    return {
        voltage_a: r1(va), voltage_b: r1(vb), voltage_c: r1(vc),
        current_a: r1(iPhase(0)), current_b: r1(iPhase(1)), current_c: r1(iPhase(2)),
        power_active_total: r2(kw), power_reactive_total: r2(kvar), power_apparent_total: r2(kva),
        power_factor_total: r3(pf), frequency: r3(freq),
        thd_voltage_a: r2(thdV), thd_current_a: r2(thdI),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Series with the energy register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Readings on the stepMin grid (aligned to ENERGY_EPOCH_MS) for fromMs ≤ t ≤ toMs.
 * The register integrates every step from the epoch, so the value at any
 * timestamp does not depend on the requested window.
 */
export function generateReadings(p: DemoSiteProfile, fromMs: number, toMs: number, stepMin = 5): DemoReading[] {
    if (!(stepMin >= 1 && stepMin <= 60 && Number.isInteger(stepMin))) throw new Error('stepMin must be an integer 1..60');
    if (fromMs < ENERGY_EPOCH_MS) throw new Error(`fromMs is before the energy epoch ${new Date(ENERGY_EPOCH_MS).toISOString()}`);
    const step = stepMin * MIN_MS;
    const hours = stepMin / 60;
    const first = ENERGY_EPOCH_MS + Math.ceil((fromMs - ENERGY_EPOCH_MS) / step) * step;

    // Each step's energy is its own power over the step that ends at it.
    let energy = p.energyStartKwh;
    for (let t = ENERGY_EPOCH_MS + step; t < first; t += step) {
        energy += instantReading(p, t).power_active_total * hours;
    }

    const out: DemoReading[] = [];
    for (let t = first; t <= toMs; t += step) {
        const r = instantReading(p, t);
        if (t > ENERGY_EPOCH_MS) energy += r.power_active_total * hours;
        out.push({ time: new Date(t), ...r, energy_import_total: r2(energy) });
    }
    return out;
}

export interface StoredRegister { time: number; energy: number }

/**
 * Re-bases the register of rows about to be written onto rows already stored.
 * Stored readings are never rewritten, so once a profile changes (or the
 * interval does) the epoch-integrated register no longer meets them. Each new
 * row is offset to continue from the nearest stored reading before it, or to
 * end just under the first stored reading after it when backfilling. With an
 * unchanged profile the offset is zero. `stored` must be sorted by time;
 * `registerAt` gives the generated register at a stored timestamp.
 */
export function joinRegister(
    fresh: DemoReading[], stored: StoredRegister[], registerAt: (ms: number) => number,
): DemoReading[] {
    if (stored.length === 0) return fresh;
    const offsets = new Map<number, number>();
    const offsetFor = (s: StoredRegister) => {
        let o = offsets.get(s.time);
        if (o === undefined) { o = s.energy - registerAt(s.time); offsets.set(s.time, o); }
        return o;
    };
    let i = 0;   // index of the first stored reading after the current row
    return fresh.map(r => {
        const t = r.time.getTime();
        while (i < stored.length && stored[i].time <= t) i++;
        const anchor = i > 0 ? stored[i - 1] : stored[0];
        const offset = offsetFor(anchor);
        return offset === 0 ? r : { ...r, energy_import_total: r2(r.energy_import_total + offset) };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time alerts the MQTT pipeline would have raised
//
// The generator writes straight to the database, so mqtt.ts never sees these
// readings and its evaluateAlerts never runs. This mirrors its thresholds and
// wording so the alerts page has the same kinds of entries, prefixed so they
// are identifiable. Keep in step with evaluateAlerts in mqtt.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface DemoAlert { type: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string }

export function evaluateDemoAlerts(r: DemoReading, s: DemoSiteSettings): DemoAlert[] {
    const out: DemoAlert[] = [];
    const add = (type: string, severity: DemoAlert['severity'], message: string) =>
        out.push({ type, severity, message: SIMULATED_ALERT_PREFIX + message });

    if (r.power_active_total > s.alert_max_kw) {
        add('PEAK_DEMAND', 'WARNING',
            `Peak demand exceeded: ${r.power_active_total.toFixed(1)} kW (limit: ${s.alert_max_kw} kW) — demand charge risk`);
    }
    const pct = (r.power_apparent_total / s.contracted_mdi_kva) * 100;
    if (pct >= 100) {
        add('MDI_EXCEEDED', 'CRITICAL',
            `Instantaneous load reached ${r.power_apparent_total.toFixed(1)} kVA — above the ${s.contracted_mdi_kva} kVA contracted MDI (${pct.toFixed(0)}%). `
            + `Billed demand is the highest 30-minute average, so check whether this was sustained.`);
    } else if (pct >= 90) {
        add('MDI_WARNING', 'WARNING',
            `Instantaneous load at ${r.power_apparent_total.toFixed(1)} kVA = ${pct.toFixed(0)}% of the ${s.contracted_mdi_kva} kVA contracted MDI`);
    }
    if (r.voltage_a < s.alert_min_v) {
        add('VOLTAGE_SAG', 'CRITICAL',
            `Voltage sag: ${r.voltage_a.toFixed(1)} V L1 (NRS 048 min: ${s.alert_min_v} V) — equipment damage risk`);
    }
    if (r.voltage_a > s.alert_max_v) {
        add('OVERVOLTAGE', 'CRITICAL',
            `Overvoltage: ${r.voltage_a.toFixed(1)} V L1 (NRS 048 max: ${s.alert_max_v} V) — insulation and equipment risk`);
    }
    if (r.thd_voltage_a > s.alert_max_thd) {
        add('HIGH_THD', 'WARNING',
            `Voltage THD: ${r.thd_voltage_a.toFixed(2)}% (NRS 048 limit: ${s.alert_max_thd}%) — harmonic distortion affecting equipment`);
    }
    if (r.frequency < s.alert_min_freq || r.frequency > s.alert_max_freq) {
        add('FREQUENCY_DEVIATION', 'WARNING',
            `Frequency deviation: ${r.frequency.toFixed(2)} Hz (NRS 048 range: ${s.alert_min_freq}–${s.alert_max_freq} Hz)`);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics the engines compute, used by the tests to prove each problem site
// actually breaches what it is meant to
// ─────────────────────────────────────────────────────────────────────────────

/** Phase current imbalance % as the predictive scanner computes it (max deviation from the mean). */
export function currentImbalancePct(rows: DemoReading[]): number {
    const avg = (k: 'current_a' | 'current_b' | 'current_c') => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    const a = avg('current_a'), b = avg('current_b'), c = avg('current_c');
    const mean = (a + b + c) / 3;
    return (Math.max(Math.abs(a - mean), Math.abs(b - mean), Math.abs(c - mean)) / mean) * 100;
}

/** Highest fixed-window average kVA (time_bucket style), as billed demand is computed. */
export function maxIntervalKva(rows: DemoReading[], intervalMin: number): number {
    const buckets = new Map<number, { sum: number; n: number }>();
    const w = intervalMin * MIN_MS;
    for (const r of rows) {
        const k = Math.floor(r.time.getTime() / w);
        const b = buckets.get(k) ?? { sum: 0, n: 0 };
        b.sum += r.power_apparent_total; b.n++;
        buckets.set(k, b);
    }
    let max = 0;
    for (const b of buckets.values()) max = Math.max(max, b.sum / b.n);
    return max;
}
