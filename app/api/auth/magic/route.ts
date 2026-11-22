/**
 * GET /api/auth/magic?token=<jwt>
 *
 * Вход по ссылке из Telegram-бота (команда /login) — без пароля.
 * Ссылка живёт 5 минут и срабатывает один раз; роли admin и учётным записям
 * с двухфакторной проверкой не выдаётся и здесь не принимается
 * (lib/auth/magic-link.ts). После проверки ставит auth_token cookie.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createToken } from '@/lib/auth/jwt';
import { pool } from '@/lib/db-pool';
import { MAGIC_USER_COLUMNS, magicLinkAllowed, readMagicToken, redeemMagicJti } from '@/lib/auth/magic-link';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.redirect(new URL('/auth/login?error=no_token', req.url));
  }

  try {
    const read = await readMagicToken(token);
    if (!read) {
      return NextResponse.redirect(new URL('/auth/login?error=expired', req.url));
    }

    const { rows } = await pool.query<{ id: string; email: string; name: string; role: string; mfa_enabled: boolean | null; preferences: unknown }>(
      `SELECT ${MAGIC_USER_COLUMNS} FROM users WHERE id = $1`,
      [read.userId]
    );

    if (!rows[0]) {
      return NextResponse.redirect(new URL('/auth/login?error=not_found', req.url));
    }

    const user = rows[0];
    if (!magicLinkAllowed(user)) {
      return NextResponse.redirect(new URL('/auth/login?error=magic_not_allowed', req.url));
    }

    // Одноразовость: погашение одной вставкой. Уже погашена — входа нет.
    if (!(await redeemMagicJti(pool, read.jti, user.id))) {
      return NextResponse.redirect(new URL('/auth/login?error=expired', req.url));
    }

    // Создаём полноценный auth_token (7 дней)
    const authToken = await createToken({
      userId: user.id,
      email:  user.email,
      role:   user.role,
    });

    // Строка user_sessions — условие входа, не аудит: без неё verifyAuth
    // отвергнет этот же токен на первом же запросе (P1, отзыв сессии, аудит
    // 28.08). До этой правки magic-link вообще не писал в user_sessions —
    // единственный путь входа, где её не было совсем.
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    try {
      await pool.query(
        `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [user.id, authToken, expiresAt],
      );
    } catch (err) {
      console.error('[auth/magic] запись сессии не удалась:', err instanceof Error ? err.message : err);
      return NextResponse.redirect(new URL('/auth/login?error=session_failed', req.url));
    }

    const redirect = '/hub/tourist';

    const res = NextResponse.redirect(new URL(redirect, req.url));
    res.cookies.set('auth_token', authToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   60 * 60 * 24 * 7,
      path:     '/',
    });
    return res;

  } catch {
    return NextResponse.redirect(new URL('/auth/login?error=expired', req.url));
  }
}
