/**
 * Заявка на прокат автомобиля — путь записи (витрина проката 23.10). Дверь
 * пока одна — форма на странице прокатчика (`POST /api/car-rental-requests`);
 * инструмент MCP, когда появится, пойдёт этим же путём, как `request_charter`
 * идёт путём заявки на машину перевозчика. Две копии правила разошлись бы на
 * первом же исключении (тот же урок, что с заявкой на жильё, 1206).
 *
 * Тексты и чистые правила — `lib/rental/rental-request.ts`.
 * Сторож: tests/unit/car-rental-request-api.test.ts.
 */

import { createLead, findRecentLeadByCommentPrefix } from '@/lib/leads/create';
import { recordPartnerDelivery } from '@/lib/leads/delivery-outcome';
import { logText } from '@/lib/log/log-text';
import { notifyPartnerRequestPersonally } from '@/lib/notifications/partner-request-notify';
import { computeQuickScore, LOW_QUALITY_SCORE } from '@/lib/leads/scoring';
import { isRealDate } from '@/lib/seat-requests/core';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import { addDays } from '@/lib/transfers/charter-request-service';
import {
  RENTAL_MAX_DAYS,
  RENTAL_MAX_DAYS_AHEAD,
  rentalDedupPrefix,
  rentalLeadComment,
  rentalSourceData,
  type RentalDoor,
  type RentalRequestFacts,
  rentalRequestLines,
} from '@/lib/rental/rental-request';

/**
 * Даты заявки. Причина отказа — кодом: тексты у дверей свои, а правило одно.
 * В отличие от машины перевозчика, дата возврата обязательна: аренда без
 * конца — не заявка, цена за сутки без числа суток ничего не говорит.
 */
export type RentalDatesCheck =
  | { ok: true }
  | { ok: false; reason: 'not_in_calendar'; field: 'date_from' | 'date_to' }
  | { ok: false; reason: 'past'; field: 'date_from'; today: string }
  | { ok: false; reason: 'too_far'; field: 'date_from'; maxDaysAhead: number }
  | { ok: false; reason: 'bad_return'; field: 'date_to'; maxDays: number };

/** `today` — сегодняшний день по Камчатке (kamchatkaToday): там берут машину. */
export function checkRentalDates(dateFrom: string, dateTo: string, today: string): RentalDatesCheck {
  if (!isRealDate(dateFrom)) return { ok: false, reason: 'not_in_calendar', field: 'date_from' };
  if (!isRealDate(dateTo)) return { ok: false, reason: 'not_in_calendar', field: 'date_to' };
  if (dateFrom < today) return { ok: false, reason: 'past', field: 'date_from', today };
  if (dateFrom > addDays(today, RENTAL_MAX_DAYS_AHEAD)) {
    return { ok: false, reason: 'too_far', field: 'date_from', maxDaysAhead: RENTAL_MAX_DAYS_AHEAD };
  }
  // RENTAL_MAX_DAYS суток — с dateFrom по dateFrom + (RENTAL_MAX_DAYS − 1) включительно.
  if (dateTo < dateFrom || dateTo > addDays(dateFrom, RENTAL_MAX_DAYS - 1)) {
    return { ok: false, reason: 'bad_return', field: 'date_to', maxDays: RENTAL_MAX_DAYS };
  }
  return { ok: true };
}

/** Что уходит в лид: текст менеджеру и структурные поля. */
export interface RentalLead {
  comment: string;
  sourceData: Record<string, unknown>;
}

export function buildRentalLead(f: RentalRequestFacts, door: RentalDoor): RentalLead {
  return { comment: rentalLeadComment(f), sourceData: rentalSourceData(f, door) };
}

/**
 * Заявку, которую createLead закроет сразу (балл ниже LOW_QUALITY_SCORE: без
 * уведомления), не создаём вовсе: обещать звонок по заявке, которую никто не
 * увидит, нельзя (тот же отказ, что у заявок MCP с 29.09).
 */
export function rentalLeadTooThin(name: string, phone: string, lead: RentalLead): boolean {
  return computeQuickScore(name, phone, lead.comment, lead.sourceData) < LOW_QUALITY_SCORE;
}

export interface SaveRentalLeadInput {
  facts: RentalRequestFacts;
  lead: RentalLead;
  name: string;
  /** Нормализованный (normalizePhone): по нему же ищется повтор. */
  phone: string;
  consent: PdConsentRecord | null;
  isSelf: boolean;
  sourceUrl: string;
}

/**
 * Записать заявку: повтор того же телефона к тому же прокатчику на ту же дату
 * начала за сутки — прежняя заявка, а не вторая. Адресат известен: лид ложится
 * прокатчику (operator_id — его клиент в CRM) и менеджеру; AI-подбор туров ему
 * не нужен. null — не записалась (причину пишет createLead).
 */
export async function saveRentalLead(i: SaveRentalLeadInput): Promise<string | null> {
  const existing = await findRecentLeadByCommentPrefix(i.phone, rentalDedupPrefix(i.facts.company.name, i.facts.dateFrom));
  if (existing) return existing;
  const leadId = await createLead({
    name: i.name,
    phone: i.phone,
    comment: i.lead.comment,
    route_title: `Прокат: ${i.facts.offer.title}`,
    operator_id: i.facts.company.partnerId,
    source_url: i.sourceUrl,
    source_data: i.lead.sourceData,
    pd_consent: i.consent,
    is_self: i.isSelf,
    skip_ai_processing: true,
  });
  if (leadId && !i.isSelf) deliverToCompany(leadId, i);
  return leadId;
}

/**
 * Лично прокатчику — в его MAX или Telegram (23.10). Не ждём: ответ человеку
 * не зависит от доставки партнёру. Исход пишется в журнал лида
 * (`partner_notified`), отказ — в лог без ПД. Свой визит владельца (is_self)
 * партнёра не будит.
 */
function deliverToCompany(leadId: string, i: SaveRentalLeadInput): void {
  const partnerId = i.facts.company.partnerId;
  void notifyPartnerRequestPersonally({
    partnerId, leadId, kind: 'car_rental',
    lines: rentalRequestLines(i.facts),
    name: i.name, phone: i.phone, comment: i.facts.comment,
  })
    .then((outcome) => recordPartnerDelivery(leadId, partnerId, outcome))
    .catch((err: unknown) => {
      console.error(`[rental-request] личная доставка прокатчику по заявке ${leadId} не удалась:`, logText(err instanceof Error ? err.message : err, 200));
    });
}
