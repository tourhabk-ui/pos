/**
 * Слова своего тура гида — без базы, их читают и экраны чата, и раздел
 * «Свои туры» на сайте (клиентский компонент). Условия гейта живут в SQL
 * (lib/guides/own-tour-publish); здесь — только их имена и подписи.
 */

/** Условия витринного гейта своего тура гида — по имени предиката в SQL. */
export const PUBLISH_BLOCKERS = ['description', 'base_price', 'guide_not_public'] as const;
export type PublishBlocker = (typeof PUBLISH_BLOCKERS)[number];

/** Чего не хватает до сайта — словами гида, одни на чат и сайт. */
export const PUBLISH_BLOCKER_LABELS: Readonly<Record<PublishBlocker, string>> = {
  description: 'нет описания тура',
  base_price: 'не указана цена',
  guide_not_public: 'анкету гида ещё не одобрила платформа — туры выходят на сайт после одобрения',
};

/** Подпись условия; неизвестное имя — как есть, а не пропуск. */
export function publishBlockerLabel(b: string): string {
  return (PUBLISH_BLOCKER_LABELS as Record<string, string>)[b] ?? b;
}

/** Состояние своего тура словами — чат и сайт. */
export function ownTourStateWords(onStorefront: boolean): string {
  return onStorefront ? 'на сайте' : 'черновик — туристы не видят';
}
