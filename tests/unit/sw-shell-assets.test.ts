/**
 * Прекэш поднимается без сети целиком: HTML вместе со своими файлами.
 *
 * Жалоба владельца 10.11: «PWA ломается без сети». Прекэш клал в память только
 * HTML (`/sos`, `/offline`, главную…), а его стили и скрипты
 * (`/_next/static/<хеш>`) — нет; и обновлялся он лишь при смене sw.js, тогда
 * как сборка меняется на каждом пуше. Без сети страница находилась, а её
 * файлы — нет: без стилей, без кнопок, «Application error» на белом фоне.
 *
 * Сторож судит поведение: sw.js исполняется в песочнице vm с настоящими
 * Response, сеть то отвечает, то обрывается, и проверяется, что отдал воркер.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildMarkFromScripts, shouldAskShellRefresh } from '@/lib/offline/shell-refresh';

const SW = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');
const ORIGIN = 'https://vedarai.ru';
const abs = (u: string) => new URL(u, ORIGIN).href;

type Key = string | { url: string };
const keyUrl = (k: Key) => abs(typeof k === 'string' ? k : k.url);

/** HTML страницы Next: стиль и скрипты тегами, ленивый чанк — в данных RSC. */
function page(build: string, name: string): string {
  return `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_next/static/css/app-${build}.css" data-precedence="next"/>
<link rel="preload" href="/_next/static/media/font-${build}.woff2" as="font"/>
</head><body><main>${name}</main>
<script src="/_next/static/chunks/webpack-${build}.js" async=""></script>
<script src="/_next/static/chunks/app/${name}/page-${build}.js" async=""></script>
<script>self.__next_f.push([1,"5:I[\\"123\\",[\\"static/chunks/lazy-${build}.js\\"],\\"Map\\"]"])</script>
<a href="/catalog">каталог</a></body></html>`;
}

interface World {
  online: boolean;
  build: string;
  /** Адреса, которые сеть отвергает 404 при живой связи. */
  broken: Set<string>;
  fetched: string[];
}

function net(world: World) {
  return async (key: Key) => {
    const url = keyUrl(key);
    world.fetched.push(url);
    if (!world.online) throw new TypeError('Failed to fetch');
    const path = new URL(url).pathname;
    if (world.broken.has(path)) return new Response('nope', { status: 404 });
    if (path.startsWith('/_next/static/')) {
      return new Response(`/* ${path} */`, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
    }
    if (/\.[a-z0-9]+$/i.test(path)) return new Response('asset', { status: 200 });
    const name = path === '/' ? 'home' : path.slice(1).replace(/\//g, '-');
    return new Response(page(world.build, name), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
}

function loadWorker(world: World) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const stores = new Map<string, Map<string, Response>>();
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (k: Key) => store.get(keyUrl(k))?.clone(),
      put: async (k: Key, res: Response) => { store.delete(keyUrl(k)); store.set(keyUrl(k), res); },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (k: Key) => store.delete(keyUrl(k)),
    };
  };
  const matchAll = async (k: Key) => {
    for (const store of stores.values()) {
      const hit = store.get(keyUrl(k));
      if (hit) return hit.clone();
    }
    return undefined;
  };
  const posted: unknown[] = [];
  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      location: { origin: ORIGIN },
      registration: { showNotification: async () => undefined },
      clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
      skipWaiting: async () => undefined,
    },
    caches: {
      match: matchAll,
      open: async (name: string) => open(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: (k: Key) => net(world)(k),
    // Повторы ждут 400–800 мс — в тесте ждать незачем.
    setTimeout: (fn: () => void) => { queueMicrotask(fn); return 0; },
    clearTimeout: () => undefined,
    Response, Headers, URL, atob, Uint8Array, Promise, console, Set, Map,
  });
  vm.runInContext(SW, context, { filename: 'public/sw.js' });

  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners.get(type) ?? []) {
      fn({ ...event, waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
    }
    await Promise.all(waits);
  };

  return {
    stores,
    posted,
    has: (name: string, path: string) => Boolean(stores.get(name)?.has(abs(path))),
    install: () => fire('install', {}),
    activate: () => fire('activate', {}),
    refresh: (build: string) => fire('message', {
      data: { type: 'REFRESH_SHELL', build },
      origin: ORIGIN,
      source: { postMessage: (m: unknown) => posted.push(m) },
    }),
    /** Запрос страницы; ответ — то, что воркер отдал в respondWith. */
    async request(path: string, init: { mode?: string; destination?: string } = {}): Promise<Response | undefined> {
      let answer: Promise<Response> | undefined;
      const request = {
        method: 'GET', url: abs(path), mode: init.mode ?? 'no-cors', destination: init.destination ?? 'script',
        cache: 'default', headers: new Headers(),
      };
      for (const fn of listeners.get('fetch') ?? []) {
        fn({ request, respondWith: (v: Promise<Response>) => { answer = Promise.resolve(v); } });
      }
      return answer ? answer.catch(() => undefined) : undefined;
    },
  };
}

