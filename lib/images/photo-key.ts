/**
 * Ключ снимка из хранилища, который можно отдать по адресу
 * /api/images/s3/<ключ> (14.10, статья летописи о Кроноцком заповеднике).
 *
 * Только `photos/…jpg` — то, что заливает media-to-s3 (scripts/media-to-s3.ts)
 * и что миграция подписывает автором и лицензией; строчная латиница, без
 * `..`. Чужие префиксы — `places/<uuid>/` уборки сирот, пакеты карты —
 * этим путём не открываются.
 */
const PHOTO_KEY = /^photos\/[a-z0-9][a-z0-9/_.-]*\.jpg$/;

export function photoKeyOf(parts: readonly string[]): string | null {
  const key = parts.join('/');
  if (key.includes('..') || !PHOTO_KEY.test(key)) return null;
  return key;
}

/** Адрес страницы для снимка под `photos/` — без бакета, его знает сервер. */
export function photoPath(key: string): string {
  return `/api/images/s3/${key}`;
}
