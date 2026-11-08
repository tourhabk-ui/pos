/**
 * /api/images/s3/<ключ> — снимок из хранилища по ключу (14.10).
 *
 * Статья летописи собирается при сборке образа, а адрес объекта зависит от
 * S3_BUCKET — поэтому страница ставит этот адрес. Открыто ровно то, что
 * публикуется: `photos/…` — `.jpg`, `.jpeg`, `.png`, `.webp` (с 08.11
 * снимки партнёров с уменьшенными копиями и логотипами).
 *
 * С 29.10 сервер отдаёт байты сам, а не редиректом на s3.twcstorage.ru:
 * владелец с телефона не увидел снимков «Лагуны Экспедиции», хотя сайт
 * открылся. Браузер туриста видит один домен — vedarai.ru.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { photoKeyOf, photoPath } from '@/lib/images/photo-key';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function get(parts: string[]) {
  const { GET } = await import('@/app/api/images/s3/[...key]/route');
  return GET(new Request('https://vedarai.ru/api/images/s3/x'), { params: Promise.resolve({ key: parts }) });
}

describe('какой ключ открывается', () => {
  it('снимки под photos/ — да', () => {
    expect(photoKeyOf(['photos', 'kronotsky', 'kronotskaya-v-shlyape.jpg'])).toBe('photos/kronotsky/kronotskaya-v-shlyape.jpg');
    expect(photoPath('photos/kronotsky/a.jpg')).toBe('/api/images/s3/photos/kronotsky/a.jpg');
  });

  it('с 08.11 — и уменьшенные копии WebP, и логотипы PNG, и .jpeg (снимки партнёров)', () => {
    expect(photoKeyOf(['photos', 'mestechko', 'tolbachik-01.640.webp'])).toBe('photos/mestechko/tolbachik-01.640.webp');
    expect(photoKeyOf(['photos', 'partners', 'topkam', 'logo.png'])).toBe('photos/partners/topkam/logo.png');
    expect(photoKeyOf(['photos', 'fishingkam', '_.jpeg'])).toBe('photos/fishingkam/_.jpeg');
  });

  it('чужие префиксы, не снимок и выход наверх — нет', () => {
    expect(photoKeyOf(['places', '7190e0a4-0000-4000-8000-000000000000', 'a.jpg'])).toBeNull();
    expect(photoKeyOf(['videos', 'fishingkam', 'clip-fish-catch.mp4'])).toBeNull();
    expect(photoKeyOf(['photos', 'kronotsky', 'a.gif'])).toBeNull();
    expect(photoKeyOf(['photos', 'kronotsky', 'a.mp4'])).toBeNull();
    expect(photoKeyOf(['photos', 'kronotsky', 'a.svg'])).toBeNull();
    expect(photoKeyOf(['photos', '..', 'maps', 'a.jpg'])).toBeNull();
    expect(photoKeyOf(['photos', 'Kronotsky', 'A.jpg'])).toBeNull();
  });
});

describe('ответ сервера: байты с нашего домена, не редирект', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const S3 = 'https://s3.twcstorage.ru/vedar-test/photos/kronotsky/kronotskaya-v-shlyape.jpg';
  const KEY = ['photos', 'kronotsky', 'kronotskaya-v-shlyape.jpg'];

  function stubStorage(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    vi.stubEnv('S3_BUCKET', 'vedar-test');
    vi.stubEnv('S3_ENDPOINT', 'https://s3.twcstorage.ru');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply(String(url), init);
    }));
    return calls;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('ключ под photos/ — 200 с байтами объекта, тип image/jpeg, кэш на сутки; Location нет', async () => {
    const calls = stubStorage(() => new Response(JPEG, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length), etag: '"abc"', 'last-modified': 'Wed, 29 Oct 2026 06:00:00 GMT' },
    }));
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([S3]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe(String(JPEG.length));
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=86400/);
  });

  it('повторный показ: условный запрос доходит до хранилища, 304 — без тела', async () => {
    const calls = stubStorage(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
    const { GET } = await import('@/app/api/images/s3/[...key]/route');
    const res = await GET(
      new Request('https://vedarai.ru/api/images/s3/x', { headers: { 'if-none-match': '"abc"' } }),
      { params: Promise.resolve({ key: KEY }) },
    );
    expect(res.status).toBe(304);
    expect(new Headers(calls[0].init?.headers).get('if-none-match')).toBe('"abc"');
  });

  it('хранилище ответило не картинкой — тип не пробрасывается, берётся по расширению ключа', async () => {
    stubStorage(() => new Response(JPEG, { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await get(KEY);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    vi.unstubAllGlobals();
    stubStorage(() => new Response(JPEG, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    expect((await get(['photos', 'mestechko', 'a.640.webp'])).headers.get('content-type')).toBe('image/webp');
    vi.unstubAllGlobals();
    stubStorage(() => new Response(JPEG, { status: 200 }));
    expect((await get(['photos', 'partners', 'logo.png'])).headers.get('content-type')).toBe('image/png');
  });

  it('svg и прочие типы хранилища на нашем домене не отдаются — только по расширению ключа', async () => {
    stubStorage(() => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    expect((await get(KEY)).headers.get('content-type')).toBe('image/jpeg');
    vi.unstubAllGlobals();
    stubStorage(() => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/gif' } }));
    expect((await get(['photos', 'partners', 'logo.png'])).headers.get('content-type')).toBe('image/png');
  });

  it('тип, названный хранилищем, сильнее расширения: JPEG под именем .png отдаётся JPEG', async () => {
    stubStorage(() => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    expect((await get(['photos', 'fishingkam', '2025-01-09_113932-mi.png'])).headers.get('content-type')).toBe('image/jpeg');
  });

  it('объекта нет (403/404 публичного бакета) — 404 «не найден»', async () => {
    stubStorage(() => new Response('<Error/>', { status: 403 }));
    expect((await get(KEY)).status).toBe(404);
    vi.unstubAllGlobals();
    stubStorage(() => new Response('<Error/>', { status: 404 }));
    expect((await get(KEY)).status).toBe(404);
  });

  it('хранилище упало или не ответило — 502 «временно недоступен», а не «нет снимка» (§4.0)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubStorage(() => new Response('oops', { status: 500 }));
    const r1 = await get(KEY);
    expect(r1.status).toBe(502);
    expect(await r1.json()).toEqual({ error: 'Снимок временно недоступен' });
    vi.unstubAllGlobals();
    stubStorage(() => { throw new Error('ETIMEDOUT'); });
    expect((await get(KEY)).status).toBe(502);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([
      '[images/s3] хранилище ответило ошибкой', '[images/s3] хранилище не ответило',
    ]));
    log.mockRestore();
  });

  it('чужой ключ — 404, бакета нет — 404; хранилище при этом не спрашивается', async () => {
    const calls = stubStorage(() => new Response(JPEG));
    expect((await get(['places', 'x', 'a.jpg'])).status).toBe(404);
    vi.resetModules();
    vi.stubEnv('S3_BUCKET', '');
    expect((await get(['photos', 'kronotsky', 'a.jpg'])).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
