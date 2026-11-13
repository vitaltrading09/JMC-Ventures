// GridIQ assessments in the web app: types and display helpers shared by the
// ops console (/ops/assessments) and the client portal.

export type AssessmentStatus = "draft" | "scheduled" | "active" | "ended" | "cancelled";

export interface AssessmentPoint { id: string; name: string; role: string }

export interface Assessment {
    id: string;
    reference: string;
    title: string;
    tenant_id?: string;
    tenant_name?: string;
    project_id: string;
    project_name: string;
    package_id?: string | null;
    package_name: string | null;
    status: AssessmentStatus;
    effective_status: AssessmentStatus;
    live: boolean;
    duration_days: number;
    planned_start_at?: string | null;
    start_at: string | null;
    end_at: string | null;
    closed_at: string | null;
    close_reason?: string | null;
    effective_end_at: string | null;
    remaining_ms: number;
    remaining: string;
    timezone: string;
    payment_state?: "unpaid" | "invoiced" | "paid" | "exception";
    payment_reference?: string | null;
    payment_exception_reason?: string | null;
    price_cents?: number | string | null;
    price?: string | null;
    quote?: any;
    report_status: string;
    retention_months: number;
    retention_until: string | null;
    retention_status: string;
    retention_exception_until?: string | null;
    delivery_days: number;
    delivery_until: string | null;
    delivery_open: boolean;
    internal_notes?: string | null;
    points: AssessmentPoint[];
}

export interface Grant {
    id: string; email: string; user_id: string | null; user_role: string | null; receives_reports: boolean;
    created_at: string; revoked_at: string | null; revoke_reason: string | null;
}

export interface AssessmentDetail extends Assessment {
    grants: Grant[];
    deployments: { id: string; installed_at: string; removed_at: string | null; point_name: string; device_code: string | null; device_id: string }[];
    audit: { at: string; actor_email: string | null; action: string; reason: string | null }[];
}

export interface Package {
    id: string; code: string; name: string; duration_days: number; price_cents: number | string; price: string;
    tax_basis: "incl_vat" | "excl_vat" | "not_vat_registered" | null; included_meters: number;
    extra_meter_price_cents: number | string | null; day_rate_cents: number | string | null; retention_months: number;
    inclusions: Record<string, unknown>; status: "draft" | "published" | "archived";
}

export const STATUS_TONE: Record<AssessmentStatus, "green" | "amber" | "blue" | "grey" | "red"> = {
    active: "green", scheduled: "blue", draft: "grey", ended: "amber", cancelled: "red",
};

export const STATUS_LABEL: Record<AssessmentStatus, string> = {
    active: "Live", scheduled: "Scheduled", draft: "Draft", ended: "Ended", cancelled: "Cancelled",
};

export const TAX_LABEL: Record<string, string> = {
    incl_vat: "incl. VAT", excl_vat: "excl. VAT", not_vat_registered: "not VAT registered",
};

/** "R7,999.00" from integer cents. */
export function zarCents(c: number | string | null | undefined): string {
    if (c === null || c === undefined || c === "") return "—";
    const v = Number(c);
    const r = Math.floor(Math.abs(v) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${v < 0 ? "-" : ""}R${r}.${String(Math.abs(v) % 100).padStart(2, "0")}`;
}

/** Rands typed by a person → integer cents (null when blank). */
export function toCents(v: string): number | null {
    const s = v.replace(/[R,\s]/g, "");
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error("Enter an amount in rand, e.g. 2999 or 2999.50");
    return Math.round(n * 100);
}

/** Fraction of the purchased window elapsed (0–1), for a progress bar. */
export function elapsedFraction(a: Pick<Assessment, "start_at" | "effective_end_at">, now = Date.now()): number {
    if (!a.start_at || !a.effective_end_at) return 0;
    const s = new Date(a.start_at).getTime(), e = new Date(a.effective_end_at).getTime();
    return Math.min(1, Math.max(0, (now - s) / (e - s)));
}
