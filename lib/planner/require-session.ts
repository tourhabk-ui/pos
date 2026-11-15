/**
 * Вход для API планера (слово владельца 14.11 «6-3»: без входа планер не
 * работает; «нужно ограничивать пользователей без регистрации»).
 *
 * Подпись токена И живая строка сессии — как у страницы /planner: по одной
 * подписи вышедший ещё до 7 дней оставался бы «вошедшим». Три исхода (§4.0):
 * вошёл; не вошёл — 401 со ссылкой на вход; не смогли проверить — 503, а не
 * «вы не вошли».
 */
import { NextRequest, NextResponse } from 'next/server';
import { extractToken, verifySessionToken } from '@/lib/auth/jwt';
import { plannerLoginHref } from '@/lib/planner/login-gate';

export const PLANNER_LOGIN_REQUIRED = 'Планер работает после входа: план хранится в личном кабинете.';
export const PLANNER_SESSION_UNCHECKED = 'Не смогли проверить вход. Попробуйте через минуту.';

export async function plannerSession(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const token = extractToken(req.headers.get('authorization')) ?? req.cookies.get('auth_token')?.value ?? null;
  const check = token ? await verifySessionToken(token) : { status: 'invalid' as const };
  if (check.status === 'valid') return { userId: check.payload.userId };
  if (check.status === 'unchecked') {
    return NextResponse.json({ success: false, error: PLANNER_SESSION_UNCHECKED }, { status: 503 });
  }
  return NextResponse.json(
    { success: false, error: PLANNER_LOGIN_REQUIRED, login: plannerLoginHref() },
    { status: 401 },
  );
}
