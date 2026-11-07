/**
 * Загруженный снимок перед хранилищем: уменьшен до размера сайта, развёрнут
 * по EXIF, без метаданных (владелец 07.11: «Да, делай», «адаптируй загрузку
 * фото»).
 *
 * Гид спросил, подрезаются ли фото до размера сайта. Не подрезались: файл
 * писался как есть — с местом съёмки внутри. Так же — фото к отзывам
 * туристов, фото жилья, фото тура из формы оператора, обложка партнёра.
 * Сторож судит поведение: снимки собирает настоящий sharp, каждый роут
 * вызывается целиком, проверяются байты, которые ушли бы в хранилище.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import type { NextRequest } from 'next/server';

const s3 = vi.hoisted(() => ({
  upload: vi.fn(async (key: string, _body: Buffer, _type: string) => ({ url: `https://s3.twcstorage.ru/bucket/${key}`, key })),
}));
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/storage/s3', () => ({ isS3Configured: true, uploadToS3: s3.upload, deleteFromS3: vi.fn(async () => undefined) }));
vi.mock('@/lib/database', () => ({ query: db.query }));
vi.mock('@/lib/auth/middleware', () => {
  const who = vi.fn(async () => ({ userId: 'u-1', role: 'operator' }));
  return { requireRole: who, requireOperator: who, requireAuth: who, requireAdmin: who };
});

import { preparePhoto, prepareLogo, rasterKind, PHOTO_MAX_SIDE, LOGO_MAX_SIDE } from '@/lib/images/upload-photo';
import { POST as tourPhoto } from '@/app/api/upload/tour-photo/route';
import { POST as operatorUpload } from '@/app/api/hub/operator/upload/route';
import { POST as reviewPhoto } from '@/app/api/reviews/photo/route';
import { POST as stayUpload } from '@/app/api/upload/route';
import { POST as partnerUpload } from '@/app/api/admin/content/partners/[id]/upload/route';

/** Метка в EXIF, которой в результате быть не должно. */
const MARK = 'probe-home-spot';

async function photo(width: number, height: number, orientation?: number): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  return img.withExif({ IFD0: { ImageDescription: MARK, Make: 'ProbePhone' } }).toBuffer();
}

const formReq = (fields: Record<string, File | string | File[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return { formData: async () => fd } as unknown as NextRequest;
};
const fileOf = (buf: Buffer, name: string, type: string) => new File([new Uint8Array(buf)], name, { type });
const HEIC = () => new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'IMG_0001.HEIC', { type: 'image/heic' });

/** То, что ушло в хранилище последним вызовом: снимок без EXIF и не больше предела. */
async function lastStored(maxSide = PHOTO_MAX_SIDE) {
  expect(s3.upload).toHaveBeenCalledTimes(1);
  const [key, body, type] = s3.upload.mock.calls[0]!;
  const meta = await sharp(body).metadata();
  expect(meta.exif, key).toBeUndefined();
  expect(body.includes(Buffer.from(MARK)), key).toBe(false);
  expect(Math.max(meta.width ?? 0, meta.height ?? 0), key).toBeLessThanOrEqual(maxSide);
  return { key, body, type, meta };
}

beforeEach(() => {
  s3.upload.mockClear();
  db.query.mockReset();
  db.query.mockImplementation(async (sql: string) => {
    if (/FROM operator_bookings/.test(sql)) return { rows: [{ id: 1 }] };
    if (/SELECT hero_image, logo_image FROM partners/.test(sql)) return { rows: [{ hero_image: null, logo_image: null }] };
    return { rows: [], rowCount: 1 };
  });
});

