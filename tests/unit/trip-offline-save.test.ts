/**
 * План на телефоне без сети (#2225): «Сохранить для офлайна» и service worker.
 *
 * Критерии задачи: после «сохранить» страница плана открывается в режиме
 * самолёта; вытеснение из LRU не удаляет явно сохранённый план. Оба
 * проверяются здесь на настоящем public/sw.js, исполненном в песочнице, с
 * кэшами, которые ведут себя как Cache Storage браузера.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  SAVED_TRIPS_CACHE_NAME, saveTripOffline, readOfflineStatus, removeTripOffline, pageAssetPaths,
  tripPagePath, tripGpxPath, tripMarkerPath, type OfflineDeps,
} from '@/lib/offline/trip-save';

const ORIGIN = 'https://vedarai.ru';
const SW = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');
const T1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const T2 = '2c8e7ace-aaaa-4b2d-9b5d-ab8dfbbd4bed';

// ── Cache Storage, который ведёт себя как браузерный ──────────────────────────

class FakeCache {
  store = new Map<string, Response>();
  failPut: Error | null = null;
  private key(req: RequestInfo | URL): string {
    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
    return new URL(url, ORIGIN).href;
  }
  async match(req: RequestInfo | URL) { const r = this.store.get(this.key(req)); return r ? r.clone() : undefined; }
  async put(req: RequestInfo | URL, res: Response) {
    if (this.failPut) throw this.failPut;
    this.store.set(this.key(req), res.clone());
  }
  async delete(req: RequestInfo | URL) { return this.store.delete(this.key(req)); }
  async keys() { return [...this.store.keys()].map((u) => new Request(u)); }
}

class FakeCacheStorage {
  named = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.named.has(name)) this.named.set(name, new FakeCache());
    return this.named.get(name)!;
  }
  async match(req: RequestInfo | URL) {
    for (const c of this.named.values()) { const r = await c.match(req); if (r) return r; }
    return undefined;
  }
  async keys() { return [...this.named.keys()]; }
  async delete(name: string) { return this.named.delete(name); }
  async has(name: string) { return this.named.has(name); }
}

const html = (t: string) => new Response(`<html>${t}</html>`, { status: 200, headers: { 'Content-Type': 'text/html' } });

/** Сеть страницы: план, GPX и файлы отвечают, если перечислены. */
function net(routes: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, ORIGIN).pathname + new URL(url, ORIGIN).search;
    const route = routes[path];
    if (!route) return new Response('нет', { status: 404 });
    return route();
  });
}

function deps(storage: FakeCacheStorage, fetchFn: ReturnType<typeof net>): OfflineDeps {
  return { caches: storage as unknown as CacheStorage, fetch: fetchFn as unknown as typeof fetch };
}

// ── Сохранение со страницы ────────────────────────────────────────────────────

