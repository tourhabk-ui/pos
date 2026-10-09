/**
 * scripts/media-to-s3.ts — залить в хранилище медиа, лежащие в репозитории
 * (`media/s3/`), по списку маркера `.github/triggers/media-to-s3.json`.
 *
 * Зачем (09.10, решение владельца «нарежь короткие видео для туров камчатской
 * рыбалки без звука и сохрани их в s3»). Пути «файл из репозитория → бакет» не
 * было: загрузчики принимали только снимки из базы или по URL, а единственный
 * приёмник видео — админская форма в браузере. Из сессии, у которой есть
 * только git, положить ролик в хранилище было нечем.
 *
 * Правила:
 *   - файл берётся только из `media/s3/`, ключ — только под `videos/`;
 *     другие префиксы бакета (места, пакеты карты) этим путём не пишутся;
 *   - сначала проверяется ВЕСЬ список, потом заливается: отказ любой строки —
 *     ничего не залито;
 *   - после заливки объект читается обратно по публичному адресу и сверяется
 *     размер и тип: «отправил» не значит «лежит» (тот же порядок, что у
 *     переезда снимков в хранилище, §4.1);
 *   - сухой прогон по умолчанию: заливка — только при `"upload": true`.
 *
 *   S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/media-to-s3.ts [--dry-run]
 *
 * Сторож: tests/unit/media-to-s3.test.ts.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { uploadToS3, isS3Configured, s3PublicBase } from '@/lib/storage/s3';

export const MARKER = '.github/triggers/media-to-s3.json';
export const MEDIA_ROOT = 'media/s3/';
export const KEY_PREFIX = 'videos/';
/** Что этим путём можно положить: короткие клипы и их обложки. */
export const ALLOWED_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
};
/** Короткий клип — не фильм: больше этого в ленте на телефоне не место. */
export const MAX_BYTES = 5 * 1024 * 1024;

export interface MediaItem {
  file: string;
  key: string;
}

export interface CheckedItem extends MediaItem {
  contentType: string;
  size: number;
}

/** Проверить строку маркера. Возвращает причину отказа или проверенную строку. */
export function checkItem(item: unknown, root: string): CheckedItem | string {
  if (typeof item !== 'object' || item === null) return 'строка не объект';
  const { file, key } = item as { file?: unknown; key?: unknown };
  if (typeof file !== 'string' || typeof key !== 'string') return 'нужны file и key строками';
  if (normalize(file) !== file || !file.startsWith(MEDIA_ROOT) || file.includes('..')) {
    return `${file}: файл только из ${MEDIA_ROOT}`;
  }
  if (!key.startsWith(KEY_PREFIX) || key.includes('..') || !/^[a-z0-9/._-]+$/.test(key)) {
    return `${key}: ключ только под ${KEY_PREFIX}, латиница в нижнем регистре`;
  }
  const ext = key.slice(key.lastIndexOf('.'));
  const contentType = ALLOWED_TYPES[ext];
  if (!contentType) return `${key}: расширение ${ext} не принимается`;
  if (!file.endsWith(ext)) return `${file}: расширение файла и ключа расходятся`;
  const path = join(root, file);
  if (!existsSync(path)) return `${file}: файла нет`;
  const size = statSync(path).size;
  if (size === 0 || size > MAX_BYTES) return `${file}: размер ${size} байт вне 1..${MAX_BYTES}`;
  return { file, key, contentType, size };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const root = process.cwd();
  const marker = JSON.parse(readFileSync(join(root, MARKER), 'utf8')) as { items?: unknown };
  const raw = Array.isArray(marker.items) ? marker.items : [];
  if (raw.length === 0) {
    // Ноль строк при запуске — отказ, а не успех (§4.0).
    console.error('ОТКАЗ: в маркере нет ни одной строки.');
    return 1;
  }

  const items: CheckedItem[] = [];
  for (const r of raw) {
    const c = checkItem(r, root);
    if (typeof c === 'string') {
      console.error(`ОТКАЗ: ${c}. Ничего не залито.`);
      return 1;
    }
    items.push(c);
  }
  console.log(`строк: ${items.length}, ${dryRun ? 'сухой прогон' : 'боевой'}`);
  if (dryRun) {
    for (const it of items) console.log(`  ${it.file} -> ${it.key} (${it.size} байт, ${it.contentType})`);
    return 0;
  }
  if (!isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.');
    return 2;
  }

  let failed = 0;
  for (const it of items) {
    await uploadToS3(it.key, readFileSync(join(root, it.file)), it.contentType);
    // Прочитать обратно по публичному адресу: так его увидит браузер.
    const res = await fetch(`${s3PublicBase()}/${it.key}`);
    const got = Buffer.from(await res.arrayBuffer()).length;
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || got !== it.size || !type.startsWith(it.contentType)) {
      console.error(`НЕ СОШЛОСЬ: ${it.key}: HTTP ${res.status}, ${got} из ${it.size} байт, тип «${type}»`);
      failed += 1;
    } else {
      console.log(`  ${it.key}: залит и прочитан обратно (${got} байт, ${type})`);
    }
  }
  if (failed > 0) {
    console.error(`Не сошлось ${failed} из ${items.length}.`);
    return 1;
  }
  console.log(`Готово: ${items.length} из ${items.length}.`);
  return 0;
}

if (process.argv[1]?.endsWith('media-to-s3.ts')) {
  main().then((code) => process.exit(code), (err) => {
    console.error('ОТКАЗ:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
