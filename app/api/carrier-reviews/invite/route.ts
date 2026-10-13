/**
 * POST /api/carrier-reviews/invite — что за поездка по ключу ссылки на отзыв
 * (заявка на машину, миграция 1235). Страница отзыва спрашивает это до формы,
 * чтобы человек видел, о какой поездке пишет, и не писал зря по устаревшей
 * ссылке.
 *
 * AUTH: публичный (в реестре POST по префиксу /api/carrier-reviews) —
 * доказательство здесь ключ. Ключ — в теле, не в адресе: адреса оседают в
 * логах. Ответ — направление и даты из заявки; имени и телефона заказчика в
 * нём нет: ссылку могли переслать.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { CARRIER_SLUG_RE, checkInvite, findPublicCarrier } from '@/lib/transfers/carrier-reviews';
import { inviteProblemText, isInviteKeyShape } from '@/lib/transfers/carrier-review-rules';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const Body = z.object({
  carrier: z.string().trim().regex(CARRIER_SLUG_RE, 'Не указан перевозчик'),
  key: z.string().refine(isInviteKeyShape, 'Ссылка на отзыв не распознана — откройте её из сообщения целиком'),
});

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: NextRequest) {
  if (!limiter.check(getTrustedClientIp(req.headers))) return fail(429, 'Слишком много запросов. Попробуйте через минуту.');

  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, 'Неверный формат запроса'); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Неверные данные');

  try {
    const carrier = await findPublicCarrier(parsed.data.carrier);
    if (!carrier) return fail(404, 'Перевозчик не найден');
    const check = await checkInvite(carrier.partnerId, parsed.data.key);
    if (check.state !== 'ok') {
      return NextResponse.json({ success: true, data: { state: check.state, message: inviteProblemText(check.state) } });
    }
    return NextResponse.json({
      success: true,
      data: { state: 'ok', destination: check.destination, date_from: check.dateFrom, date_to: check.dateTo },
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[carrier-reviews/invite] ссылка не проверена: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return fail(503, 'Не смогли проверить ссылку — сбой на нашей стороне. Попробуйте позже.');
  }
}
