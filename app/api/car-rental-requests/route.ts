/**
 * POST /api/car-rental-requests — заявка на прокат автомобиля с формы на
 * странице прокатчика /car-rental/[slug] (витрина проката, решение владельца
 * 23.10 «пока берем аренду автомобилей и трансфер»; схема 1317).
 *
 * AUTH: публичный by design — арендатор без аккаунта, как заявка на машину
 * перевозчика. Защита: rate-limit, Zod, обязательное согласие на ПД с
 * текстом, который называет получателя — прокат автомобилей (purpose 'rental').
 *
 * Путь записи — lib/rental/rental-request-service: даты, текст менеджеру,
 * повтор. Это заявка, не бронь: машина не закрепляется, занятость система не
 * ведёт, оплаты через платформу нет. Машина — только строка прайса этого
 * прокатчика, слово в слово: чужой текст машиной не становится.
 *
 * Ответ на повтор неотличим от ответа на новую заявку (оракул «этот телефон
 * уже просил эту машину», как у заявки перевозчику). В логи — ни телефона,
 * ни имени: только SQLSTATE и обрезанное сообщение ошибки.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { loadRentalCompanyBySlug } from '@/lib/rental/rental';
import { rentalPagePath } from '@/lib/rental/rental-format';
import { rentalDays } from '@/lib/rental/rental-request';
import {
  buildRentalLead,
  checkRentalDates,
  rentalLeadTooThin,
  saveRentalLead,
  type RentalDatesCheck,
} from '@/lib/rental/rental-request-service';
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';
import { isSelfVisit } from '@/lib/analytics/self-visit';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const Schema = z.object({
  company:    z.string().trim().min(1, 'Не указан прокатчик').max(100),
  car:        z.string().trim().min(1, 'Выберите машину').max(120, 'Название машины длиннее 120 символов'),
  date_from:  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Выберите дату начала аренды'),
  date_to:    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Выберите дату возврата'),
  // Имя — одной строкой: в уведомлении менеджеру оно стоит над телефоном.
  name:       z.string().trim().min(2, 'Имя: минимум 2 символа').max(120, 'Имя длиннее 120 символов')
    .regex(/^[^\p{Cc}]+$/u, 'Имя — одной строкой'),
  phone:      z.string().trim().min(5, 'Укажите телефон — по нему подтвердят заявку').max(50),
  comment:    z.string().trim().max(1000, 'Комментарий длиннее 1000 символов').optional(),
  pd_consent: z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

function datesError(d: Exclude<RentalDatesCheck, { ok: true }>): string {
  switch (d.reason) {
    case 'not_in_calendar': return 'Такой даты нет в календаре';
    case 'past': return 'Дата начала аренды уже прошла';
    case 'too_far': return `Прайс прокатчика годовой: выберите дату в пределах ${d.maxDaysAhead} дней`;
    case 'bad_return': return `Дата возврата — не раньше начала и не позже чем через ${d.maxDays} дн.`;
  }
}

const fail = (status: number, error: string, field?: string) =>
  NextResponse.json({ success: false, error, ...(field ? { field } : {}) }, { status });

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) return fail(429, 'Слишком много запросов. Попробуйте через минуту.');

  let body: unknown;
  try { body = await req.json(); } catch { return fail(400, 'Неверный формат запроса'); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(400, first?.message ?? 'Неверные данные формы', String(first?.path?.[0] ?? ''));
  }
  const d = parsed.data;

  const phone = normalizePhone(d.phone);
  if (!phone) return fail(400, 'Телефон не похож на номер: нужно 10–15 цифр, например +7 900 123-45-67', 'phone');

  const dates = checkRentalDates(d.date_from, d.date_to, kamchatkaToday());
  if (!dates.ok) return fail(400, datesError(dates), dates.field);

  // Отказ базы — не «прокатчика нет» (§4.0): заявка не создаётся, человек
  // знает, что это сбой нашей стороны.
  let company;
  try {
    company = await loadRentalCompanyBySlug(d.company);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[car-rental-requests] прокатчик не прочитан: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return fail(503, 'Не удалось проверить прокатчика — заявка не создана. Попробуйте позже или позвоните ему.');
  }
  if (!company) return fail(404, 'Такого прокатчика нет на Ведаре');

  const offer = company.offers.find((o) => o.title === d.car);
  if (!offer) return fail(400, 'Такой машины нет в прайсе прокатчика — выберите из списка', 'car');

  const facts = {
    company, offer, dateFrom: d.date_from, dateTo: d.date_to,
    days: rentalDays(d.date_from, d.date_to), comment: d.comment || null,
  };
  const lead = buildRentalLead(facts, 'form');
  if (rentalLeadTooThin(d.name, phone, lead)) {
    return fail(400, 'Заявка слишком неполная — менеджер её не увидит. Укажите имя и фамилию.', 'name');
  }

  const consent = buildConsentRecord(true, ip, 'car-rental-page', 'rental');
  const leadId = await saveRentalLead({
    facts, lead, name: d.name, phone, consent,
    // Свой визит владельца (метка 1145) — заявка с пометкой, вне счёта спроса.
    isSelf: isSelfVisit(req.headers.get('cookie')),
    sourceUrl: `${getPublicBaseUrl()}${rentalPagePath(company.slug)}`,
  });
  if (!leadId) return fail(503, 'Не удалось сохранить заявку — попробуйте позже или позвоните прокатчику.');

  return NextResponse.json({
    success: true,
    data: {
      company: company.name,
      car: offer.title,
      date_from: d.date_from,
      date_to: d.date_to,
      days: facts.days,
      price: { rub_per_day: offer.priceRubPerDay, is_from: offer.priceIsFrom },
    },
  });
}
