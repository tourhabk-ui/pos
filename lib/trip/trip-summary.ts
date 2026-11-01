/**
 * Один общий статус поездки для /trip-request (D1, 02.11): из состояний
 * частей. Подтверждает человек — «подтверждено» только по ответу партнёра.
 */
import type { RequestState } from '@/lib/mcp/request-status-schema';

export interface TripSummary { tone: 'ok' | 'wait' | 'act' | 'bad'; ru: string; en: string }

export function tripSummary(states: (RequestState | null)[]): TripSummary {
  const n = states.length;
  if (n === 0) return { tone: 'bad', ru: 'В ссылке нет частей поездки — откройте ссылку из ответа целиком.', en: 'The link has no trip parts — open the full link.' };
  const missing = states.filter((s) => s === null || s === 'failed' || s === 'unknown').length;
  const confirmed = states.filter((s) => s === 'confirmed').length;
  const act = states.filter((s) => s === 'declined' || s === 'other_date' || s === 'cancelled' || s === 'no_answer').length;
  if (confirmed === n) return { tone: 'ok', ru: `Все части поездки подтверждены (${n} из ${n}).`, en: `All ${n} parts confirmed.` };
  if (act > 0) return { tone: 'act', ru: `Нужен ваш ответ: по ${act} из ${n} частей — другая дата, отказ или не дозвонились. Подтверждено ${confirmed} из ${n}.`, en: `Your reply needed on ${act} of ${n} parts. Confirmed ${confirmed} of ${n}.` };
  if (missing > 0) return { tone: 'bad', ru: `Статус ${missing} из ${n} частей не прочитан — откройте часть по ссылке ниже. Подтверждено ${confirmed} из ${n}.`, en: `Status of ${missing} of ${n} parts not read. Confirmed ${confirmed} of ${n}.` };
  return { tone: 'wait', ru: `Ждём подтверждения людьми: подтверждено ${confirmed} из ${n}. Оператор, владелец жилья или менеджер свяжутся по телефону.`, en: `Waiting for human confirmation: ${confirmed} of ${n} confirmed.` };
}
