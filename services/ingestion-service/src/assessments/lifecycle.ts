// ─────────────────────────────────────────────────────────────────────────────
// Assessment clocks (GridIQ implementation prompt, section 5). Pure functions,
// unit-tested in test/assessments.test.js.
//
// Four independent clocks:
//   1. physical deployment window      deployments.installed_at / removed_at
//   2. purchased access window         assessments.start_at / end_at
//   3. report finalisation / delivery  report_status, delivery_days
//   4. retention / deletion            retention_until, retention_status
//
// Rules:
//   - A day is 24 hours from the confirmed start (no calendar-day rounding);
//     windows are half-open: start_at <= t < end_at. UTC is stored, site-local
//     time is displayed.
//   - The clock starts at an explicit, staff-confirmed start, never when an
//     invitation is sent. Missing telemetry neither pauses nor extends it;
//     staff extend it with a reason (audited).
//   - Early closure keeps end_at (the purchase) and sets closed_at; access
//     stops at the earlier of the two.
//   - Retention runs from the effective end for N calendar months; when the
//     target month is shorter, the last day of that month is used (31 Aug + 6
//     months = 28/29 Feb), at the same site-local time of day.
// ─────────────────────────────────────────────────────────────────────────────

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export type AssessmentStatus = 'draft' | 'scheduled' | 'active' | 'ended' | 'cancelled';

export interface AssessmentClock {
    status: AssessmentStatus;
    start_at: Date | string | null;
    end_at: Date | string | null;
    closed_at?: Date | string | null;
    delivery_days?: number | null;
    retention_until?: Date | string | null;
    retention_exception_until?: Date | string | null;
}

const t = (v: Date | string | null | undefined): number | null => (v === null || v === undefined ? null : new Date(v).getTime());

/** end_at for a purchased duration: exactly days × 24 h after the start. */
export function endFor(start: Date, days: number): Date {
    if (!Number.isInteger(days) || days <= 0) throw new Error('duration_days: a positive whole number');
    return new Date(start.getTime() + days * DAY);
}

/** The moment access stops: the purchased end, or an earlier closure. */
export function effectiveEnd(a: AssessmentClock): Date | null {
    const end = t(a.end_at);
    if (end === null) return null;
    const closed = t(a.closed_at);
    return new Date(closed !== null ? Math.min(end, closed) : end);
}

/**
 * The state a reader should act on at `now`: an 'active' row past its end is
 * 'ended' even if the expiry job has not run yet.
 */
export function effectiveStatus(a: AssessmentClock, now = new Date()): AssessmentStatus {
    if (a.status !== 'active' && a.status !== 'scheduled') return a.status;
    const start = t(a.start_at), end = effectiveEnd(a)?.getTime() ?? null;
    if (a.status === 'scheduled' && start !== null && end !== null && start <= now.getTime()) {
        // A scheduled row whose start has passed is still not live until staff
        // confirm the start (status → active).
        return 'scheduled';
    }
    if (a.status === 'active' && end !== null && now.getTime() >= end) return 'ended';
    return a.status;
}

/** Is live access open at `now`? Mirrors liveAssessmentSql in src/scope.ts. */
export function isLive(a: AssessmentClock, now = new Date()): boolean {
    const start = t(a.start_at), end = t(a.end_at);
    return a.status === 'active' && (a.closed_at === null || a.closed_at === undefined)
        && start !== null && end !== null && start <= now.getTime() && now.getTime() < end;
}

/** Remaining live time in ms (0 when not live). */
export function remainingMs(a: AssessmentClock, now = new Date()): number {
    return isLive(a, now) ? Math.max(0, effectiveEnd(a)!.getTime() - now.getTime()) : 0;
}

/** Final-delivery window after the effective end: [end, end + delivery_days), capped by retention. */
export function deliveryWindow(a: AssessmentClock): { from: Date; to: Date } | null {
    const end = effectiveEnd(a);
    if (!end || (a.status !== 'active' && a.status !== 'ended')) return null;
    const days = a.delivery_days ?? 7;
    let to = end.getTime() + days * DAY;
    const ret = t(a.retention_until);
    if (ret !== null) to = Math.min(to, ret);
    return to > end.getTime() ? { from: end, to: new Date(to) } : null;
}

/** Offset (ms) of a time zone at an instant, e.g. +2 h for Africa/Johannesburg. */
export function tzOffsetMs(tz: string, at: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * `months` calendar months after `from`, in the site's time zone, keeping the
 * local time of day; clamped to the last day of a shorter target month.
 */
export function addCalendarMonths(from: Date, months: number, tz = 'Africa/Johannesburg'): Date {
    const off = tzOffsetMs(tz, from);
    const local = new Date(from.getTime() + off);
    const y = local.getUTCFullYear(), m = local.getUTCMonth() + months, d = local.getUTCDate();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const target = Date.UTC(y, m, Math.min(d, lastDay), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
    // Convert back with the target's own offset (DST-safe for zones that have it).
    const guess = new Date(target - off);
    return new Date(target - tzOffsetMs(tz, guess));
}

/** The deletion deadline: effective end + retention months (or a documented exception). */
export function retentionUntil(a: AssessmentClock & { retention_months: number; timezone?: string }): Date | null {
    const exc = t(a.retention_exception_until);
    if (exc !== null) return new Date(exc);
    const end = effectiveEnd(a);
    return end ? addCalendarMonths(end, a.retention_months, a.timezone ?? 'Africa/Johannesburg') : null;
}

/** Duration for display: "6 d 4 h", "3 h 12 min". */
export function formatDuration(ms: number): string {
    if (ms <= 0) return '0 min';
    const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / 60_000);
    if (d > 0) return `${d} d ${h} h`;
    if (h > 0) return `${h} h ${m} min`;
    return `${m} min`;
}

/** Integer cents → "R7,999.00". */
export function formatZar(cents: number | null | undefined): string | null {
    if (cents === null || cents === undefined) return null;
    const neg = cents < 0, v = Math.abs(cents);
    const rands = Math.floor(v / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '-' : ''}R${rands}.${String(v % 100).padStart(2, '0')}`;
}

export class LifecycleError extends Error {
    constructor(message: string, public status = 409) { super(message); }
}

/** Which transitions staff may make, and what each needs. */
export function checkTransition(a: AssessmentClock & { payment_state: string }, action: 'schedule' | 'start' | 'extend' | 'close' | 'cancel', now = new Date()) {
    const s = effectiveStatus(a, now);
    switch (action) {
        case 'schedule':
            if (a.status !== 'draft') throw new LifecycleError(`Only a draft can be scheduled (this one is ${a.status})`);
            return;
        case 'start':
            if (a.status !== 'draft' && a.status !== 'scheduled') throw new LifecycleError(`Only a draft or scheduled assessment can start (this one is ${a.status})`);
            if (a.payment_state !== 'paid' && a.payment_state !== 'exception') {
                throw new LifecycleError('Record the payment, or an approved payment exception with a reason, before starting the clock');
            }
            return;
        case 'extend':
            if (a.status !== 'active' && a.status !== 'ended') throw new LifecycleError(`Only an active or ended assessment can be extended (this one is ${a.status})`);
            if (a.closed_at) throw new LifecycleError('This assessment was closed early; create a replacement assessment instead');
            return;
        case 'close':
            if (s !== 'active') throw new LifecycleError('Only a live assessment can be closed early');
            return;
        case 'cancel':
            if (a.status !== 'draft' && a.status !== 'scheduled') throw new LifecycleError('Only an assessment that has not started can be cancelled; close a live one early instead');
            return;
    }
}
