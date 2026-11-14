/**
 * Точка кадра снимка, который оператор загрузил сам (14.11, слово владельца
 * «1 да»).
 *
 * Станок `npm run images` считает точку снимкам в хранилище, а фото тура,
 * загруженное через сайт, он не видит: в плитке 16:10 вертикальный пейзаж
 * показывал одно небо. Теперь точку считает сама загрузка тем же правилом и
 * пишет в имя файла (`tour_<hash>.fy55.jpg`), а витрины её читают.
 *
 * Сторож судит поведение: снимки собирает настоящий sharp, оба роута
 * вызываются целиком, проверяется ключ, ушедший в хранилище, и точка, которую
 * витрина прочитает по выданному адресу.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const s3 = vi.hoisted(() => ({
  upload: vi.fn(async (key: string, _body: Buffer, _type: string) => ({ url: `https://s3.twcstorage.ru/bucket/${key}`, key })),
}));
vi.mock('@/lib/storage/s3', () => ({ isS3Configured: true, uploadToS3: s3.upload, deleteFromS3: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/middleware', () => {
  const who = vi.fn(async () => ({ userId: 'u-1', role: 'operator' }));
  return { requireRole: who, requireOperator: who, requireAuth: who, requireAdmin: who };
});

import { uploadFocusY, focusMark, uploadFocusMark } from '@/lib/images/upload-focus';
import { preparePhoto } from '@/lib/images/upload-photo';
import { photoFocusY, focusFromMark, photoFocusKey, PHOTO_FOCUS_Y, AUTO_PHOTO_FOCUS_Y } from '@/lib/tours/photo-focus';
import { photoFocusFor } from '../../scripts/photo-focus.mjs';
import { POST as tourPhoto } from '@/app/api/upload/tour-photo/route';
import { POST as operatorUpload } from '@/app/api/hub/operator/upload/route';

/** Портрет: ровное небо в верхней доле `skyShare`, ниже — пёстрые детали. */
async function skyPortrait(w = 960, h = 1280, skyShare = 0.45): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  const skyRows = Math.round(h * skyShare);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (y < skyRows) { raw[i] = 120; raw[i + 1] = 170; raw[i + 2] = 230; continue; }
      const v = ((Math.floor(x / 16) * 37 + Math.floor(y / 16) * 61) % 7) * 36;
      raw[i] = v; raw[i + 1] = 255 - v; raw[i + 2] = (v * 3) % 255;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** Ровная заливка: деталей нет нигде. */
const flat = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();

const formReq = (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return { formData: async () => fd } as unknown as NextRequest;
};
const fileOf = (buf: Buffer, name: string) => new File([new Uint8Array(buf)], name, { type: 'image/jpeg' });

beforeEach(() => { s3.upload.mockClear(); });

