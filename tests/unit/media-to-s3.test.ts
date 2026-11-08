/**
 * Заливщик media/s3/ → хранилище (scripts/media-to-s3.ts). Шапка скрипта
 * называла этого сторожа с 09.10, а файла не было: правила заливщика
 * проверялись кусками в тестах клипов и снимков мест.
 *
 * Здесь — что пропускает проверка строки маркера (08.11, переезд снимков
 * партнёров из public/images): под photos/ — снимки, логотипы и уменьшенные
 * копии, и ровно те ключи, которые открывает раздача /api/images/s3/; тип —
 * по байтам файла, а не по имени. Проверяется вызовом на настоящих файлах во
 * временной папке. И по самому репозиторию: файл media/s3 без строки маркера
 * в хранилище не попадёт, а тяжёлый снимок без копий 320/640 поедет на телефон
 * оригиналом.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkItem, sniffType, uploadAndVerify, MARKER, type UploadIo, type CheckedItem } from '@/scripts/media-to-s3';
import { photoKeyOf } from '@/lib/images/photo-key';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const HTML = Buffer.from('<html>\n<head><title>404 Not Found</title></head>\n</html>\n');

let root = '';
function put(rel: string, bytes: Buffer): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'media-to-s3-'));
  put('media/s3/photos/p/a.jpg', JPEG);
  put('media/s3/photos/p/b.jpeg', JPEG);
  put('media/s3/photos/p/logo.png', PNG);
  put('media/s3/photos/p/a.640.webp', WEBP);
  put('media/s3/photos/p/jpeg-inside.png', JPEG);
  put('media/s3/photos/p/portal.jpg', HTML);
  put('media/s3/photos/p/a.gif', Buffer.from('GIF89a'));
  put('media/s3/photos/P/a.jpg', JPEG);
  put('media/s3/videos/p/clip.mp4', MP4);
  put('media/s3/videos/p/clip.poster.jpg', JPEG);
  put('media/s3/videos/p/jpeg-inside.mp4', JPEG);
  put('media/s3/videos/p/a.640.webp', WEBP);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const check = (file: string) => checkItem({ file: `media/s3/${file}`, key: file }, root);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('тип — по байтам', () => {
  it('узнаёт JPEG, PNG, WebP и MP4; остальное — null', () => {
    expect(sniffType(JPEG)).toBe('image/jpeg');
    expect(sniffType(PNG)).toBe('image/png');
    expect(sniffType(WEBP)).toBe('image/webp');
    expect(sniffType(MP4)).toBe('video/mp4');
    expect(sniffType(HTML)).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
});

describe('под photos/ — снимки, логотипы, копии', () => {
  it('JPEG, PNG и уменьшенная копия WebP проходят, тип хранилищу — по байтам', () => {
    expect(check('photos/p/a.jpg')).toMatchObject({ contentType: 'image/jpeg', size: JPEG.length });
    expect(check('photos/p/b.jpeg')).toMatchObject({ contentType: 'image/jpeg' });
    expect(check('photos/p/logo.png')).toMatchObject({ contentType: 'image/png' });
    expect(check('photos/p/a.640.webp')).toMatchObject({ contentType: 'image/webp' });
    // JPEG под именем .png (два таких у «Рыбалки на Камчатке») хранилище назовёт JPEG.
    expect(check('photos/p/jpeg-inside.png')).toMatchObject({ contentType: 'image/jpeg' });
  });

  it('внутри не снимок — отказ: страница «404», сохранённая как .jpg, не заливается', () => {
    expect(check('photos/p/portal.jpg')).toMatch(/внутри не снимок/);
  });

  it('чужое расширение и ключ, который раздача не откроет, — отказ', () => {
    expect(check('photos/p/a.gif')).toMatch(/только снимки/);
    expect(check('photos/P/a.jpg')).toMatch(/латиница в нижнем регистре/);
    expect(checkItem({ file: 'media/s3/photos/p/a.jpg', key: 'photos/_a.jpg' }, root)).toMatch(/отдаёт \/api\/images\/s3/);
    expect(checkItem({ file: 'media/s3/videos/p/clip.mp4', key: 'photos/p/clip.mp4' }, root)).toMatch(/только снимки/);
  });

  it('что заливщик пропускает под photos/, раздача открывает', () => {
    for (const f of ['photos/p/a.jpg', 'photos/p/b.jpeg', 'photos/p/logo.png', 'photos/p/a.640.webp']) {
      expect(typeof check(f), f).toBe('object');
      expect(photoKeyOf(f.split('/')), f).toBe(f);
    }
  });
});

describe('под videos/ — клипы и обложки, и только они', () => {
  it('MP4 и обложка JPEG проходят', () => {
    expect(check('videos/p/clip.mp4')).toMatchObject({ contentType: 'video/mp4' });
    expect(check('videos/p/clip.poster.jpg')).toMatchObject({ contentType: 'image/jpeg' });
  });

  it('JPEG под именем .mp4 и копии WebP — отказ', () => {
    expect(check('videos/p/jpeg-inside.mp4')).toMatch(/внутри image\/jpeg, а ключ \.mp4/);
    expect(check('videos/p/a.640.webp')).toMatch(/расширение \.webp не принимается/);
  });
});

describe('заливка с чтением обратно: обрыв сети — вторая попытка, несовпадение — отказ', () => {
  const item = (): CheckedItem => ({ file: 'media/s3/photos/p/a.jpg', key: 'photos/p/a.jpg', contentType: 'image/jpeg', size: JPEG.length });
  function io(replies: Array<'throw' | Response>): UploadIo & { uploads: number; reads: number } {
    const state = { uploads: 0, reads: 0 };
    return Object.assign(state, {
      upload: async () => { state.uploads += 1; },
      fetch: async () => {
        const r = replies[state.reads++];
        if (r === 'throw' || r === undefined) throw new TypeError('fetch failed');
        return r;
      },
      sleep: async () => {},
      base: () => 'https://s3.example.test/bucket',
    });
  }
  const ok = () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });

  it('один обрыв при чтении обратно (прогон 22) — повтор, объект засчитан', async () => {
    const t = io(['throw', ok()]);
    const r = await uploadAndVerify(item(), root, t);
    expect(r).toEqual({ ok: true, line: `залит и прочитан обратно с попытки 2 (${JPEG.length} байт, image/jpeg)` });
    expect([t.uploads, t.reads]).toEqual([2, 2]);
  });

  it('хранилище ответило 5xx — тоже повтор', async () => {
    const t = io([new Response('oops', { status: 503 }), ok()]);
    expect((await uploadAndVerify(item(), root, t)).ok).toBe(true);
  });

  it('два обрыва подряд — отказ с причиной, попыток не больше двух', async () => {
    const t = io(['throw', 'throw', ok()]);
    expect(await uploadAndVerify(item(), root, t)).toEqual({ ok: false, line: 'НЕ ЗАЛИТО: photos/p/a.jpg: fetch failed' });
    expect(t.reads).toBe(2);
  });

  it('ответ 200 с чужим размером или типом — отказ сразу, без повтора: это не обрыв', async () => {
    const short = io([new Response(JPEG.subarray(0, 3), { status: 200, headers: { 'content-type': 'image/jpeg' } }), ok()]);
    expect((await uploadAndVerify(item(), root, short)).line).toMatch(/^НЕ СОШЛОСЬ: photos\/p\/a\.jpg: HTTP 200, 3 из/);
    expect(short.reads).toBe(1);
    const html = io([new Response(JPEG, { status: 200, headers: { 'content-type': 'text/html' } })]);
    expect((await uploadAndVerify(item(), root, html)).ok).toBe(false);
  });
});

describe('маркер заливки', () => {
  const marker = JSON.parse(readFileSync(join(process.cwd(), MARKER), 'utf-8')) as {
    items: Array<{ file: string; key: string }>;
  };

  it('каждая строка проходит проверку, ключи не повторяются', () => {
    const bad = marker.items
      .map((it) => ({ it, c: checkItem(it, process.cwd()) }))
      .filter(({ c }) => typeof c === 'string')
      .map(({ it, c }) => `${it.key}: ${String(c)}`);
    expect(bad).toEqual([]);
    expect(new Set(marker.items.map((i) => i.key)).size).toBe(marker.items.length);
  });

  it('каждый файл media/s3 стоит в маркере: иначе он лежит в репозитории, а в хранилище его нет', () => {
    const keys = new Set(marker.items.map((i) => i.key));
    const lost = filesUnder(join(process.cwd(), 'media/s3'))
      .map((f) => relative(join(process.cwd(), 'media/s3'), f).split('\\').join('/'))
      .filter((k) => !keys.has(k));
    expect(lost).toEqual([]);
  });

  it('у каждого тяжёлого снимка в media/s3/photos есть копии 320 и 640 (порог и ширины — scripts/optimize-images.mjs)', () => {
    const keys = new Set(marker.items.map((i) => i.key));
    const without: string[] = [];
    for (const abs of filesUnder(join(process.cwd(), 'media/s3/photos'))) {
      if (!/\.(jpe?g|png)$/i.test(abs) || statSync(abs).size < 50 * 1024) continue;
      const key = relative(join(process.cwd(), 'media/s3'), abs).split('\\').join('/');
      for (const w of [320, 640]) {
        const v = key.replace(/\.(jpe?g|png)$/i, `.${w}.webp`);
        if (!keys.has(v)) without.push(v);
      }
    }
    expect(without).toEqual([]);
  });

  it('каждый снимок маркера открывается раздачей /api/images/s3/', () => {
    const shut = marker.items.filter((i) => i.key.startsWith('photos/') && photoKeyOf(i.key.split('/')) === null);
    expect(shut.map((i) => i.key)).toEqual([]);
  });
});
