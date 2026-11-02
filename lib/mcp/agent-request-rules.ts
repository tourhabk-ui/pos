/**
 * lib/mcp/agent-request-rules.ts — три правила заявки для внешнего агента (#2968).
 *
 * Агенты-браузеры и агенты по REST оставляют заявку формой тура или
 * `POST /api/hub/bookings/create`. Что они говорят человеку после этого,
 * решают правила, а правила читают из /llms.txt. До 03.11 они были
 * рассыпаны по абзацам: «не бронь» стояло в одном, согласие — в другом,
 * кто продавец — в шапке файла. Здесь — одним списком, на двух языках.
 *
 * Модуль чистый (без базы): /llms.txt собирается и без неё.
 */
import { paymentRule, paymentRuleEn } from '@/lib/mcp/payment-rule';

export function agentRequestRulesRu(acceptsPayments: boolean): string {
  return [
    'Три правила для агента:',
    '1. **Заявка — не бронь.** Даты, места и цену подтверждает человек — оператор тура; мгновенного бронирования нет. Ответ «заявка создана» значит «оператор её получил», а не «место закреплено».',
    '2. **Согласие на обработку персональных данных даёт сам человек.** Агент не ставит его за человека: галочку в форме или `pd_consent: true` в запросе — только после явного согласия туриста; на странице статуса заявки он подтверждает его сам.',
    `3. **Ведар не продавец.** Тур продаёт и проводит оператор под своим именем. ${paymentRule(acceptsPayments)}`,
    'Создана ли заявка, говорит поле `created` в ответе `POST /api/hub/bookings/create`: `true` — записана (HTTP 200, есть `booking_id`); `false` — **заявка не создана**, причина в `error` (HTTP 400/404/422/429/500). Без `created: true` человеку не говорят, что заявка есть.',
  ].join('\n');
}

export function agentRequestRulesEn(acceptsPayments: boolean): string {
  return [
    'Three rules for agents: (1) a request is not a booking — a human (the tour operator) confirms dates, seats and price; there is no instant booking;',
    '(2) consent to personal-data processing is given by the person, never by the agent — set `pd_consent: true` only after the tourist explicitly agreed;',
    `(3) Vedar is not the seller — the operator sells and runs the tour under its own name. ${paymentRuleEn(acceptsPayments)}`,
    '`POST /api/hub/bookings/create` answers `created: true` (HTTP 200) when the request is recorded and `created: false` with `error` when it is not — do not tell the person a request exists without `created: true`.',
  ].join(' ');
}
