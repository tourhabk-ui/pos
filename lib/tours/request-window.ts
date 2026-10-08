/**
 * Даты без календаря — только по сезону (решение владельца 08.10, #2244, #2245).
 *
 * Строка `tour_availability` — слово оператора о конкретной дате: открыл —
 * дата его, закрыл — не его. Дата БЕЗ строки до 08.10 принималась любая: и в
 * заявке оператору у тура без расписания («все даты свободны для заявки»), и
 * в обычной брони. Оттуда два случая одного дефекта:
 *
 *   - #2244: «Летняя рыбалка на кижуча» продавалась на октябрь. Оператор
 *     пишет о себе «летний сезон — с июня по сентябрь», а октябрьские даты
 *     поставила наша сессия 29.09. Владелец: «только по сезону»;
 *   - #2245: «Край Вулканов» без расписания принимал заявку на любую дату
 *     вперёд, а оператор берёт предварительную бронь на сезон 2027 года «с мая
 *     по 1 октября».
 *
 * Правило: если у тура записан сезон (`season_start`, `season_end`) и он ещё
 * не кончился, дата выезда без строки календаря принимается только внутри
 * него, и поездка должна закончиться в сезоне (то же, что у каталога,
 * `catalogAvailability`). Строка календаря сильнее сезона: дату, которую
 * оператор открыл сам, правило не трогает.
 *
 * Сезон не записан или уже прошёл — окна нет, и дата принимается как раньше:
 * дату согласует оператор. Прошедший сезон — не запрет на всё будущее:
 * следующего в данных нет, и придумывать его здесь нельзя (§4.0). Чтобы тур
 * закрылся до следующего сезона, сезон записывается вперёд — так сделано для
 * рыбалки 6 и 9 (миграция 1183).
 *
 * Сторож: tests/unit/tour-request-window.test.ts.
 */

import { tourDays, type AvailabilityInput } from './catalog-availability';

export type WindowInput = Pick<AvailabilityInput, 'duration_type' | 'multi_day_count' | 'duration_hours'> & {
  season_start: string | Date | null;
  season_end: string | Date | null;
};

export type RequestWindow =
  /** Даты ВЫЕЗДА с `from` по `to` включительно; сезон — для подписи. */
  | { kind: 'season'; from: string; to: string; seasonStart: string; seasonEnd: string }
  /** Окна нет: сезон не записан, прошёл или короче самого тура. */
  | { kind: 'unbounded'; why: 'not_recorded' | 'past' | 'too_short' };

const ISO = /^\d{4}-\d{2}-\d{2}/;

/**
 * День из колонки DATE. Строка (`::text`) — её первые десять знаков. Date —
 * по местным частям: драйвер собирает DATE полночью пояса процесса, и UTC-части
 * в поясе восточнее Гринвича дали бы вчерашний день.
 */
export function isoDay(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return ISO.test(v) ? v.slice(0, 10) : null;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** Окно дат выезда без календаря на день `today` (YYYY-MM-DD, по Камчатке). */
export function requestWindow(t: WindowInput, today: string): RequestWindow {
  const seasonStart = isoDay(t.season_start);
  const seasonEnd = isoDay(t.season_end);
  if (!seasonStart || !seasonEnd) return { kind: 'unbounded', why: 'not_recorded' };
  const lastStart = addDays(seasonEnd, -(tourDays(t) - 1));
  if (lastStart < seasonStart) return { kind: 'unbounded', why: 'too_short' };
  if (lastStart < today) return { kind: 'unbounded', why: 'past' };
  return { kind: 'season', from: seasonStart > today ? seasonStart : today, to: lastStart, seasonStart, seasonEnd };
}

/** Можно ли выехать в этот день без строки календаря. */
export function dateInWindow(w: RequestWindow, date: string): boolean {
  return w.kind === 'unbounded' || (date >= w.from && date <= w.to);
}

/** «1 мая 2027» — с годом всегда: окно легко оказывается в следующем году. */
export function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).replace(/\s*г\.$/, '');
}

/** «сезон 1 мая 2027 — 1 октября 2027, выезд с 1 мая по 24 сентября 2027». */
export function windowLabel(w: Extract<RequestWindow, { kind: 'season' }>): string {
  const season = `сезон ${longDay(w.seasonStart)} — ${longDay(w.seasonEnd)}`;
  return w.to === w.seasonEnd && w.from === w.seasonStart
    ? season
    : `${season}, выезд с ${longDay(w.from)} по ${longDay(w.to)}`;
}

/** Отказ словами: дата вне окна. Одна формулировка на все двери. */
export function outOfSeasonText(w: Extract<RequestWindow, { kind: 'season' }>, date: string): string {
  return `Тур принимает заявки только по сезону (${windowLabel(w)}). Дата ${longDay(date)} вне сезона.`;
}

/** Окно для формы на карточке тура: границы ввода даты и подпись. */
export interface SeasonWindowView {
  from: string;
  to: string;
  label: string;
}

export function seasonWindowView(w: RequestWindow): SeasonWindowView | null {
  return w.kind === 'season' ? { from: w.from, to: w.to, label: windowLabel(w) } : null;
}
