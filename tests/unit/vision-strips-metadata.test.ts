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

/** Голый JPEG: SOI, таблица, скан с данными и конец кадра. */
function bareJpeg(data: number[] = [0xab, 0xcd, 0xef]): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, ...data, 0xff, 0xd9]),
  ]);
}

function gifWithXmp(): Buffer {
  const sub = (b: Buffer) => Buffer.concat([Buffer.from([b.length]), b]);
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), // 1×1, глобальная палитра на 2 цвета
    Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xff]), sub(Buffer.from('NETSCAPE2.0', 'latin1')), sub(Buffer.from([1, 0, 0])), Buffer.from([0]),
    Buffer.from([0x21, 0xff]), sub(Buffer.from('XMP DataXMP', 'latin1')), sub(Buffer.from(`<x:xmpmeta>${GPS}</x:xmpmeta>`, 'latin1')), Buffer.from([0]),
    Buffer.from([0x21, 0xfe]), sub(Buffer.from(`снято в ${GPS}`, 'utf8')), Buffer.from([0]),
    Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
    Buffer.from(`хвост ${GPS}`, 'utf8'),
  ]);
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

// Ревью безопасности PR #3840: хвост за концом кадра и форматы, которые шли
// как есть, несли координаты мимо очистки.
describe('очистка снимка: то, что идёт мимо заголовка', () => {
  it('JPEG: EXIF, приписанный после конца кадра, отброшен; файл кончается FF D9', () => {
    const tail = jpegSegment(0xe1, Buffer.from(`Exif\0\0${GPS}`, 'latin1'));
    const r = stripImageMetadata(Buffer.concat([bareJpeg(), tail]).toString('base64'));
    expect(r).toMatchObject({ ok: true, format: 'jpeg', removed: 1 });
    if (!r.ok) return;
    const out = decoded(r.base64);
    expect(out.toString('latin1')).not.toContain('GPSLatitude');
    expect(out.equals(bareJpeg())).toBe(true);
  });

  it('JPEG: второй кадр со своим EXIF (MPO, «живое фото») отброшен', () => {
    const second = Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xe1, Buffer.from(`Exif\0\0${GPS}`, 'latin1')), bareJpeg().subarray(2)]);
    const r = stripImageMetadata(Buffer.concat([bareJpeg(), second]).toString('base64'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(decoded(r.base64).toString('latin1')).not.toContain('GPSLatitude');
  });

  it('JPEG прогрессивный: FF 00 и перезапуски внутри данных, второй скан и таблица между сканами — на месте; APP1 между сканами снят', () => {
    const scan1 = [0x11, 0xff, 0x00, 0x22, 0xff, 0xd3, 0x33, 0xff, 0xff, 0xd4, 0x44];
    const img = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xdb, Buffer.alloc(65, 1)),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, ...scan1]),
      jpegSegment(0xc4, Buffer.alloc(20, 7)),
      jpegSegment(0xe1, Buffer.from(`Exif\0\0${GPS}`, 'latin1')),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 6, 5, 4, 3, 2, 1, 0x55, 0x66, 0xff, 0xd9]),
    ]);
    const r = stripImageMetadata(img.toString('base64'));
    expect(r).toMatchObject({ ok: true, removed: 1 });
    if (!r.ok) return;
    const out = decoded(r.base64);
    expect(out.toString('latin1')).not.toContain('GPSLatitude');
    expect(out.includes(Buffer.from(scan1))).toBe(true);
    expect(out.includes(jpegSegment(0xc4, Buffer.alloc(20, 7)))).toBe(true);
    expect(out.subarray(-4).equals(Buffer.from([0x55, 0x66, 0xff, 0xd9]))).toBe(true);
  });

  it('JPEG: незнакомые APPn и JFXX сняты, JFIF остался; без конца кадра — отказ', () => {
    const img = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01', 'latin1')),
      jpegSegment(0xe0, Buffer.from(`JFXX\0${GPS}`, 'latin1')),
      jpegSegment(0xe3, Buffer.from(`Meta\0${GPS}`, 'latin1')),
      jpegSegment(0xec, Buffer.from(`Ducky${GPS}`, 'latin1')),
      bareJpeg().subarray(2),
    ]);
    const r = stripImageMetadata(img.toString('base64'));
    expect(r).toMatchObject({ ok: true, removed: 3 });
    if (r.ok) {
      expect(decoded(r.base64).toString('latin1')).not.toContain('GPSLatitude');
      expect(decoded(r.base64).toString('latin1')).toContain('JFIF');
    }
    expect(stripImageMetadata(bareJpeg().subarray(0, -2).toString('base64')).ok).toBe(false);
    // Оборван после заголовка: ни данных изображения, ни конца кадра.
    const headerOnly = Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xdb, Buffer.alloc(65, 1))]);
    expect(stripImageMetadata(headerOnly.toString('base64')).ok).toBe(false);
  });

  it('GIF: XMP и комментарий сняты, повтор анимации, управление кадром и кадр — на месте, хвост за концом отброшен', () => {
    const r = stripImageMetadata(gifWithXmp().toString('base64'));
    expect(r).toMatchObject({ ok: true, format: 'gif', removed: 3 });
    if (!r.ok) return;
    const out = decoded(r.base64);
    expect(out.toString('latin1')).not.toContain('GPSLatitude');
    expect(out.toString('latin1')).toContain('NETSCAPE2.0');
    expect(out.includes(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]))).toBe(true);
    expect(out.subarray(-6).equals(Buffer.from([2, 2, 0x44, 0x01, 0, 0x3b]))).toBe(true);
  });

  it('GIF без конца файла — отказ', () => {
    expect(stripImageMetadata(gifWithXmp().subarray(0, 40).toString('base64')).ok).toBe(false);
  });

  it('PNG и WebP: незнакомый блок снят, хвост за IEND отброшен', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.alloc(13, 1)),
      pngChunk('caBX', Buffer.from(GPS, 'latin1')),
      pngChunk('IDAT', Buffer.from('ДАННЫЕ', 'utf8')),
      pngChunk('IEND', Buffer.alloc(0)),
      Buffer.from(`хвост ${GPS}`, 'latin1'),
    ]);
    const p = stripImageMetadata(png.toString('base64'));
    expect(p).toMatchObject({ ok: true, removed: 1 });
    if (p.ok) expect(decoded(p.base64).toString('latin1')).not.toContain('GPSLatitude');

    const body = Buffer.concat([webpChunk('VP8 ', Buffer.from('ДАННЫЕ', 'utf8')), webpChunk('c2pa', Buffer.from(GPS, 'latin1'))]);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1');
    const w = stripImageMetadata(Buffer.concat([head, body]).toString('base64'));
    expect(w).toMatchObject({ ok: true, removed: 1 });
    if (w.ok) expect(decoded(w.base64).toString('latin1')).not.toContain('GPSLatitude');
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

