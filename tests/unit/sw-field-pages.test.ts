/**
 * Карточки, которые смотрят дома, открываются на слабой связи.
 *
 * Жалоба владельца 08.11: «PWA не работает при плохой связи». Причина была в
 * адресах, а не в таймаутах: шаблоны service worker'а писались под uuid
 * (`/places/<hex>`, `/tours/<hex>`), а сайт перешёл на слаги. Перепись
 * sitemap 08.11: из 385 карточек мест узнавалось 3, из 75 карточек туров — ни
 * одной, у маршрутов (373) ветки не было вовсе. Неузнанная карточка уходила в
 * общую ветку, а та сохраняет только главную — в память телефона она не
 * попадала, и на слабой связи показать было нечего.
 *
 * Прежний сторож (`navigation-loading`) судил адреса `/places/0a1b2c3d` —
 * ровно ту форму, которую шаблон и знал, — и потому был зелёным всё это
 * время. Здесь адреса — настоящие, из sitemap, и worker судится вызовом в
 * песочнице vm: что получил respondWith, что легло в кэш, какой поставлен таймер.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');

type Key = string | { url: string };
const keyUrl = (k: Key) => (typeof k === 'string' ? k : k.url);

interface Sandbox {
  respond(path: string, init?: { mode?: string; destination?: string }): Promise<unknown> | undefined;
  /** Сработать таймерам; delays — с какими сроками они ставились. */
  fireTimers(): void;
  delays: number[];
  puts: string[];
  deleted: string[];
}

/**
 * sw.js в песочнице. `net` отвечает за сеть, `stored` — что лежит в кэше
 * (по полному адресу). Записанное через cache.put попадает в `puts` и в
 * `stored`, так что следующий запрос видит копию, как в браузере.
 */
function loadWorker(net: (url: string) => Promise<Response>, stored: Map<string, Response>): Sandbox {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const puts: string[] = [];
  const deleted: string[] = [];
  const match = async (key: Key) => stored.get(keyUrl(key))?.clone();
  const cacheStore = {
    match,
    put: async (key: Key, res: Response) => { puts.push(keyUrl(key)); stored.set(keyUrl(key), res); },
    keys: async () => [...stored.keys()].map((url) => ({ url })),
    delete: async (key: Key) => { deleted.push(keyUrl(key)); return stored.delete(keyUrl(key)); },
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
    caches: { match, open: async () => cacheStore, keys: async () => [], delete: async () => true },
    fetch: (req: Key) => net(keyUrl(req)),
    setTimeout: (fn: () => void, ms: number) => { timers.push(fn); delays.push(ms); return timers.length; },
    clearTimeout: () => undefined,
    Response, Headers, URL, atob, Uint8Array, Promise, console,
  });
  vm.runInContext(SW, context, { filename: 'public/sw.js' });
  return {
    respond(path, init = { mode: 'navigate', destination: 'document' }) {
      let answer: Promise<unknown> | undefined;
      const request = {
        method: 'GET', url: `https://vedarai.ru${path}`, mode: init.mode, destination: init.destination,
        cache: 'default', headers: new Headers(),
      };
      for (const fn of listeners.get('fetch') ?? []) {
        fn({ request, respondWith: (value: unknown) => { answer = Promise.resolve(value); } });
      }
      return answer;
    },
    fireTimers() { for (const fn of timers.splice(0)) fn(); },
    delays,
    puts,
    deleted,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const hanging = () => new Promise<Response>(() => undefined);
const page = (text: string) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/html' } });

/** Ответ к этому моменту: висящий промис отличается от отданного. */
async function settledNow(answer: Promise<unknown> | undefined) {
  let state: { settled: boolean; value: unknown } = { settled: false, value: undefined };
  void answer?.then((value) => { state = { settled: true, value }; });
  await flush();
  return state;
}

async function text(value: unknown): Promise<string> {
  expect(value).toBeInstanceOf(Response);
  return (value as Response).text();
}

/**
 * Карточки — настоящие адреса из sitemap 08.11: слаги, номер тура, старый
 * uuid места, короткий адрес тура и зона маршрута.
 */
const CARDS = [
  '/places/kurilskoe-ozero',
  '/places/0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379',
  '/catalog/tours/lagexp-kamchatka-na-maksimum-zimnij-marshrut',
  '/catalog/tours/122',
  '/tours/lagexp-kamchatka-letnij-ekspress',
  '/routes/visitkamchatka-death-valley',
  '/routes/trekking/eastern',
];

/**
 * Каждая динамическая страница карточки в app/ даёт свой образец адреса:
 * появится новая вложенность — сторож спросит и её.
 */
function cardPagesFromApp(): string[] {
  const out: string[] = [];
  const dirs: Array<[string, string]> = [
    ['app/places/[id]', '/places/some-place'],
    ['app/catalog/tours/[id]', '/catalog/tours/some-tour'],
    ['app/routes/[id]', '/routes/some-route'],
  ];
  for (const [dir, sample] of dirs) {
    if (!existsSync(join(ROOT, dir, 'page.tsx'))) continue;
    out.push(sample);
    for (const sub of readdirSync(join(ROOT, dir))) {
      if (/^\[.+\]$/.test(sub) && existsSync(join(ROOT, dir, sub, 'page.tsx'))) out.push(`${sample}/some-${sub.slice(1, -1)}`);
    }
  }
  return out;
}

describe('карточки по настоящим адресам сохраняются в память телефона (вызов в vm)', () => {
  it('образцы из app/ найдены — сторож не сторожит пустоту', () => {
    expect(cardPagesFromApp().length).toBeGreaterThanOrEqual(4);
  });

  for (const path of [...CARDS, ...cardPagesFromApp()]) {
    it(`${path}: открыта онлайн — копия легла в кэш`, async () => {
      const stored = new Map<string, Response>();
      const worker = loadWorker(async () => page('свежая карточка'), stored);
      expect(await text(await worker.respond(path))).toBe('свежая карточка');
      await flush(); await flush();
      expect(worker.puts, `${path}: страница не сохранена — на слабой связи показать будет нечего`)
        .toContain(`https://vedarai.ru${path}`);
    });

    it(`${path}: связь висит — через таймаут отдаётся сохранённая копия`, async () => {
      const stored = new Map([[`https://vedarai.ru${path}`, page('копия карточки')]]);
      const worker = loadWorker(hanging, stored);
      const answer = worker.respond(path);
      expect((await settledNow(answer)).settled).toBe(false);
      worker.fireTimers();
      const { settled, value } = await settledNow(answer);
      expect(settled, `${path}: копия есть, а worker ждёт сеть бесконечно`).toBe(true);
      expect(await text(value)).toBe('копия карточки');
    });
  }

  it('связь есть — отдаётся свежая карточка, а не старая копия (после деплоя копия ссылается на удалённые чанки)', async () => {
    const path = '/catalog/tours/lagexp-kamchatka-na-maksimum-zimnij-marshrut';
    const stored = new Map([[`https://vedarai.ru${path}`, page('старая копия')]]);
    const worker = loadWorker(async () => page('свежая карточка'), stored);
    expect(await text(await worker.respond(path))).toBe('свежая карточка');
  });

  it('сети нет — копия, а без копии экран «нет соединения»', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    const path = '/places/kurilskoe-ozero';
    const withCopy = loadWorker(offline, new Map([[`https://vedarai.ru${path}`, page('копия')]]));
    expect(await text(await withCopy.respond(path))).toBe('копия');
    const noCopy = loadWorker(offline, new Map([['/offline', page('нет соединения')]]));
    expect(await text(await noCopy.respond(path))).toBe('нет соединения');
  });

  it('формы карточек (вложенные адреса) не сохраняются', async () => {
    for (const path of ['/places/kurilskoe-ozero/review', '/catalog/tours/122/request']) {
      const worker = loadWorker(async () => page('форма'), new Map());
      await worker.respond(path);
      await flush(); await flush();
      expect(worker.puts, path).not.toContain(`https://vedarai.ru${path}`);
    }
  });

  it('маршрутов в памяти не больше 30: старые уходят первыми', async () => {
    const stored = new Map<string, Response>();
    for (let i = 0; i < 30; i++) stored.set(`https://vedarai.ru/routes/r-${i}`, page(String(i)));
    const worker = loadWorker(async () => page('новый'), stored);
    await worker.respond('/routes/new-route');
    for (let i = 0; i < 5; i++) await flush();
    expect(worker.deleted).toEqual(['https://vedarai.ru/routes/r-0']);
  });
});

