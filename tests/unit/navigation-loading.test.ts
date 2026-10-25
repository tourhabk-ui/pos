/**
 * Переход должен быть виден, а висящая сеть — заканчиваться.
 *
 * Полевой прогон 04.08 (EDGE, «одна палка»): работала только главная, любой
 * переход выглядел как «ничего не происходит». Две независимые причины, обе
 * не про офлайн — офлайн как раз отработан честно:
 *
 *  1. Service worker ловил только ОТКЛОНЁННЫЙ fetch. При живой, но издыхающей
 *     сети запрос не отклоняется, он висит; `.catch` не срабатывает никогда,
 *     кэш не отдаётся. «Почти офлайн» в горах — обычное состояние связи, и
 *     именно его обработки не было.
 *  2. У страниц не было `loading.tsx` (6 из 210). App Router до готовности
 *     серверного компонента держит СТАРЫЙ экран: на быстрой сети незаметно,
 *     на медленной — молчание, неотличимое от сломанной кнопки.
 *
 * Сторож закрывает обе. Ответ worker судится вызовом: sw.js исполняется в
 * песочнице vm с подставленными fetch и caches, и проверяется, что получил
 * respondWith (проверка качества 24.10: поиск строк `function emptyOffline`
 * оставался зелёным, когда отказ снова отдавал undefined вместо Response).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SW = read('public/sw.js');
const NAV = read('components/shared/BottomNav.tsx');
const HOME = read('app/_home/_HomeV8Client.tsx');

/** Куда уводит таб-бар: пути из ITEMS, без query. */
function tabBarRoutes(): string[] {
  const items = NAV.match(/href:\s*'([^']+)'/g) ?? [];
  return items
    .map((m) => m.replace(/href:\s*'|'/g, '').split('?')[0])
    .filter((p) => p.startsWith('/'));
}