// Настоящие кодировщики, а не собранные руками байты: очищенный снимок
// декодируется в те же пиксели, что исходный, а EXIF с GPS из него ушёл.
describe('очистка снимка: настоящие файлы из sharp', () => {
  async function source() {
    const sharp = (await import('sharp')).default;
    const raw = Buffer.alloc(48 * 32 * 3);
    for (let k = 0; k < raw.length; k++) raw[k] = (k * 37) % 251;
    return { sharp, base: sharp(raw, { raw: { width: 48, height: 32, channels: 3 } }) };
  }
  const exif = { IFD0: { ImageDescription: GPS, Copyright: GPS } };

  for (const kind of ['jpeg', 'jpeg-progressive', 'png', 'webp', 'gif'] as const) {
    it(`${kind}: пиксели те же, метаданных нет`, async () => {
      const { sharp, base } = await source();
      let pipe = base.clone().withExif(exif);
      if (kind === 'jpeg') pipe = pipe.jpeg({ quality: 90 });
      if (kind === 'jpeg-progressive') pipe = pipe.jpeg({ quality: 90, progressive: true, optimiseScans: true });
      if (kind === 'png') pipe = pipe.png();
      if (kind === 'webp') pipe = pipe.webp({ lossless: true });
      if (kind === 'gif') pipe = pipe.gif();
      const file = await pipe.toBuffer();
      // GIF у sharp EXIF не пишет — его метаданные проверены сборкой выше.
      if (kind !== 'gif') expect(file.toString('latin1'), `${kind}: в исходнике нет EXIF`).toContain('GPSLatitude');
      const r = stripImageMetadata(file.toString('base64'));
      expect(r.ok, kind).toBe(true);
      if (!r.ok) return;
      const out = decoded(r.base64);
      expect(out.toString('latin1')).not.toContain('GPSLatitude');
      const [a, b] = await Promise.all([sharp(file).raw().toBuffer(), sharp(out).raw().toBuffer()]);
      expect(b.equals(a), `${kind}: пиксели разошлись`).toBe(true);
      const meta = await sharp(out).metadata();
      expect(meta.exif, `${kind}: EXIF остался`).toBeUndefined();
    });
  }
});