describe('данные карточки места (API) на слабой связи (вызов в vm)', () => {
  const api = '/api/places/kurilskoe-ozero';
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('слаг в адресе узнаётся: ответ ложится в кэш', async () => {
    const worker = loadWorker(async () => json({ success: true }), new Map());
    await worker.respond(api, { mode: 'cors', destination: '' });
    await flush(); await flush();
    expect(worker.puts).toContain(`https://vedarai.ru${api}`);
  });

  it('связь висит — через таймаут отдаётся копия данных', async () => {
    const stored = new Map([[`https://vedarai.ru${api}`, json({ success: true, data: { name: 'копия' } })]]);
    const worker = loadWorker(hanging, stored);
    const answer = worker.respond(api, { mode: 'cors', destination: '' });
    expect((await settledNow(answer)).settled).toBe(false);
    worker.fireTimers();
    const { settled, value } = await settledNow(answer);
    expect(settled).toBe(true);
    expect(JSON.parse(await text(value)).data.name).toBe('копия');
  });

  it('сети нет и копии нет — 503 с объяснением, а не вечное ожидание', async () => {
    const worker = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')), new Map());
    const answer = await worker.respond(api, { mode: 'cors', destination: '' });
    expect((answer as Response).status).toBe(503);
    expect(JSON.parse(await text(answer)).error).toMatch(/Нет подключения/);
  });
});

describe('клиентский переход на слабой связи (вызов в vm)', () => {
  const path = '/places/kurilskoe-ozero';
  const rsc = `${path}?_rsc=1a2b`;
  const asRsc = { mode: 'cors', destination: '' };

  it('копия документа есть — переход сдаётся за 4 с, а не за 8', async () => {
    const worker = loadWorker(hanging, new Map([[`https://vedarai.ru${path}`, page('копия')]]));
    worker.respond(rsc, asRsc);
    await flush(); await flush();
    expect(worker.delays).toContain(4000);
    expect(worker.delays).not.toContain(8000);
  });

  it('копии нет — переход ждёт сеть дольше (8 с)', async () => {
    const worker = loadWorker(hanging, new Map());
    worker.respond(rsc, asRsc);
    await flush(); await flush();
    expect(worker.delays).toContain(8000);
  });

  it('после сдавшегося перехода документ отдаётся из копии сразу, без второго ожидания', async () => {
    const worker = loadWorker(hanging, new Map([[`https://vedarai.ru${path}`, page('копия')]]));
    const payload = worker.respond(rsc, asRsc);
    await flush(); await flush();
    worker.fireTimers();
    expect(((await settledNow(payload)).value as Response).status).toBe(503);

    const doc = worker.respond(path);
    const { settled, value } = await settledNow(doc);
    expect(settled, 'документ снова ждёт висящую сеть — турист видит немой экран ещё 4 секунды').toBe(true);
    expect(await text(value)).toBe('копия');
  });
});
