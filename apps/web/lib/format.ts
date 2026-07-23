// Shared number + currency formatting.
//
// Why this exists: Postgres NUMERIC/DECIMAL columns (money, scores, paybacks)
// are serialised as JSON *strings* by node-postgres to preserve precision.
// The frontend treated them as numbers, so `sum + value` concatenated strings
// ("0" + "12000.00" → "012000.00") and `string.toLocaleString()` returned the
// raw string with no separators. Coerce at the boundary and format through here.

/** Safely coerce an unknown (string | number | null) to a finite number, else 0. */
export function toNum(v: unknown): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

/** Rand currency with thousands separators. Defaults to whole Rands (no cents). */
export function zar(v: unknown, decimals = 0): string {
    const n = toNum(v);
    return `R ${n.toLocaleString('en-ZA', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    })}`;
}

/** Plain number with thousands separators. */
export function num(v: unknown, decimals = 0): string {
    return toNum(v).toLocaleString('en-ZA', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

/**
 * Normalise the numeric fields of an AI recommendation coming off the API,
 * turning NUMERIC-column strings into real numbers so downstream maths and
 * formatting behave. Spreads the original object so all other fields survive.
 */
export function normalizeRec<T extends Record<string, any>>(r: T): T {
    return {
        ...r,
        estimated_monthly_saving_zar: toNum(r.estimated_monthly_saving_zar),
        estimated_implementation_cost_zar: toNum(r.estimated_implementation_cost_zar),
        payback_months: toNum(r.payback_months),
    };
}
