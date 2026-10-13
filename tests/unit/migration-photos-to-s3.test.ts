/**
 * Снимки из миграций — в хранилище (решение владельца 13.10: «согласен,
 * перенеси в S3»), фаза 1: заливка по маркеру, построенному из самих миграций.
 *
 * Перепись 13.10: 59 файлов migrations/ несут 154 JPEG hex-литералами —
 * 24,7 МБ байтов в 53 МБ SQL, 95% каталога. Что держит сторож:
 *  - разборщик находит каждый decode('…','hex') со своей таблицей, считает
 *    sha256 и строит ключ по содержимому (`migrations/photos/<sha256>.jpg`):
 *    ключ не зависит от того, как миграция привязывает снимок к месту;
 *  - не-JPEG, обрывок и чужой размер — отказ с именем файла и номером, а не
 *    молчаливый пропуск;
 *  - маркер равен миграциям до байта: правка hex в любой из 59 миграций без
 *    перестройки маркера — красный, и заливка по старому списку не пойдёт;
 *  - ключи лежат вне `places/<uuid>/`, которым распоряжается уборка сирот;
 *  - workflow зовёт скрипт по маркеру с ключами хранилища, сухой прогон без
 *    `upload: true`, одна очередь без отмены.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractPhotos, buildManifest, diffMarker, keyFor, readMarker, MARKER, KEY_PREFIX, MIN_BYTES,
} from '../../scripts/migration-photos-to-s3';
import { PLACE_IMAGE_KEY_RE } from '@/lib/storage/orphan-delete';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Правдоподобный JPEG: маркеры начала и конца, между ними заполнение нужной длины. */
function fakeJpeg(size: number, seed: number): Buffer {
  const b = Buffer.alloc(size, seed & 0xff);
  b[0] = 0xff; b[1] = 0xd8; b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}
/** Hex по 96 знаков на строку — та же форма, что в миграциях. */
function hexLines(buf: Buffer): string {
  return (buf.toString('hex').match(/.{1,96}/g) ?? []).map((l) => `         '${l}'`).join('\n');
}
const HERO = fakeJpeg(MIN_BYTES + 100, 1);
const GALLERY = fakeJpeg(MIN_BYTES + 200, 2);
const SQL = `-- 9999: проба
BEGIN;
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author)
SELECT p.ark_id,
       decode(
${hexLines(HERO)}
         , 'hex'),
       'image/jpeg', 'проба', 'manual-upload', 960, 540, 'Автор'
  FROM places p WHERE p.id::text = '00000000-0000-0000-0000-000000000000' LIMIT 1
ON CONFLICT (route_id) DO NOTHING;

UPDATE place_gallery_photos g
   SET image_data = decode(
${hexLines(GALLERY)}, 'hex'),
       mime_type = 'image/jpeg'
  FROM places p
 WHERE p.id::text = '00000000-0000-0000-0000-000000000000' AND g.ark_id = p.ark_id AND g.position = 1;
COMMIT;
`;

describe('разборщик hex-снимков', () => {
  it('находит каждый decode с таблицей, хэшем и ключом по содержимому', () => {
    const photos = extractPhotos(SQL, '9999_proba.sql');
    expect(photos.map((p) => [p.n, p.table, p.bytes])).toEqual([
      [1, 'ai_route_images', HERO.length],
      [2, 'place_gallery_photos', GALLERY.length],
    ]);
    const sha = createHash('sha256').update(GALLERY).digest('hex');
    expect(photos[1].sha256).toBe(sha);
    expect(photos[1].key).toBe(`${KEY_PREFIX}${sha}.jpg`);
    expect(keyFor(sha)).toBe(photos[1].key);
  });

  it('не JPEG, обрывок и нечётный hex — отказ с именем и номером, не пропуск', () => {
    const notJpeg = Buffer.alloc(MIN_BYTES + 10, 0x41);
    expect(() => extractPhotos(`decode(\n'${notJpeg.toString('hex')}', 'hex')`, 'x.sql')).toThrow(/x\.sql #1: не JPEG/);
    const short = fakeJpeg(MIN_BYTES - 1, 3);
    expect(() => extractPhotos(`decode('${short.toString('hex')}', 'hex')`, 'y.sql')).toThrow(/y\.sql #1: .* вне/);
    expect(() => extractPhotos(`decode('ffd8f', 'hex')`, 'z.sql')).toThrow(/нечётной длины/);
  });

  it('ключи — вне префикса мест, которым распоряжается уборка сирот', () => {
    expect(KEY_PREFIX).toBe('migrations/photos/');
    expect(PLACE_IMAGE_KEY_RE.test(keyFor('a'.repeat(64)))).toBe(false);
  });
});

describe('маркер заливки построен из миграций и равен им до байта', () => {
  const marker = readMarker(ROOT);

  it('перестройка даёт ровно то, что лежит в маркере', () => {
    const actual = buildManifest(ROOT);
    expect(actual.length).toBeGreaterThan(0);
    expect(diffMarker(marker.items, actual)).toEqual([]);
    expect(actual).toEqual(marker.items);
  }, 60_000);

  it('каждая запись — JPEG по размеру, ключ по своему хэшу, таблица названа', () => {
    for (const p of marker.items) {
      expect(p.key, p.migration).toBe(keyFor(p.sha256));
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.bytes).toBeGreaterThanOrEqual(MIN_BYTES);
      expect(['ai_route_images', 'place_gallery_photos']).toContain(p.table);
    }
    expect(marker.run).toBeGreaterThanOrEqual(1);
    expect(marker.note.length).toBeGreaterThan(20);
  });

  it('расхождение называется словами: чужой хэш, лишний и пропавший снимок', () => {
    const a = buildManifest(ROOT).slice(0, 3);
    const changed = [{ ...a[0], sha256: 'f'.repeat(64) }, a[1]];
    expect(diffMarker(changed, a)).toEqual([
      `${a[0].migration}#${a[0].n}: запись маркера расходится с миграцией`,
      `${a[2].migration}#${a[2].n}: снимок есть в миграции, но не в маркере`,
    ]);
    expect(diffMarker([...a, { ...a[0], n: 99 }], a)).toEqual([`${a[0].migration}#99: в миграциях такого снимка нет`]);
  }, 60_000);
});

describe('workflow заливки', () => {
  const wf = read('.github/workflows/migration-photos-to-s3.yml');

  it('идёт по маркеру, зовёт скрипт, ключи хранилища из секретов, сухой прогон без upload', () => {
    expect(wf).toContain(`- '${MARKER}'`);
    expect(wf).toContain('npx tsx scripts/migration-photos-to-s3.ts $FLAG');
    for (const s of ['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_ENDPOINT']) {
      expect(wf).toContain(`${s}: \${{ secrets.${s} }}`);
    }
    expect(wf).toMatch(/if \[ "\$\{\{ steps\.cfg\.outputs\.upload \}\}" != "true" \]; then FLAG="--dry-run"; fi/);
    expect(wf).toMatch(/group: migration-photos-to-s3\s+cancel-in-progress: false/);
  });

  it('скрипт: сверка с миграциями до заливки, чтение обратно, повтор без перезаливки', () => {
    const src = read('scripts/migration-photos-to-s3.ts');
    expect(src).toMatch(/const diff = diffMarker\(marker\.items, actual\);[\s\S]*?return 1;/);
    expect(src).toMatch(/const have = await headSize\(url\);\s*if \(have === it\.bytes\) \{ skipped \+= 1; continue; \}/);
    expect(src).toMatch(/sha !== it\.sha256/);
    expect(src).toContain("console.error('ОТКАЗ: в маркере нет ни одного снимка.')");
  });
});
