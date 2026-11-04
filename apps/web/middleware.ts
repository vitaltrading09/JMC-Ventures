import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Helper to safely decode JWT payload in Edge runtime without external libraries
function decodeJwt(token: string) {
    try {
        const base64Url = token.split('.')[1];
        if (!base64Url) return null;

        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));

        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

// Internal (Grid-IQ) roles since Phase 7; client roles are client_admin / client_viewer.
const isInternal = (role: string) => role === 'super_admin' || role === 'engineer';
// The broker portfolio is kept but hidden unless built with NEXT_PUBLIC_FEATURE_BROKER=true.
const BROKER_ENABLED = process.env.NEXT_PUBLIC_FEATURE_BROKER === 'true';
// PV sizer, the meter page's simulation tab, savings and "What we caught":
// sizing belongs to the feasibility company (plan Part E). Kept under
// /dashboard, off unless built with NEXT_PUBLIC_FEATURE_TOOLS=true.
const TOOLS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_TOOLS === 'true';
const TOOL_ROUTES = [/^\/dashboard\/tools\/pv-sizer$/, /^\/dashboard\/savings$/, /^\/dashboard\/value$/, /^\/dashboard\/sites\/[^/]+$/];

/** Where the pre-Phase-8 pages moved, for a user of this kind (Phase 8, PR 3). */
export function movedTo(path: string, internal: boolean): string | null {
    if (path === '/admin' || path === '/admin/') return '/ops';
    if (path.startsWith('/admin/clients')) return '/ops/clients';
    if (path.startsWith('/admin/leads')) return '/ops/leads';
    if (path.startsWith('/admin')) return '/ops';
    if (!path.startsWith('/dashboard')) return null;
    if (TOOLS_ENABLED && TOOL_ROUTES.some((re) => re.test(path))) return null;
    if (internal) {
        if (path.startsWith('/dashboard/settings/data')) return '/ops/import';
        if (path.startsWith('/dashboard/sites') || path.startsWith('/dashboard/sld') || path.startsWith('/dashboard/settings')) return '/ops/projects';
        if (path.startsWith('/dashboard/recommendations') || path.startsWith('/dashboard/reports')) return '/ops/review';
        if (path.startsWith('/dashboard/alerts')) return '/ops/data-health';
        return '/ops';
    }
    if (path.startsWith('/dashboard/alerts')) return '/portal/alerts';
    if (path.startsWith('/dashboard/settings')) return '/portal/settings';
    if (path === '/dashboard' || path === '/dashboard/') return '/portal';
    // Sites, analytics, health check, recommendations, reports, SLD: now tabs of a project.
    return '/portal/projects';
}

export function middleware(request: NextRequest) {
    const token = request.cookies.get('token')?.value;
    const path = request.nextUrl.pathname;

    // Define route categories
    const isDashboardRoute = path.startsWith('/dashboard');
    const isAdminRoute = path.startsWith('/admin');
    const isBrokerRoute = path.startsWith('/broker');
    const isOpsRoute = path.startsWith('/ops');
    // Client portal (Phase 8). Internal users may open it too (it shows every tenant's projects).
    const isPortalRoute = path.startsWith('/portal');
    const isLoginRoute = path === '/login';

    // 1. Handle Login Route
    if (isLoginRoute && token) {
        const payload = decodeJwt(token);
        if (payload) {
            if (isInternal(payload.role)) {
                return NextResponse.redirect(new URL('/ops', request.url));
            }
            // A broker has no tenant data of their own. Their home is the portfolio.
            if (payload.role === 'broker' && BROKER_ENABLED) {
                return NextResponse.redirect(new URL('/broker', request.url));
            }
            return NextResponse.redirect(new URL('/portal', request.url));
        }
    }

    // 2. Protect Authenticated Routes
    if (!token && (isDashboardRoute || isAdminRoute || isBrokerRoute || isOpsRoute || isPortalRoute)) {
        return NextResponse.redirect(new URL('/login', request.url));
    }

    // 3. Handle Role-Based Access Control (RBAC)
    if (token) {
        const payload = decodeJwt(token);

        if (!payload) {
            // Invalid token, force re-login
            const response = NextResponse.redirect(new URL('/login', request.url));
            response.cookies.delete('token');
            return response;
        }

        const role = payload.role;

        // The ops console is for Grid-IQ staff only.
        if ((isAdminRoute || isOpsRoute) && !isInternal(role)) {
            return NextResponse.redirect(new URL(role === 'broker' && BROKER_ENABLED ? '/broker' : '/portal', request.url));
        }

        // The portfolio is broker-only, and off unless the feature flag is set.
        // super_admin is the platform operator, not a broker, and holds no client grants.
        if (isBrokerRoute && (role !== 'broker' || !BROKER_ENABLED)) {
            return NextResponse.redirect(new URL(isInternal(role) ? '/ops' : '/portal', request.url));
        }

        // A broker landing on the client pages sees nothing useful.
        if ((isDashboardRoute || isPortalRoute) && role === 'broker' && BROKER_ENABLED) {
            return NextResponse.redirect(new URL('/broker', request.url));
        }

        // Old /dashboard and /admin URLs (bookmarks, links in old emails).
        const moved = movedTo(path, isInternal(role));
        if (moved) return NextResponse.redirect(new URL(moved, request.url));
    }

    return NextResponse.next();
}

export const config = {
    // Run middleware on these paths
    matcher: ['/dashboard/:path*', '/admin/:path*', '/broker/:path*', '/ops/:path*', '/portal/:path*', '/login'],
};