describe('saveTripOffline: что ложится на телефон', () => {
  it('страница, GPX, файлы страницы и метка — в свой кэш', async () => {
    const storage = new FakeCacheStorage();
    const f = net({
      [tripPagePath(T1)]: () => html('план'),
      [tripGpxPath(T1)]: () => new Response('<gpx/>', { status: 200 }),
      '/_next/static/chunks/a.js': () => new Response('a'),
      '/_next/static/css/b.css': () => new Response('b'),
    });
    const r = await saveTripOffline(T1, ['/_next/static/chunks/a.js', '/_next/static/css/b.css'], deps(storage, f), new Date('2026-10-08T12:00:00Z'));
    expect(r).toEqual({ ok: true, savedAt: '2026-10-08T12:00:00.000Z', gpx: true, assets: 2, assetsFailed: 0 });
    const cache = await storage.open(SAVED_TRIPS_CACHE_NAME);
    expect(await (await cache.match(tripPagePath(T1)))!.text()).toContain('план');
    expect(await cache.match(tripGpxPath(T1))).toBeDefined();
    expect(await cache.match('/_next/static/chunks/a.js')).toBeDefined();
    expect(await readOfflineStatus(T1, deps(storage, f))).toEqual({ kind: 'saved', savedAt: '2026-10-08T12:00:00.000Z' });
    // Страница берётся из сети заново, а не из общего кэша: копия — свежая правка.
    expect(f).toHaveBeenCalledWith(tripPagePath(T1), { cache: 'no-store' });
  });

  it('плана нет (ссылке больше 7 дней) — отказ словами и ничего не сохранено', async () => {
    const storage = new FakeCacheStorage();
    const r = await saveTripOffline(T1, [], deps(storage, net({})));
    expect(r).toEqual({ ok: false, reason: 'план не найден — ссылка неверна или ей больше 7 дней' });
    expect(await readOfflineStatus(T1, deps(storage, net({})))).toEqual({ kind: 'not_saved' });
  });

  it('у плана без координат GPX нет — это не отказ', async () => {
    const storage = new FakeCacheStorage();
    const r = await saveTripOffline(T1, [], deps(storage, net({ [tripPagePath(T1)]: () => html('план') })));
    expect(r).toMatchObject({ ok: true, gpx: false });
  });

  it('файл страницы не скачался — посчитан, план всё равно сохранён', async () => {
    const storage = new FakeCacheStorage();
    const r = await saveTripOffline(T1, ['/_next/static/chunks/x.js'], deps(storage, net({ [tripPagePath(T1)]: () => html('план') })));
    expect(r).toMatchObject({ ok: true, assets: 0, assetsFailed: 1 });
  });

  it('не хватило места — так и сказано', async () => {
    const storage = new FakeCacheStorage();
    (await storage.open(SAVED_TRIPS_CACHE_NAME)).failPut = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    const r = await saveTripOffline(T1, [], deps(storage, net({ [tripPagePath(T1)]: () => html('план') })));
    expect(r).toEqual({ ok: false, reason: 'на телефоне не хватило места' });
  });

  it('нет Cache API — состояние «нельзя», а не кнопка, которая ничего не сделает', async () => {
    const d: OfflineDeps = { caches: undefined, fetch: vi.fn() as unknown as typeof fetch };
    expect(await readOfflineStatus(T1, d)).toEqual({ kind: 'unavailable', reason: 'в этом браузере нет офлайн-хранилища' });
    expect(await saveTripOffline(T1, [], d)).toMatchObject({ ok: false });
  });

  it('файлы, на которые не ссылается ни один сохранённый план, убираются', async () => {
    const storage = new FakeCacheStorage();
    const routes = {
      [tripPagePath(T1)]: () => html('1'), [tripPagePath(T2)]: () => html('2'),
      '/_next/static/a.js': () => new Response('a'), '/_next/static/b.js': () => new Response('b'), '/_next/static/c.js': () => new Response('c'),
    };
    await saveTripOffline(T1, ['/_next/static/a.js', '/_next/static/b.js'], deps(storage, net(routes)));
    await saveTripOffline(T2, ['/_next/static/b.js', '/_next/static/c.js'], deps(storage, net(routes)));
    const cache = await storage.open(SAVED_TRIPS_CACHE_NAME);
    expect(await cache.match('/_next/static/a.js')).toBeDefined();
    expect(await removeTripOffline(T1, deps(storage, net(routes)))).toBe(true);
    expect(await cache.match(tripPagePath(T1))).toBeUndefined();
    expect(await cache.match(tripMarkerPath(T1))).toBeUndefined();
    expect(await cache.match('/_next/static/a.js')).toBeUndefined();
    expect(await cache.match('/_next/static/b.js')).toBeDefined();
    expect(await cache.match('/_next/static/c.js')).toBeDefined();
    expect(await cache.match(tripPagePath(T2))).toBeDefined();
  });

  it('файлы страницы — только чанки и стили своего домена', () => {
    expect(pageAssetPaths(ORIGIN, [
      `${ORIGIN}/_next/static/chunks/app.js?v=1`, '/_next/static/css/x.css',
      'https://mc.yandex.ru/metrika/tag.js', `${ORIGIN}/api/places`, 'не адрес :::',
      `${ORIGIN}/_next/static/chunks/app.js?v=1`,
    ])).toEqual(['/_next/static/chunks/app.js?v=1', '/_next/static/css/x.css']);
  });
});

// ── public/sw.js в песочнице ──────────────────────────────────────────────────

function loadSw(storage: FakeCacheStorage, network: (r: Request) => Promise<Response>) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: {},
  };
  runInNewContext(SW, {
    self, caches: storage, fetch: network, Response, Request, Headers, URL, Blob, console,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    Promise, Date, Math, JSON, Number, String, Array, Object, RegExp, Error, Map, Set, atob, Uint8Array,
  });
  const fetchEvent = async (req: Request): Promise<Response | 'passthrough'> => {
    let answer: Promise<Response> | null = null;
    listeners.fetch({ request: req, respondWith: (p: Promise<Response>) => { answer = p; }, waitUntil: () => {} });
    return answer ? await answer : 'passthrough';
  };
  const activate = async () => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  return { fetchEvent, activate };
}

