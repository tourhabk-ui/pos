/**
 * Кабинет проката на сайте (/hub/carrier/rental): то же, что кнопки
 * «Мои машины», «Заявки», «Календарь» в MAX, для вошедшего владельца
 * карточки (владелец 26.10: прокатчику «Лагуны» — кабинет на сайте).
 *
 * Правила не дублируются: ответ на заявку — answerRentalRequest, отметка
 * дня — setOperatorMark, горизонт календаря — car-calendar. Пилот тот же,
 * что в чате (RENTAL_OPERATOR_PILOT_SLUGS): вне пилота кабинет читает, но
 * не пишет.
 */

import { pool } from '@/lib/db-pool';
import { kamchatkaDate, ruShort, shiftDate } from '@/lib/analytics/kamchatka-day';
import { RENTAL_CALENDAR_DAYS } from '@/lib/rental/car-calendar';
import { loadCalendarMarks } from '@/lib/rental/car-calendar-store';
import { partnerAnswerText, type AnswerTell } from '@/lib/rental/request-answer';
import type { AnswerActor } from '@/lib/rental/request-answer-flow';

export type ActorLoad = { outcome: 'ok'; actor: AnswerActor } | { outcome: 'missing' | 'db_error' };

/** Имя и адрес карточки вошедшего: по ним пилот и строка менеджеру. */
export async function loadRentalActor(partnerId: string): Promise<ActorLoad> {
  try {
    const { rows: [row] } = await pool.query<{ name: string; slug: string | null }>(
      `SELECT name, slug FROM partners WHERE id = $1::uuid`,
      [partnerId],
    );
    if (!row) return { outcome: 'missing' };
    return { outcome: 'ok', actor: { partnerId, partnerName: row.name, slug: row.slug } };
  } catch (err) {
    console.error('[rental-web] карточка не прочитана, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return { outcome: 'db_error' };
  }
}

/** Строка ответа без разметки чата: на сайте её рисует React. */
export function answerTellPlain(tell: AnswerTell): string {
  return partnerAnswerText(tell).replace(/<\/?b>/g, '');
}

/** HTTP-статус исхода ответа: записано — 200, остальное называет причину. */
export function answerTellStatus(tell: AnswerTell): number {
  switch (tell.kind) {
    case 'take':
    case 'take_no_car':
    case 'take_bad_dates':
    case 'decline':
    case 'charter_take':
    case 'charter_decline':
      return 200;
    case 'already':
      return 409;
    case 'missing':
      return 404;
    case 'not_yours':
    case 'not_pilot':
      return 403;
    case 'retry':
    case 'unread':
      return 503;
    case 'unparsed':
      return 400;
  }
}

export interface CalendarDay {
  day: string;
  label: string;
  /** null — отметки нет. Это не «свободна». */
  busy: boolean | null;
}

/** 30 дней машины с сегодняшнего по Камчатке. Отказ базы — отдельный исход. */
export async function loadCarDays(offerId: string, now: Date): Promise<{ today: string; days: CalendarDay[] } | 'db_error'> {
  const today = kamchatkaDate(now);
  const last = shiftDate(today, RENTAL_CALENDAR_DAYS - 1);
  const marks = await loadCalendarMarks(offerId, today, last);
  if (marks === 'db_error') return 'db_error';
  const days: CalendarDay[] = [];
  for (let i = 0; i < RENTAL_CALENDAR_DAYS; i++) {
    const day = shiftDate(today, i);
    days.push({ day, label: ruShort(day), busy: marks.has(day) ? marks.get(day)! : null });
  }
  return { today, days };
}
