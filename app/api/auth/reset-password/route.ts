/**
 * POST /api/auth/reset-password — новый пароль по токену из ссылки.
 *
 * Публичный вход (префикс /api/auth открыт на Edge). Правило пароля — то же,
 * что везде (passwordSchema). Погашение — lib/auth/password-reset: токен
 * одноразовый, срочный, по хешу. После успеха человек входит обычным путём —
 * сессия здесь не выдаётся: ссылка из письма не должна быть равна входу.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { passwordSchema } from '@/lib/auth/password';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { consumePasswordResetToken, CONSUME_FAILURE_TEXT } from '@/lib/auth/password-reset';

export const dynamic = 'force-dynamic';

const ipLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

const Schema = z.object({
  token: z.string().min(20, 'Ссылка повреждена').max(200, 'Ссылка повреждена'),
  password: passwordSchema,
});

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!ipLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много попыток. Попробуйте через 15 минут.' },
      { status: 429 },
    );
  }

  const parsed = Schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await consumePasswordResetToken(parsed.data.token, parsed.data.password);
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[reset-password] погашение не удалось:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 503 });
  }

  if (!result.ok) {
    return NextResponse.json({ success: false, error: CONSUME_FAILURE_TEXT[result.reason] }, { status: 400 });
  }

  return NextResponse.json({ success: true, message: 'Пароль изменён. Теперь войдите с новым паролем.' });
}
