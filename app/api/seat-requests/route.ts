/**
 * POST /api/seat-requests — турист спрашивает у оператора свободные места
 * (решение владельца 29.09).
 *
 * AUTH: публичный by design — у туриста из планера аккаунта нет. Защита:
 * rate-limit, Zod, обязательное согласие на ПД (форма с галочкой одна —
 * наша), ответ оператору уходит только в его подключённый канал.
 *
 * Ключ статуса отдаётся ОДИН раз, в базе — хэш.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { REPLY_CHANNELS, SEAT_REQUEST_FAILURE } from '@/lib/seat-requests/core';
import { createSeatRequest, statusUrl, touristBotLinks } from '@/lib/seat-requests/service';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const Schema = z.object({
  tour_id:       z.coerce.number().int().positive({ message: 'Укажите тур' }),
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: ГГГГ-ММ-ДД'),
  participants:  z.coerce.number().int().min(1, 'Минимум 1 человек').max(100, 'Не больше 100 человек'),
  tourist_name:  z.string().trim().min(2, 'Имя: минимум 2 символа').max(255),
  tourist_phone: z.string().trim().min(10, 'Телефон слишком короткий').max(20, 'Телефон слишком длинный'),
  reply_channel: z.enum(REPLY_CHANNELS, { message: 'Выберите, где получить ответ' }),
  pd_consent:    z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
  // Код агентской ссылки, пойманный ReferralCapture: плохой код бронь без
  // атрибуции, а не отказ туристу (решает reserveBooking).
  referral_code: z.string().trim().max(32).optional(),
  // Откуда спросили: планер или карточка тура без расписания (04.10).
  source:        z.enum(['planner', 'tour_card']).default('planner'),
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
    const first = parsed.error.issues[0];
    return NextResponse.json({ success: false, error: first?.message ?? 'Неверные данные формы', field: first?.path?.[0] }, { status: 400 });
  }
  const d = parsed.data;

  const consent = buildConsentRecord(true, ip, 'seat-request');
  if (!consent) {
    return NextResponse.json({ success: false, error: 'Нужно согласие на обработку персональных данных' }, { status: 400 });
  }

  const result = await createSeatRequest({
    tourId: d.tour_id,
    date: d.date,
    participants: d.participants,
    touristName: d.tourist_name,
    touristPhone: d.tourist_phone,
    replyChannel: d.reply_channel,
    pdConsent: consent,
    referralCode: d.referral_code ?? null,
    source: d.source,
  });

  if (!result.ok) {
    const r = SEAT_REQUEST_FAILURE[result.reason] ?? SEAT_REQUEST_FAILURE.check_failed!;
    return NextResponse.json({ success: false, error: r.error, reason: result.reason }, { status: r.status });
  }

  return NextResponse.json({
    success: true,
    data: {
      status_token: result.statusToken,
      status_url: statusUrl(result.statusToken),
      deadline_at: result.deadlineAt.toISOString(),
      bot_links: touristBotLinks(result.statusToken),
    },
  });
}
