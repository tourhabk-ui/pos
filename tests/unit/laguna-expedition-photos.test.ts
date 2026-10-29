/**
 * Снимки 34 туров «Лагуны Экспедиции» и её логотип (миграция 1343, слово
 * владельца 29.10: «они дали добро на использоваеие», «и логотип», «фото в
 * s3?» — да).
 *
 * Здесь — связка, которую база проверить не может: каждый адрес, который
 * миграция пишет туру, открывается раздачей (/api/images/s3/ отдаёт только
 * то, что пропускает photoKeyOf), файл под ним лежит в media/s3/, проходит
 * проверку заливщика и стоит в маркере media-to-s3 — иначе в хранилище его не
 * будет, и карточка покажет битую картинку. Снимки пережаты и без метаданных
 * (в части исходников были координаты места съёмки). Что миграция делает на
 * базе — ставит, не перетирает, подписывает, повтор ничего не меняет —
 * судит tests/integration/operators-list.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { photoKeyOf, photoPath } from '@/lib/images/photo-key';
import { checkItem, MARKER } from '@/scripts/media-to-s3';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/1343_laguna_expedition_photos.sql'), 'utf-8');
const MIG_1339 = readFileSync(join(ROOT, 'migrations/1339_laguna_expedition_tours.sql'), 'utf-8');
const DIR = 'media/s3/photos/laguna-expedition';
const LOGO = '/images/laguna-expedition/laguna-expedition-logo.png';

/** Строки VALUES миграции: адрес тура → его снимки по порядку. */
function toursOfMigration(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/\('(lagexp-[a-z0-9-]+)', ARRAY\[([\s\S]*?)\]::text\[\]\)/g)) {
    out.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return out;
}
const TOURS = toursOfMigration(MIG);
const URLS = [...new Set([...TOURS.values()].flat())];
const marker = JSON.parse(readFileSync(join(ROOT, MARKER), 'utf-8')) as {
  upload: boolean; items: Array<{ file: string; key: string }>;
};

/** Размер JPEG из маркера SOF; null — маркера нет. */
function jpegSize(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

describe('1343: снимки туров «Лагуны Экспедиции» — в хранилище, а не в образе', () => {
  it('снимки получает каждый из 34 туров 1339, и только они', () => {
    const slugs1339 = [...new Set([...MIG_1339.matchAll(/'(lagexp-[a-z0-9-]+)'::text,/g)].map((m) => m[1]))].sort();
    expect(slugs1339).toHaveLength(34);
    expect([...TOURS.keys()].sort()).toEqual(slugs1339);
    for (const [slug, photos] of TOURS) {
      expect(photos.length, slug).toBeGreaterThanOrEqual(1);
      // Обложка и не больше пяти в галерею.
      expect(photos.length, slug).toBeLessThanOrEqual(6);
      expect(new Set(photos).size, `${slug}: снимок дважды`).toBe(photos.length);
    }
  });

  it('каждый адрес открывается раздачей /api/images/s3/ и собран photoPath', () => {
    expect(URLS.length).toBeGreaterThan(100);
    for (const url of URLS) {
      const key = url.replace(/^\/api\/images\/s3\//, '');
      expect(photoKeyOf(key.split('/')), url).toBe(key);
      expect(photoPath(key), url).toBe(url);
      expect(key.startsWith('photos/laguna-expedition/'), url).toBe(true);
    }
  });

  it('файл каждого адреса лежит в media/s3/, проходит заливщик и стоит в маркере; лишних файлов нет', () => {
    const items = new Map(marker.items.map((i) => [i.key, i.file]));
    expect(marker.upload).toBe(true);
    for (const url of URLS) {
      const key = url.replace(/^\/api\/images\/s3\//, '');
      const file = `media/s3/${key}`;
      expect(items.get(key), `${key} нет в маркере`).toBe(file);
      const checked = checkItem({ file, key }, ROOT);
      expect(typeof checked === 'string' ? checked : 'ok', key).toBe('ok');
    }
    const onDisk = readdirSync(join(ROOT, DIR)).map((f) => `/api/images/s3/photos/laguna-expedition/${f}`).sort();
    expect(onDisk, 'файл в media/s3 без тура или тур без файла').toEqual([...URLS].sort());
  });

  it('снимки пережаты до 1600 px по длинной стороне и без метаданных (EXIF, координаты)', () => {
    for (const url of URLS) {
      const buf = readFileSync(join(ROOT, 'media/s3', url.replace(/^\/api\/images\/s3\//, '')));
      expect(buf.subarray(0, 2).toString('hex'), url).toBe('ffd8');
      const size = jpegSize(buf);
      expect(size, url).not.toBeNull();
      expect(Math.max(size!.w, size!.h), url).toBeLessThanOrEqual(1600);
      expect(buf.includes(Buffer.from('Exif\0\0', 'binary')), `${url}: EXIF не снят`).toBe(false);
    }
  });

  it('в public/images снимков туров нет — только логотип; логотип — PNG 512×512', () => {
    const pub = readdirSync(join(ROOT, 'public/images/laguna-expedition'));
    expect(pub).toEqual(['laguna-expedition-logo.png']);
    expect(MIG).toContain(`'${LOGO}'`);
    const png = readFileSync(join(ROOT, 'public', LOGO));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
    expect(existsSync(join(ROOT, 'public/images/laguna-expedition', 'laguna-expedition-logo.png'))).toBe(true);
  });
});
