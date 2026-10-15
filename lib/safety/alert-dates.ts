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

/**
 * Наши технические TTL из ingest (lib/services/safety/seismic-parser.ts):
 * дорожные ограничения живут неделю, прочее — сутки или двое. Это срок жизни
 * ЗАПИСИ, а не срок действия ограничения: МЧС таких дат не сообщает.
 */
export const TECHNICAL_TTL_HOURS = [24, 48, 24 * 7];

/**
 * Отличить срок из источника от нашего TTL. Совпал с техническим с точностью до
 * получаса — значит дату придумали мы, и подписывать её «действует до» нельзя:
 * это обещание знания, которого у нас нет.
 */
export function isTechnicalExpiry(at: string | null, until: string | null): boolean {
  if (!at || !until) return false;
  const from = new Date(at).getTime();
  const to = new Date(until).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const hours = (to - from) / 3_600_000;
  return TECHNICAL_TTL_HOURS.some((ttl) => Math.abs(hours - ttl) < 0.5);
}

/**
 * Чем является срок записи ленты — одно правило для сайта и MCP (#2495,
 * решение владельца 15.10):
 *  - `source` — срок пришёл из источника: «действует до»;
 *  - `feed_window` — ручная запись: срок ставит человек, а когда окончание не
 *    объявлено, ставит заглушку на годы вперёд (миграции 718/729). Честно
 *    здесь только «в ленте до»: сайт писал «действует до 1 янв.» у пропусков
 *    на Вилючинский перевал, окончание которых не объявлено;
 *  - `technical` — наш TTL ингеста: срок жизни записи, не ограничения;
 *  - `none` — срока нет.
 */
export type AlertTerm = 'source' | 'feed_window' | 'technical' | 'none';

export function alertTerm(a: { at: string | null; until: string | null; manual?: boolean }): AlertTerm {
  if (!a.until) return 'none';
  if (a.manual) return 'feed_window';
  return isTechnicalExpiry(a.at, a.until) ? 'technical' : 'source';
}

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
