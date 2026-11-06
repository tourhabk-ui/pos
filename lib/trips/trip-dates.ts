/**
 * lib/trips/trip-dates.ts
 *
 * Даты сохранённой поездки — календарные дни, а не моменты времени.
 *
 * Путь человека 07.11: в конструкторе 10–14 июля, на странице сохранённого
 * маршрута — «9 июля — 13 июля», а заголовок «Маршрут 2027-07-10». Записывалась
 * дата верно (колонка `date`). Сдвигало чтение:
 * - node-pg собирает `date` в Date на полночь пояса сервера;
 * - JSON отдаёт её UTC-моментом;
 * - страница через `new Date(...)` переводит этот момент в пояс браузера.
 * Если пояса не совпадают, день уходит на соседний. Тот же сдвиг шёл в смету
 * и в «Собрать заново».
 *
 * Поэтому наружу уходит строка YYYY-MM-DD, а человеку она показывается без
 * перевода в пояс браузера. Модуль без импортов: его читают и роут, и
 * страница в браузере.
 */

/**
 * День из колонки DATE. Date — по местным частям: драйвер собрал её полночью
 * пояса процесса. Строка — её первые десять знаков. Иное — null.
 */
export function calendarDay(v: unknown): string | null {
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** Строка поездки с датами-днями: то, что уходит из /api/trips наружу. */
export function withCalendarDates<T extends { arrival_date?: unknown; departure_date?: unknown }>(
  row: T,
): Omit<T, 'arrival_date' | 'departure_date'> & { arrival_date: string | null; departure_date: string | null } {
  return { ...row, arrival_date: calendarDay(row.arrival_date), departure_date: calendarDay(row.departure_date) };
}

/** «10 июля 2027 г.» («10 июл. 2027 г.» — short) из YYYY-MM-DD — тот же день в любом поясе браузера. */
export function ruCalendarDate(day: string | null | undefined, month: 'long' | 'short' = 'long'): string {
  const iso = calendarDay(day);
  if (!iso) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('ru-RU', {
    day: 'numeric', month, year: 'numeric', timeZone: 'UTC',
  });
}
