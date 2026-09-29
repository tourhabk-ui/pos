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
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { REPLY_CHANNELS } from '@/lib/seat-requests/core';
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
});

const REASON_TEXT: Record<string, { status: number; error: string }> = {
  date_past:            { status: 422, error: 'Выбранная дата уже прошла.' },
  tour_not_found:       { status: 404, error: 'Тур не найден или больше не доступен.' },
  operator_unreachable: { status: 409, error: 'Этот оператор пока не принимает запросы мест в мессенджере. Оставьте заявку — менеджер свяжется с оператором.' },
  delivery_failed:      { status: 502, error: 'Не удалось доставить запрос оператору. Оставьте заявку — менеджер свяжется с ним.' },
  check_failed:         { status: 503, error: 'Не удалось отправить запрос, попробуйте через минуту.' },
};

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
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
    source: 'planner',
  });

  if (!result.ok) {
    const r = REASON_TEXT[result.reason] ?? REASON_TEXT.check_failed!;
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
