/**
 * POST /api/carrier-reviews — отзыв о перевозчике (миграция 1235; слово
 * владельца 13.10: «делай блок отзывов но логично»).
 *
 * Отзыв оставляет только тот, кто ехал, — двумя путями, и у каждого своё
 * доказательство:
 *   · via 'seat' — вход в аккаунт и заказанное через Ведар место в поездке
 *     этого перевозчика: подтверждено, поездка не отменена, дата прошла;
 *   · via 'link' — ключ одноразовой ссылки, которую менеджер Ведара выдал,
 *     подтвердив, что поездка по заявке на машину состоялась.
 *
 * AUTH: публичный маршрут (в реестре — POST), потому что заказчик машины
 * аккаунта не заводил: его доказательство — ключ, а не вход. Путь 'seat'
 * требует входа внутри (requireAuth). Без места и без ключа писать некуда —
 * анонимного отзыва нет. Rate-limit по IP, Zod.
 *
 * Отказы — словами правила («после даты поездки», «ссылка устарела»), а не
 * «что-то пошло не так»: человек должен понять, почему нельзя.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import {
  CARRIER_SLUG_RE,
  findPublicCarrier,
  writeInviteReview,
  writeSeatReview,
  type WriteReviewResult,
} from '@/lib/transfers/carrier-reviews';
import { inviteProblemText, isInviteKeyShape, normalizeAuthorName } from '@/lib/transfers/carrier-review-rules';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const common = {
  carrier: z.string().trim().regex(CARRIER_SLUG_RE, 'Не указан перевозчик'),
  rating: z.number({ error: 'Поставьте оценку от 1 до 5' }).int().min(1, 'Поставьте оценку от 1 до 5').max(5, 'Поставьте оценку от 1 до 5'),
  comment: z.string().trim().max(4000, 'Отзыв длиннее 4000 символов').optional().default(''),
};

const Body = z.discriminatedUnion('via', [
  z.object({ via: z.literal('seat'), seat_booking_id: z.string().uuid('Выберите поездку'), ...common }),
  z.object({
    via: z.literal('link'),
    key: z.string().refine(isInviteKeyShape, 'Ссылка на отзыв не распознана — откройте её из сообщения целиком'),
    author_name: z.string().max(200),
    ...common,
  }),
]);

const fail = (status: number, error: string, field?: string) =>
  NextResponse.json({ success: false, error, ...(field ? { field } : {}) }, { status });

function refusal(r: Exclude<WriteReviewResult, { ok: true }>): NextResponse {
  switch (r.reason) {
    case 'not_found': return fail(404, 'Такого заказа места у этого перевозчика в вашем аккаунте нет');
    case 'not_confirmed': return fail(403, 'Отзыв — только по месту, которое перевозчик подтвердил');
    case 'trip_cancelled': return fail(403, 'Эта поездка отменена — отзыв по ней оставить нельзя');
    case 'not_yet': return fail(403, 'Отзыв можно оставить на следующий день после поездки');
    case 'already': return fail(409, 'Отзыв по этой поездке уже оставлен');
    case 'unknown':
    case 'expired':
    case 'used': return fail(r.reason === 'unknown' ? 404 : 410, inviteProblemText(r.reason));
  }
}

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) return fail(429, 'Слишком много запросов. Попробуйте через минуту.');

  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, 'Неверный формат запроса'); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(400, first?.message ?? 'Неверные данные отзыва', String(first?.path?.[0] ?? ''));
  }
  const b = parsed.data;

  try {
    const carrier = await findPublicCarrier(b.carrier);
    if (!carrier) return fail(404, 'Перевозчик не найден');

    let result: WriteReviewResult;
    if (b.via === 'seat') {
      const auth = await requireAuth(req);
      if (auth instanceof NextResponse) return fail(401, 'Войдите в аккаунт, в котором заказывали место');
      result = await writeSeatReview({
        userId: auth.userId,
        partnerId: carrier.partnerId,
        seatBookingId: b.seat_booking_id,
        rating: b.rating,
        comment: b.comment,
        today: kamchatkaToday(),
      });
    } else {
      const authorName = normalizeAuthorName(b.author_name);
      if (!authorName) {
        return fail(400, 'Подпись — имя буквами, от 2 до 60 знаков; без телефона и почты: отзыв увидят все', 'author_name');
      }
      result = await writeInviteReview({
        partnerId: carrier.partnerId,
        key: b.key,
        authorName,
        rating: b.rating,
        comment: b.comment,
      });
    }

    if (!result.ok) return refusal(result);
    return NextResponse.json({ success: true, data: { id: result.id, carrier: carrier.slug }, message: 'Отзыв опубликован' });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[carrier-reviews] отзыв не записан: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return fail(503, 'Не удалось сохранить отзыв — сбой на нашей стороне. Попробуйте позже.');
  }
}
