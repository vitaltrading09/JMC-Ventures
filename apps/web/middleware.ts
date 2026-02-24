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
    const isLoginRoute = request.nextUrl.pathname === '/login';

    // 1. Handle Login Route
    if (isLoginRoute && token) {
        const payload = decodeJwt(token);
        if (payload) {
            if (payload.role === 'super_admin') {
                return NextResponse.redirect(new URL('/admin', request.url));
            }
            return NextResponse.redirect(new URL('/dashboard', request.url));
        }
    }

    // 2. Protect Authenticated Routes
    if (!token && (isDashboardRoute || isAdminRoute)) {
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
            return NextResponse.redirect(new URL('/dashboard', request.url));
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
    matcher: ['/dashboard/:path*', '/admin/:path*', '/login'],
};
