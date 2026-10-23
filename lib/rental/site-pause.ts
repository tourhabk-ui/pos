/**
 * Прокат на сайте на паузе — слово владельца 23.10: «пока прячем прокат лагуны
 * до понедельника но оставляем его для mcp и A2A».
 *
 * Что значит «прячем» здесь. Прокатчик под паузой не показывается людям на
 * сайте: его нет на витрине /car-rental, в планере («Машина напрокат»), в
 * sitemap, в ответах Кузьмича в чате (сайт, виджет, Telegram, MAX), нет ссылки
 * на прокат со страницы его трансфера, а пока на витрине никого не осталось —
 * и дверей «Прокат» на главной. Его прайс по-прежнему отдают MCP
 * (`search_car_rental`, поверхность `mcp`) и A2A (прямой вызов идёт тем же
 * путём, что MCP; свободный вопрос агента — с отметкой `agent`).
 *
 * Страница прокатчика /car-rental/<slug> при этом открывается по прямой
 * ссылке, только без индексации: на неё ведут ответы MCP и A2A, и заявка на
 * машину оставляется только там. Закрыть её — значит отдать агенту адрес,
 * который отвечает 404, и оставить его человека без пути к заявке.
 *
 * Пауза кончается сама — во вторник 27.10 в 00:00 по Камчатке (UTC+12);
 * продлена с 26.10, потому что созвон с «Лагуной» — 26.10 в 20:00 по Камчатке.
 * Продлить — сдвинуть `until` видимым коммитом; снять раньше — убрать slug.
 * Решение «прятать» — владельца, срок назван им же; сторож:
 * `tests/unit/rental-site-pause.test.tsx`.
 */

export interface RentalSitePause {
  /** Прокатчики, которых сайт не показывает людям, — по slug партнёра. */
  readonly slugs: readonly string[];
  /** Момент, с которого пауза кончается (ISO, UTC). */
  readonly until: string;
  /** Когда прокат вернётся — словами для витрины и Кузьмича. */
  readonly returnsOn: string;
}

export const RENTAL_SITE_PAUSE: RentalSitePause = {
  slugs: ['laguna-prokat'],
  // Вторник 27.10.2026, 00:00 по Камчатке = 26.10, 12:00 UTC. Продлено на сутки:
  // созвон с «Лагуной» перенесён на понедельник 26.10, 20:00 по Камчатке.
  until: '2026-10-26T12:00:00.000Z',
  returnsOn: 'во вторник, 27 октября',
};

/** Идёт ли пауза в этот момент. */
export function rentalSitePauseActive(now: Date = new Date(), pause: RentalSitePause = RENTAL_SITE_PAUSE): boolean {
  return pause.slugs.length > 0 && now.getTime() < Date.parse(pause.until);
}

/** Спрятан ли этот прокатчик от людей на сайте в этот момент. */
export function rentalHiddenOnSite(slug: string, now: Date = new Date(), pause: RentalSitePause = RENTAL_SITE_PAUSE): boolean {
  return rentalSitePauseActive(now, pause) && pause.slugs.includes(slug);
}

/**
 * Прокатчики для людей на сайте: показанные и сколько спрятано паузой.
 * `hidden` нужен, чтобы пустая витрина говорила «вернётся тогда-то», а не
 * «прокатчиков нет»: прокатчик есть, его прячет решение, а не пустой прайс.
 */
export function rentalOnSite<T extends { slug: string }>(
  companies: readonly T[],
  now: Date = new Date(),
  pause: RentalSitePause = RENTAL_SITE_PAUSE,
): { shown: T[]; hidden: number } {
  const shown = companies.filter((c) => !rentalHiddenOnSite(c.slug, now, pause));
  return { shown, hidden: companies.length - shown.length };
}
