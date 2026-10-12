/**
 * GET /api/requests/status?k=<ключ статуса> — состояние заявки для человека
 * по ключу из ответа агента (вторая половина ступени 1 контура, #2371).
 * То же, что агенту даёт get_request_status, без подсказок про инструменты
 * и без имени и телефона — они человеку известны.
 *
 * AUTH: публичный (реестр lib/auth/public-api-routes); доступ — по ключу,
 * который получили только агент и человек. Частота — по IP. Ключ в запросе
 * сюда — осознанно (как `t` у /api/seat-requests/status): страница держит
 * его во фрагменте, в метрику просмотров он не попадает.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { readRequestStatus } from '@/lib/mcp/request-status';
import { McpUserError } from '@/lib/mcp/jsonrpc';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 60 });

export async function GET(req: NextRequest) {
  if (!limiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }
  const k = req.nextUrl.searchParams.get('k') ?? '';
  try {
    const { state, kind, tour, date, participants, alt_date, deadline, human, consent } = await readRequestStatus(k);
    return NextResponse.json({ success: true, data: { state, kind, tour, date, participants, alt_date, deadline, human, consent } });
  } catch (err) {
    if (err instanceof McpUserError) {
      // key_not_found — ключа нет или истёк (404); прочее — ключ не той формы (400).
      return NextResponse.json({ success: false, error: err.message }, { status: err.code === 'key_not_found' ? 404 : 400 });
    }
    // База не ответила: причина уже в логе (readRequestStatus); человеку — «не смог», не «ждёт оператора».
    return NextResponse.json({ success: false, error: 'Не удалось проверить состояние заявки, попробуйте через минуту' }, { status: 503 });
  }
}
