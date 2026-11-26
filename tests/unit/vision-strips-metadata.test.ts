/**
 * Снимок уходит в модель зрения без места съёмки (проверка безопасности
 * ИИ-части 26.11, слово владельца «чини Карт бланш»).
 *
 * Окно чата отправляло снимок до 3 МБ как есть, и сервер передавал его в
 * зарубежные модели вместе с EXIF: GPS снимка из похода — точное место
 * человека (152-ФЗ). Теперь метаданные снимает вход зрения
 * (callVisionDetailed → lib/images/strip-metadata) до любой ступени.
 *
 * Снимки здесь собраны по байтам: в каждом — блок с координатами и данные
 * изображения. Сторож — вызов очистки и вызов зрения с подменённой сетью:
 * что ушло в запрос к модели.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { stripImageMetadata } from '@/lib/images/strip-metadata';
import { callVisionDetailed } from '@/lib/ai/providers';

const GPS = 'GPSLatitude 53.2569 GPSLongitude 158.8366';

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** JPEG: JFIF, EXIF с GPS, XMP, IPTC, комментарий, таблица, данные изображения. */
function jpegWithGps(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    jpegSegment(0xe1, Buffer.from(`Exif\0\0${GPS}`, 'latin1')),
    jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS}</x:xmpmeta>`, 'latin1')),
    jpegSegment(0xed, Buffer.from(`Photoshop 3.0\0${GPS}`, 'latin1')),
    jpegSegment(0xfe, Buffer.from(`снято в ${GPS}`, 'utf8')),
    jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01профиль', 'utf8')),
    jpegSegment(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xab, 0xcd, 0xef, 0xff, 0xd9]),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function pngWithGps(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, 1)),
    pngChunk('eXIf', Buffer.from(GPS, 'latin1')),
    pngChunk('tEXt', Buffer.from(`Comment\0${GPS}`, 'latin1')),
    pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${GPS}`, 'latin1')),
    pngChunk('IDAT', Buffer.from('ДАННЫЕ-ИЗОБРАЖЕНИЯ', 'utf8')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1'); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webpWithGps(): Buffer {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF, XMP, альфа
  const body = Buffer.concat([
    webpChunk('VP8X', vp8x),
    webpChunk('VP8 ', Buffer.from('ДАННЫЕ-ИЗОБРАЖЕНИЯ', 'utf8')),
    webpChunk('EXIF', Buffer.from(GPS, 'latin1')),
    webpChunk('XMP ', Buffer.from(`<x:xmpmeta>${GPS}</x:xmpmeta>!`, 'latin1')),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

const decoded = (b64: string) => Buffer.from(b64, 'base64');

describe('очистка снимка', () => {
  it('JPEG: EXIF, XMP, IPTC и комментарий сняты; JFIF, профиль и данные изображения на месте', () => {
    const r = stripImageMetadata(jpegWithGps().toString('base64'));
    expect(r).toMatchObject({ ok: true, format: 'jpeg', removed: 4 });
    if (!r.ok) return;
    const out = decoded(r.base64);
    expect(out.toString('latin1')).not.toContain('GPSLatitude');
    expect(out.toString('latin1')).not.toContain('Exif');
    expect(out.toString('latin1')).toContain('JFIF');
    expect(out.toString('latin1')).toContain('ICC_PROFILE');
    // Данные изображения после SOS — байт в байт, до конца файла.
    expect(out.subarray(-15).equals(Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xab, 0xcd, 0xef, 0xff, 0xd9]))).toBe(true);
  });

  it('PNG: eXIf и текстовые блоки сняты, IHDR, IDAT и IEND на месте', () => {
    const r = stripImageMetadata(pngWithGps().toString('base64'));
    expect(r).toMatchObject({ ok: true, format: 'png', removed: 3 });
    if (!r.ok) return;
    const out = decoded(r.base64).toString('latin1');
    expect(out).not.toContain('GPSLatitude');
    for (const t of ['IHDR', 'IDAT', 'IEND']) expect(out).toContain(t);
  });

  it('WebP: блоки EXIF и XMP сняты, флаги о них погашены, размер RIFF сходится', () => {
    const r = stripImageMetadata(webpWithGps().toString('base64'));
    expect(r).toMatchObject({ ok: true, format: 'webp', removed: 2 });
    if (!r.ok) return;
    const out = decoded(r.base64);
    expect(out.toString('latin1')).not.toContain('GPSLatitude');
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    const flags = out[20];
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(flags & 0x10).toBe(0x10); // альфа осталась
  });

  it('HEIC и непонятный формат — отказ с причиной, а не снимок как есть', () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)]);
    const r = stripImageMetadata(heic.toString('base64'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/формат/);
  });

  it('битый JPEG — отказ, а не обрезанный снимок', () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00]), Buffer.alloc(8)]);
    expect(stripImageMetadata(broken.toString('base64')).ok).toBe(false);
  });
});

describe('вход зрения: в модель уходит очищенный снимок', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('в запросах к моделям нет координат; тип — по байтам, а не по слову клиента', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-test');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    vi.stubEnv('QWEN_API_KEY', 'qwen-test');
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return new Response('{}', { status: 500 });
    }));
    await callVisionDetailed(pngWithGps().toString('base64'), 'image/jpeg', 'что на снимке?');
    const images = bodies.flatMap((b) => [...b.matchAll(/(?:data:image\/[a-z]+;base64,|"data":")([A-Za-z0-9+/=]{40,})/g)].map((m) => m[1]));
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(decoded(img).toString('latin1')).not.toContain('GPSLatitude');
    expect(bodies.join('\n')).not.toContain('image/jpeg;base64');
  });

  it('снимок, который очистить нечем, в модель не уходит: сеть не зовётся, причина в следе', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)]);
    const r = await callVisionDetailed(heic.toString('base64'), 'image/heic', 'что на снимке?');
    expect(r.text).toBeNull();
    expect(r.legs[0]).toMatchObject({ provider: 'metadata_strip', outcome: 'refused' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
