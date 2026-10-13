/**
 * Снимки из миграций — в хранилище (решение владельца 13.10: «согласен,
 * перенеси в S3»). Фаза 1 — заливка по маркеру, построенному из самих
 * миграций; фаза 2 — миграции пишут ключ вместо байтов, прод переведён по
 * хэшу байтов (1228), раздача читает ключ.
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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractPhotos, buildManifest, keyFor, readMarker, MARKER, KEY_PREFIX, MIN_BYTES,
} from '../../scripts/migration-photos-to-s3';
import { PLACE_IMAGE_KEY_RE, REFERENCE_COLUMNS } from '@/lib/storage/orphan-delete';

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

describe('фаза 2: миграции байтов не носят, маркер — запись о том, что залито', () => {
  const marker = readMarker(ROOT);
  const unique = [...new Map(marker.items.map((p) => [p.sha256, p])).values()];

  it('ни в одной миграции не осталось hex-снимка', () => {
    expect(buildManifest(ROOT)).toEqual([]);
  }, 60_000);

  it('каждый снимок маркера записан ключом в своей миграции', () => {
    for (const p of marker.items) {
      const sql = read(`migrations/${p.migration}`);
      expect(sql, `${p.migration} #${p.n}`).toContain(`'${p.key}'`);
      expect(p.key).toBe(keyFor(p.sha256));
      expect(['ai_route_images', 'place_gallery_photos']).toContain(p.table);
    }
    expect(marker.items.length).toBeGreaterThan(100);
  });

  it('1228 переводит прод-строки по хэшу байтов: каждая пара (sha256, ключ), один проход на таблицу', () => {
    const sql = read('migrations/1228_migration_photos_to_s3_keys.sql');
    for (const p of unique) expect(sql).toContain(`('${p.sha256}', '${p.key}')`);
    expect((sql.match(/encode\(sha256\(/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/UPDATE ai_route_images i\s+SET s3_key = k\.s3_key, image_data = NULL/);
    expect(sql).toMatch(/UPDATE place_gallery_photos g\s+SET s3_key = k\.s3_key, image_data = NULL/);
    expect(sql).toMatch(/CREATE TEMP TABLE _migration_photo_keys/);
    // s3_url не трогается: у строки с байтами его нет, а чужой адрес — не наш.
    expect(sql).not.toMatch(/s3_url\s*=/);
  });

  it('схема готова к ключу и на проде (1227), и на чистой базе (968, 930)', () => {
    const m1226 = read('migrations/1227_place_gallery_photos_s3_key.sql');
    expect(m1226).toMatch(/ADD COLUMN IF NOT EXISTS s3_key TEXT/);
    expect(m1226).toMatch(/DROP CONSTRAINT IF EXISTS place_gallery_photos_has_image/);
    expect(m1226).toMatch(/CHECK \(image_data IS NOT NULL OR s3_url IS NOT NULL OR s3_key IS NOT NULL\)/);
    const m968 = read('migrations/968_place_gallery_photos.sql');
    expect(m968).toMatch(/s3_key\s+TEXT,/);
    expect(m968).toMatch(/CHECK \(image_data IS NOT NULL OR s3_url IS NOT NULL OR s3_key IS NOT NULL\)/);
    const m930 = read('migrations/930_sinichkino_coords_and_owner_photo.sql');
    expect(m930).toMatch(/ADD COLUMN IF NOT EXISTS s3_key TEXT/);
    expect(m930).toMatch(/ALTER COLUMN image_data DROP NOT NULL/);
    expect(m930.indexOf('DROP NOT NULL')).toBeLessThan(m930.indexOf('INSERT INTO ai_route_images'));
  });

  it('уборка сирот знает ключ галереи', () => {
    expect(REFERENCE_COLUMNS.map((c) => `${c.table}.${c.expr}`)).toContain('place_gallery_photos.s3_key');
  });
});

describe('раздача читает ключ: адрес из S3_BUCKET, после s3_url и раньше байтов', () => {
  const KEY = keyFor('a'.repeat(64));
  let rows: Array<Record<string, unknown>> = [];
  const query = vi.fn(async () => ({ rows }));

  async function routes() {
    vi.resetModules();
    vi.stubEnv('S3_BUCKET', 'vedar-test');
    vi.stubEnv('S3_ENDPOINT', 'https://s3.twcstorage.ru');
    vi.doMock('@/lib/db-pool', () => ({ pool: { query } }));
    const hero = await import('@/app/api/images/route/[routeId]/route');
    const gallery = await import('@/app/api/images/place-gallery/[arkId]/[position]/route');
    return { hero, gallery };
  }
  const ark = '7190e0a4-52f1-47fb-ba17-0fcb493d99df';
  const req = (url: string) => new NextRequest(url);

  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('@/lib/db-pool'); });

  it('только ключ — 302 на объект хранилища', async () => {
    const { hero, gallery } = await routes();
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: null, s3_key: KEY, thumb_url: null }];
    const h = await hero.GET(req(`http://x/api/images/route/${ark}`), { params: Promise.resolve({ routeId: ark }) });
    expect(h.status).toBe(302);
    expect(h.headers.get('location')).toBe(`https://s3.twcstorage.ru/vedar-test/${KEY}`);
    expect(h.headers.get('x-source')).toBe('s3-key');
    const g = await gallery.GET(req(`http://x/api/images/place-gallery/${ark}/1`), { params: Promise.resolve({ arkId: ark, position: '1' }) });
    expect(g.status).toBe(302);
    expect(g.headers.get('location')).toBe(`https://s3.twcstorage.ru/vedar-test/${KEY}`);
  });

  it('адрес s3_url старше ключа; байты — только когда нет ни того, ни другого', async () => {
    const { hero, gallery } = await routes();
    rows = [{ image_data: Buffer.from('x'), mime_type: 'image/jpeg', s3_url: 'https://s3.twcstorage.ru/vedar-test/places/old.jpg', s3_key: KEY, thumb_url: null }];
    const h = await hero.GET(req(`http://x/api/images/route/${ark}`), { params: Promise.resolve({ routeId: ark }) });
    expect(h.headers.get('location')).toBe('https://s3.twcstorage.ru/vedar-test/places/old.jpg');
    rows = [{ image_data: Buffer.from('jpegbytes'), mime_type: 'image/jpeg', s3_url: null, s3_key: null }];
    const g = await gallery.GET(req(`http://x/api/images/place-gallery/${ark}/1`), { params: Promise.resolve({ arkId: ark, position: '1' }) });
    expect(g.status).toBe(200);
    expect(g.headers.get('x-source')).toBe('stored');
  });
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
