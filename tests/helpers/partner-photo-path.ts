/**
 * Снимки партнёров переехали из папки сайта в хранилище (08.11, миграция
 * 1406). Старые миграции по-прежнему пишут адрес /images/<папка>/…, а на
 * проде после цепочки он уже /api/images/s3/photos/<папка>/…, и файл лежит
 * в media/s3/. Тестам, которые сверяют миграцию с файлом, нужен один ответ
 * на вопрос «где этот снимок», а не своя замена пути в каждом файле.
 */
import { join } from 'node:path';

/** Папки, переехавшие целиком: те же, что в 1406 и в next.config.js. */
export const MOVED_PHOTO_DIRS = [
  'fishingkam', 'kutha', 'laguna-prokat', 'mestechko', 'partners', 'shatun',
  'tours/bystraya-rafting', 'volcanoesland', 'zaporozhets', 'zheltukhin',
] as const;

const MOVED = new RegExp(`^/images/(${MOVED_PHOTO_DIRS.join('|')})/`);
const S3_WEB = '/api/images/s3/';

/** Адрес после 1406: старый адрес папки сайта → адрес раздачи хранилища. */
export function inStorage(web: string): string {
  return web.replace(MOVED, `${S3_WEB}photos/$1/`);
}

/** Файл на диске для адреса снимка: снимок в хранилище — media/s3, оформление — public. */
export function photoFile(web: string, root: string = process.cwd()): string {
  const w = inStorage(web);
  return w.startsWith(S3_WEB) ? join(root, 'media', 's3', w.slice(S3_WEB.length)) : join(root, 'public', w);
}