const CACHE_NAME = /const CACHE_NAME = '([^']+)'/.exec(SW)![1];
const offline = async () => { throw new TypeError('Failed to fetch'); };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function savedStorage(): Promise<FakeCacheStorage> {
  const storage = new FakeCacheStorage();
  const saved = await storage.open(SAVED_TRIPS_CACHE_NAME);
  await saved.put(`${ORIGIN}${tripPagePath(T1)}`, html('сохранённый план'));
  await saved.put(`${ORIGIN}${tripGpxPath(T1)}`, new Response('<gpx>сохранённый</gpx>'));
  return storage;
}

afterEach(() => { vi.useRealTimers(); });

describe('service worker: сохранённый план без сети', () => {
  it('имя кэша — одно на страницу и воркер', () => {
    expect(SW).toContain(`const SAVED_TRIPS_CACHE_NAME = '${SAVED_TRIPS_CACHE_NAME}';`);
  });

  it('режим самолёта: страница плана — из сохранённого, не «офлайн-заглушка»', async () => {
    const { fetchEvent } = loadSw(await savedStorage(), offline);
    const res = await fetchEvent(new Request(`${ORIGIN}${tripPagePath(T1)}`)) as Response;
    expect(await res.text()).toContain('сохранённый план');
  });

  it('связь висит — через таймаут сохранённая копия, а не ожидание минутами', async () => {
    vi.useFakeTimers();
    const { fetchEvent } = loadSw(await savedStorage(), () => new Promise<Response>(() => {}));
    const pending = fetchEvent(new Request(`${ORIGIN}${tripPagePath(T1)}`));
    await vi.advanceTimersByTimeAsync(4100);
    const res = await pending as Response;
    expect(await res.text()).toContain('сохранённый план');
  });

  it('GPX плана без сети — из сохранённого', async () => {
    const { fetchEvent } = loadSw(await savedStorage(), offline);
    const res = await fetchEvent(new Request(`${ORIGIN}${tripGpxPath(T1)}`)) as Response;
    expect(await res.text()).toContain('сохранённый');
  });

  it('активация новой версии воркера сохранённые планы не стирает', async () => {
    const storage = await savedStorage();
    await storage.open('kamchatour-v1');
    await storage.open(CACHE_NAME);
    const { activate } = loadSw(storage, offline);
    await activate();
    const left = await storage.keys();
    expect(left).toContain(SAVED_TRIPS_CACHE_NAME);
    expect(left).toContain(CACHE_NAME);
    expect(left).not.toContain('kamchatour-v1');
  });

  it('LRU общего кэша вытесняет открытые планы, но не сохранённый', async () => {
    const storage = await savedStorage();
    const opened: string[] = [];
    const { fetchEvent } = loadSw(storage, async (req: Request) => html(`онлайн ${req.url}`));
    // Сохранённый план открыт первым, потом ещё одиннадцать — общий кэш держит десять.
    for (const i of Array.from({ length: 12 }, (_, k) => k)) {
      const token = i === 0 ? T1 : `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
      opened.push(token);
      await fetchEvent(new Request(`${ORIGIN}${tripPagePath(token)}`));
      await flush();
    }
    const general = await storage.open(CACHE_NAME);
    const generalTrips = (await general.keys()).filter((r) => r.url.includes('/trip/'));
    expect(generalTrips).toHaveLength(10);
    expect(generalTrips.some((r) => r.url.includes(T1))).toBe(false);
    // Без сети сохранённый план открывается — из своего кэша.
    const { fetchEvent: offlineFetch } = loadSw(storage, offline);
    const res = await offlineFetch(new Request(`${ORIGIN}${tripPagePath(T1)}`)) as Response;
    expect(await res.text()).toContain('сохранённый план');
  });
});

// ── Страница: честное состояние вместо обещания ───────────────────────────────

describe('страница плана говорит, сохранён ли он', () => {
  const client = readFileSync(join(process.cwd(), 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');
  const button = readFileSync(join(process.cwd(), 'app/trip/[token]/_OfflineSave.tsx'), 'utf-8');

  it('прежнее обещание «сохраняется на телефоне» снято, на его месте — кнопка с состоянием', () => {
    expect(client).not.toContain('Страница плана сохраняется на телефоне и открывается без интернета');
    expect(client).toContain('<OfflineSave token={token} isDraft={isDraft} />');
  });

  it('три состояния названы словами', () => {
    expect(button).toContain('План не сохранён для офлайна');
    expect(button).toContain('План сохранён на этом устройстве');
    expect(button).toContain('Сохранить план на телефон в этом браузере нельзя');
    expect(button).toContain('Офлайн заработает после того, как страница один раз перезагрузится с интернетом.');
  });
});
