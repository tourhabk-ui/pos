import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth, getTokenFromRequest } from '@/lib/auth';
import { createToken } from '@/lib/auth/jwt';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

const refreshLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

/**
 * POST /api/auth/refresh
 * Refreshes an existing valid JWT token.
 * The caller must send a valid (not yet expired) token.
 * Returns a new token with a fresh 7-day expiration.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!refreshLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много запросов. Попробуйте позже.' },
      { status: 429 }
    );
  }

  try {
    const oldToken = getTokenFromRequest(request);
    const auth = await verifyAuth(request);
    if (!auth.isAuthenticated || !auth.userId || !auth.email || !auth.role || !oldToken) {
      return NextResponse.json(
        { success: false, error: 'Токен недействителен' },
        { status: 401 }
      );
    }

    const newToken = await createToken({
      userId: auth.userId,
      email: auth.email,
      role: auth.role,
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Строка сессии переносится на новый токен, а не создаётся заново:
    // старая сессия должна остаться той же (один и тот же логический вход),
    // и signout по НОВОМУ токену обязан отзывать её так же надёжно, как по
    // старому. До этой правки refresh вообще не трогал user_sessions — токен
    // менялся, а строка под него оставалась под старым значением. С учётом
    // проверки сессии в verifyAuth (P1, аудит 28.08) это раньше означало бы,
    // что обновлённый токен сразу не проходит проверку сессии; матч по
    // старому токену здесь обязателен, иначе rowCount будет 0.
    const updated = await query(
      'UPDATE user_sessions SET token = $1, expires_at = $2 WHERE token = $3',
      [newToken, expiresAt, oldToken],
    );
    if (updated.rowCount === 0) {
      console.error('[auth/refresh] сессия исчезла между проверкой и обновлением');
      return NextResponse.json(
        { success: false, error: 'Сессия недействительна. Войдите заново.' },
        { status: 401 }
      );
    }

    const response = NextResponse.json({
      success: true,
      token: newToken,
    });

    response.cookies.set('auth_token', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return response;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка обновления токена' },
      { status: 500 }
    );
  }
}
