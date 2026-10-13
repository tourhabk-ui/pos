/**
 * GET /api/carrier-reviews/eligible?carrier=<slug> — места этого человека в
 * поездках перевозчика, по которым можно оставить отзыв (миграция 1235):
 * заказаны им лично через Ведар, подтверждены перевозчиком, поездка не
 * отменена и её дата прошла, отзыва ещё нет.
 *
 * AUTH: вход обязателен (не в публичном реестре: Edge требует JWT, и
 * requireAuth внутри). Отказ базы — 503 с `searched: false`: страница должна
 * сказать «не смогли проверить», а не «поездок нет».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { CARRIER_SLUG_RE, findPublicCarrier, listReviewableSeats } from '@/lib/transfers/carrier-reviews';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const Query = z.object({ carrier: z.string().trim().regex(CARRIER_SLUG_RE, 'Не указан перевозчик') });

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверный запрос' }, { status: 400 });
  }

  try {
    const carrier = await findPublicCarrier(parsed.data.carrier);
    if (!carrier) return NextResponse.json({ success: false, error: 'Перевозчик не найден' }, { status: 404 });
    const seats = await listReviewableSeats(auth.userId, carrier.partnerId, kamchatkaToday());
    return NextResponse.json({ success: true, searched: true, data: { seats } });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[carrier-reviews/eligible] места не проверены: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return NextResponse.json(
      { success: false, searched: false, error: 'Не смогли проверить ваши поездки — попробуйте позже' },
      { status: 503 },
    );
  }
}
