// ─────────────────────────────────────────────────────────────────────────────
// Point briefing: what the consultant asks GridIQ staff about a measurement
// point, so that findings are read in the light of where the meter sits and
// what it feeds (measurement_points.context, migration 1793870000000).
//
//   QUESTIONS          the interview, with follow-ups that depend on answers
//   normaliseContext   validates and cleans what staff saved (PATCH /points/:id)
//   briefing           progress and the next question (GET /points/:id/briefing)
//   describeContext    the answers as plain sentences (reports, portal, the model)
//   siteHint           what the answers change for one kind of finding: used in
//                      rule findings (evidence.site_hint), watch conclusions and
//                      the consultant's measured-data answers
//
// Unknown is a valid answer everywhere and never turns into a guess.
// Pure and unit-tested (test/point-context.test.js).
// ─────────────────────────────────────────────────────────────────────────────

export type QType = 'single' | 'multi' | 'number' | 'text';
export interface Question {
    id: string; type: QType; ask: string; why: string;
    options?: { value: string; label: string }[];
    unit?: string;
    when?: (c: Ctx) => boolean;
}
export type Ctx = Record<string, any>;

const has = (c: Ctx, k: string, ...vals: string[]) => Array.isArray(c[k]) && vals.some((v) => c[k].includes(v));
const MOTORS = (c: Ctx) => has(c, 'loads', 'motors', 'compressors');

export const QUESTIONS: Question[] = [
    { id: 'location', type: 'single', ask: 'Where exactly is this meter connected?',
        why: 'A dip seen at the supply point means something different from one seen on a feeder.',
        options: [
            { value: 'utility_supply', label: 'At the utility supply point' },
            { value: 'transformer_lv', label: 'On the low-voltage side of the site transformer' },
            { value: 'main_board', label: 'On the main distribution board' },
            { value: 'sub_board', label: 'On a sub-board or feeder' },
            { value: 'single_load', label: 'On one machine or load' },
        ] },
    { id: 'supply', type: 'single', ask: 'Who supplies the site?',
        why: 'It decides who to ask for supply records and which limits apply.',
        options: [{ value: 'eskom', label: 'Eskom' }, { value: 'municipal', label: 'Municipality' }, { value: 'landlord', label: 'Landlord (sub-metered)' }, { value: 'unknown', label: 'Not known' }] },
    { id: 'transformer_kva', type: 'number', unit: 'kVA', ask: 'What size is the transformer feeding this point?',
        why: 'Loading and voltage drop are judged against it.', when: (c) => c.location !== 'single_load' },
    { id: 'loads', type: 'multi', ask: 'What does this point feed? Choose everything downstream.',
        why: 'Each kind of load leaves its own fingerprint: drives distort, motors dip the voltage when they start.',
        options: [
            { value: 'motors', label: 'Large motors, pumps or fans' }, { value: 'compressors', label: 'Compressors or refrigeration' },
            { value: 'vsd', label: 'Variable-speed drives' }, { value: 'hvac', label: 'Air conditioning' },
            { value: 'ups_it', label: 'UPS, servers or IT' }, { value: 'led_lighting', label: 'LED lighting' },
            { value: 'welders_furnaces', label: 'Welders, furnaces or heating' }, { value: 'ev_chargers', label: 'EV or battery chargers' },
            { value: 'lifts', label: 'Lifts or escalators' }, { value: 'general', label: 'Offices, plugs and small loads' },
        ] },
    { id: 'largest_motor_kw', type: 'number', unit: 'kW', ask: 'How big is the largest motor?',
        why: 'A large motor starting is the most common cause of dips on site.', when: MOTORS },
    { id: 'start_method', type: 'single', ask: 'How does that motor start?',
        why: 'A direct-on-line start draws about six times the running current.', when: MOTORS,
        options: [{ value: 'dol', label: 'Direct-on-line' }, { value: 'star_delta', label: 'Star-delta' }, { value: 'soft_starter', label: 'Soft starter' }, { value: 'vsd', label: 'Variable-speed drive' }, { value: 'unknown', label: 'Not known' }] },
    { id: 'pf_correction', type: 'single', ask: 'Is a capacitor bank (power-factor correction) installed at or below this point?',
        why: 'It changes what a low power factor means, and capacitors can amplify harmonics.',
        options: [{ value: 'none', label: 'None' }, { value: 'fixed', label: 'Fixed bank' }, { value: 'automatic', label: 'Automatic (stepped) bank' }, { value: 'detuned', label: 'Detuned bank (with reactors)' }, { value: 'unknown', label: 'Not known' }] },
    { id: 'pf_kvar', type: 'number', unit: 'kvar', ask: 'What is the bank\'s total size?',
        why: 'To judge whether it can cover the reactive power measured.', when: (c) => ['fixed', 'automatic', 'detuned'].includes(c.pf_correction) },
    { id: 'generation', type: 'multi', ask: 'Is any generation or storage connected below this point?',
        why: 'Solar and generators change the power factor, the voltage and the direction of power.',
        options: [{ value: 'pv', label: 'Solar PV' }, { value: 'generator', label: 'Standby generator' }, { value: 'bess', label: 'Battery storage' }, { value: 'none', label: 'None' }] },
    { id: 'sensitive', type: 'multi', ask: 'Which sensitive equipment matters most here?',
        why: 'It tells us which disturbances are worth the client\'s attention.',
        options: [{ value: 'plc', label: 'PLCs and control systems' }, { value: 'drives', label: 'Drives' }, { value: 'it', label: 'Servers, tills or network' }, { value: 'medical_lab', label: 'Medical or laboratory equipment' }, { value: 'none', label: 'Nothing in particular' }] },
    { id: 'symptoms', type: 'multi', ask: 'What problems has the client reported?',
        why: 'Findings that match a reported problem come first.',
        options: [{ value: 'trips', label: 'Nuisance tripping' }, { value: 'restarts', label: 'Equipment restarting or resetting' }, { value: 'flicker', label: 'Flickering lights' },
            { value: 'failures', label: 'Failed drives, power supplies or motors' }, { value: 'overheating', label: 'Hot cables, transformer or neutral' }, { value: 'high_bill', label: 'High demand charges or penalties' }, { value: 'none', label: 'None reported' }] },
    { id: 'symptom_note', type: 'text', ask: 'Anything about when it happens? (time of day, which machine, since when)',
        why: 'A time or a machine lets us go straight to the right readings.', when: (c) => Array.isArray(c.symptoms) && c.symptoms.some((s: string) => s !== 'none') },
];
const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

