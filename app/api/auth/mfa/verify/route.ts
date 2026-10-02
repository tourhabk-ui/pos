import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyAuth } from '@/lib/auth';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { decryptMfaSecret } from '@/lib/auth/mfa-crypto';
import { verifyTOTP } from '@/lib/auth/totp';

const mfaVerifyLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

// Та же форма кода, что у входа (login-verify): шесть цифр TOTP.
const BodySchema = z.object({
  token: z.string().trim().regex(/^\d{6}$/, 'Код должен состоять из 6 цифр'),
});

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!mfaVerifyLimiter.check(ip)) {
    return NextResponse.json(
      { error: 'Слишком много попыток. Попробуйте позже.' },
      { status: 429 }
    );
  }

  try {
    const auth = await verifyAuth(request);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Некорректное тело запроса' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Некорректный код' },
        { status: 400 }
      );
    }
    const mfaToken = parsed.data.token;

    // Получаем сохранённый MFA secret из БД
    const result = await query<{ mfa_secret: string }>(
      'SELECT mfa_secret FROM users WHERE id = $1',
      [auth.userId]
    );

    const user = result.rows[0];
    if (!user?.mfa_secret) {
      return NextResponse.json({ error: 'Двухфакторная защита не настроена' }, { status: 400 });
    }

    const verified = verifyTOTP(decryptMfaSecret(user.mfa_secret), mfaToken);

    if (verified) {
      await query(
        'UPDATE users SET mfa_enabled = true WHERE id = $1',
        [auth.userId]
      );
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Неверный код' }, { status: 400 });
  } catch (err) {
    console.error('[mfa/verify] сбой:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Внутренняя ошибка, попробуйте позже' }, { status: 500 });
  }
}
