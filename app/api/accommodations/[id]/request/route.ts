/**
 * POST /api/accommodations/[id]/request — заявка хозяину жилья без своей
 * брони (миграция 1206, решение владельца 10.10).
 *
 * AUTH: публичный by design — гость без аккаунта, как в запросе мест тура
 * (/api/seat-requests). Защита: rate-limit, Zod, обязательное согласие на ПД
 * (текст варианта «владельцу жилья», lib/legal/pd-consent), ПД гостя уходят
 * только в MAX. Принимается только объектом «через владельца»: опубликован,
 * есть телефон, нет своего сайта брони и нет номеров — у объекта с номерами
 * своя бронь (/book), и второй путь противоречил бы ей.
 *
 * Согласие пишется в той же вставке, что заявка (stay_requests, NOT NULL).
 * Ответ называет, кому заявка дошла: хозяину, оператору платформы или никому
 * (lib/stay/stay-request — три исхода). Запись и доставка — общий путь с
 * MCP-инструментом create_stay_request (lib/stay/stay-request-service).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { checkStayDates, submitStayRequest } from '@/lib/stay/stay-request-service';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const IdSchema = z.string().uuid();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Schema = z.object({
  check_in:   z.string().regex(DATE, 'Укажите дату заезда'),
  check_out:  z.string().regex(DATE, 'Укажите дату выезда'),
  guests:     z.coerce.number().int().min(1, 'Минимум 1 гость').max(50, 'Не больше 50 гостей'),
  name:       z.string().trim().min(2, 'Имя: минимум 2 символа').max(120),
  phone:      z.string().trim().min(10, 'Телефон слишком короткий').max(20, 'Телефон слишком длинный')
                .regex(/^[+\d\s()-]+$/, 'Телефон: только цифры, пробелы, скобки и дефис'),
  comment:    z.string().trim().max(1000, 'Комментарий: не больше 1000 символов').optional(),
  pd_consent: z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

function fail(error: string, status: number, field?: string) {
  return NextResponse.json({ success: false, error, ...(field ? { field } : {}) }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) return fail('Слишком много запросов. Попробуйте через минуту.', 429);

  const idParsed = IdSchema.safeParse((await params).id);
  if (!idParsed.success) return fail('Объект не найден', 404);

  let body: unknown;
  try { body = await req.json(); } catch { return fail('Неверный формат запроса', 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first?.message ?? 'Неверные данные формы', 400, first?.path?.[0]?.toString());
  }
  const d = parsed.data;

  const dates = checkStayDates(d.check_in, d.check_out, kamchatkaToday());
  if (!dates.ok) return fail(dates.error, 400, dates.field);

  const consent = buildConsentRecord(true, ip, 'stay-request', 'stay');
  if (!consent) return fail('Нужно согласие на обработку персональных данных', 400, 'pd_consent');

  // Какие объекты принимают заявку, запись, доставка хозяину и оператору —
  // общий путь с MCP (lib/stay/stay-request-service).
  const r = await submitStayRequest({
    accommodationId: idParsed.data,
    checkIn: d.check_in,
    checkOut: d.check_out,
    nights: dates.nights,
    guests: d.guests,
    guestName: d.name,
    guestPhone: d.phone,
    comment: d.comment || null,
    consent,
    door: 'form',
  });
  if (!r.ok) {
    return r.reason === 'not_accepting'
      ? fail('У этого объекта заявка через форму не принимается', 404)
      : fail('Не удалось принять заявку. Позвоните владельцу по телефону на карточке.', 503);
  }
  const { delivered } = r;
  if (delivered === 'none') {
    return NextResponse.json({
      success: false,
      error: 'Заявка записана, но передать её сейчас не удалось. Позвоните владельцу по телефону на карточке.',
      data: { delivered },
    }, { status: 502 });
  }
  return NextResponse.json({ success: true, data: { delivered } });
}