/** Validates and cleans a saved context; unknown keys and invalid values are refused. */
export function normaliseContext(input: unknown): Ctx {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('context: an object of answers');
    const out: Ctx = {};
    for (const [k, v] of Object.entries(input as Ctx)) {
        const q = BY_ID.get(k);
        if (!q) throw new Error(`context: unknown question "${k}"`);
        if (v === null || v === undefined || v === '') continue;
        if (q.type === 'single') {
            if (!q.options!.some((o) => o.value === v)) throw new Error(`context.${k}: one of ${q.options!.map((o) => o.value).join(', ')}`);
            out[k] = v;
        } else if (q.type === 'multi') {
            if (!Array.isArray(v) || v.some((x) => !q.options!.some((o) => o.value === x))) throw new Error(`context.${k}: a list of ${q.options!.map((o) => o.value).join(', ')}`);
            const list = Array.from(new Set(v as string[]));
            // "none" excludes the rest.
            out[k] = list.includes('none') && list.length > 1 ? list.filter((x) => x !== 'none') : list;
            if (!out[k].length) delete out[k];
        } else if (q.type === 'number') {
            const num = Number(v);
            if (!Number.isFinite(num) || num <= 0 || num > 1_000_000) throw new Error(`context.${k}: a positive number`);
            out[k] = num;
        } else out[k] = String(v).slice(0, 500);
    }
    // Follow-ups whose condition no longer holds are dropped.
    for (const q of QUESTIONS) if (q.when && !q.when(out)) delete out[q.id];
    return out;
}

/** Progress of the interview and the next open question. */
export function briefing(ctx: Ctx | null | undefined) {
    const c = ctx ?? {};
    const asked = QUESTIONS.filter((q) => !q.when || q.when(c));
    const answered = asked.filter((q) => c[q.id] !== undefined);
    const next = asked.find((q) => c[q.id] === undefined) ?? null;
    return { total: asked.length, answered: answered.length, complete: !next, next: next?.id ?? null, asked: asked.map((q) => q.id) };
}

