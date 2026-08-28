import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createToken, verifyMfaPendingToken } from '@/lib/auth/jwt';
import { decryptMfaSecret } from '@/lib/auth/mfa-crypto';
import { verifyTOTP } from '@/lib/auth/totp';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { ApiResponse } from '@/types';
import { UsersRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

// 5 попыток в минуту на IP — тот же бюджет, что у /api/auth/mfa/verify.
const mfaLoginLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const BodySchema = z.object({
  mfaPendingToken: z.string().min(1, 'Токен подтверждения отсутствует'),
  code: z.string().regex(/^\d{6}$/, 'Код должен состоять из 6 цифр'),
});

/**
 * POST /api/auth/mfa/login-verify
 * Второй шаг входа для аккаунтов с MFA: код TOTP + pending-токен из
 * /api/auth/signin → полноценная сессия (JWT + cookie + строка user_sessions).
 * Публичный: pending-токен уже подтверждает, что пароль был верным, но сам
 * по себе не даёт доступа ни к чему — только к этому шагу (5 минут жизни).
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!mfaLoginLimiter.check(ip)) {
    return NextResponse.json({
      success: false,
      error: 'Слишком много попыток. Попробуйте через минуту.',
    } as ApiResponse<null>, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректный запрос' } as ApiResponse<null>, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues[0]?.message || 'Некорректные данные',
    } as ApiResponse<null>, { status: 400 });
  }

  const { mfaPendingToken, code } = parsed.data;

  const userId = await verifyMfaPendingToken(mfaPendingToken);
  if (!userId) {
    return NextResponse.json({
      success: false,
      error: 'Токен подтверждения недействителен или истёк. Войдите заново.',
    } as ApiResponse<null>, { status: 401 });
  }

  const userResult = await pool.query<UsersRow>(
    `SELECT id, email, name, role, preferences, created_at, updated_at, mfa_enabled, mfa_secret
     FROM users WHERE id = $1`,
    [userId],
  );
  const user = userResult.rows[0];

  if (!user || !user.mfa_enabled || !user.mfa_secret) {
    return NextResponse.json({
      success: false,
      error: 'MFA для этого аккаунта не настроен',
    } as ApiResponse<null>, { status: 400 });
  }

  const verified = verifyTOTP(decryptMfaSecret(user.mfa_secret), code);
  if (!verified) {
    return NextResponse.json({
      success: false,
      error: 'Неверный код',
    } as ApiResponse<null>, { status: 400 });
  }

  const token = await createToken({ userId: user.id, email: user.email, role: user.role });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  try {
    await pool.query(
      `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt],
    );
  } catch (err) {
    console.error('[mfa/login-verify] запись сессии не удалась:', err instanceof Error ? err.message : err);
    return NextResponse.json({
      success: false,
      error: 'Не удалось создать сессию. Попробуйте войти ещё раз.',
    } as ApiResponse<null>, { status: 502 });
  }

  const userData = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roles: [user.role],
    preferences: user.preferences || {},
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    token,
  };

  const response = NextResponse.json({ success: true, data: userData } as ApiResponse<unknown>);

  response.cookies.set('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}
