/**
 * Веб-копия героя из снимка туриста (аудит vedarai.ru 01.10).
 *
 * Перенос в герои ставил ссылкой оригинал загрузки — 3000x4000, 6,1 МБ на
 * главной. Сторож держит три вещи:
 *   1. копия по канону платформы и БЕЗ обрезки: портрет покрывает 1280x720,
 *      а не вписывается внутрь в 540 пикселей ширины;
 *   2. перенос пишет копию в s3_url, а оригинал — в source_url;
 *   3. починка уже перенесённых не трогает изменившуюся строку и называет
 *      каждый отказ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeWebVariant, WEB_VARIANT } from '@/lib/images/web-variant';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Тяжёлый «снимок»: шум не жмётся, как и настоящая фотография. */
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let x = 12345;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; raw[i] = x & 0xff; }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
}

describe('копия по канону, без обрезки', () => {
  it('портрет покрывает 1280x720: ширина 1280, кадр целиком, стало легче', async () => {
    const src = await noisyJpeg(1500, 2000);
    const v = await makeWebVariant(src);
    expect(v.status).toBe('made');
    if (v.status !== 'made') return;
    expect(v.width).toBe(WEB_VARIANT.width);
    expect(v.height).toBe(Math.round(2000 * (1280 / 1500)));
    expect(v.buf.length).toBeLessThan(src.length);
    const meta = await sharp(v.buf).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('маленький снимок не увеличивается', async () => {
    const src = await noisyJpeg(800, 600);
    const v = await makeWebVariant(src);
    if (v.status === 'made') {
      expect(v.width).toBeLessThanOrEqual(800);
      expect(v.height).toBeLessThanOrEqual(600);
    } else {
      expect(v.status).toBe('not_needed');
    }
  });

  it('не картинка — «не смог» с причиной, а не исключение', async () => {
    const v = await makeWebVariant(Buffer.from('это не jpeg'));
    expect(v.status).toBe('failed');
    if (v.status === 'failed') expect(v.reason.length).toBeGreaterThan(0);
  });

  it('EXIF-поворот — до уменьшения, качество и размер — канон платформы', () => {
    const src = code('lib/images/web-variant.ts');
    expect(src).toMatch(/\.rotate\(\)\s*\.resize\(size\.width, size\.height, \{ fit: 'outside', withoutEnlargement: true \}\)/);
    // Размер по умолчанию — канон героя; копия для карточки задаёт свой.
    expect(src).toMatch(/makeWebVariant\(input: Buffer, size: VariantSize = WEB_VARIANT\)/);
    expect(WEB_VARIANT).toEqual({ width: 1280, height: 720, quality: 85 });
  });
});

/**
 * Копия для карточки (миграция 1138, аудит 01.10): главная грузила снимки
 * карточек оригиналами — 1,95 МБ из 2,6 на рамки в ~170 пикселей.
 */
describe('копия для карточки (scope thumb)', () => {
  const ROUTE = code('app/api/cron/hero-web-variant/route.ts');
  const SERVE = code('app/api/images/route/[routeId]/route.ts');

  it('480x360, ключ рядом с объектом снимка', async () => {
    const { THUMB_VARIANT } = await import('@/lib/images/web-variant');
    const { thumbVariantKey } = await import('@/lib/places/hero-variant');
    expect(THUMB_VARIANT).toEqual({ width: 480, height: 360, quality: 80 });
    expect(thumbVariantKey('ark', 'img')).toBe('places/ark/img-480.jpg');
  });

  it('пишет только thumb_url, оригинал не трогает; гонка — не тронуто', () => {
    expect(ROUTE).toMatch(/scope === 'thumb'/);
    expect(ROUTE).toMatch(/UPDATE ai_route_images SET thumb_url = \$1\s+WHERE id = \$2::uuid AND s3_url = \$3 AND thumb_url IS NULL/);
    expect(ROUTE).toMatch(/heroVariantFor\(r\.s3_url, thumbVariantKey\(r\.route_id, r\.id\), THUMB_VARIANT\)/);
  });

  it('«копия не нужна» записывает оригинал, иначе строка выбиралась бы вечно', () => {
    expect(ROUTE).toMatch(/const url = variant\.status === 'made' \? variant\.url : r\.s3_url;/);
    expect(ROUTE).toMatch(/i\.thumb_url IS NULL/);
  });

  it('раздача: ?size=card — копия; без копии оригинал с коротким кэшем', () => {
    expect(SERVE).toMatch(/searchParams\.get\('size'\) === 'card'/);
    expect(SERVE).toMatch(/if \(forCard && row\?\.thumb_url\)/);
    expect(SERVE).toMatch(/'Cache-Control': forCard \? CACHE_UNTIL_THUMB : CACHE_LONG/);
  });

  it('карточки просят копию', () => {
    const CARD = code('lib/routes/card-image.ts');
    expect(CARD.match(/\?size=card`/g)).toHaveLength(2);
  });

  it('актуатор знает задачу thumb', () => {
    const wf = code('.github/workflows/images-repack.yml');
    expect(wf).toMatch(/'oversize', 'thumb'\)/);
    expect(wf).toMatch(/EXTRA="\\"scope\\": \\"thumb\\","/);
  });
});

describe('перенос в герои пишет копию, оригинал остаётся источником', () => {
  const LIB = code('lib/places/user-photo-hero.ts');

  it('копия делается до записи и одной дорогой с починкой', () => {
    expect(LIB).toMatch(/heroVariantFor\(row\.url, heroVariantKey\(row\.ark_id, photoId\)\)/);
    const ROUTE = code('app/api/cron/hero-web-variant/route.ts');
    expect(ROUTE).toMatch(/scope === 'oversize' \? oversizeVariantKey\(r\.route_id, r\.id\) : heroVariantKey\(r\.route_id, r\.id\)/);
    expect(ROUTE).toMatch(/heroVariantFor\(r\.s3_url, key\)/);
  });

  it('s3_url — копия, source_url — оригинал', () => {
    expect(LIB).toMatch(/made\?\.url \?\? row\.url, `hero from user photo \$\{photoId\}`, author \?\? null, row\.url/);
    expect(LIB).toMatch(/VALUES \(\$1, \$2, \$6, NULL, 'image\/jpeg', \$3, 'manual-upload', \$4, NULL, NULL, \$5/);
  });

  it('копия не вышла — отказ виден в логе и в ответе', () => {
    expect(LIB).toMatch(/console\.error\('\[user-photo-hero\] веб-копия не сделана, герой — оригинал:'/);
    expect(LIB).toMatch(/variant: variant\.status === 'made'/);
  });
});

describe('починка перенесённых героев', () => {
  const poolQueryMock = vi.fn();
  const variantMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    poolQueryMock.mockReset();
    variantMock.mockReset();
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
    vi.doMock('@/lib/places/hero-variant', () => ({
      heroVariantFor: (...a: unknown[]) => variantMock(...a),
      heroVariantKey: (ark: string, id: string) => `place-heroes/${ark}/${id}-1280.jpg`,
      oversizeVariantKey: (ark: string, id: string) => `places/${ark}/${id}-1280.jpg`,
    }));
    process.env.CRON_SECRET = 'test-secret';
  });

  async function post(body: unknown) {
    const { POST } = await import('@/app/api/cron/hero-web-variant/route');
    const { NextRequest } = await import('next/server');
    return POST(new NextRequest('http://x/api/cron/hero-web-variant', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  const ROW = { id: '11111111-1111-1111-1111-111111111111', route_id: 'ark-1', s3_url: 'https://s3/places/x/orig.jpg', place_name: 'Дикие озерки' };

  it('кандидат — герой, чья ссылка равна оригиналу загрузки', () => {
    const src = code('app/api/cron/hero-web-variant/route.ts');
    expect(src).toMatch(/i\.image_data IS NULL\s+AND i\.s3_url IS NOT NULL\s+AND i\.s3_url = i\.source_url/);
  });

  it('по умолчанию — сухой прогон: план без записи', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('COUNT(*)') ? { rows: [{ pending: '1' }] } : { rows: [ROW] }));
    const res = await post({ reason: 'аудит 01.10: главная 8,7 МБ' });
    const json = await res.json();
    expect(json.dry_run).toBe(true);
    expect(json.would_resize).toHaveLength(1);
    expect(variantMock).not.toHaveBeenCalled();
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
  });

  it('боевой: копия записана с условием «строка не менялась»', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE')) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve(sql.includes('COUNT(*)') ? { rows: [{ pending: '1' }] } : { rows: [ROW] });
    });
    variantMock.mockResolvedValue({ status: 'made', url: 'https://s3/place-heroes/ark-1/v.jpg', key: 'place-heroes/ark-1/v.jpg', width: 1280, height: 1707, wasBytes: 6_100_000, nowBytes: 350_000 });
    const json = await (await post({ reason: 'аудит 01.10: главная 8,7 МБ', dry_run: false })).json();
    expect(json.recompressed_count).toBe(1);
    expect(json.pending_before).toBe(1);
    const upd = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE'))!;
    expect(String(upd[0])).toMatch(/WHERE id = \$5::uuid AND s3_url = \$6 AND image_data IS NULL/);
    expect(upd[1]).toEqual(['https://s3/place-heroes/ark-1/v.jpg', 'place-heroes/ark-1/v.jpg', 1280, 1707, ROW.id, ROW.s3_url]);
  });

  it('копия не вышла — строка не тронута, причина в отчёте', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('COUNT(*)') ? { rows: [{ pending: '1' }] } : { rows: [ROW] }));
    variantMock.mockResolvedValue({ status: 'failed', reason: 'оригинал ответил 404' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const json = await (await post({ reason: 'аудит 01.10: главная 8,7 МБ', dry_run: false })).json();
    expect(json.failed).toEqual([{ id: ROW.id, reason: 'оригинал ответил 404' }]);
    expect(json.recompressed_count).toBe(0);
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
    errSpy.mockRestore();
  });

  it('без причины — 400, без секрета — 401', async () => {
    expect((await post({ dry_run: false })).status).toBe(400);
    const { POST } = await import('@/app/api/cron/hero-web-variant/route');
    const { NextRequest } = await import('next/server');
    const res = await POST(new NextRequest('http://x', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
  });

  describe('scope oversize: тяжёлые объекты хранилища', () => {
    const HEAVY = { id: '22222222-2222-2222-2222-222222222222', route_id: 'ark-2', s3_url: 'https://s3/places/ark-2/heavy.jpg', s3_key: 'places/ark-2/heavy.jpg', place_name: 'Урочище' };
    const LIGHT = { id: '33333333-3333-3333-3333-333333333333', route_id: 'ark-3', s3_url: 'https://s3/places/ark-3/light.jpg', s3_key: 'places/ark-3/light.jpg', place_name: 'Озеро' };
    const DEAD  = { id: '44444444-4444-4444-4444-444444444444', route_id: 'ark-4', s3_url: 'https://s3/places/ark-4/dead.jpg', s3_key: 'places/ark-4/dead.jpg', place_name: 'Бухта' };
    const fetchMock = vi.fn();

    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockImplementation((url: string) => {
        if (url === HEAVY.s3_url) return Promise.resolve({ ok: true, headers: new Headers({ 'content-length': '681274' }) });
        if (url === LIGHT.s3_url) return Promise.resolve({ ok: true, headers: new Headers({ 'content-length': '230000' }) });
        return Promise.resolve({ ok: false, status: 503, headers: new Headers() });
      });
      vi.stubGlobal('fetch', fetchMock);
      poolQueryMock.mockImplementation((sql: string) => {
        if (String(sql).includes('UPDATE')) return Promise.resolve({ rowCount: 1 });
        return Promise.resolve({ rows: [HEAVY, LIGHT, DEAD] });
      });
    });

    it('кандидаты — показываемые снимки в хранилище, кроме героев из снимков туристов', () => {
      const src = code('app/api/cron/hero-web-variant/route.ts');
      expect(src).toMatch(/AND i\.s3_url IS DISTINCT FROM i\.source_url/);
      expect(src).toMatch(/NOT LIKE 'place-heroes\/%'/);
      expect(src).toMatch(/\$\{shownPhotoSql\('i\.model'\)\}/);
      expect(src).toMatch(/method: 'HEAD'/);
    });

    it('сухой: в плане только тяжёлый, не ответивший — в unchecked, а не «лёгкий»', async () => {
      const json = await (await post({ reason: 'аудит 01.10: снимки 0,5–0,7 МБ', scope: 'oversize' })).json();
      expect(json.scope).toBe('oversize');
      expect(json.pending).toBe(1);
      expect(json.would_resize).toEqual([{ id: HEAVY.id, subject: 'Урочище', source: HEAVY.s3_url, kb: 665 }]);
      expect(json.unchecked).toEqual([{ id: DEAD.id, reason: 'HEAD ответил 503' }]);
      expect(variantMock).not.toHaveBeenCalled();
    });

    it('боевой: копия рядом с прежним объектом, прежний ключ в отчёте', async () => {
      variantMock.mockResolvedValue({ status: 'made', url: 'https://s3/places/ark-2/v.jpg', key: `places/ark-2/${HEAVY.id}-1280.jpg`, width: 1280, height: 852, wasBytes: 681274, nowBytes: 260000 });
      const json = await (await post({ reason: 'аудит 01.10: снимки 0,5–0,7 МБ', scope: 'oversize', dry_run: false })).json();
      expect(variantMock).toHaveBeenCalledWith(HEAVY.s3_url, `places/ark-2/${HEAVY.id}-1280.jpg`);
      expect(json.recompressed_count).toBe(1);
      expect(json.resized[0].replaced_key).toBe(HEAVY.s3_key);
      const upd = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE'))!;
      expect(upd[1]).toEqual(['https://s3/places/ark-2/v.jpg', `places/ark-2/${HEAVY.id}-1280.jpg`, 1280, 852, HEAVY.id, HEAVY.s3_url]);
    });

    it('неизвестный scope — 400', async () => {
      expect((await post({ reason: 'аудит 01.10: снимки', scope: 'all' })).status).toBe(400);
    });
  });
});
