/**
 * Подписи кодов, которые лежат в данных места и маршрута латиницей.
 *
 * Один словарь на карточку (PlaceFacts), «Как добраться» (access-text) и
 * список маршрутов места (PlaceRoutes). 04.10 у Этнического стойбища
 * Кайныран «Как добраться» кончалось словом «avachinsky», а у маршрута
 * стояло «easy»: подписи жили в карточке, а соседние блоки печатали код.
 * Кода без подписи на экран не выводим — молчание лучше латиницы.
 */

export const PLACE_ZONE_LABELS: Record<string, string> = {
  avachinsky:    'Авачинский',
  mutnovsky:     'Мутновский',
  klyuchevsky:   'Ключевская группа',
  nalychevo:     'Налычево',
  kronotsky:     'Кроноцкий',
  southern:      'Южная Камчатка',
  central:       'Центральная',
  northern:      'Северная',
  petropavlovsk: 'Петропавловск',
  commander:     'Командорские о-ва',
  // Коды зон сейсмо-разбора (lib/services/safety/seismic-zones) лежат в той же
  // колонке; без подписи карточка показывала «Район: eastern» (аудит 29.09).
  // «Камчатка», а не «побережье» (16.10, #83): зона шире берега. В западную
  // приём относит и Быстринский округ — Эссо, Апапельские источники, — а в
  // восточную Карымский и Узон в десятках километров от моря; «Западное
  // побережье» на карточке Эссо было бы неправдой. Имена — те же, что у
  // предупреждений, заводимых человеком (lib/safety/alerts.ts).
  eastern:       'Восточная Камчатка',
  western:       'Западная Камчатка',
};

/** Код — подписью; записанное словами (кириллица) — как есть; прочее — null. */
export function placeZoneLabel(code: string | null | undefined): string | null {
  const c = code?.trim();
  if (!c) return null;
  return PLACE_ZONE_LABELS[c] ?? (/[а-яё]/i.test(c) ? c : null);
}

export const ROUTE_DIFFICULTY_RU: Record<string, string> = {
  easy: 'лёгкий', medium: 'средней сложности', hard: 'сложный', extreme: 'экстремальный',
};

export function routeDifficultyLabel(code: string | null | undefined): string | null {
  const c = code?.trim();
  return c ? ROUTE_DIFFICULTY_RU[c] ?? null : null;
}
