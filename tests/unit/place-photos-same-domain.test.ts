// @vitest-environment node
/**
 * Снимки мест — с нашего домена (11.11).
 *
 * Раздача героя и галереи места отвечала 302 на s3.twcstorage.ru. На телефоне
 * владельца снимки со второго домена не грузились; после #2841 снимки «Лагуны»
 * с нашего домена у него видны (подтвердил 11.11: «фото видны»). Значит,
 * причина — второй домен, и места переходят на тот же путь
 * (lib/images/serve-stored).
 *
 * Сторож — вызовом роутов с подменёнными базой и хранилищем: объект нашего
 * бакета отдаётся телом без Location, чужой адрес — по-прежнему редиректом
 * (сервер чужое не скачивает), отказ хранилища — 502 с логом, а не «нет».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const BASE = 'https://s3.twcstorage.ru/vedar-test';
const ARK = '7190e0a4-52f1-47fb-ba17-0fcb493d99df';

let rows: Array<Record<string, unknown>> = [];
const fetched: Array<{ url: string; headers: Record<string, string> }> = [];
let upstream: () => Promise<Response> = async () => new Response('jpegbytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });

async function load() {
  vi.resetModules();
  vi.stubEnv('S3_BUCKET', 'vedar-test');
  vi.stubEnv('S3_ENDPOINT', 'https://s3.twcstorage.ru');
  vi.doMock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows })) } }));
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: { headers?: Record<string, string> }) => {
    fetched.push({ url: String(u), headers: init?.headers ?? {} });
    return upstream();
  }));
  const hero = await import('@/app/api/images/route/[routeId]/route');
  const gallery = await import('@/app/api/images/place-gallery/[arkId]/[position]/route');
  const serve = await import('@/lib/images/serve-stored');
  return { hero, gallery, serve };
}

const heroCall = (h: Awaited<ReturnType<typeof load>>['hero'], headers: Record<string, string> = {}) =>
  h.GET(new NextRequest(`http://x/api/images/route/${ARK}`, { headers }), { params: Promise.resolve({ routeId: ARK }) });
const galleryCall = (g: Awaited<ReturnType<typeof load>>['gallery']) =>
  g.GET(new NextRequest(`http://x/api/images/place-gallery/${ARK}/1`), { params: Promise.resolve({ arkId: ARK, position: '1' }) });

beforeEach(() => {
  fetched.length = 0;
  upstream = async () => new Response('jpegbytes', { status: 200, headers: { 'content-type': 'image/jpeg', etag: '"e1"' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/db-pool');
});

describe('чей адрес отдаётся с нашего домена', () => {
  it('только объект нашего бакета', async () => {
    const { serve } = await load();
    expect(serve.isOurStoredUrl(`${BASE}/places/a.jpg`)).toBe(true);
    expect(serve.isOurStoredUrl('https://upload.wikimedia.org/a.jpg')).toBe(false);
    expect(serve.isOurStoredUrl('https://s3.twcstorage.ru/other-bucket/a.jpg')).toBe(false);
    expect(serve.isOurStoredUrl(`${BASE}-evil/a.jpg`)).toBe(false);
    expect(serve.isOurStoredUrl(`${BASE}/../other/a.jpg`)).toBe(false);
    // Ревью безопасности #3238: точечные сегменты в кодировке разбор адреса
    // превращает в «..» — проверка судит адрес после разбора, как его видит fetch.
    expect(serve.isOurStoredUrl(`${BASE}/%2e%2e/other-bucket/key.jpg`)).toBe(false);
    expect(serve.isOurStoredUrl(`${BASE}/.%2E/other-bucket/key.jpg`)).toBe(false);
    expect(serve.isOurStoredUrl(`${BASE}/places/%2e%2e/%2e%2e/x.jpg`)).toBe(false);
    expect(serve.isOurStoredUrl('https://user:pw@s3.twcstorage.ru/vedar-test/a.jpg')).toBe(false);
    // Чужой хост с тем же путём бакета — не наш.
    expect(serve.isOurStoredUrl('https://evil.example/vedar-test/a.jpg')).toBe(false);
    expect(serve.isOurStoredUrl('http://s3.twcstorage.ru/vedar-test/a.jpg')).toBe(false);
    expect(serve.isOurStoredUrl(`${BASE}/`)).toBe(false);
    // Тот же адрес иначе записанный — свой, и отдаётся разобранным.
    expect(serve.ourStoredUrl('https://S3.TWCSTORAGE.RU:443/vedar-test/places/a.jpg')).toBe(`${BASE}/places/a.jpg`);
    expect(serve.isOurStoredUrl(null)).toBe(false);
  });

  it('бакета нет — своим не считается ничего', async () => {
    vi.resetModules();
    vi.stubEnv('S3_BUCKET', '');
    const serve = await import('@/lib/images/serve-stored');
    expect(serve.isOurStoredUrl('https://s3.twcstorage.ru/a.jpg')).toBe(false);
    // База без бакета кончается на «/»: адрес с двойной косой своим не становится.
    expect(serve.isOurStoredUrl('https://s3.twcstorage.ru//a.jpg')).toBe(false);
  });
});

describe('герой места', () => {
  it('объект нашего бакета — тело с нашего домена, без Location', async () => {
    const { hero } = await load();
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/places/a.jpg`, s3_key: null, thumb_url: null }];
    const res = await heroCall(hero);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-source')).toBe('s3');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('jpegbytes');
    expect(fetched.map((f) => f.url)).toEqual([`${BASE}/places/a.jpg`]);
  });

  it('чужой адрес источника — редирект, сервер его не скачивает', async () => {
    const { hero } = await load();
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: 'https://upload.wikimedia.org/x/a.jpg', s3_key: null, thumb_url: null }];
    const res = await heroCall(hero);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://upload.wikimedia.org/x/a.jpg');
    expect(fetched).toHaveLength(0);
  });

  it('повторный показ — условный запрос доходит до хранилища, 304 без тела', async () => {
    const { hero } = await load();
    upstream = async () => new Response(null, { status: 304, headers: { etag: '"e1"' } });
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/places/a.jpg`, s3_key: null, thumb_url: null }];
    const res = await heroCall(hero, { 'if-none-match': '"e1"' });
    expect(res.status).toBe(304);
    expect(fetched[0]!.headers['If-None-Match']).toBe('"e1"');
  });

  it('чужой тип хранилища не пробрасывается — тип по адресу', async () => {
    const { hero } = await load();
    upstream = async () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/places/a.png`, s3_key: null, thumb_url: null }];
    const res = await heroCall(hero);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('адрес с закодированным «..» не скачивается — редирект браузеру', async () => {
    const { hero } = await load();
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/%2e%2e/other-bucket/key.jpg`, s3_key: null, thumb_url: null }];
    const res = await heroCall(hero);
    expect(res.status).toBe(302);
    expect(fetched).toHaveLength(0);
  });

  it('по переадресации хранилища сервер не идёт: redirect manual, 3xx — 502 с логом', async () => {
    const { hero } = await load();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let mode: unknown;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: { redirect?: string }) => {
      fetched.push({ url: String(u), headers: {} });
      mode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }));
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/places/a.jpg`, s3_key: null, thumb_url: null }];
    const res = await heroCall(hero);
    expect(mode).toBe('manual');
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    expect(log.mock.calls.some((c) => String(c[0]).includes('переадресацией'))).toBe(true);
    log.mockRestore();
  });

  it('объекта нет — 404; хранилище упало — 502 и строка в лог', async () => {
    const { hero } = await load();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/places/a.jpg`, s3_key: null, thumb_url: null }];
    upstream = async () => new Response('', { status: 403 });
    expect((await heroCall(hero)).status).toBe(404);
    upstream = async () => { throw new Error('ECONNRESET'); };
    expect((await heroCall(hero)).status).toBe(502);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('[images/route]'))).toBe(true);
    log.mockRestore();
  });
});

describe('галерея места', () => {
  it('объект нашего бакета — тело; чужой адрес — редирект', async () => {
    const { gallery } = await load();
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: `${BASE}/places/g.jpg`, s3_key: null }];
    const ours = await galleryCall(gallery);
    expect(ours.status).toBe(200);
    expect(ours.headers.get('location')).toBeNull();
    rows = [{ image_data: null, mime_type: 'image/jpeg', s3_url: 'https://example.org/g.jpg', s3_key: null }];
    const foreign = await galleryCall(gallery);
    expect(foreign.status).toBe(302);
    expect(fetched.map((f) => f.url)).toEqual([`${BASE}/places/g.jpg`]);
  });
});