describe('preparePhoto', () => {
  it('большой снимок с телефона — длинная сторона 2048, EXIF и метка места не остаются', async () => {
    const input = await photo(4000, 3000);
    expect((await sharp(input).metadata()).exif, 'в исходнике EXIF есть').toBeTruthy();
    expect(input.includes(Buffer.from(MARK))).toBe(true);

    const r = await preparePhoto(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.width, r.height]).toEqual([PHOTO_MAX_SIDE, 1536]);
    expect([r.mime, r.ext]).toEqual(['image/jpeg', 'jpg']);
    const after = await sharp(r.buf).metadata();
    expect(after.format).toBe('jpeg');
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(r.buf.includes(Buffer.from(MARK))).toBe(false);
    expect(r.buf.length).toBeLessThan(input.length);
  });

  it('портрет с меткой поворота встаёт стоя, и метки поворота в файле нет', async () => {
    // 400×200 с orientation 6 — телефон держали вертикально.
    const r = await preparePhoto(await photo(400, 200, 6));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.width, r.height]).toEqual([200, 400]);
    expect((await sharp(r.buf).metadata()).orientation).toBeUndefined();
  });

  it('маленький снимок не увеличивается, кадр не обрезается', async () => {
    const r = await preparePhoto(await photo(800, 600));
    expect(r.ok && [r.width, r.height]).toEqual([800, 600]);
  });

  it('прозрачный PNG — JPEG на белом фоне', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const r = await preparePhoto(png);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { data } = await sharp(r.buf).raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(data[0]!, data[1]!, data[2]!)).toBeGreaterThan(245);
  });

  it('не снимок — отказ с причиной, а не пустой «успех»', async () => {
    const r = await preparePhoto(Buffer.from('not an image at all'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('до разбора доходят только растровые снимки', () => {
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');

  it('JPEG, PNG, WebP, GIF, HEIF узнаются по байтам; SVG, TIFF и текст — нет', async () => {
    const gen = (fmt: 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff') =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).toFormat(fmt).toBuffer();
    expect(rasterKind(await gen('jpeg'))).toBe('jpeg');
    expect(rasterKind(await gen('png'))).toBe('png');
    expect(rasterKind(await gen('webp'))).toBe('webp');
    expect(rasterKind(await gen('gif'))).toBe('gif');
    expect(rasterKind(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBe('heif');
    expect(rasterKind(await gen('tiff'))).toBeNull();
    expect(rasterKind(SVG)).toBeNull();
    expect(rasterKind(Buffer.from('hello'))).toBeNull();
  });

  it('SVG и TIFF не разбираются ни как снимок, ни как логотип', async () => {
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).tiff().toBuffer();
    for (const input of [SVG, tiff]) {
      for (const r of [await preparePhoto(input), await prepareLogo(input)]) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/не растровый снимок/);
      }
    }
  });

  it('SVG под именем .jpg и типом image/jpeg — отказ на роуте, в хранилище ничего', async () => {
    const res = await tourPhoto(formReq({ file: fileOf(SVG, 'photo.jpg', 'image/jpeg') }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/Не удалось прочитать снимок/);
    expect(s3.upload).not.toHaveBeenCalled();
  });
});

describe('prepareLogo', () => {
  it('логотип — PNG до 1024 с прозрачностью, без метаданных', async () => {
    const logo = await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 200, g: 50, b: 10, alpha: 0.5 } } })
      .png().withExif({ IFD0: { ImageDescription: MARK } }).toBuffer();
    const r = await prepareLogo(logo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.width, r.height, r.mime, r.ext]).toEqual([LOGO_MAX_SIDE, 341, 'image/png', 'png']);
    const meta = await sharp(r.buf).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    expect(meta.exif).toBeUndefined();
    expect(r.buf.includes(Buffer.from(MARK))).toBe(false);
  });
});

