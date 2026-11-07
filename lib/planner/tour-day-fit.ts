/**
 * Тур встаёт на день плана, только если в этот день у него есть выезд
 * (волна 3 аудита планировщика 07.11: 3.2 и сезон из 3.5, находки E2 и E6).
 *
 * Пруф с прода 07.11: план на 7 дней с 10.07.2027, вулканы.
 * - «Восхождение на вулкан Горелый и лавовые пещеры» стоял днём 2 (11.07) с
 *   припиской «в ваши даты свободных мест нет».
 * - Выезды тура — 15 и 16.07, внутри поездки, а день 6 (15.07) был свободным.
 * - Тур был посчитан в смете.
 *
 * Правило #3080 сортировало туры по местам во всём ОКНЕ поездки, а ставило
 * тур на конкретный ДЕНЬ. Проверяет код, а не модель (совет, пересланный
 * владельцем 07.11): дата выезда — из календаря оператора и сезона тура.
 *
 * Исходов три, и ни один не подменяет другой (§4.0):
 * - `dated` — у тура календарь: на день плана он встаёт только в дату, где у
 *   него есть свободные места;
 * - `request` — календаря нет: дату подтверждает оператор, но день плана
 *   обязан лежать в сезоне выездов тура (lib/tours/request-window, 08.10);
 * - `unread` — занятость или расписание не прочитались: тур встаёт, а день
 *   говорит «не прочиталось» — «выезда нет» было бы враньём.
 *
 * Сторож: tests/unit/tour-day-fit.test.ts.
 */
import { dateInWindow, requestWindow } from '@/lib/tours/request-window';

export type TourDates =
  /** Календарь оператора: даты выезда с местами в окне поездки. */
  | { kind: 'dated'; dates: ReadonlySet<string> }
  /** Календаря нет: дату подтверждает оператор, внутри сезона выездов. */
  | { kind: 'request'; seasonStart: string | null; seasonEnd: string | null; days: number }
  /** Занятость или расписание не прочитались. */
  | { kind: 'unread' };

/**
 * Можно ли поставить тур на день плана с датой `date` (YYYY-MM-DD).
 * Нет сведений (план без дат, «Сам») — как раньше: проверять нечем.
 */
export function tourFitsDate(info: TourDates | undefined, date: string, today: string): boolean {
  if (!info || info.kind === 'unread') return true;
  if (info.kind === 'dated') return info.dates.has(date);
  const window = requestWindow({
    duration_type: info.days > 1 ? 'multi_day' : null,
    multi_day_count: info.days,
    duration_hours: null,
    season_start: info.seasonStart,
    season_end: info.seasonEnd,
  }, today);
  return dateInWindow(window, date);
}

/** Очередь туров одного интереса в блоке зоны: голова — следующий тур. */
export interface TourQueue<T> {
  tours: T[];
  /** Туры, которым не нашлось выезда в дни, где до них дошла очередь. */
  deferred: T[];
}

/**
 * Ставит в голову очереди тур, у которого есть выезд в этот день.
 *
 * - Тур, ждавший своей даты, идёт первым: его даты редки, а следующий в
 *   очереди может встать и в другой день.
 * - Тур без выезда в этот день не пропадает — ждёт в `deferred`.
 * - Уже стоящий в плане тур второй раз не ставится (тот же тур бывает в
 *   списках двух интересов).
 *
 * Голова пуста — тура на этот день нет: день берёт маршрут или общий день.
 */
export function lineUpForDate<T extends { tourId: string }>(
  q: TourQueue<T>,
  fits: (t: T) => boolean,
  placed: ReadonlySet<string>,
): void {
  const back = q.deferred.findIndex((t) => !placed.has(t.tourId) && fits(t));
  if (back >= 0) q.tours.unshift(q.deferred.splice(back, 1)[0]);
  while (q.tours.length > 0) {
    const t = q.tours[0];
    if (placed.has(t.tourId)) {
      q.tours.shift();
      continue;
    }
    if (fits(t)) return;
    q.deferred.push(t);
    q.tours.shift();
  }
}

const RU_MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «15 и 16 июля», «15, 16 и 17 июля», «30 июня и 1 июля» — не больше трёх дат. */
export function departureDatesWords(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort();
  const shown = sorted.slice(0, 3);
  const words = shown.map((iso, i) => {
    const day = Number(iso.slice(8, 10));
    const month = Number(iso.slice(5, 7));
    const next = shown[i + 1];
    const sameMonthAsNext = next !== undefined && next.slice(5, 7) === iso.slice(5, 7);
    return sameMonthAsNext ? String(day) : `${day} ${RU_MONTHS_GEN[month - 1] ?? ''}`.trim();
  });
  const head = words.length > 1 ? `${words.slice(0, -1).join(', ')} и ${words[words.length - 1]}` : (words[0] ?? '');
  return sorted.length > shown.length ? `${head} и ещё ${sorted.length - shown.length}` : head;
}

/**
 * Строка «Важно» про туры, которым не нашлось дня с выездом.
 * Пусто — строки нет.
 */
export function offDaysWarning(offDays: ReadonlyArray<{ title: string; dates: readonly string[] }>): string | null {
  if (offDays.length === 0) return null;
  const withDates = offDays.filter((t) => t.dates.length > 0);
  const noDates = offDays.filter((t) => t.dates.length === 0);
  const parts: string[] = [];
  if (withDates.length > 0) {
    parts.push(`Не встали в план — в дни этих занятий у тура нет выезда: ${withDates
      .slice(0, 3)
      .map((t) => `«${t.title}» (выезды ${departureDatesWords(t.dates)})`)
      .join('; ')}${withDates.length > 3 ? ` и ещё ${withDates.length - 3}` : ''}. Хотите тур — переставьте день плана на дату выезда.`);
  }
  if (noDates.length > 0) {
    parts.push(`В ваши даты у тура нет выездов — его не ставили: ${noDates
      .slice(0, 3)
      .map((t) => `«${t.title}»`)
      .join(', ')}${noDates.length > 3 ? ` и ещё ${noDates.length - 3}` : ''}.`);
  }
  return parts.join(' ');
}
