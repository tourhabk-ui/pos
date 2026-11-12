/**
 * POST /api/leads/tour-date-question — вопрос оператору с формы брони тура:
 * «ходите ли вы в этот день?» (план «после отказа», этап 6, срез б).
 *
 * Форма брони на дату, которую в календаре закрыл Ведар (а не оператор),
 * получает отказ `DATE_CLOSED_BY_PLATFORM` со словами «спросите оператора».
 * Эта дверь и есть «спросить»: та же заявка-вопрос, что у ИИ-агента
 * (`create_booking_request`, этап 6а), — общий сервис
 * lib/requests/tour-date-question.
 *
 * AUTH: публичный by design — турист без аккаунта (как бронь тура). Защита:
 * rate-limit, Zod, обязательное согласие на ПД; вопрос уходит только на дату,
 * закрытую Ведаром, — что это за дата, проверяет сервер, а не форма.
 *
 * Это заявка, не бронь: места не закрепляются, оплаты нет. Имя и телефон
 * получает оператор тура — тот же адресат, что у брони.
 *
 * Ответ на повтор неотличим от ответа на новую заявку (оракул «этот телефон
 * уже спрашивал этот тур на эту дату», как у MCP). Ключ страницы заявки
 * выдаётся и повтору, но переписку открывает только ключ новой заявки.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { getPublicBaseUrl } from '@/lib/config';
import { isSelfVisit } from '@/lib/analytics/self-visit';
import { LEAD_FORM_KEY_NAME, issueRequestKey, requestPageLinks } from '@/lib/mcp/request-status';
import { notifyOperatorNewLead, notifyPartnerNewLeadPersonally } from '@/lib/notifications/lead-notify';
import { recordPartnerDelivery } from '@/lib/leads/delivery-outcome';
import { askOperatorAboutDate, dateQuestionComment, dateQuestionRefusal, dateQuestionSentText } from '@/lib/requests/tour-date-question';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const Schema = z.object({
  tour_id:      z.coerce.number({ error: 'Укажите тур' }).int('Укажите тур').positive('Укажите тур'),
  date:         z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД'),
  participants: z.coerce.number({ error: 'Сколько человек — числом' }).int('Сколько человек — целым числом')
    .min(1, 'Не меньше одного человека').max(100, 'Не больше 100 человек в одной заявке'),
  // Имя — одной строкой: в уведомлении оно стоит над телефоном.
  name:         z.string().trim().min(2, 'Имя: минимум 2 символа').max(120, 'Имя длиннее 120 символов')
    .regex(/^[^\p{Cc}]+$/u, 'Имя — одной строкой'),
  phone:        z.string().trim().min(5, 'Укажите телефон — по нему ответит оператор').max(50),
  comment:      z.string().trim().max(1000, 'Комментарий длиннее 1000 символов').optional(),
  pd_consent:   z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

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

  const consent = buildConsentRecord(true, ip, 'tour-form');
  if (!consent) return fail(400, 'Нужно согласие на обработку персональных данных', 'pd_consent');
  const isSelf = isSelfVisit(req.headers.get('cookie'));
  const sourceUrl = `${getPublicBaseUrl()}/catalog/tours/${d.tour_id}`;
  const comment = d.comment || null;

  const outcome = await askOperatorAboutDate({
    tourId: d.tour_id, date: d.date, participants: d.participants,
    name: d.name, phone, comment, consent, isSelf, sourceUrl,
  });
  const refusal = dateQuestionRefusal(outcome);
  if (refusal || outcome.state !== 'sent') {
    return fail(refusal?.status ?? 503, refusal?.error ?? 'Не удалось отправить вопрос — попробуйте позже.', refusal?.field);
  }

  // Уведомления — только о новой заявке и не о своей пробе: лично оператору
  // (если его чат привязан), затем рабочему чату Ведара с исходом личной
  // доставки. Ответ человеку их не ждёт; отказ — в лог, не в тишину.
  if (outcome.created && !isSelf) {
    const { leadId, operatorId, operatorName, tourTitle } = outcome;
    const leadComment = dateQuestionComment({
      tourTitle, tourId: d.tour_id, date: d.date, participants: d.participants, comment,
    });
    void (async () => {
      let predraft: string[] = [];
      try {
        const { operatorPredraft } = await import('@/lib/requests/operator-predraft');
        predraft = await operatorPredraft(d.tour_id, d.date, d.participants);
      } catch (e) {
        console.error('[tour-date-question] черновик оператору не собран', e instanceof Error ? e.message : e);
      }
      const personal = operatorId
        ? await notifyPartnerNewLeadPersonally({
            operatorId, leadId, name: d.name, phone, comment: leadComment,
            routeTitle: tourTitle, origin: 'форма брони тура на Ведаре', sourceUrl, predraft,
          })
        : null;
      if (operatorId && personal) await recordPartnerDelivery(leadId, operatorId, personal);
      await notifyOperatorNewLead({
        leadId, name: d.name, phone, comment: leadComment, routeTitle: tourTitle,
        forPartner: operatorId ? { name: operatorName ?? operatorId, outcome: personal } : undefined,
      });
    })().catch((e: unknown) => {
      console.error(`[tour-date-question] уведомления о заявке ${leadId} не отправлены:`, e instanceof Error ? e.message : e);
    });
  }

  const key = await issueRequestKey({ leadId: outcome.leadId }, LEAD_FORM_KEY_NAME, { opensChat: outcome.created && !isSelf });
  const links = requestPageLinks(key);
  return NextResponse.json({
    success: true,
    data: { message: dateQuestionSentText(links.page !== null), ...links },
  });
}
