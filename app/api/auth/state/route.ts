import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractToken } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/state — «вошёл ли смотрящий», без 401.
 *
 * Шапка на каждом экране спрашивала /api/auth/me, а у гостя это 401: лишний
 * красный запрос в консоли на 74 страницах из 78 (#1780). Гость — не ошибка,
 * а нормальный ответ, и код ему полагается 200. Здесь три исхода, не два:
 * `authenticated: true | false`, а отказ проверки токена — 500 с логом, не
 * «гость» (§4.0). Данных пользователя роут не отдаёт — за ними /api/auth/me.
 */
export async function GET(request: NextRequest) {
  const cookieToken = request.cookies.get('auth_token')?.value;
  const headerToken = extractToken(request.headers.get('Authorization'));
  const token = cookieToken || headerToken;
  if (!token) {
    return NextResponse.json({ success: true, data: { authenticated: false } });
  }
  try {
    const payload = await verifyToken(token);
    return NextResponse.json({ success: true, data: { authenticated: Boolean(payload) } });
  } catch (err) {
    console.error('[auth/state] проверка токена не выполнена', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось проверить сессию' },
      { status: 500 },
    );
  }
}
