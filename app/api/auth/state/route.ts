import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, extractToken } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/state — «вошёл ли смотрящий», без 401.
 *
 * Шапка на каждом экране спрашивала /api/auth/me, а у гостя это 401: лишний
 * красный запрос в консоли на 74 страницах из 78 (#1780). Гость — не ошибка,
 * а нормальный ответ, и код ему полагается 200. Здесь три исхода, не два:
 * `authenticated: true | false`, а отказ проверки — 500 с логом, не
 * «гость» (§4.0). Данных пользователя роут не отдаёт — за ними /api/auth/me.
 *
 * «Вошёл» — это подпись И живая строка user_sessions (аудит 15.10, P3-01):
 * до этого роут сверял только подпись, и после выхода шапка ещё до 7 дней
 * показывала вышедшего вошедшим. Ветка 500 тогда была номинальной —
 * verifyToken не бросает; теперь её производитель — сбой запроса сессии.
 */
const UNCHECKED = () =>
  NextResponse.json({ success: false, error: 'Не удалось проверить сессию' }, { status: 500 });

export async function GET(request: NextRequest) {
  const cookieToken = request.cookies.get('auth_token')?.value;
  const headerToken = extractToken(request.headers.get('Authorization'));
  const token = cookieToken || headerToken;
  if (!token) {
    return NextResponse.json({ success: true, data: { authenticated: false } });
  }
  try {
    const session = await verifySessionToken(token);
    if (session.status === 'unchecked') {
      // Причина (текст ошибки БД) уже в логе checkSession; здесь — чей вопрос.
      console.error('[auth/state] сессия не проверена — ответ «не знаю», не «гость»');
      return UNCHECKED();
    }
    return NextResponse.json({ success: true, data: { authenticated: session.status === 'valid' } });
  } catch (err) {
    console.error('[auth/state] проверка токена не выполнена', err instanceof Error ? err.message : err);
    return UNCHECKED();
  }
}
