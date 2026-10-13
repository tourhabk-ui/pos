/**
 * Заявка на машину целиком — один путь на две двери: форма на странице
 * перевозчика (`POST /api/charter-requests`, стандарт карточки
 * трансфера 13.10) и инструмент MCP `request_charter` (10.10).
 *
 * Двери отличаются тем, как получено согласие (галочка на форме; `consent:
 * true` от ассистента в MCP) и каким текстом отвечают человеку или агенту.
 * Что принимается по датам, что уходит менеджеру и перевозчику, как ловится
 * повтор — здесь, одно. Две копии этого разошлись бы на первом же правиле (тот
 * же урок, что с заявкой на жильё, 1206, и карточкой тура, §11).
 *
 * Тексты и чистые правила — `lib/transfers/charter-request.ts`.
 * Сторожа: tests/unit/mcp-request-charter.test.ts,
 * tests/unit/transfer-card-standard.test.tsx.
 */

import { createLead, findRecentLeadByCommentPrefix } from '@/lib/leads/create';
import { computeQuickScore, LOW_QUALITY_SCORE } from '@/lib/leads/scoring';
import { isRealDate } from '@/lib/seat-requests/core';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import {
  CHARTER_MAX_DAYS_AHEAD,
  CHARTER_MAX_TRIP_DAYS,
  charterDedupPrefix,
  charterLeadComment,
  charterSourceData,
  type CharterDoor,
  type CharterRequestFacts,
} from '@/lib/transfers/charter-request';

/** Прибавить дни к дате YYYY-MM-DD (UTC-арифметика по календарным суткам). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Даты заявки. Причина отказа — кодом: тексты у дверей свои (агенту — «назовите
 * дату», человеку на форме — «выберите»), а правило одно.
 */
export type CharterDatesCheck =
  | { ok: true }
  | { ok: false; reason: 'not_in_calendar'; field: 'date_from' | 'date_to' }
  | { ok: false; reason: 'past'; field: 'date_from'; today: string }
  | { ok: false; reason: 'too_far'; field: 'date_from'; maxDaysAhead: number }
  | { ok: false; reason: 'bad_return'; field: 'date_to'; maxTripDays: number };

/** `today` — сегодняшний день по Камчатке (kamchatkaToday): там едет машина. */
export function checkCharterDates(dateFrom: string, dateTo: string | null, today: string): CharterDatesCheck {
  if (!isRealDate(dateFrom)) return { ok: false, reason: 'not_in_calendar', field: 'date_from' };
  if (dateTo !== null && !isRealDate(dateTo)) return { ok: false, reason: 'not_in_calendar', field: 'date_to' };
  if (dateFrom < today) return { ok: false, reason: 'past', field: 'date_from', today };
  if (dateFrom > addDays(today, CHARTER_MAX_DAYS_AHEAD)) {
    return { ok: false, reason: 'too_far', field: 'date_from', maxDaysAhead: CHARTER_MAX_DAYS_AHEAD };
  }
  if (dateTo !== null && (dateTo < dateFrom || dateTo > addDays(dateFrom, CHARTER_MAX_TRIP_DAYS))) {
    return { ok: false, reason: 'bad_return', field: 'date_to', maxTripDays: CHARTER_MAX_TRIP_DAYS };
  }
  return { ok: true };
}

/** Что уходит в лид: текст менеджеру и структурные поля. */
export interface CharterLead {
  comment: string;
  sourceData: Record<string, unknown>;
}

export function buildCharterLead(f: CharterRequestFacts, door: CharterDoor): CharterLead {
  return { comment: charterLeadComment(f), sourceData: charterSourceData(f, door) };
}

/**
 * Заявку, которую createLead закроет сразу (балл ниже LOW_QUALITY_SCORE: без
 * уведомления), не создаём вовсе: обещать звонок по заявке, которую никто не
 * увидит, нельзя (тот же отказ, что у заявок MCP с 29.09).
 */
export function charterLeadTooThin(name: string, phone: string, lead: CharterLead): boolean {
  return computeQuickScore(name, phone, lead.comment, lead.sourceData) < LOW_QUALITY_SCORE;
}

export interface SaveCharterLeadInput {
  facts: CharterRequestFacts;
  lead: CharterLead;
  name: string;
  /** Нормализованный (normalizePhone): по нему же ищется повтор. */
  phone: string;
  consent: PdConsentRecord | null;
  isSelf: boolean;
  sourceUrl: string;
}

/**
 * Записать заявку: повтор того же телефона к тому же перевозчику на ту же дату
 * выезда за сутки — прежняя заявка, а не вторая. Адресат известен: лид ложится
 * перевозчику (его клиент в CRM) и менеджеру; AI-подбор туров ему не нужен.
 * null — не записалась (причину пишет createLead).
 */
export async function saveCharterLead(i: SaveCharterLeadInput): Promise<string | null> {
  const existing = await findRecentLeadByCommentPrefix(i.phone, charterDedupPrefix(i.facts.carrier.name, i.facts.dateFrom));
  if (existing) return existing;
  return createLead({
    name: i.name,
    phone: i.phone,
    comment: i.lead.comment,
    route_title: `Вахтовка: ${i.facts.destination}`,
    operator_id: i.facts.carrier.partnerId,
    source_url: i.sourceUrl,
    source_data: i.lead.sourceData,
    pd_consent: i.consent,
    is_self: i.isSelf,
    skip_ai_processing: true,
  });
}
