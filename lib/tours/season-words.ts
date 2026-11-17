/**
 * Сезон тура словами — одно правило на карточку, MCP (`get_tour_details`) и
 * `/api/tours/[id]` (#3487, 17.11).
 *
 * Повод. У «Вилючинского перевала» «Лагуны Экспедиции» (ID85) сезон в записи не
 * заполнен, а календарь открыт: карточка о сезоне молчала, и человек не знал,
 * действует ли тур в его месяц. Выдумывать конец сезона нельзя (§4.0), молчать —
 * тоже. Правило:
 *   1. Сезон записан датами — «19 июл — 29 сен 2027» (`seasonLabel`).
 *   2. Не записан, а в календаре оператора есть даты — сказано, что сезона в
 *      записи нет, и названы первая и последняя дата календаря.
 *   3. Ни того, ни другого — «не записан — дату подтверждает оператор».
 *
 * Сторож: tests/unit/tour-surfaces-agree.test.ts.
 */
import { seasonLabel } from '@/lib/tours/season';

/** Сезон не записан, календаря нет: одна строка на все поверхности. */
export const SEASON_NOT_RECORDED = 'не записан — дату подтверждает оператор';

export interface CalendarRange {
  /** YYYY-MM-DD */
  first: string;
  /** YYYY-MM-DD */
  last: string;
}

export interface SeasonFacts {
  season_start?: string | Date | null;
  season_end?: string | Date | null;
}

/** Первая и последняя дата календаря из ответа базы; чего нет — null. */
export function calendarRangeOf(first: unknown, last: unknown): CalendarRange | null {
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const f = day(first);
  const l = day(last);
  return f && l && f <= l ? { first: f, last: l } : null;
}

/** Сезон тура словами по правилу выше. */
export function tourSeasonWords(t: SeasonFacts, calendar?: CalendarRange | null): string {
  const label = seasonLabel(t.season_start, t.season_end);
  if (label) return label;
  if (calendar) {
    const range = calendar.first === calendar.last
      ? seasonLabel(calendar.first, calendar.first)?.replace(/^(.+?) — \1/, '$1')
      : seasonLabel(calendar.first, calendar.last);
    if (range) return `не записан; даты в календаре оператора: ${range}`;
  }
  return SEASON_NOT_RECORDED;
}