/** Дождаться фоновой записи (cacheIfOk не ждёт её в respondWith). */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('прекэш кладёт страницу вместе с её файлами', () => {
  it('после установки /sos и /offline поднимаются без сети: HTML, стиль, скрипты, ленивый чанк', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    const sw = loadWorker(world);
    await sw.install();
    await sw.activate();

    world.online = false;
    for (const name of ['sos', 'offline']) {
      const doc = await sw.request(`/${name}`, { mode: 'navigate', destination: 'document' });
      expect(doc?.status, `/${name} без сети`).toBe(200);
      expect(await doc!.text()).toContain(`<main>${name}</main>`);
      for (const file of [
        '/_next/static/css/app-b1.css',
        '/_next/static/chunks/webpack-b1.js',
        `/_next/static/chunks/app/${name}/page-b1.js`,
        '/_next/static/chunks/lazy-b1.js',
        '/_next/static/media/font-b1.woff2',
      ]) {
        const res = await sw.request(file);
        expect(res?.status, `${file} для /${name} без сети`).toBe(200);
      }
    }
  });

  it('файлы прекэша живут в отдельном кэше и переживают активацию нового воркера', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    const sw = loadWorker(world);
    await sw.install();
    await sw.activate();
    expect(sw.has('kh-shell-v1', '/_next/static/chunks/app/sos/page-b1.js')).toBe(true);
    // Посторонний кэш активация убирает, кэш файлов прекэша — нет.
    sw.stores.set('kamchatour-v1', new Map());
    await sw.activate();
    expect(sw.stores.has('kamchatour-v1')).toBe(false);
    expect(sw.stores.has('kh-shell-v1')).toBe(true);
  });

  it('файл не лёг — прежняя целая копия страницы не заменяется полуготовой', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    const sw = loadWorker(world);
    await sw.install();
    world.build = 'b2';
    world.broken.add('/_next/static/chunks/app/sos/page-b2.js');
    await sw.refresh('/_next/static/chunks/webpack-b2.js');
    expect(sw.posted).toContainEqual({ type: 'SHELL_REFRESHED', status: 'partial' });

    world.online = false;
    const doc = await sw.request('/sos', { mode: 'navigate', destination: 'document' });
    const html = await doc!.text();
    expect(html, 'в памяти осталась целая страница сборки b1').toContain('page-b1.js');
    expect((await sw.request('/_next/static/chunks/app/sos/page-b1.js'))?.status).toBe(200);
  });
});

describe('прекэш догоняет новую сборку', () => {
  it('новая метка — свежий HTML и файлы, файлы прошлой сборки убраны; та же метка — сеть не трогается', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    const sw = loadWorker(world);
    await sw.install();
    await sw.activate();

    world.build = 'b2';
    await sw.refresh('/_next/static/chunks/webpack-b2.js');
    expect(sw.posted).toContainEqual({ type: 'SHELL_REFRESHED', status: 'refreshed' });
    expect(sw.has('kh-shell-v1', '/_next/static/chunks/app/sos/page-b2.js')).toBe(true);
    expect(sw.has('kh-shell-v1', '/_next/static/chunks/app/sos/page-b1.js'), 'файл прошлой сборки').toBe(false);

    world.fetched.length = 0;
    await sw.refresh('/_next/static/chunks/webpack-b2.js');
    expect(sw.posted).toContainEqual({ type: 'SHELL_REFRESHED', status: 'same' });
    expect(world.fetched, 'та же сборка — без сети').toEqual([]);

    world.online = false;
    const doc = await sw.request('/offline', { mode: 'navigate', destination: 'document' });
    expect(await doc!.text()).toContain('page-b2.js');
    expect((await sw.request('/_next/static/chunks/app/offline/page-b2.js'))?.status).toBe(200);
  });

  it('без метки просьба ничего не делает', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    const sw = loadWorker(world);
    await sw.refresh('');
    expect(sw.posted).toContainEqual({ type: 'SHELL_REFRESHED', status: 'no-mark' });
    expect(world.fetched).toEqual([]);
  });
});

