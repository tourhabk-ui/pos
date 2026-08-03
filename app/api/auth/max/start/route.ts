/**
 * POST /api/auth/max/start
 *
 * Начинает вход через MAX: создаёт одноразовую сессию (nonce) и возвращает
 * deep-link в бота. Пользователь открывает ссылку, жмёт «Старт» — бот
 * подтверждает nonce. Дальше сайт опрашивает /api/auth/max/status.
 *
 * Env:
 *   NEXT_PUBLIC_MAX_BOT_LINK — ссылка на бота (default https://max.ru/id4101147649_bot)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createMaxLoginSession } from '@/lib/auth/max-login';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const startLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// Ссылка на бота строго на max.ru — env с посторонним хостом игнорируем
// (deep-link уходит в window.open на клиенте; чужой хост = open redirect).
function botLink(): string {
  const fallback = 'https://max.ru/id4101147649_bot';
  const candidate = process.env.NEXT_PUBLIC_MAX_BOT_LINK ?? fallback;
  try {
    const u = new URL(candidate);
    if (u.protocol === 'https:' && (u.hostname === 'max.ru' || u.hostname.endsWith('.max.ru'))) {
      return candidate.replace(/\/$/, '');
    }
  } catch { /* битый URL в env */ }
  return fallback;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request.headers);
  if (!startLimiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов.' }, { status: 429 });
  }

  try {
    const { nonce } = await createMaxLoginSession();
    const deepLink = `${botLink()}?start=login-${nonce}`;
    return NextResponse.json({
      success: true,
      nonce,
      deepLink,
      expiresIn: 300,
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Не удалось начать вход через MAX.' }, { status: 500 });
  }
}
