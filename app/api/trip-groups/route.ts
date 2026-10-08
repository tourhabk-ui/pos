/**
 * POST /api/trip-groups — завести группу для общего плана поездки (#2226).
 *
 * AUTH: публичный by design — организатор, как и участники, без аккаунта.
 * Защита: rate-limit, Zod, даты в пределах, которые собирает планер. Группа —
 * только даты; ни имён, ни контактов. Доступ к ней — знанием id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { createGroup, groupDatesProblem } from '@/lib/planner/trip-groups';
import { getPublicBaseUrl } from '@/lib/config';
import { kamchatkaToday } from '@/lib/seat-requests/core';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const Schema = z.object({
  arrival_date:   z.string().regex(DAY, 'Формат даты: ГГГГ-ММ-ДД'),
  departure_date: z.string().regex(DAY, 'Формат даты: ГГГГ-ММ-ДД'),
});

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов. Попробуйте через минуту.' }, { status: 429 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  const { arrival_date, departure_date } = parsed.data;
  const problem = groupDatesProblem(arrival_date, departure_date, kamchatkaToday());
  if (problem) return NextResponse.json({ success: false, error: problem }, { status: 422 });

  const id = await createGroup(arrival_date, departure_date);
  if (!id) return NextResponse.json({ success: false, error: 'Не удалось завести группу, попробуйте через минуту.' }, { status: 503 });
  return NextResponse.json({ success: true, data: { id, url: `${getPublicBaseUrl()}/trip-group/${id}` } });
}
