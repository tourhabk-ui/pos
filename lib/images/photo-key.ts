/**
 * Ключ снимка из хранилища, который можно отдать по адресу
 * /api/images/s3/<ключ> (14.10, статья летописи о Кроноцком заповеднике).
 *
 * Только `photos/…` — то, что заливает media-to-s3 (scripts/media-to-s3.ts);
 * строчная латиница, без `..`. Чужие префиксы — `places/<uuid>/` уборки
 * сирот, пакеты карты — этим путём не открываются.
 *
 * С 08.11 — не только JPEG: снимки партнёров переезжают из public/images в
 * хранилище вместе с уменьшенными копиями (`.320/.640/.1280.webp`, их режет
 * scripts/optimize-images.mjs) и логотипами PNG. Пока ключ знал один `.jpg`,
 * копиям и логотипам в хранилище не было адреса, и сессии клали снимки
 * партнёров в папку сайта — отсюда 83 МБ снимков в образе.
 */
const PHOTO_KEY = /^photos\/[a-z0-9][a-z0-9/_.-]*\.(jpe?g|png|webp)$/;

/** Тип по расширению ключа — на случай, когда хранилище своего не назвало. */
const TYPE_BY_EXT: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function photoKeyOf(parts: readonly string[]): string | null {
  const key = parts.join('/');
  if (key.includes('..') || !PHOTO_KEY.test(key)) return null;
  return key;
}

/** Тип снимка по ключу, прошедшему photoKeyOf. */
export function photoTypeOf(key: string): string {
  return TYPE_BY_EXT[key.slice(key.lastIndexOf('.') + 1)] ?? 'image/jpeg';
}

/** Адрес страницы для снимка под `photos/` — без бакета, его знает сервер. */
export function photoPath(key: string): string {
  return `/api/images/s3/${key}`;
}
