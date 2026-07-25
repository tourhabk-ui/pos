/**
 * NEXT.JS MIDDLEWARE
 * Глобальный middleware для всех запросов
 * 
 * Выполняется перед каждым запросом к приложению
 * 
 * ВАЖНО: Middleware работает в Edge Runtime
 * Не поддерживает Node.js модули (crypto, fs и т.д.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis/cloudflare';
import { isPathMatch, isPublicApiPath } from '@/lib/auth/public-api-routes';

// JWT_SECRET читается в runtime, не при сборке
function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return new TextEncoder().encode(secret);
}

// Protected routes that require authentication
const PROTECTED_ROUTES = ['/hub', '/profile'];

// Public sub-paths inside protected prefixes (no auth needed)
const PUBLIC_HUB_PATHS = ['/hub/safety', '/hub/fishing', '/hub/transfer'];

type AuthRole = 'tourist' | 'operator' | 'guide' | 'transfer_operator' | 'transfer' | 'agent' | 'admin';

const API_ROLE_REQUIREMENTS: Record<string, AuthRole> = {
  '/api/tourist': 'tourist',
  '/api/operator': 'operator',
  '/api/admin': 'admin',
  '/api/guide': 'guide',
  '/api/transfer-operator': 'transfer_operator',
  '/api/transfer': 'transfer_operator',
  '/api/agent': 'agent',
  '/api/agents/operator': 'operator',
};

function normalizeRole(role: string | null | undefined): AuthRole | null {
  if (!role) {
    return null;
  }

  const allowedRoles = new Set<AuthRole>([
    'tourist',
    'operator',
    'guide',
    'transfer_operator',
    'transfer',
    'agent',
    'admin',
  ]);

  return allowedRoles.has(role as AuthRole) ? (role as AuthRole) : null;
}

function hasRequiredRole(userRole: string | null, requiredRole: AuthRole): boolean {
  const normalizedUserRole = normalizeRole(userRole);
  const normalizedRequiredRole = normalizeRole(requiredRole);

  if (!normalizedUserRole || !normalizedRequiredRole) {
    return false;
  }

  if (normalizedRequiredRole === 'transfer_operator' || normalizedRequiredRole === 'transfer') {
    return normalizedUserRole === 'transfer_operator' || normalizedUserRole === 'transfer';
  }

  return normalizedUserRole === normalizedRequiredRole;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const trimmedHeader = authHeader.trim();
  if (!trimmedHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return trimmedHeader.slice(7).trim() || null;
}

function applySecurityHeaders(response: NextResponse, pathname?: string): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Widget paths: allow iframe embedding
  if (pathname && (pathname.startsWith('/widget/') || pathname.startsWith('/api/widget'))) {
    response.headers.set('X-Frame-Options', 'ALLOWALL');
  } else {
    response.headers.set('X-Frame-Options', 'DENY');
  }

  // Content Security Policy (базовый)
  if (process.env.NODE_ENV === 'production') {
    const scriptSrc = "'self' 'unsafe-inline' https://api-maps.yandex.ru https://*.yandex.ru https://mc.yandex.ru https://unpkg.com https://emrldco.com https://www.clarity.ms";
    const styleSrc = "'self' 'unsafe-inline' https://*.yandex.ru https://unpkg.com";
    const imgSrc = "'self' data: https: blob:";
    const connectSrc = "'self' https://*.yandex.ru https://*.yandex.net https://mc.yandex.ru https://mc.yandex.md wss://mc.yandex.ru https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://s3.twcstorage.ru https://emrldco.com https://www.clarity.ms";
    const fontSrc = "'self' data: https://*.yandex.ru";
    const workerSrc = "'self' blob:";

    if (pathname && pathname.startsWith('/widget/')) {
      response.headers.set(
        'Content-Security-Policy',
        `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; img-src ${imgSrc}; connect-src ${connectSrc}; font-src ${fontSrc}; worker-src ${workerSrc}; frame-ancestors *;`
      );
    } else {
      response.headers.set(
        'Content-Security-Policy',
        `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; img-src ${imgSrc}; connect-src ${connectSrc}; font-src ${fontSrc}; worker-src ${workerSrc};`
      );
    }
  }

  return response;
}

// Public route check учитывает путь и HTTP метод
function getRequiredRole(pathname: string): AuthRole | null {
  const matchedRoute = Object.entries(API_ROLE_REQUIREMENTS).find(([route]) =>
    isPathMatch(pathname, route)
  );

  return matchedRoute?.[1] ?? null;
}

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

const ratelimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(100, '60 s'), // 100 req/min per IP — защита от DoS, не мешает нормальному браузингу
    })
  : null;

export async function middleware(request: NextRequest) {
  // ── Redirect legacy /routes?kind=tour → /marketplace ──
  const kind = request.nextUrl.searchParams.get('kind');
  if (request.nextUrl.pathname === '/routes' && kind === 'tour') {
    const url = new URL('/marketplace', request.url);
    return NextResponse.redirect(url, 301);
  }

  // Skip rate limiting if Redis is not configured (development mode)
  if (ratelimit) {
    // x-real-ip — устанавливается nginx (нельзя подделать снаружи)
    // cf-connecting-ip — устанавливается Cloudflare (надёжно только за CF CDN)
    // x-forwarded-for — берём первый IP из списка (ближайший к клиенту)
    const ip = request.headers.get('x-real-ip')
      || request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || '127.0.0.1';
    const { success } = await ratelimit.limit(ip);

    if (!success) {
      return applySecurityHeaders(
        NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        request.nextUrl.pathname
      );
    }
  }

  const { pathname } = request.nextUrl;
  const method = request.method;

  // MCP server — public, no auth required (Timeweb AI agent calls this)
  if (pathname.startsWith('/api/mcp')) {
    return applySecurityHeaders(NextResponse.next(), pathname);
  }

  // Check if route requires authentication
  const isProtectedRoute = PROTECTED_ROUTES.some(route => pathname.startsWith(route))
    && !PUBLIC_HUB_PATHS.some(p => pathname.startsWith(p));
  const isPublicApiRoute = isPublicApiPath(pathname, method);
  const isApiRoute = pathname.startsWith('/api');

  // Skip auth check for public routes
  if (!isProtectedRoute && (isPublicApiRoute || !isApiRoute)) {
    return applySecurityHeaders(NextResponse.next(), pathname);
  }
  
  // Get token from cookie or Authorization header
  const token = request.cookies.get('auth_token')?.value ||
                extractBearerToken(request.headers.get('authorization'));
  
  if (!token) {
    // Redirect to login for protected pages
    if (isProtectedRoute) {
      // Use x-forwarded-host so redirect goes to the real domain, not internal localhost
      const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
      const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
      const base = `${proto}://${host}`;
      const url = new URL(`/auth/login?from=${encodeURIComponent(pathname)}`, base);
      return applySecurityHeaders(NextResponse.redirect(url), pathname);
    }

    // Return 401 for protected API routes
    if (isApiRoute && !isPublicApiRoute) {
      return applySecurityHeaders(
        NextResponse.json(
          { success: false, error: 'Не авторизован' },
          { status: 401 }
        ),
        pathname
      );
    }
  }

  // Verify JWT token
  if (token) {
    try {
      const { payload } = await jwtVerify(token, getJWTSecret());

      const userRole = typeof payload.role === 'string' ? payload.role : null;

      // Проверяем RBAC для API-маршрутов на основе роли из JWT
      if (isApiRoute) {
        const requiredRole = getRequiredRole(pathname);
        if (requiredRole && !hasRequiredRole(userRole, requiredRole)) {
          return applySecurityHeaders(
            NextResponse.json(
              { success: false, error: 'Forbidden' },
              { status: 403 }
            ),
            pathname
          );
        }
        return applySecurityHeaders(NextResponse.next(), pathname);
      }

      return applySecurityHeaders(NextResponse.next(), pathname);

    } catch {

      // Clear invalid token
      if (isProtectedRoute) {
        const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
        const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
        const base = `${proto}://${host}`;
        const url = new URL(`/auth/login?from=${encodeURIComponent(pathname)}&error=session_expired`, base);
        const redirect = NextResponse.redirect(url);
        redirect.cookies.delete('auth_token');
        return applySecurityHeaders(redirect, pathname);
      }

      if (isApiRoute && !isPublicApiRoute) {
        return applySecurityHeaders(
          NextResponse.json(
            { success: false, error: 'Неверный или истекший токен' },
            { status: 401 }
          ),
          pathname
        );
      }
    }
  }

  return applySecurityHeaders(NextResponse.next(), pathname);
}

// Apply middleware to specific routes
export const config = {
  matcher: [
    '/api/:path*',
    '/hub/:path*',
    '/profile/:path*',
    '/widget/:path*',
    '/routes',
  ],
};
// Build ID: 1774529925