describe('открытая онлайн карточка сохраняется с ленивыми файлами', () => {
  it('карточка места: чанк карты, который браузер ещё не просил, ложится в память', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    const sw = loadWorker(world);
    const res = await sw.request('/places/kurilskoe-ozero', { mode: 'navigate', destination: 'document' });
    expect(res?.status).toBe(200);
    await settle();

    world.online = false;
    const doc = await sw.request('/places/kurilskoe-ozero', { mode: 'navigate', destination: 'document' });
    expect(await doc!.text()).toContain('<main>places-kurilskoe-ozero</main>');
    expect((await sw.request('/_next/static/chunks/lazy-b1.js'))?.status, 'ленивый чанк без сети').toBe(200);
    expect((await sw.request('/_next/static/chunks/app/places-kurilskoe-ozero/page-b1.js'))?.status).toBe(200);
  });
});

describe('запасной экран «Связи нет» прекэшируется с повторами', () => {
  it('/offline ложится, даже если первая попытка оборвалась', async () => {
    const world: World = { online: true, build: 'b1', broken: new Set(), fetched: [] };
    let first = true;
    const realNet = net(world);
    // Первый запрос /offline обрывается, следующие — проходят.
    const wrapped = async (k: Key) => {
      if (first && new URL(keyUrl(k)).pathname === '/offline') { first = false; throw new TypeError('blink'); }
      return realNet(k);
    };
    // Подменить сеть внутри песочницы нельзя после загрузки, поэтому
    // проверяем на отдельном воркере с оборванной первой попыткой.
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const store = new Map<string, Response>();
    const cacheApi = {
      match: async (k: Key) => store.get(keyUrl(k))?.clone(),
      put: async (k: Key, r: Response) => { store.set(keyUrl(k), r); },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (k: Key) => store.delete(keyUrl(k)),
    };
    const ctx = vm.createContext({
      self: {
        addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
        location: { origin: ORIGIN }, registration: {}, clients: { claim: async () => undefined },
        skipWaiting: async () => undefined,
      },
      caches: { match: cacheApi.match, open: async () => cacheApi, keys: async () => [], delete: async () => true },
      fetch: wrapped,
      setTimeout: (fn: () => void) => { queueMicrotask(fn); return 0; },
      clearTimeout: () => undefined,
      Response, Headers, URL, atob, Uint8Array, Promise, console, Set, Map,
    });
    vm.runInContext(SW, ctx);
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners.get('install') ?? []) fn({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(first).toBe(false);
    expect(store.has(abs('/offline')), '/offline после обрыва первой попытки').toBe(true);
  });
});

describe('метка сборки страницы', () => {
  it('берётся из адреса webpack-рантайма', () => {
    expect(buildMarkFromScripts([
      'https://vedarai.ru/_next/static/chunks/main-app-1a2b.js',
      'https://vedarai.ru/_next/static/chunks/webpack-9f8e7d.js',
    ])).toBe('/_next/static/chunks/webpack-9f8e7d.js');
    expect(buildMarkFromScripts(['/_next/static/chunks/main-app-1a2b.js'])).toBeNull();
    expect(buildMarkFromScripts([])).toBeNull();
  });

  it('без связи и в режиме экономии трафика просьбы нет', () => {
    expect(shouldAskShellRefresh({ onLine: true })).toBe(true);
    expect(shouldAskShellRefresh({ onLine: false })).toBe(false);
    expect(shouldAskShellRefresh({ onLine: true, connection: { saveData: true } })).toBe(false);
  });
});
