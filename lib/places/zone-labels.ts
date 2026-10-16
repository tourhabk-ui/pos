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
  // Метки районов вне четырёх зон (16.10, карт-бланш владельца): Корякский
  // округ — тревоги по его метке и по широте (lib/safety/krai-far.ts),
  // Северные Курилы — Сахалинская область (lib/safety/kuril-north.ts).
  krai_koryak:   'Корякский округ',
  kuril_north:   'Северные Курилы (Сахалинская обл.)',
};

/** Код — подписью; записанное словами (кириллица) — как есть; прочее — null. */
export function placeZoneLabel(code: string | null | undefined): string | null {
  const c = code?.trim();
  if (!c) return null;
  return PLACE_ZONE_LABELS[c] ?? (/[а-яё]/i.test(c) ? c : null);
}

/**
 * Район места словами — подпись зоны и записанный район через запятую; ничего
 * не записано или только незнакомый код — null. Для промптов агентов и их
 * журнала: «Район: krai_koryak» в промпте — заказ на слаг в публичном тексте.
 */
export function placeAreaWords(zone: string | null | undefined, district: string | null | undefined): string | null {
  const words = [placeZoneLabel(zone), district?.trim() || null].filter((x): x is string => Boolean(x));
  return words.length ? words.join(', ') : null;
}

export const ROUTE_DIFFICULTY_RU: Record<string, string> = {
  easy: 'лёгкий', medium: 'средней сложности', hard: 'сложный', extreme: 'экстремальный',
};

/** Код — подписью; записанное словами — как есть (как у района); прочее — null. */
export function routeDifficultyLabel(code: string | null | undefined): string | null {
  const c = code?.trim();
  if (!c) return null;
  return ROUTE_DIFFICULTY_RU[c] ?? (/[а-яё]/i.test(c) ? c : null);
}

/**
 * Сезон маршрута (kamchatka_routes.season): код или список через запятую
 * («summer, autumn»). Один словарь со сниппетом поиска (lib/seo/place-meta).
 */
export const ROUTE_SEASON_RU: Record<string, string> = {
  summer: 'лето', winter: 'зима', all: 'круглый год', spring: 'весна', autumn: 'осень',
};

export function routeSeasonLabel(code: string | null | undefined): string | null {
  const words = (code ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => ROUTE_SEASON_RU[x] ?? (/[а-яё]/i.test(x) ? x : null))
    .filter((x): x is string => x !== null);
  return words.length ? words.join(', ') : null;
}

/** Вид маршрута (kamchatka_routes.route_type): паспорта пишут его кодом (lib/import/passport-fields). */
export const ROUTE_TYPE_RU: Record<string, string> = {
  radial: 'радиальный', linear: 'линейный', loop: 'кольцевой',
};

export function routeTypeLabel(code: string | null | undefined): string | null {
  const c = code?.trim();
  if (!c) return null;
  return ROUTE_TYPE_RU[c] ?? (/[а-яё]/i.test(c) ? c : null);
}
