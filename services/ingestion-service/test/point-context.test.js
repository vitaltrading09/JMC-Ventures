'use strict';
// Point briefing (src/point-context.ts): the interview, validation, the answers
// in words and what they change per kind of finding. Pure functions.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist/point-context.js');

test('the interview: follow-ups appear only when they apply, and progress counts them', () => {
    const empty = C.briefing({});
    assert.strictEqual(empty.next, 'location'); assert.strictEqual(empty.answered, 0);
    assert.ok(!empty.asked.includes('largest_motor_kw') && !empty.asked.includes('pf_kvar') && !empty.asked.includes('symptom_note'));
    const b = C.briefing({ location: 'main_board', supply: 'municipal', transformer_kva: 500, loads: ['motors', 'vsd'], pf_correction: 'automatic', symptoms: ['trips'] });
    assert.ok(b.asked.includes('largest_motor_kw') && b.asked.includes('start_method') && b.asked.includes('pf_kvar') && b.asked.includes('symptom_note'));
    assert.strictEqual(b.next, 'largest_motor_kw');
    assert.ok(!C.briefing({ location: 'single_load' }).asked.includes('transformer_kva'));
});

test('validation: unknown keys and values are refused; "none" excludes the rest; stale follow-ups are dropped', () => {
    assert.throws(() => C.normaliseContext({ colour: 'blue' }), /unknown question/);
    assert.throws(() => C.normaliseContext({ location: 'roof' }), /context\.location/);
    assert.throws(() => C.normaliseContext({ transformer_kva: -5 }), /positive number/);
    assert.throws(() => C.normaliseContext([]), /an object/);
    const c = C.normaliseContext({ loads: ['general'], largest_motor_kw: 55, start_method: 'dol', generation: ['pv', 'none'], pf_correction: 'none', pf_kvar: 100, symptoms: [], supply: '' });
    assert.deepStrictEqual(c, { loads: ['general'], generation: ['pv'], pf_correction: 'none' });
});

test('the answers in words', () => {
    const s = C.describeContext({ location: 'main_board', supply: 'municipal', transformer_kva: 500, loads: ['motors', 'vsd', 'hvac'], largest_motor_kw: 55, start_method: 'dol',
        pf_correction: 'automatic', pf_kvar: 150, generation: ['pv'], symptoms: ['trips', 'restarts'], symptom_note: 'mostly at 06:00' });
    assert.strictEqual(s[0], 'Meter connected on the main distribution board, supplied by the municipality, through a 500 kVA transformer.');
    assert.strictEqual(s[1], 'Feeds large motors, pumps or fans, variable-speed drives and air conditioning. Largest motor 55 kW, started direct-on-line.');
    assert.strictEqual(s[2], 'Power-factor correction: automatic (stepped) bank, 150 kvar.');
    assert.match(s[4], /Reported by the client: nuisance tripping and equipment restarting or resetting \(mostly at 06:00\)\./);
    assert.deepStrictEqual(C.describeContext({}), []);
    assert.deepStrictEqual(C.describeContext(null), []);
});

test('what the answers change per finding', () => {
    const ctx = { location: 'sub_board', loads: ['motors', 'vsd', 'ups_it'], largest_motor_kw: 55, start_method: 'dol', pf_correction: 'automatic', pf_kvar: 150, sensitive: ['plc'], symptoms: ['restarts', 'high_bill'], generation: ['pv'] };
    const sags = C.siteHint('sags', ctx);
    assert.match(sags, /a 55 kW motor started direct-on-line/); assert.match(sags, /compare with the main incomer/); assert.match(sags, /PLCs and control systems/i); assert.match(sags, /reported equipment restarting/);
    const thd = C.siteHint('thd', ctx);
    assert.match(thd, /variable-speed drives and UPS, servers or IT/);
    assert.strictEqual(C.siteHint('pf', {}), null); assert.match(thd, /without detuning reactors/); assert.match(thd, /solar inverters/);
    const pf = C.siteHint('pf', ctx);
    assert.match(pf, /A 150 kvar automatic \(stepped\) bank is installed, yet the power factor is low/); assert.match(pf, /high demand charges/);
    assert.match(C.siteHint('pf', { pf_correction: 'none', loads: ['compressors'] }), /No power-factor correction is installed/);
    assert.match(C.siteHint('sags', { loads: ['motors'], start_method: 'soft_starter' }), /less likely cause/);
    assert.strictEqual(C.siteHint('sags', {}), null);
    assert.strictEqual(C.siteHint('general', ctx), null);
    // No sizing and no money in any hint.
    for (const k of ['sags', 'thd', 'pf', 'demand', 'imbalance', 'baseload']) assert.doesNotMatch(C.siteHint(k, ctx) ?? '', /R\s?\d|install a \d+/);
});
