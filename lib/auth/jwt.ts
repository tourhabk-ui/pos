/**
 * JWT Token Management
 * Utilities for creating and verifying JWT tokens
 */

import { SignJWT, jwtVerify } from 'jose';
import { query } from '@/lib/database';

const JWT_ALGORITHM = 'HS256';
const JWT_EXPIRATION = '7d'; // 7 days
const MFA_PENDING_EXPIRATION = '5m';

// Получаем секрет в runtime, а не при загрузке модуля (во время сборки)
function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return new TextEncoder().encode(secret);
}

export interface JWTPayload extends Record<string, unknown> {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

interface RequestLike {
  headers?: Headers | Record<string, string | undefined>;
  cookies?: {
    get?: (name: string) => { value?: string } | string | undefined;
  };
}

/**
 * Create a new JWT token
 */
export async function createToken(payload: JWTPayload): Promise<string> {
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRATION)
    .sign(getJWTSecret());

  return token;
}

/**
 * Verify and decode JWT token
 */
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    // Пин алгоритма: принимаем ТОЛЬКО HS256. Без этого jose доверяет полю alg
    // из заголовка токена — защита в глубину против algorithm-confusion, если
    // однажды изменится тип ключа (симметричный ключ уже отсекает RS*/ES*/none,
    // но пин снимает зависимость от этого неявного свойства).
    const { payload } = await jwtVerify(token, getJWTSecret(), { algorithms: [JWT_ALGORITHM] });
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Extract token from Authorization header
 */
export function extractToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const normalizedHeader = authHeader.trim();
  if (!normalizedHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return normalizedHeader.slice(7).trim() || null;
}

/**
 * Get user from NextRequest
 */
function getHeader(request: RequestLike, name: string): string | null {
  if (!request?.headers) {
    return null;
  }

  if (request.headers instanceof Headers) {
    return request.headers.get(name);
  }

  const lowerName = name.toLowerCase();
  const headerValue = request.headers[name] ?? request.headers[lowerName];
  return typeof headerValue === 'string' ? headerValue : null;
}

function getCookieValue(request: RequestLike, name: string): string | null {
  try {
    if (request?.cookies?.get) {
      const cookie = request.cookies.get(name);
      if (typeof cookie === 'string') {
        return cookie;
      }
      if (cookie?.value) {
        return cookie.value;
      }
    }
  } catch {
    // ignore
  }
  
  const cookieHeader = getHeader(request, 'cookie');
  
  if (!cookieHeader) {
    return null;
  }
  
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  
  return null;
}

/**
 * Проверяет, что сессия токена ещё жива в user_sessions (не отозвана через
 * /api/auth/signout и не истекла по expires_at). verifyToken выше проверяет
 * ТОЛЬКО подпись и exp самого JWT — без этой проверки logout был
 * косметическим: подпись оставалась годной ещё до 7 дней после удаления
 * строки сессии, и токен, утёкший например из localStorage, продолжал
 * работать. Внешний security-аудит владельца 28.08 (P1) поймал это.
 *
 * Fail-closed: сбой запроса к БД тоже трактуется как «сессия недействительна» —
 * это путь авторизации, отвечать «доступ есть» на «не смог проверить» нельзя (§4.0).
 */
export async function isSessionActive(token: string): Promise<boolean> {
  return (await checkSession(token)) === 'active';
}

/**
 * Та же проверка строки user_sessions, но с тремя исходами (§4.0):
 * 'active' — сессия жива, 'inactive' — отозвана или истекла,
 * 'unchecked' — запрос к БД не выполнился (причина уже в логе).
 *
 * isSessionActive схлопывает третий исход в «нет» — для гейта доступа это
 * верно. Но /api/auth/state обещает отличать «гость» от «не смог проверить»,
 * и до аудита 15.10 (P3-01) эта ветка была номинальной: роут сверял только
 * подпись, а verifyToken не бросает. Здесь у неё появился производитель.
 */
export type SessionCheck = 'active' | 'inactive' | 'unchecked';

export async function checkSession(token: string): Promise<SessionCheck> {
  try {
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM user_sessions WHERE token = $1 AND expires_at > now() LIMIT 1',
      [token],
    );
    return rows.length > 0 ? 'active' : 'inactive';
  } catch (err) {
    console.error('[auth/jwt] проверка сессии упала:', err instanceof Error ? err.message : err);
    return 'unchecked';
  }
}

export type SessionTokenCheck =
  | { status: 'valid'; payload: JWTPayload }
  | { status: 'invalid' }
  | { status: 'unchecked' };

/**
 * Подпись И строка сессии — для тех, у кого на руках сам токен, а не запрос:
 * серверные страницы читают cookie через cookies(), а /api/auth/me и
 * /api/auth/state берут токен в своём порядке — cookie раньше заголовка, как
 * /api/auth/signout, который строку сессии удаляет.
 *
 * Аудит 15.10, P3-01: /api/auth/me, /api/auth/state и три серверные
 * страницы звали голый verifyToken — после выхода подпись оставалась годной
 * ещё до 7 дней, вышедший оставался «вошедшим» для шапки, а утёкший токен
 * продолжал отдавать email и имя. Голый verifyToken вне lib/auth теперь
 * запрещён сторожем tests/unit/session-revocation-reaches-me.test.ts.
 */
export async function verifySessionToken(token: string): Promise<SessionTokenCheck> {
  const payload = await verifyToken(token);
  if (!payload) return { status: 'invalid' };
  const session = await checkSession(token);
  if (session === 'active') return { status: 'valid', payload };
  return session === 'unchecked' ? { status: 'unchecked' } : { status: 'invalid' };
}

export async function getUserFromRequest(request: RequestLike): Promise<JWTPayload | null> {
  const authHeader = getHeader(request, 'authorization');
  let token = extractToken(authHeader);

  if (!token) {
    token = getCookieValue(request, 'auth_token');
  }

  if (token) {
    const payload = await verifyToken(token);
    if (payload && await isSessionActive(token)) {
      return payload;
    }
  }

  return null;
}

/**
 * Короткоживущий (5 минут) токен «пароль подтверждён, жду код MFA».
 * Отдельная форма от createToken: НЕ несёт email/role, поэтому verifyToken
 * отвергнет его как обычный auth-токен по строгой проверке формы payload —
 * пере-использовать pending-токен вместо полной сессии нельзя даже случайно.
 */
export async function createMfaPendingToken(userId: string): Promise<string> {
  return new SignJWT({ userId, purpose: 'mfa_pending' })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(MFA_PENDING_EXPIRATION)
    .sign(getJWTSecret());
}

/** Возвращает userId, если pending-токен MFA валиден, иначе null. */
export async function verifyMfaPendingToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJWTSecret(), { algorithms: [JWT_ALGORITHM] });
    if (payload.purpose !== 'mfa_pending' || typeof payload.userId !== 'string') {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}
