// Data layer for the ops console and portal (Phase 8): fetch helpers for
// TanStack Query. Every call goes through NEXT_PUBLIC_API_URL (the gateway)
// with the session cookie. A 401 sends the user to /login.

const API = process.env.NEXT_PUBLIC_API_URL;

export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

async function parse<T>(res: Response): Promise<T> {
    if (res.status === 401 && typeof window !== 'undefined') {
        window.location.href = '/login';
    }
    const text = await res.text();
    const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
        const msg = body && typeof body === 'object' && 'error' in body ? String((body as any).error) : `Request failed (${res.status})`;
        throw new ApiError(res.status, msg);
    }
    return body as T;
}

/** GET a JSON resource, e.g. apiGet('/ingestion/fleet'). */
export async function apiGet<T>(path: string): Promise<T> {
    return parse<T>(await fetch(`${API}${path}`, { credentials: 'include' }));
}

/** POST / PATCH / PUT / DELETE with a JSON body. */
export async function apiSend<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return parse<T>(await fetch(`${API}${path}`, {
        method,
        credentials: 'include',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    }));
}

/** Display time zone for every date and chart: South African local time. */
export const TZ = 'Africa/Johannesburg';
export const TZ_LABEL = 'SAST';

export function fmtDateTime(v: string | Date | null | undefined): string {
    if (!v) return '–';
    return new Date(v).toLocaleString('en-ZA', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtDate(v: string | Date | null | undefined): string {
    if (!v) return '–';
    return new Date(v).toLocaleDateString('en-ZA', { timeZone: TZ, dateStyle: 'medium' });
}

export function fmtAgo(v: string | Date | null | undefined): string {
    if (!v) return 'never';
    const d = Date.now() - new Date(v).getTime();
    if (d < 60_000) return 'just now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
    return `${Math.floor(d / 86_400_000)} d ago`;
}