describe('роуты загрузки пишут только подготовленный снимок', () => {
  it('фото тура (кабинеты гида и оператора, админка): .jpg, image/jpeg, без EXIF, до 2048', async () => {
    const res = await tourPhoto(formReq({ file: fileOf(await photo(3000, 4000), 'IMG_1234.PNG', 'image/png') }));
    expect(res.status).toBe(200);
    const { key, body, type, meta } = await lastStored();
    expect(key).toMatch(/^images\/tours\/tour_[0-9a-f]{12}\.jpg$/);
    expect(type).toBe('image/jpeg');
    expect([meta.width, meta.height]).toEqual([1536, PHOTO_MAX_SIDE]);
    const json = await res.json() as { ok: boolean; url: string; sizeKb: number };
    expect(json.ok).toBe(true);
    expect(json.url).toBe(`https://s3.twcstorage.ru/bucket/${key}`);
    expect(json.sizeKb).toBe(Math.round(body.length / 1024));
  });

  it('фото тура из формы оператора: снимок 6 МБ больше не отказ, в хранилище — подготовленный JPEG', async () => {
    // Снимок тяжелее прежних 5 МБ: шум не сжимается, как и настоящая съёмка.
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .jpeg({ quality: 100 }).withExif({ IFD0: { ImageDescription: MARK } }).toBuffer();
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    const res = await operatorUpload(formReq({ file: fileOf(big, 'tour.jpg', 'image/jpeg') }));
    expect(res.status).toBe(200);
    const { key, type } = await lastStored();
    expect(key).toMatch(/^tours\/u-1\/\d+\.jpg$/);
    expect(type).toBe('image/jpeg');
  });

  it('фото к отзыву туриста: место съёмки не уходит в публичный файл', async () => {
    const res = await reviewPhoto(formReq({ file: fileOf(await photo(4000, 3000), 'review.jpg', 'image/jpeg'), tour_id: '7' }));
    expect(res.status).toBe(200);
    const { key, type } = await lastStored();
    expect(key).toMatch(/^reviews\/[0-9a-f]{16}\.jpg$/);
    expect(type).toBe('image/jpeg');
  });

  it('фото жилья: каждый файл подготовлен, тип из подготовки', async () => {
    const res = await stayUpload(formReq({ files: [fileOf(await photo(4000, 3000), 'room.jpg', 'image/jpeg')] }));
    expect(res.status).toBe(200);
    const { key, type } = await lastStored();
    expect(key).toMatch(/^uploads\/\d+-[0-9a-f]{16}\.jpg$/);
    expect(type).toBe('image/jpeg');
  });

  it('обложка партнёра — снимок JPEG; логотип — PNG до 1024, оба без EXIF', async () => {
    const params = { params: Promise.resolve({ id: 'p-1' }) };
    const hero = await partnerUpload(formReq({ file: fileOf(await photo(4000, 3000), 'hero.jpg', 'image/jpeg'), type: 'hero' }), params);
    expect(hero.status).toBe(200);
    const h = await lastStored();
    expect(h.key).toMatch(/^partners\/p-1\/hero-\d+\.jpg$/);
    expect(h.type).toBe('image/jpeg');

    s3.upload.mockClear();
    const logoPng = await sharp({ create: { width: 2000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().withExif({ IFD0: { ImageDescription: MARK } }).toBuffer();
    const logo = await partnerUpload(formReq({ file: fileOf(logoPng, 'logo.png', 'image/png'), type: 'logo' }), params);
    expect(logo.status).toBe(200);
    const l = await lastStored(LOGO_MAX_SIDE);
    expect(l.key).toMatch(/^partners\/p-1\/logo-\d+\.png$/);
    expect(l.type).toBe('image/png');
    expect(l.meta.hasAlpha).toBe(true);
  });

  it('HEIC, который не разобрался, — отказ словами и совет на каждом роуте, в хранилище ничего', async () => {
    const answers = [
      await tourPhoto(formReq({ file: HEIC() })),
      await reviewPhoto(formReq({ file: HEIC(), tour_id: '7' })),
      await partnerUpload(formReq({ file: new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: 'image/jpeg' }), type: 'hero' }),
        { params: Promise.resolve({ id: 'p-1' }) }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toMatch(/HEIC/);
      expect(json.error).toMatch(/«Наиболее совместимый»/);
    }
    expect(s3.upload).not.toHaveBeenCalled();
  });

  it('битый файл — отказ «не удалось прочитать», исходник не пишется', async () => {
    const broken = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'x.jpg', { type: 'image/jpeg' });
    const answers = [
      await tourPhoto(formReq({ file: broken() })),
      await operatorUpload(formReq({ file: broken() })),
      await stayUpload(formReq({ files: [broken()] })),
    ];
    for (const res of answers) {
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/Не удалось прочитать снимок/);
    }
    expect(s3.upload).not.toHaveBeenCalled();
  });
});
