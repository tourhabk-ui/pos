/**
 * Заголовок страницы, который помещается в выдачу.
 *
 * Аудит vedarai.ru 01.10: у страниц планов заголовки были по 86–91 знаку
 * («Камчатка за 7 дней: вулканы, треккинг и термальные — готовый план с
 * турами и ценами | Ведар»), а выдача показывает около 60 — хвост и название
 * сайта обрезались многоточием. Здесь выбирается самый длинный из
 * предложенных хвостов, при котором заголовок целиком укладывается в предел;
 * не уложился ни один — заголовок без хвоста.
 *
 * Предел считает и суффикс шаблона layout (« | Ведар»): обрезается именно он.
 */
export const TITLE_LIMIT = 65;
export const BRAND_SUFFIX = ' | Ведар';

export function fitTitle(base: string, tails: readonly string[], limit: number = TITLE_LIMIT): string {
  const room = limit - BRAND_SUFFIX.length - base.length;
  const fitting = tails.filter((t) => t.length <= room).sort((a, b) => b.length - a.length);
  return base + (fitting[0] ?? '');
}

/** Хвосты заголовка плана — от полного к короткому. */
export const PLAN_TITLE_TAILS = [
  ' — готовый план с турами и ценами',
  ' — план с турами и ценами',
  ' — готовый план',
  ' — план',
] as const;

/** Хвосты заголовка парка — от полного к короткому. */
export const PARK_TITLE_TAILS = [
  ' — маршруты, карты офлайн, регистрация МЧС',
  ' — маршруты, офлайн-карты и МЧС',
  ' — маршруты и офлайн-карты',
  ' — маршруты',
] as const;

/**
 * Хвост, без которого заголовок не отличить от соседа (аудит 01.10).
 *
 * Шесть маршрутов к термальным источникам носят ровно имя своего места, и
 * при длинном имени `fitTitle` отбрасывал хвост целиком: страница маршрута
 * и страница места выходили в выдачу под ОДНИМ заголовком. Здесь, если не
 * поместился ни один хвост, ставится самый короткий — сверх предела
 * обрежется « | Ведар», а не слово, отличающее маршрут от места.
 */
export function fitTitleRequired(base: string, tails: readonly string[], limit: number = TITLE_LIMIT): string {
  const fitted = fitTitle(base, tails, limit);
  if (fitted !== base || tails.length === 0) return fitted;
  const shortest = [...tails].sort((a, b) => a.length - b.length)[0];
  return base + shortest;
}

/** Хвосты заголовка маршрута — от полного к короткому. */
export const ROUTE_TITLE_TAILS = [' — маршрут на Камчатке', ' — маршрут'] as const;
