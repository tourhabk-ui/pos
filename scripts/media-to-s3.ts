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
 *   - файл берётся только из `media/s3/`, ключ — только под `videos/` или
 *     `photos/` (14.10: снимки мест со свободной лицензией, выбранные в
 *     сессии, — первым Кроноцкий заповедник). Другие префиксы бакета этим
 *     путём не пишутся: `places/<uuid>/` распоряжается уборка сирот
 *     (lib/storage/orphan-delete), `maps/` — сборка пакетов карты;
 *   - под `photos/` — снимки `.jpg`/`.jpeg`, логотипы `.png` и уменьшенные
 *     копии `.webp` (08.11, переезд снимков партнёров из public/images), и
 *     только ключ, который отдаёт /api/images/s3/ (photoKeyOf): что залито,
 *     то и открывается. Тип — по байтам файла, не по имени: внутри должен
 *     быть снимок (страница «404» nginx, сохранённая как .jpg, — отказ);
 *     под `videos/` — `.mp4` с видео внутри и обложки `.jpg` с JPEG;
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

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { uploadToS3, isS3Configured, s3PublicBase } from '@/lib/storage/s3';
import { photoKeyOf } from '@/lib/images/photo-key';

export const MARKER = '.github/triggers/media-to-s3.json';
export const MEDIA_ROOT = 'media/s3/';
export const KEY_PREFIX = 'videos/';
/** Снимки мест (14.10): JPEG под своим префиксом, вне `places/<uuid>/` уборки сирот. */
export const PHOTO_KEY_PREFIX = 'photos/';
/** Что можно положить под videos/: короткие клипы и их обложки. */
export const VIDEO_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
};
/** Что можно положить под photos/: снимки, логотипы, уменьшенные копии (08.11). */
export const PHOTO_EXTS: readonly string[] = ['.jpg', '.jpeg', '.png', '.webp'];
/** Сколько объектов заливается разом: снимков партнёров — около тысячи. */
export const CONCURRENCY = 6;
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

/** Тип файла по первым байтам; null — не узнан. Имя файла здесь не голос. */
export function sniffType(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  return null;
}

function readHead(path: string): Buffer {
  const buf = Buffer.alloc(16);
  const fd = openSync(path, 'r');
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Проверить строку маркера. Возвращает причину отказа или проверенную строку. */
export function checkItem(item: unknown, root: string): CheckedItem | string {
  if (typeof item !== 'object' || item === null) return 'строка не объект';
  const { file, key } = item as { file?: unknown; key?: unknown };
  if (typeof file !== 'string' || typeof key !== 'string') return 'нужны file и key строками';
  if (normalize(file) !== file || !file.startsWith(MEDIA_ROOT) || file.includes('..')) {
    return `${file}: файл только из ${MEDIA_ROOT}`;
  }
  const underPhotos = key.startsWith(PHOTO_KEY_PREFIX);
  if ((!key.startsWith(KEY_PREFIX) && !underPhotos) || key.includes('..') || !/^[a-z0-9/._-]+$/.test(key)) {
    return `${key}: ключ только под ${KEY_PREFIX} или ${PHOTO_KEY_PREFIX}, латиница в нижнем регистре`;
  }
  const ext = key.slice(key.lastIndexOf('.'));
  if (underPhotos) {
    if (!PHOTO_EXTS.includes(ext) || photoKeyOf(key.split('/')) === null) {
      return `${key}: под ${PHOTO_KEY_PREFIX} — только снимки ${PHOTO_EXTS.join(', ')} с ключом, который отдаёт /api/images/s3/`;
    }
  } else if (!VIDEO_TYPES[ext]) {
    return `${key}: расширение ${ext} не принимается`;
  }
  if (!file.endsWith(ext)) return `${file}: расширение файла и ключа расходятся`;
  const path = join(root, file);
  if (!existsSync(path)) return `${file}: файла нет`;
  const size = statSync(path).size;
  if (size === 0 || size > MAX_BYTES) return `${file}: размер ${size} байт вне 1..${MAX_BYTES}`;
  const inside = sniffType(readHead(path));
  if (underPhotos) {
    // Тип — по байтам: два снимка «Рыбалки на Камчатке» лежат JPEG-ом под
    // именем .png, и хранилище назовёт их тем, что они есть.
    if (!inside?.startsWith('image/')) return `${file}: внутри не снимок (${inside ?? 'тип не узнан'})`;
    return { file, key, contentType: inside, size };
  }
  if (inside !== VIDEO_TYPES[ext]) return `${file}: внутри ${inside ?? 'тип не узнан'}, а ключ ${ext}`;
  return { file, key, contentType: VIDEO_TYPES[ext], size };
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
  let next = 0;
  // Объекты независимы: несколько заливок разом, отказ одного не останавливает
  // остальные и считается в итог.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const it = items[next++];
      try {
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
      } catch (err) {
        console.error(`НЕ ЗАЛИТО: ${it.key}: ${err instanceof Error ? err.message : String(err)}`);
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
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