/** Куда уводит блок безопасности главной: внутренние ссылки без query и якоря. */
function homeSafetyRoutes(): string[] {
  const hrefs = HOME.match(/href="(\/[^"#?]*)/g) ?? [];
  return hrefs.map((m) => m.replace('href="', ''));
}

function routeDir(pathname: string): string {
  return pathname === '/' ? 'app' : join('app', pathname.slice(1));
}

/**
 * Скелет адреса: `loading.tsx` рядом со страницей — в папке адреса или в его
 * группе маршрутов `(…)`, где лежит сама `page.tsx`. Группа нужна спискам
 * /catalog и /routes (аудит SEO 29.09, Н2): файл загрузки в корне раздела
 * оборачивал и карточки, и их 404/308 уходили наружу как 200.
 */
function hasLoading(pathname: string): boolean {
  const dir = join(ROOT, routeDir(pathname));
  if (existsSync(join(dir, 'loading.tsx'))) return true;
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((d) => /^\(.+\)$/.test(d)
    && existsSync(join(dir, d, 'page.tsx')) && existsSync(join(dir, d, 'loading.tsx')));
}

/** Страница адреса — в его папке или в группе маршрутов. */
function hasPage(pathname: string): boolean {
  const dir = join(ROOT, routeDir(pathname));
  if (existsSync(join(dir, 'page.tsx'))) return true;
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((d) => /^\(.+\)$/.test(d) && existsSync(join(dir, d, 'page.tsx')));
}

type Cached = (key: unknown) => Response | undefined;

interface Worker {
  /** Что получил respondWith; undefined — запрос не перехвачен. */
  respond(path: string, init?: { mode?: string; destination?: string }): Promise<unknown> | undefined;
  /** Сработать таймерам, которые worker поставил к этому моменту. */
  fireTimers(): void;
}

/**
 * sw.js в песочнице: fetch и caches подставлены, таймеры копятся и
 * срабатывают по команде, чтобы «висящую» сеть отличать от отказа.
 */
function loadWorker(net: () => Promise<Response>, cached: Cached): Worker {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const timers: Array<() => void> = [];
  const cacheStore = {
    match: async (key: unknown) => cached(key),
    put: async () => undefined,
    keys: async () => [],
    delete: async () => true,
  };
  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      location: { origin: 'https://vedarai.ru' },
      registration: { showNotification: async () => undefined },
      clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
      skipWaiting: async () => undefined,
    },
    caches: {
      match: async (key: unknown) => cached(key),
      open: async () => cacheStore,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: () => net(),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => undefined,
    Response, Headers, URL, atob, Uint8Array, Promise, console,
  });
  vm.runInContext(SW, context, { filename: 'public/sw.js' });
  return {
    respond(path, init = { mode: 'navigate', destination: 'document' }) {
      let answer: Promise<unknown> | undefined;
      const request = {
        method: 'GET',
        url: `https://vedarai.ru${path}`,
        mode: init.mode,
        destination: init.destination,
        cache: 'default',
        headers: new Headers(),
      };
      for (const fn of listeners.get('fetch') ?? []) {
        fn({ request, respondWith: (value: unknown) => { answer = Promise.resolve(value); } });
      }
      return answer;
    },
    fireTimers() {
      for (const fn of timers.splice(0)) fn();
    },
  };
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const nothingCached: Cached = () => undefined;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('service worker: отказ сети заканчивается Response, а не undefined (вызов в vm)', () => {
  for (const path of ['/catalog', '/map', '/places/0a1b2c3d', '/tours/0a1b2c3d']) {
    it(`${path}: сети нет, кэш пуст — 503, а не TypeError в respondWith`, async () => {
      const answer = await loadWorker(offline, nothingCached).respond(path);
      expect(answer).toBeInstanceOf(Response);
      expect((answer as Response).status).toBe(503);
    });
  }

  it('сети нет, копии страницы нет — отдаётся сохранённая /offline', async () => {
    const page = new Response('нет соединения', { status: 200 });
    const answer = await loadWorker(offline, (key) => (key === '/offline' ? page : undefined)).respond('/catalog');
    expect(answer).toBe(page);
  });

  it('сети нет, копия страницы есть — отдаётся копия', async () => {
    const copy = new Response('карточка места', { status: 200 });
    const answer = await loadWorker(offline, (key) => (typeof key === 'object' ? copy : undefined)).respond('/places/0a1b2c3d');
    expect(answer).toBe(copy);
  });

  it('по таймауту отдаётся кэш, а без кэша сеть ждут дальше', async () => {
    // Обрывать медленную, но живую загрузку нечем заменить: белый экран через
    // 4 секунды был бы враньём наоборот.
    const copy = new Response('главная из кэша', { status: 200 });
    const hanging = loadWorker(() => new Promise<Response>(() => undefined), (key) => (typeof key === 'object' ? copy : undefined));
    const fromCache = hanging.respond('/');
    hanging.fireTimers();
    expect(await fromCache).toBe(copy);

    let arrive: (r: Response) => void = () => undefined;
    const slow = loadWorker(() => new Promise<Response>((resolve) => { arrive = resolve; }), nothingCached);
    const answer = slow.respond('/');
    let settled = false;
    void answer?.then(() => { settled = true; });
    slow.fireTimers();
    await flush();
    expect(settled).toBe(false);
    const late = new Response('главная из сети', { status: 200 });
    arrive(late);
    expect(await answer).toBe(late);
  });
});

describe('service worker: висящая сеть заканчивается таймаутом', () => {
  it('навигация не ждёт сеть бесконечно', () => {
    expect(SW).toMatch(/NAV_TIMEOUT_MS/);
    expect(SW).toMatch(/function navigateWithTimeout/);
  });

  it('RSC-пейлоад тоже под таймаутом — иначе переход виснет молча', () => {
    expect(SW).toMatch(/RSC_TIMEOUT_MS/);
  });

  it('обе ветки навигации идут через таймаут, а не голый fetch', () => {
    // Ветка whitelist и общая ветка — обе должны звать общий помощник.
    const calls = SW.match(/navigateWithTimeout\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // объявление + два вызова
  });

  it('кэш пересобран — иначе у телефонов останется старый worker', () => {
    const version = SW.match(/CACHE_NAME = 'kamchatour-v(\d+)'/)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(22);
  });
});

describe('навигация: переход виден сразу', () => {
  it('у каждой цели таб-бара есть скелетон', () => {
    const routes = tabBarRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const r of routes) {
      if (r === '/') continue; // главная — точка старта, не переход
      expect(hasLoading(r), `${r}: нет loading.tsx`).toBe(true);
    }
  });

  it('у целей блока безопасности главной есть скелетон', () => {
    const routes = homeSafetyRoutes().filter((r) => hasPage(r));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      if (r === '/') continue;
      expect(hasLoading(r), `${r}: нет loading.tsx`).toBe(true);
    }
  });

  it('скелетон объявлен как состояние загрузки, а не немая заглушка', () => {
    const shared = read('components/shared/RouteLoading.tsx');
    expect(shared).toMatch(/role="status"/);
    expect(shared).toMatch(/aria-label="Загрузка/);
  });
});
