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

export function middleware(request: NextRequest) {
    const token = request.cookies.get('token')?.value;

    // Define route categories
    const isDashboardRoute = request.nextUrl.pathname.startsWith('/dashboard');
    const isAdminRoute = request.nextUrl.pathname.startsWith('/admin');
    const isBrokerRoute = request.nextUrl.pathname.startsWith('/broker');
    const isLoginRoute = request.nextUrl.pathname === '/login';

    // 1. Handle Login Route
    if (isLoginRoute && token) {
        const payload = decodeJwt(token);
        if (payload) {
            if (payload.role === 'super_admin') {
                return NextResponse.redirect(new URL('/admin', request.url));
            }
            // A broker has no tenant data of their own — /dashboard would be
            // empty for them. Their home is the portfolio.
            if (payload.role === 'broker') {
                return NextResponse.redirect(new URL('/broker', request.url));
            }
            return NextResponse.redirect(new URL('/dashboard', request.url));
        }
    }

    // 2. Protect Authenticated Routes
    if (!token && (isDashboardRoute || isAdminRoute || isBrokerRoute)) {
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

        // Route: Client trying to access Admin area
        if (isAdminRoute && role !== 'super_admin') {
            return NextResponse.redirect(new URL(role === 'broker' ? '/broker' : '/dashboard', request.url));
        }

        // The portfolio is broker-only. super_admin is the platform operator,
        // not a broker, and holds no client grants.
        if (isBrokerRoute && role !== 'broker') {
            return NextResponse.redirect(new URL(role === 'super_admin' ? '/admin' : '/dashboard', request.url));
        }

        // A broker landing on the tenant dashboard sees nothing useful.
        if (isDashboardRoute && role === 'broker') {
            return NextResponse.redirect(new URL('/broker', request.url));
        }

        // Route: Admin hitting the root dashboard (redirect to their proper home)
        // Note: We might allow admins to access /dashboard/sites/[id] later for impersonation, 
        // so we specifically only redirect the root /dashboard
        if (isDashboardRoute && request.nextUrl.pathname === '/dashboard' && role === 'super_admin') {
            return NextResponse.redirect(new URL('/admin', request.url));
        }
    }

    return NextResponse.next();
}

export const config = {
    // Run middleware on these paths
    matcher: ['/dashboard/:path*', '/admin/:path*', '/broker/:path*', '/login'],
};
