/**
 * POST /api/request-drafts/resume { token, action: 'read' | 'withdraw' }
 * Страница /request-resume по ключу из ссылки напоминания: прочитать текст
 * пожелания (без ПД) или отозвать согласие на повторный контакт.
 *
 * AUTH: публичный (реестр lib/auth/public-api-routes); доступ — по ключу.
 * Частота — по IP. База не ответила — 503.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { readDraftByToken, withdrawByToken } from '@/lib/requests/request-drafts';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const Schema = z.object({
  token: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
  action: z.enum(['read', 'withdraw']),
});

export async function POST(req: NextRequest) {
  if (!limiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов. Попробуйте через минуту.' }, { status: 429 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 }); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Неверная ссылка' }, { status: 400 });
  try {
    if (parsed.data.action === 'withdraw') {
      const ok = await withdrawByToken(parsed.data.token);
      return ok ? NextResponse.json({ success: true }) : NextResponse.json({ success: false, error: 'Ссылка не найдена' }, { status: 404 });
    }
    const d = await readDraftByToken(parsed.data.token);
    if (!d) return NextResponse.json({ success: false, error: 'Ссылка не найдена' }, { status: 404 });
    return NextResponse.json({ success: true, ...d });
  } catch {
    return NextResponse.json({ success: false, error: 'База недоступна' }, { status: 503 });
  }
}