const label = (qid: string, v: string) => BY_ID.get(qid)?.options?.find((o) => o.value === v)?.label ?? v;
/** Lower-case the first letter, except for abbreviations (UPS, EV, LED, PLCs). */
const lower = (s: string) => (/^[A-Z][A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const loadNames = (c: Ctx, ...vals: string[]) => (Array.isArray(c.loads) ? c.loads.filter((v: string) => vals.includes(v)).map((v: string) => lower(label('loads', v))) : []);

/** The answers as sentences (empty when nothing is known). */
export function describeContext(ctx: Ctx | null | undefined): string[] {
    const c = ctx ?? {};
    const out: string[] = [];
    if (c.location || c.supply || c.transformer_kva) {
        const where = c.location ? `Meter connected ${lower(label('location', c.location))}` : 'Meter location not recorded';
        const sup = c.supply && c.supply !== 'unknown' ? `, supplied by ${c.supply === 'eskom' ? 'Eskom' : c.supply === 'municipal' ? 'the municipality' : 'the landlord'}` : '';
        out.push(`${where}${sup}${c.transformer_kva ? `, through a ${c.transformer_kva} kVA transformer` : ''}.`);
    }
    if (Array.isArray(c.loads) && c.loads.length) {
        const motor = c.largest_motor_kw ? ` Largest motor ${c.largest_motor_kw} kW${c.start_method && c.start_method !== 'unknown' ? `, started ${lower(label('start_method', c.start_method))}` : ''}.` : '';
        out.push(`Feeds ${list(c.loads.map((v: string) => lower(label('loads', v))))}.${motor}`);
    }
    if (c.pf_correction) out.push(c.pf_correction === 'none' ? 'No power-factor correction installed.' : c.pf_correction === 'unknown' ? 'Whether power-factor correction is installed is not known.'
        : `Power-factor correction: ${lower(label('pf_correction', c.pf_correction))}${c.pf_kvar ? `, ${c.pf_kvar} kvar` : ''}.`);
    if (Array.isArray(c.generation) && c.generation.length && !c.generation.includes('none')) out.push(`Connected below this point: ${list(c.generation.map((v: string) => lower(label('generation', v))))}.`);
    if (Array.isArray(c.sensitive) && c.sensitive.length && !c.sensitive.includes('none')) out.push(`Sensitive equipment: ${list(c.sensitive.map((v: string) => lower(label('sensitive', v))))}.`);
    if (Array.isArray(c.symptoms) && c.symptoms.length) out.push(c.symptoms.includes('none') ? 'No problems reported by the client.'
        : `Reported by the client: ${list(c.symptoms.map((v: string) => lower(label('symptoms', v))))}${c.symptom_note ? ` (${c.symptom_note})` : ''}.`);
    return out;
}

export type HintKind = 'sags' | 'thd' | 'pf' | 'demand' | 'imbalance' | 'baseload' | 'general';

/** What the briefing changes for one kind of finding; null when it adds nothing. */
export function siteHint(kind: HintKind, ctx: Ctx | null | undefined): string | null {
    const c = ctx ?? {};
    const s: string[] = [];
    const reported = (...vals: string[]) => (Array.isArray(c.symptoms) ? c.symptoms.filter((v: string) => vals.includes(v)).map((v: string) => lower(label('symptoms', v))) : []);
    if (kind === 'sags') {
        if (MOTORS(c)) {
            const motor = c.largest_motor_kw ? `a ${c.largest_motor_kw} kW motor` : list(loadNames(c, 'motors', 'compressors'));
            if (c.start_method === 'dol' || c.start_method === 'star_delta') s.push(`This point feeds ${motor} started ${lower(label('start_method', c.start_method))}: a start like that draws several times the running current, so match the dip times against its starts first. A soft starter or drive would reduce the dip.`);
            else if (c.start_method === 'soft_starter' || c.start_method === 'vsd') s.push(`The largest motor here already starts through a ${c.start_method === 'vsd' ? 'drive' : 'soft starter'}, so motor starting is a less likely cause; check its ramp setting and look at other loads.`);
            else s.push(`This point feeds ${motor}: find out how the largest one starts, because a direct start is the most common cause of dips on site.`);
        }
        if (c.location === 'utility_supply' || c.location === 'transformer_lv') s.push('The meter sits at the supply point, so a dip here with no load start on site arrived from the network.');
        if (c.location === 'sub_board' || c.location === 'single_load') s.push('The meter sits below the main board: a dip here can also come from another feeder on that board or from this feeder\'s own cable, so compare with the main incomer.');
        const sens = Array.isArray(c.sensitive) ? c.sensitive.filter((v: string) => v !== 'none').map((v: string) => lower(label('sensitive', v))) : [];
        if (sens.length) s.push(`The ${list(sens)} listed here are what these dips are most likely to reset; ride-through on their control supply protects them whatever the cause.`);
        const rep = reported('restarts', 'trips', 'flicker');
        if (rep.length) s.push(`This fits the reported ${list(rep)}: compare the dip times with when that happened.`);
    } else if (kind === 'thd') {
        const src = loadNames(c, 'vsd', 'ups_it', 'led_lighting', 'ev_chargers', 'welders_furnaces');
        if (src.length) s.push(`This point feeds ${list(src)}, which draw distorted current: they are the first sources to check.`);
        if (c.pf_correction === 'fixed' || c.pf_correction === 'automatic') s.push('A capacitor bank without detuning reactors is installed here: it can resonate with these harmonics and amplify them, and distortion shortens capacitor life. Have the bank inspected before anything else.');
        if (c.pf_correction === 'detuned') s.push('The capacitor bank here is detuned, so resonance with it is less likely.');
        if (has(c, 'generation', 'pv')) s.push('The solar inverters also add distortion, mostly at low output (early morning and late afternoon).');
        const rep = reported('failures', 'overheating', 'trips');
        if (rep.length) s.push(`This may be related to the reported ${list(rep)}.`);
    } else if (kind === 'pf') {
        const motors = loadNames(c, 'motors', 'compressors', 'hvac', 'lifts');
        if (c.pf_correction === 'none') s.push(`No power-factor correction is installed at this point, so the low power factor is the natural result of ${motors.length ? `the ${list(motors)}` : 'the inductive loads'}. A correction bank is the usual remedy, sized by a specialist from a full month of this data.`);
        else if (['fixed', 'automatic', 'detuned'].includes(c.pf_correction)) s.push(`A ${c.pf_kvar ? `${c.pf_kvar} kvar ` : ''}${lower(label('pf_correction', c.pf_correction))} is installed, yet the power factor is low: check that it is switched on, its fuses and contactors, the controller's target and current transformer, and whether it is large enough.`);
        else if (c.pf_correction === 'unknown') s.push('Find out whether a capacitor bank exists at this point: if one does, it is not doing its work; if none does, that explains the low power factor.');
        if (has(c, 'generation', 'pv')) s.push('Solar reduces the kW drawn from the grid but not the reactive power, so the power factor at the supply point drops while the sun shines. That is expected; the correction target should allow for it.');
        if (reported('high_bill').length) s.push('This fits the reported high demand charges: a low power factor raises the billed kVA.');
    } else if (kind === 'demand') {
        const big = loadNames(c, 'compressors', 'hvac', 'motors', 'ev_chargers', 'welders_furnaces');
        if (big.length) s.push(`Of what this point feeds, the ${list(big)} are the loads to stagger or move out of the peak half-hours.`);
        if (has(c, 'generation', 'bess')) s.push('The battery below this point can be set to shave these peaks.');
        if (c.transformer_kva) s.push(`Compare the peaks with the ${c.transformer_kva} kVA transformer rating as well as with the contracted limit.`);
        if (reported('high_bill').length) s.push('This fits the reported high demand charges.');
    } else if (kind === 'imbalance') {
        const single = loadNames(c, 'led_lighting', 'general', 'ups_it', 'welders_furnaces', 'ev_chargers');
        if (single.length) s.push(`Single-phase loads such as the ${list(single)} here are what to redistribute across the phases.`);
        if (reported('overheating', 'trips').length) s.push(`This may be related to the reported ${list(reported('overheating', 'trips'))}.`);
    } else if (kind === 'baseload') {
        const must = loadNames(c, 'ups_it', 'compressors'), may = loadNames(c, 'hvac', 'led_lighting', 'general', 'motors');
        if (must.length) s.push(`Of what this point feeds, the ${list(must)} probably have to run through the night.`);
        if (may.length) s.push(`Usually not needed overnight: the ${list(may)}. Check their timers and controls first.`);
    }
    return s.length ? s.join(' ') : null;
}
