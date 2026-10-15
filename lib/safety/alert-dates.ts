/**
 * Даты записи ленты предупреждений словами — для MCP `safety_status` (#2495).
 *
 * MCP перечислял ленту одними заголовками, и «Вилючинский перевал: проезд по
 * пропускам с 15 июля» в середине октября читался как свежее предупреждение:
 * ни когда запись появилась, ни сколько платформа её держит, в ответе не было.
 *
 * Почему «в ленте до …», а не «действует до …». `expires_at` — срок, до
 * которого запись стоит в ленте, а не объявленное окончание ограничения: у
 * разобранных лент он считается от публикации по роду тревоги, у ручных
 * записей его ставит человек, и когда окончание не объявлено — заглушкой
 * (миграции 718 и 729: «срок окончания НЕ объявлен» при `expires_at` в 2027).
 * Отличить настоящий срок от заглушки по одной дате нельзя; правило «дальше
 * полугода — не срок» с приближением заглушки начинает выдавать её за срок.
 * «В ленте до» верно в обоих случаях.
 */

/** «3 июля» по Камчатке; год — только если не текущий. null — даты нет. */
export function alertDayLabel(iso: string | null, nowMs: number = Date.now()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const year = (t: number) => new Date(t).toLocaleDateString('ru-RU', { year: 'numeric', timeZone: 'Asia/Kamchatka' });
  const sameYear = year(d.getTime()) === year(nowMs);
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'Asia/Kamchatka',
  });
}
