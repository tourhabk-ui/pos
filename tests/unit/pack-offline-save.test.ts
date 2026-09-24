/**
 * Сохранение своих пакетов карты для поля (24.09).
 *
 * Скрин владельца с полевого экрана: «Карта не сохраняеться». Кнопка слала
 * service worker'у список растровых тайлов OSM, а их массовая закачка
 * выключена с 28.08 — сохранить не удавалось ни разу. Теперь кнопка качает
 * свои пакеты (то, чем поле и рисуется), а service worker отдаёт их карте без
 * связи.
 *
 * Сторож держит связку целиком, а не половину (§10.09):
 *   1. выбор файлов — ровно те адреса, что попросит карта (эпоха, без
 *      pmtiles://, глифы с закодированным шрифтом), клетки под маршрутом и
 *      обзор;
 *   2. закачка — целый файл в кэш под точным адресом, неудача с причиной,
 *      нехватка места словами;
 *   3. service worker — тот же кэш, переживает свою активацию, режет Range
 *      из сохранённого файла с ETag, несохранённое берёт из сети, закачку и
 *      замер (no-store) пропускает мимо кэша.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { planPackFiles, networkUrl, PACK_CACHE_NAME } from '@/lib/offline/pack-files';
import { PACK_GLYPHS } from '@/lib/map/pack-source';
import { downloadPackFiles, measurePackFiles, totalFromContentRange, totalMb } from '@/lib/offline/pack-download';
import { builtRegionPacks, type RegionPack } from '@/lib/map/field-base-map';
import { OVERVIEW_ID } from '@/lib/geo/regions';

const BASE = 'https://s3.twcstorage.ru/bucket';
const SW = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');
const packs = builtRegionPacks(BASE);

describe('выбор файлов под маршрут', () => {
  // Авачинский перевал — внутри клетки 53N158E.
  const avacha = { south: 53.20, west: 158.75, north: 53.30, east: 158.85 };

  it('клетка под маршрутом, обзор и глифы — и больше ничего', () => {
    const plan = planPackFiles(avacha, packs)!;
    expect(plan.basis).toBe('cells');
    expect(plan.packs).toEqual([OVERVIEW_ID, 'cell-53n158e']);
    const kinds = plan.files.filter(f => f.pack === 'cell-53n158e').map(f => f.kind).sort();
    expect(kinds).toEqual(['contours', 'manifest', 'places', 'terrain', 'vector']);
    // Глифы — ровно диапазоны реестра заливки: свой список уже расходился
    // с хранилищем (256-511 → 403 в прогоне offline-pack-check 1).
    const glyphRanges = plan.files.filter(f => f.kind === 'glyphs').map(f => f.url.match(/\/(\d+-\d+)\.pbf/)?.[1]);
    expect(glyphRanges).toEqual([...PACK_GLYPHS.ranges]);
    expect(plan.files.some(f => f.kind === 'ocean')).toBe(true);
  });

  it('адреса — ровно те, что попросит карта: с эпохой и без pmtiles://', () => {
    const plan = planPackFiles(avacha, packs)!;
    const cell = packs.find(p => p.region === 'cell-53n158e')!;
    const urls = plan.files.map(f => f.url);
    expect(urls).toContain(networkUrl(cell.source.terrainUrl));
    expect(urls).toContain(networkUrl(cell.source.vectorUrl!));
    expect(urls).toContain(cell.source.contoursUrl);
    for (const u of urls) {
      expect(u.startsWith('pmtiles://'), u).toBe(false);
      expect(u, u).toMatch(/[?&]e=\d{8}/);
    }
  });

  it('глифы — адрес, который соберёт MapLibre (шрифт закодирован, как в Request)', () => {
    const g = planPackFiles(avacha, packs)!.files.find(f => f.kind === 'glyphs')!;
    expect(g.url).toMatch(/\/glyphs\/Noto%20Sans%20Regular\/0-255\.pbf\?e=/);
    // Ключ кэша совпадает с тем, как браузер нормализует адрес запроса.
    expect(new Request(g.url.replace('%20', ' ').replace('%20', ' ')).url).toBe(g.url);
  });

  it('векторный пакет заменяет слои OSM — одно и то же не качается дважды', () => {
    const plan = planPackFiles(avacha, packs)!;
    expect(plan.files.some(f => f.pack === 'cell-53n158e' && f.kind === 'osm')).toBe(false);
  });

  it('маршрут у края клетки берёт и соседнюю', () => {
    const edge = { south: 52.99, west: 158.5, north: 53.01, east: 158.6 };
    const plan = planPackFiles(edge, packs)!;
    expect(plan.packs).toEqual(expect.arrayContaining(['cell-52n158e', 'cell-53n158e']));
  });

  it('рамки нет — null, а не «качать нечего»', () => {
    expect(planPackFiles(null, packs)).toBeNull();
  });

  it('клеток нет — районные пакеты', () => {
    const fake: RegionPack[] = packs
      .filter(p => !p.region.startsWith('cell-'))
      .map(p => p);
    const plan = planPackFiles(avacha, fake)!;
    expect(plan.basis).toBe('regions');
    expect(plan.packs).toContain('avacha-group');
  });
});

describe('замер и закачка', () => {
  it('вес из Content-Range, неизвестный — null', () => {
    expect(totalFromContentRange('bytes 0-0/79490527')).toBe(79490527);
    expect(totalFromContentRange(null)).toBeNull();
    expect(totalMb([
      { url: 'a', kind: 'terrain', pack: 'x', bytes: 79_490_527, status: 206 },
      { url: 'b', kind: 'vector', pack: 'x', bytes: null, status: null },
    ])).toEqual({ mb: 79, unknown: 1 });
  });

  it('замер шлёт Range 0-0 мимо кэша', async () => {
    const fetchFn = vi.fn(async () => new Response('P', { status: 206, headers: { 'Content-Range': 'bytes 0-0/1234' } }));
    const [m] = await measurePackFiles([{ url: `${BASE}/map-packs/x.terrain.pmtiles?e=1`, kind: 'terrain', pack: 'x' }], fetchFn as never);
    expect(m.bytes).toBe(1234);
    expect(m.status).toBe(206);
    const init = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-0');
  });

  function memCaches() {
    const store = new Map<string, Map<string, Response>>();
    const api = {
      async open(name: string) {
        if (!store.has(name)) store.set(name, new Map());
        const m = store.get(name)!;
        return {
          async put(k: string, r: Response) {
            // Как настоящий Cache Storage: тело дочитывается при записи.
            const buf = await r.arrayBuffer();
            m.set(k, new Response(buf, { status: r.status, headers: r.headers }));
          },
          async match(k: string) { return m.get(k)?.clone(); },
        };
      },
    };
    return { api: api as unknown as CacheStorage, store };
  }

  it('целый файл ложится в кэш пакетов под точным адресом, неудачи названы', async () => {
    const { api, store } = memCaches();
    const files = [
      { url: `${BASE}/map-packs/a.terrain.pmtiles?e=1`, kind: 'terrain' as const, pack: 'a' },
      { url: `${BASE}/map-packs/a.contours.geojson?e=1`, kind: 'contours' as const, pack: 'a' },
    ];
    const fetchFn = vi.fn(async (u: string) => u.includes('contours')
      ? new Response('нет', { status: 404 })
      : new Response(new Uint8Array(2_500_000), { status: 200, headers: { 'Content-Length': '2500000', ETag: '"abc"' } }));
    const seen: number[] = [];
    const res = await downloadPackFiles(files, p => seen.push(p.bytesDone), { fetchFn: fetchFn as never, cachesApi: api });
    expect(res.saved).toBe(1);
    expect(res.bytes).toBe(2_500_000);
    expect(res.failed).toEqual([{ url: files[1].url, kind: 'contours', why: 'HTTP 404' }]);
    expect(store.get(PACK_CACHE_NAME)?.has(files[0].url)).toBe(true);
    // Закачка идёт мимо кэша service worker'а — иначе вернулась бы прежняя копия.
    for (const c of fetchFn.mock.calls) expect(((c as unknown[])[1] as RequestInit).cache).toBe('no-store');
    // Прогресс по байтам, а не только по файлам.
    expect(Math.max(...seen)).toBe(2_500_000);
  });

  it('частичный ответ (206) — не файл: в кэш не кладётся', async () => {
    const { api } = memCaches();
    const res = await downloadPackFiles(
      [{ url: `${BASE}/map-packs/a.terrain.pmtiles`, kind: 'terrain', pack: 'a' }],
      () => {},
      { fetchFn: (async () => new Response('P', { status: 206 })) as never, cachesApi: api },
    );
    expect(res.saved).toBe(0);
    expect(res.failed[0].why).toBe('HTTP 206');
  });

  it('нет места — сказано словами', async () => {
    const api = { async open() { return { async put() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }, async match() { return undefined; } }; } };
    const res = await downloadPackFiles(
      [{ url: `${BASE}/map-packs/a.terrain.pmtiles`, kind: 'terrain', pack: 'a' }],
      () => {},
      { fetchFn: (async () => new Response('x', { status: 200 })) as never, cachesApi: api as unknown as CacheStorage },
    );
    expect(res.failed[0].why).toBe('не хватило места в телефоне');
  });
});

describe('service worker отдаёт сохранённое', () => {
  it('тот же кэш, и активация его не стирает', () => {
    expect(SW).toContain(`const PACK_CACHE_NAME = '${PACK_CACHE_NAME}';`);
    const activate = SW.slice(SW.indexOf("self.addEventListener('activate'"), SW.indexOf('function isTourPage'));
    expect(activate).toMatch(/&& key !== PACK_CACHE_NAME\)/);
  });

  /** Запустить sw.js в песочнице и достать обработчик fetch. */
  function loadSw(cached: Map<string, Response>, net: (r: Request) => Promise<Response>) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = {
      location: { origin: 'https://vedarai.ru' },
      addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: {},
    };
    const caches = {
      open: async () => ({ match: async (k: string) => cached.get(k)?.clone(), put: async () => {}, keys: async () => [] }),
      match: async () => undefined,
      keys: async () => [],
    };
    runInNewContext(SW, {
      self, caches, fetch: net, Response, Request, Headers, URL, Blob, console, setTimeout, clearTimeout,
      Promise, Date, Math, JSON, Number, String, Array, Object, RegExp, Error, Map, Set,
    });
    return async (req: Request): Promise<Response | 'passthrough'> => {
      let answer: Promise<Response> | null = null;
      listeners.fetch({ request: req, respondWith: (p: Promise<Response>) => { answer = p; } });
      return answer ? await answer : 'passthrough';
    };
  }

  const URL_T = 'https://s3.twcstorage.ru/bucket/map-packs/cell-53n158e.terrain.pmtiles?e=20260924';
  const bytes = new Uint8Array(100).map((_, i) => i);
  const saved = () => new Map([[URL_T, new Response(bytes, {
    status: 200, headers: { 'Content-Type': 'application/octet-stream', ETag: '"af9c"' },
  })]]);

  it('Range из сохранённого файла: 206, нужные байты, Content-Range и ETag', async () => {
    const net = vi.fn(async () => { throw new TypeError('offline'); });
    const handle = loadSw(saved(), net);
    const res = await handle(new Request(URL_T, { headers: { Range: 'bytes=10-19' } })) as Response;
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('ETag')).toBe('"af9c"');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(net).not.toHaveBeenCalled();
  });

  it('открытый конец Range и выход за край — по правилам HTTP', async () => {
    const handle = loadSw(saved(), async () => { throw new TypeError('offline'); });
    const tail = await handle(new Request(URL_T, { headers: { Range: 'bytes=95-' } })) as Response;
    expect(tail.headers.get('Content-Range')).toBe('bytes 95-99/100');
    const over = await handle(new Request(URL_T, { headers: { Range: 'bytes=200-300' } })) as Response;
    expect(over.status).toBe(416);
  });

  it('без Range — файл целиком (горизонтали, места, глифы)', async () => {
    const handle = loadSw(saved(), async () => { throw new TypeError('offline'); });
    const res = await handle(new Request(URL_T)) as Response;
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('не сохранено — из сети как есть', async () => {
    const net = vi.fn(async () => new Response('net', { status: 206 }));
    const handle = loadSw(new Map(), net);
    const res = await handle(new Request(URL_T, { headers: { Range: 'bytes=0-1' } })) as Response;
    expect(await res.text()).toBe('net');
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('закачка и замер (cache: no-store) идут мимо кэша', async () => {
    const handle = loadSw(saved(), async () => new Response('net'));
    expect(await handle(new Request(URL_T, { cache: 'no-store' }))).toBe('passthrough');
  });
});
