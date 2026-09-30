/**
 * Удаление брошенного объекта хранилища — правила, без сети и базы.
 *
 * Повод (30.09). Миграция 1116 поставила снимки владельца на место скрытой
 * картинки Козельского. Строка в базе переписана, а сам объект
 * `places/7190e0a4-…/f30b51e0-….jpg` остался в бакете ничьим. Владелец:
 * «это была заглушка скачанная с интернета — удали». Миграция хранилища не
 * касается и не должна, а удалить отдельный объект в платформе было нечем.
 *
 * Удаление необратимо, поэтому правила здесь жёсткие и записаны один раз:
 *   - только ключи снимков мест (`places/<uuid>/<файл>.<jpg|png|webp>`);
 *     чужой префикс (пакеты карты, треки, фото отчётов) инструмент не трогает;
 *   - объект, на который ссылается ХОТЬ ОДНА строка, не удаляется;
 *   - проверка ссылок, которая не смогла выполниться, — отказ, а не «ссылок
 *     нет» (§4.0: «не смог проверить» не равно «хорошо»);
 *   - сухой прогон по умолчанию, партия не больше 10, причина обязательна.
 */

/** Ключ снимка места: папка — ark_id места или маршрута, имя — без путей. */
export const PLACE_IMAGE_KEY_RE =
  /^places\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:jpe?g|png|webp)$/;

export const DELETE_BATCH_MAX = 10;

export function isPlaceImageKey(key: string): boolean {
  return PLACE_IMAGE_KEY_RE.test(key) && !key.includes('..');
}

/**
 * Где в базе может лежать ссылка на объект хранилища — ключом или адресом.
 * Список снят с information_schema 30.09 (колонки с s3_/photo/image/cover/url
 * в базовых таблицах). Новая таблица со ссылками на снимки мест обязана
 * попасть сюда — сторож `s3-object-delete.test.ts` держит этот список.
 */
export const REFERENCE_COLUMNS: ReadonlyArray<{ table: string; expr: string }> = [
  { table: 'ai_route_images', expr: 's3_key' },
  { table: 'ai_route_images', expr: 's3_url' },
  { table: 'place_gallery_photos', expr: 's3_url' },
  { table: 'places', expr: 'photo_url' },
  { table: 'places', expr: 'images::text' },
  { table: 'user_place_photos', expr: 'url' },
  { table: 'collections', expr: 'cover_image' },
  { table: 'operator_tours', expr: 'tour_image' },
  { table: 'operator_tours', expr: 'photos::text' },
  { table: 'operator_tour_reviews', expr: 'photos::text' },
  { table: 'partners', expr: 'hero_image' },
  { table: 'partners', expr: 'photo_url' },
  { table: 'route_templates', expr: 'images::text' },
  { table: 'assets', expr: 'url' },
];

/**
 * Один запрос: сколько строк в каждой колонке содержат ключ. `strpos`, а не
 * LIKE: в ключе бывает `_`, а для LIKE это подстановка.
 */
export function referenceCountSql(): string {
  return REFERENCE_COLUMNS
    .map(({ table, expr }) =>
      `SELECT '${table}.${expr.replace('::text', '')}' AS col, count(*)::int AS n FROM ${table} WHERE strpos(${expr}, $1) > 0`)
    .join('\nUNION ALL\n');
}

export type DeleteVerdict =
  | { key: string; outcome: 'refused_bad_key' }
  | { key: string; outcome: 'refused_referenced'; referencedBy: string[] }
  | { key: string; outcome: 'refused_check_failed'; reason: string }
  | { key: string; outcome: 'already_absent' }
  | { key: string; outcome: 'would_delete'; bytes: number | null }
  | { key: string; outcome: 'deleted'; bytes: number | null }
  | { key: string; outcome: 'delete_unverified'; reason: string };
