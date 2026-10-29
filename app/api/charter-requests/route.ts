/**
 * POST /api/charter-requests — заявка на машину целиком с формы на
 * странице перевозчика /transfers/[slug] (стандарт карточки трансфера 13.10;
 * владелец: «да делай»). До этого заявку можно было отправить только через
 * MCP или звонком.
 *
 * AUTH: публичный by design — турист без аккаунта. Защита: rate-limit, Zod,
 * обязательное согласие на ПД с текстом, который называет получателя —
 * перевозчика (purpose 'carrier').
 *
 * Путь записи — общий с MCP request_charter (lib/transfers/charter-request-
 * service): те же даты, тот же план по прайсу и парку, тот же текст
 * менеджеру, тот же повтор. Это заявка, не бронь: машина не закрепляется,
 * занятость на даты система не ведёт, оплаты через платформу нет.
 *
 * Ответ на повтор неотличим от ответа на новую заявку (оракул «этот телефон
 * уже просил эту машину», как у MCP).
 *
 * В ответе — страница заявки и ссылка подключить MAX (1350): там человек
 * переписывается с перевозчиком. Ключ выдаётся и повтору (ответ тот же), но
 * переписку открывает только ключ новой заявки: телефон не секрет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { loadCarrierBySlug } from '@/lib/transfers/charter';
import { planCharterRequest } from '@/lib/transfers/charter-request';
import { carrierPagePath } from '@/lib/transfers/charter-format';
import { getPublicBaseUrl } from '@/lib/config';
import {
  buildCharterLead,
  charterLeadTooThin,
  checkCharterDates,
  saveCharterLeadDetailed,
  type CharterDatesCheck,
} from '@/lib/transfers/charter-request-service';
import { logText } from '@/lib/log/log-text';
import { CHARTER_FORM_KEY_NAME, issueRequestKey, requestPageLinks } from '@/lib/mcp/request-status';
import { isSelfVisit } from '@/lib/analytics/self-visit';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const Schema = z.object({
  carrier:     z.string().trim().min(1, 'Не указан перевозчик').max(100),
  destination: z.string().trim().min(2, 'Укажите, куда ехать').max(200, 'Направление длиннее 200 символов'),
  date_from:   z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Выберите дату выезда'),
  date_to:     z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата возвращения в формате ГГГГ-ММ-ДД').optional(),
  passengers:  z.coerce.number({ error: 'Сколько человек — числом' }).int('Сколько человек — целым числом')
    .min(1, 'Не меньше одного человека').max(60, 'Не больше 60 человек в одной заявке'),
  // Имя — одной строкой: в уведомлении менеджеру оно стоит над телефоном.
  name:        z.string().trim().min(2, 'Имя: минимум 2 символа').max(120, 'Имя длиннее 120 символов')
    .regex(/^[^\p{Cc}]+$/u, 'Имя — одной строкой'),
  phone:       z.string().trim().min(5, 'Укажите телефон — по нему подтвердят заявку').max(50),
  comment:     z.string().trim().max(1000, 'Комментарий длиннее 1000 символов').optional(),
  pd_consent:  z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

function datesError(d: Exclude<CharterDatesCheck, { ok: true }>): string {
  switch (d.reason) {
    case 'not_in_calendar': return 'Такой даты нет в календаре';
    case 'past': return 'Дата выезда уже прошла';
    case 'too_far': return `Прайс перевозчика годовой: выберите дату в пределах ${d.maxDaysAhead} дней`;
    case 'bad_return': return `Дата возвращения — не раньше выезда и не позже чем через ${d.maxTripDays} дн.`;
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

  const dateTo = d.date_to ?? null;
  const dates = checkCharterDates(d.date_from, dateTo, kamchatkaToday());
  if (!dates.ok) return fail(400, datesError(dates), dates.field);

  // Отказ базы — не «перевозчика нет» (§4.0): заявка не создаётся, человек
  // знает, что это сбой нашей стороны.
  let carrier;
  try {
    carrier = await loadCarrierBySlug(d.carrier);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[charter-requests] перевозчик не прочитан: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return fail(503, 'Не удалось проверить перевозчика — заявка не создана. Попробуйте позже или позвоните ему.');
  }
  if (!carrier) return fail(404, 'Такого перевозчика нет на Ведаре');

  const plan = planCharterRequest(carrier, d.destination, d.passengers);
  if (plan.kind === 'too_many') {
    return fail(400, `В парке перевозчика всего ${plan.seatsTotal} мест — разделите группу или уточните число человек`, 'passengers');
  }
  if (plan.kind === 'ambiguous') {
    return fail(400, `Под это подходит несколько направлений прайса: ${plan.options.join('; ')}. Выберите одно`, 'destination');
  }

  const facts = {
    carrier, plan, destination: d.destination, dateFrom: d.date_from, dateTo,
    passengers: d.passengers, comment: d.comment || null,
  };
  const lead = buildCharterLead(facts, 'form');
  if (charterLeadTooThin(d.name, phone, lead)) {
    return fail(400, 'Заявка слишком неполная — менеджер её не увидит. Укажите имя и фамилию.', 'name');
  }

  const consent = buildConsentRecord(true, ip, 'transfer-page', 'carrier');
  const isSelf = isSelfVisit(req.headers.get('cookie'));
  const saved = await saveCharterLeadDetailed({
    facts, lead, name: d.name, phone, consent,
    // Свой визит владельца (метка 1145) — заявка с пометкой, вне счёта спроса.
    isSelf,
    sourceUrl: `${getPublicBaseUrl()}${carrierPagePath(carrier.slug)}`,
  });
  if (!saved) return fail(503, 'Не удалось сохранить заявку — попробуйте позже или позвоните перевозчику.');
  // Страница заявки и MAX (1350): ключ выдаётся и повтору — ответ двери тот же, —
  // но переписку с перевозчиком открывает только ключ новой заявки.
  const key = await issueRequestKey({ leadId: saved.id }, CHARTER_FORM_KEY_NAME, { opensChat: saved.created && !isSelf });

  return NextResponse.json({
    success: true,
    data: {
      carrier: carrier.name,
      destination: d.destination,
      // Строка прайса, если направление в нём есть; иначе цену называет перевозчик.
      price_line: plan.kind === 'priced' ? { to: plan.line.to, price_rub: plan.line.priceRub, note: plan.line.note } : null,
      vehicles_needed: plan.vehicles,
      ...requestPageLinks(key),
    },
  });
}
