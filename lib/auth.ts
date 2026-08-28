/**
 * Authentication utilities
 * JWT-based auth + role checks for API routes
 */

import { NextRequest } from 'next/server';
import { extractToken, verifyToken, isSessionActive } from '@/lib/auth/jwt';
import { query } from '@/lib/database';

export type AuthRole =
  | 'tourist'
  | 'operator'
  | 'guide'
  | 'transfer_operator'
  | 'transfer'
  | 'agent'
  | 'admin';

export interface VerifiedAuth {
  userId: string | null;
  role: AuthRole | null;
  email: string | null;
  isAuthenticated: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  role: AuthRole;
}

type AllowedRoles = AuthRole | AuthRole[];

const BASE_ROLES = new Set<AuthRole>([
  'tourist',
  'operator',
  'guide',
  'transfer_operator',
  'transfer',
  'agent',
  'admin',
]);

function normalizeRole(role: string | null | undefined): AuthRole | null {
  if (!role) {
    return null;
  }

  return BASE_ROLES.has(role as AuthRole) ? (role as AuthRole) : null;
}

function toRoleList(allowedRoles: AllowedRoles): AuthRole[] {
  return Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
}

function rolesMatch(userRole: string | null | undefined, allowedRole: AuthRole): boolean {
  const normalizedUserRole = normalizeRole(userRole);
  const normalizedAllowedRole = normalizeRole(allowedRole);

  if (!normalizedUserRole || !normalizedAllowedRole) {
    return false;
  }

  // Обратная совместимость: старые токены используют transfer
  if (normalizedAllowedRole === 'transfer_operator') {
    return normalizedUserRole === 'transfer_operator' || normalizedUserRole === 'transfer';
  }

  if (normalizedAllowedRole === 'transfer') {
    return normalizedUserRole === 'transfer' || normalizedUserRole === 'transfer_operator';
  }

  return normalizedUserRole === normalizedAllowedRole;
}

/** Извлечь JWT токен из запроса (Authorization header приоритетнее, иначе auth_token cookie). Для передачи во внутренние вызовы API. */
export function getTokenFromRequest(request: NextRequest): string | null {
  const headerToken = extractToken(request.headers.get('authorization'));
  const cookieToken = request.cookies.get('auth_token')?.value ?? null;
  return headerToken || cookieToken;
}

export async function verifyAuth(request: NextRequest): Promise<VerifiedAuth> {
  const token = getTokenFromRequest(request);

  if (!token) {
    return {
      userId: null,
      role: null,
      email: null,
      isAuthenticated: false,
    };
  }

  const payload = await verifyToken(token);
  if (!payload || typeof payload.userId !== 'string') {
    return {
      userId: null,
      role: null,
      email: null,
      isAuthenticated: false,
    };
  }

  // Отзыв сессии (logout) должен реально работать, не только удалять cookie:
  // подпись JWT остаётся годной ещё до 7 дней после signout, если её не
  // сверить со строкой в user_sessions. P1, аудит 28.08.
  if (!(await isSessionActive(token))) {
    return {
      userId: null,
      role: null,
      email: null,
      isAuthenticated: false,
    };
  }

  const role = normalizeRole(typeof payload.role === 'string' ? payload.role : null);

  if (!role) {
    return {
      userId: null,
      role: null,
      email: null,
      isAuthenticated: false,
    };
  }

  return {
    userId: payload.userId,
    role,
    email: typeof payload.email === 'string' ? payload.email : null,
    isAuthenticated: true,
  };
}

export async function authenticateUser(request: NextRequest): Promise<string | null> {
  const auth = await verifyAuth(request);
  return auth.userId;
}

export async function authorizeRole(
  requestOrUserId: NextRequest | string,
  allowedRoles: AllowedRoles
): Promise<boolean> {
  const allowed = toRoleList(allowedRoles);

  if (typeof requestOrUserId !== 'string') {
    const auth = await verifyAuth(requestOrUserId);
    if (!auth.isAuthenticated || !auth.role) {
      return false;
    }

    return allowed.some(role => rolesMatch(auth.role, role));
  }

  const userResult = await query<{ role: string }>(
    'SELECT role FROM users WHERE id = $1 LIMIT 1',
    [requestOrUserId]
  );

  if (userResult.rows.length === 0) {
    return false;
  }

  return allowed.some(role => rolesMatch(userResult.rows[0].role, role));
}

// getUserFromToken убрана 22.08.2026 (перепись).
//
// Пользователя по токену достаёт requireAuth (lib/auth/middleware.ts) — она и
// проверяет права заодно. Вторая дверь в ту же комнату опасна тем, что не
// проверяет ничего: позвать её вместо requireAuth легко и незаметно.
