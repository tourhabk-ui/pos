/**
 * GET /api/seat-requests/status?t=<ключ статуса> — что ответил оператор.
 *
 * AUTH: публичный; доступ — по ключу статуса, который получил только автор
 * запроса. ПД туриста в ответе нет — они ему известны.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { readSeatRequest, touristBotLinks } from '@/lib/seat-requests/service';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 60 });

export async function GET(req: NextRequest) {
  if (!limiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }
  const t = req.nextUrl.searchParams.get('t') ?? '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(t)) {
    return NextResponse.json({ success: false, error: 'Неверная ссылка' }, { status: 400 });
  }
  const view = await readSeatRequest(t);
  if (view === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не удалось проверить статус, попробуйте через минуту' }, { status: 503 });
  }
  if (view === null) return NextResponse.json({ success: false, error: 'Запрос не найден' }, { status: 404 });
  return NextResponse.json({ success: true, data: { ...view, botLinks: touristBotLinks(t) } });
}
