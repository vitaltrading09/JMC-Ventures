'use strict';
// Assessment clocks (src/assessments/lifecycle.ts) and the access-window
// clamps (src/scope.ts). Pure functions, no database.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../dist/assessments/lifecycle.js');
const { clampToAccess, alignInward } = require('../dist/scope.js');

const H = 3_600_000, D = 24 * H;

test('a 7-day package started 10:00 SAST ends exactly seven 24-hour periods later', () => {
    const start = new Date('2026-11-02T08:00:00Z');           // 10:00 SAST
    const end = L.endFor(start, 7);
    assert.strictEqual(end.toISOString(), '2026-11-09T08:00:00.000Z');
    assert.strictEqual(end.getTime() - start.getTime(), 7 * D);
    assert.throws(() => L.endFor(start, 0));
    assert.throws(() => L.endFor(start, 1.5));
});

test('the window is half-open: live at start, not live at end_at', () => {
    const a = { status: 'active', start_at: '2026-11-02T08:00:00Z', end_at: '2026-11-09T08:00:00Z', closed_at: null };
    assert.strictEqual(L.isLive(a, new Date('2026-11-02T07:59:59.999Z')), false);
    assert.strictEqual(L.isLive(a, new Date('2026-11-02T08:00:00Z')), true);
    assert.strictEqual(L.isLive(a, new Date('2026-11-09T07:59:59.999Z')), true);
    assert.strictEqual(L.isLive(a, new Date('2026-11-09T08:00:00Z')), false);
    // The expiry job not having run does not matter: the effective status is ended.
    assert.strictEqual(L.effectiveStatus(a, new Date('2026-11-09T08:00:00Z')), 'ended');
    assert.strictEqual(L.remainingMs(a, new Date('2026-11-08T08:00:00Z')), D);
    assert.strictEqual(L.formatDuration(D + 4 * H), '1 d 4 h');
});

test('early closure stops access at closed_at and keeps the purchased end', () => {
    const a = { status: 'ended', start_at: '2026-11-02T08:00:00Z', end_at: '2026-11-09T08:00:00Z', closed_at: '2026-11-05T12:00:00Z', delivery_days: 7 };
    assert.strictEqual(L.isLive(a, new Date('2026-11-04T00:00:00Z')), false);   // status ended
    assert.strictEqual(L.effectiveEnd(a).toISOString(), '2026-11-05T12:00:00.000Z');
    const w = L.deliveryWindow(a);
    assert.strictEqual(w.from.toISOString(), '2026-11-05T12:00:00.000Z');
    assert.strictEqual(w.to.toISOString(), '2026-11-12T12:00:00.000Z');
});

test('the delivery window is capped by retention', () => {
    const a = { status: 'ended', start_at: '2026-11-02T08:00:00Z', end_at: '2026-11-09T08:00:00Z', delivery_days: 7, retention_until: '2026-11-10T08:00:00Z' };
    assert.strictEqual(L.deliveryWindow(a).to.toISOString(), '2026-11-10T08:00:00.000Z');
});

test('retention: calendar months in the site time zone, clamped to month end', () => {
    // 31 Aug 2026 10:00 SAST + 6 months → 28 Feb 2027 10:00 SAST.
    const r = L.addCalendarMonths(new Date('2026-08-31T08:00:00Z'), 6, 'Africa/Johannesburg');
    assert.strictEqual(r.toISOString(), '2027-02-28T08:00:00.000Z');
    // 30 Nov 2027 + 3 months → 29 Feb 2028 (leap year).
    assert.strictEqual(L.addCalendarMonths(new Date('2027-11-30T08:00:00Z'), 3).toISOString(), '2028-02-29T08:00:00.000Z');
    // 23:30 SAST on 31 Jan is still 31 Jan locally (21:30 UTC): + 1 month → 28 Feb 23:30 SAST.
    assert.strictEqual(L.addCalendarMonths(new Date('2027-01-31T21:30:00Z'), 1).toISOString(), '2027-02-28T21:30:00.000Z');
    // A DST zone keeps the local time of day.
    const ny = L.addCalendarMonths(new Date('2026-01-15T15:00:00Z'), 6, 'America/New_York');   // 10:00 EST
    assert.strictEqual(ny.toISOString(), '2026-07-15T14:00:00.000Z');                          // 10:00 EDT
    const a = { status: 'active', start_at: '2026-11-02T08:00:00Z', end_at: '2026-11-09T08:00:00Z', retention_months: 3 };
    assert.strictEqual(L.retentionUntil(a).toISOString(), '2027-02-09T08:00:00.000Z');
    assert.strictEqual(L.retentionUntil({ ...a, retention_exception_until: '2027-06-01T00:00:00Z' }).toISOString(), '2027-06-01T00:00:00.000Z');
});

test('transitions: payment before start; no cancel once started; extend needs an open assessment', () => {
    const draft = { status: 'draft', start_at: null, end_at: null, payment_state: 'unpaid' };
    assert.throws(() => L.checkTransition(draft, 'start'), /payment/);
    L.checkTransition({ ...draft, payment_state: 'paid' }, 'start');
    L.checkTransition({ ...draft, payment_state: 'exception' }, 'start');
    const live = { status: 'active', start_at: new Date(Date.now() - H), end_at: new Date(Date.now() + H), payment_state: 'paid' };
    assert.throws(() => L.checkTransition(live, 'cancel'));
    assert.throws(() => L.checkTransition(live, 'start'));
    L.checkTransition(live, 'close');
    L.checkTransition(live, 'extend');
    assert.throws(() => L.checkTransition({ ...live, closed_at: new Date() }, 'extend'), /closed early/);
});

test('money is integer cents', () => {
    assert.strictEqual(L.formatZar(799900), 'R7,999.00');
    assert.strictEqual(L.formatZar(5), 'R0.05');
    assert.strictEqual(L.formatZar(null), null);
});

test('client ranges are clamped to the assessment and aligned inward to whole buckets', () => {
    const w = { access_from: new Date('2026-11-02T10:00:30Z'), access_to: new Date('2026-11-03T10:00:00Z') };
    const c = clampToAccess(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-02T12:00:00Z'), w);
    assert.strictEqual(c.from.toISOString(), '2026-11-02T10:00:30.000Z');
    // The 10:00 minute straddles the start: the first whole minute is 10:01.
    const m = alignInward(c, 60_000, w);
    assert.strictEqual(m.from.toISOString(), '2026-11-02T10:01:00.000Z');
    assert.strictEqual(m.to.toISOString(), '2026-11-02T12:00:00.000Z');
    // SAST days: aligned to local midnight (22:00 UTC).
    const d = alignInward({ from: new Date('2026-11-02T10:00:30Z'), to: new Date('2026-11-05T10:00:00Z') }, D, w, 2 * H);
    assert.strictEqual(d.from.toISOString(), '2026-11-02T22:00:00.000Z');
    assert.strictEqual(d.to.toISOString(), '2026-11-04T22:00:00.000Z');
    // Entirely outside → null.
    assert.strictEqual(clampToAccess(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'), w), null);
    // Internal users: no window, unchanged.
    const r = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') };
    assert.deepStrictEqual(clampToAccess(r.from, r.to, {}), r);
    assert.deepStrictEqual(alignInward(r, 60_000, {}), r);
});