describe('точка кадра при загрузке', () => {
  it('вертикальный пейзаж с небом наверху получает точку ниже верха — ту же, что дал бы станок', async () => {
    const prepared = await preparePhoto(await skyPortrait());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const f = await uploadFocusY(prepared.buf);
    expect(f).toEqual({ ok: true, y: expect.any(Number) });
    if (!f.ok || f.y == null) return;
    expect(f.y).toBeGreaterThan(0);
    expect(f.y % 5).toBe(0);

    // Правило одно: станок на том же файле даёт ту же точку.
    const dir = mkdtempSync(join(tmpdir(), 'focus-'));
    try {
      const file = join(dir, 'p.jpg');
      writeFileSync(file, prepared.buf);
      expect(await photoFocusFor(file)).toBe(f.y);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('снимок без неба, ровная заливка и горизонтальный кадр точки не получают', async () => {
    for (const [name, buf] of [
      ['без неба', await skyPortrait(960, 1280, 0)],
      ['заливка', await flat(960, 1280)],
      ['горизонт', await skyPortrait(1280, 960)],
    ] as const) {
      const f = await uploadFocusY(buf);
      expect(f, name).toEqual({ ok: true, y: null });
      expect(await uploadFocusMark(buf, 'test'), name).toBe('');
    }
  });

  it('не смог посчитать — третий исход с причиной; пометки нет, причина в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = Buffer.from('не снимок');
    const f = await uploadFocusY(bad);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.reason.length).toBeGreaterThan(0);
    expect(await uploadFocusMark(bad, 'hub/operator/upload')).toBe('');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[hub/operator/upload] точка кадра не посчитана'), expect.any(String));
    err.mockRestore();
  });

  it('пометка: шаг из правила, ноль и пустота — без пометки', () => {
    expect(focusMark(55)).toBe('.fy55');
    expect(focusMark(100)).toBe('.fy100');
    expect(focusMark(0)).toBe('');
    expect(focusMark(null)).toBe('');
    expect(focusMark(Number.NaN)).toBe('');
  });
});

describe('витрина читает пометку из имени', () => {
  it('адреса хранилища и раздачи', () => {
    expect(photoFocusY('https://s3.twcstorage.ru/bucket/images/tours/tour_0123456789ab.fy55.jpg')).toBe(55);
    expect(photoFocusY('https://s3.twcstorage.ru/bucket/tours/u-1/1731600000000.fy40.jpg')).toBe(40);
    expect(photoFocusY('/images/tours/tour_0123456789ab.fy70.jpg')).toBe(70);
    expect(photoFocusY('https://s3.twcstorage.ru/bucket/images/tours/tour_0123456789ab.jpg')).toBeNull();
  });

  it('пометка вне 1..100 или не число — не точка', () => {
    for (const key of ['a.fy0', 'a.fy101', 'a.fyx', 'a.fy', 'a.fy5.b']) expect(focusFromMark(key), key).toBeNull();
  });

  it('ручная и посчитанная станком точки по-прежнему читаются; ключ с пометкой режет нарезку', () => {
    const [manualKey, manualY] = Object.entries(PHOTO_FOCUS_Y)[0]!;
    expect(photoFocusY(`/api/images/s3/photos/${manualKey}.jpg`)).toBe(manualY);
    const autoEntry = Object.entries(AUTO_PHOTO_FOCUS_Y)[0];
    if (autoEntry) expect(photoFocusY(`/api/images/s3/photos/${autoEntry[0]}.jpg`)).toBe(autoEntry[1]);
    expect(photoFocusKey('/x/tour_1.fy55.640.webp')).toBe('x/tour_1.fy55');
  });
});

describe('роуты загрузки пишут точку в имя', () => {
  it('фото тура (кабинеты гида и оператора, админка): tour_<hash>.fyN.jpg, витрина читает N', async () => {
    const res = await tourPhoto(formReq(fileOf(await skyPortrait(), 'IMG_1.jpg')));
    expect(res.status).toBe(200);
    const [key] = s3.upload.mock.calls[0]!;
    expect(key).toMatch(/^images\/tours\/tour_[0-9a-f]{12}\.fy\d{1,3}\.jpg$/);
    const { url } = await res.json() as { url: string };
    const y = photoFocusY(url);
    expect(y).not.toBeNull();
    expect(key).toContain(`.fy${y}.jpg`);
  });

  it('фото тура из формы оператора: <время>.fyN.jpg; снимок без неба — без пометки', async () => {
    const res = await operatorUpload(formReq(fileOf(await skyPortrait(), 'tour.jpg')));
    expect(res.status).toBe(200);
    const { url } = await res.json() as { url: string };
    expect(url).toMatch(/\/tours\/u-1\/\d+\.fy\d{1,3}\.jpg$/);
    expect(photoFocusY(url)).toBeGreaterThan(0);

    s3.upload.mockClear();
    const plain = await operatorUpload(formReq(fileOf(await skyPortrait(960, 1280, 0), 'tour.jpg')));
    const { url: plainUrl } = await plain.json() as { url: string };
    expect(plainUrl).toMatch(/\/tours\/u-1\/\d+\.jpg$/);
    expect(photoFocusY(plainUrl)).toBeNull();
  });
});
