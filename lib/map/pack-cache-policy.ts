/**
 * lib/map/pack-cache-policy.ts — заголовок Cache-Control у файлов пакетов карты.
 *
 * До 05.09 все объекты бакета — фото, видео И архивы карты — заливались с
 * `public, max-age=31536000, immutable` (lib/storage/s3.ts): для фото это
 * верно, у них новый файл — новый ключ. У пакетов карты ключ ПОСТОЯННЫЙ
 * (`map-packs/<район>.terrain.pmtiles`), файл под ним переписывается при
 * каждой пересборке, а читатель PMTiles берёт его КУСКАМИ по Range. Два
 * следствия, оба увидены снимками на раннере (прогоны 8-11):
 *
 *   1. Chromium хранит частичные (206) ответы одного адреса в своём
 *      HTTP-кэше и склеивает их. Прогон 11: прокси отдал 4778 Б с
 *      Content-Length 4778, страница прочла 3232 — при двух соседних
 *      Range-запросах к тому же файлу в полёте. Итог — «could not be
 *      decoded» на тайле, который в архиве цел. Читатель PMTiles ровно от
 *      этого на Windows-Chrome ходит с cache: 'no-store'; для частичных
 *      ответов архива правильный заголовок — `no-store`: их нельзя ни
 *      хранить, ни склеивать.
 *   2. «Год и immutable» у переписанного файла — год старой карты в
 *      телефоне: пересборка рельефа с запасом DEM (05.09) не дошла бы до
 *      владельца, пока кэш не вычистится сам. Читатель PMTiles лечит это
 *      частично (ETag в заголовке архива против ETag куска — несовпадение
 *      ведёт к перечитыванию), но GeoJSON, паспорт и глифы читаются целиком
 *      и ничем не проверяются: им — `no-cache` (хранить можно, отдавать
 *      только после сверки ETag с хранилищем: 304 дёшев, устаревший слой —
 *      нет).
 *
 * Офлайн этим не задет: пакет для поля кладётся отдельным слоем
 * (lib/offline), а service worker чужие Range-запросы не перехватывает.
 * Старые объекты перештамповываются на месте: scripts/map-tiles/stamp-cache-control.ts.
 */

/** Cache-Control для ключа под map-packs/: архивы по Range — не хранить; остальное — сверять. */
export function packCacheControl(key: string): string {
  return key.endsWith('.pmtiles') ? 'no-store' : 'no-cache';
}

/** MIME-тип файла пакета по ключу — тот же, что задаёт заливка (upload-*.ts). */
export function packContentType(key: string): string {
  if (key.endsWith('.pmtiles')) return 'application/octet-stream';
  if (key.endsWith('.geojson')) return 'application/geo+json';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.pbf')) return 'application/x-protobuf';
  throw new Error(`неизвестный род файла пакета: ${key}`);
}
