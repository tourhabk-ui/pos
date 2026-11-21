// @vitest-environment jsdom
/**
 * Экран ошибки — не тупик: 112 и экран SOS на каждом (экран в машине, 21.11).
 *
 * Владелец открыл сайт на экране в машине (старый Chrome на Android). /sos
 * упал в «Произошла ошибка» с «Попробовать снова» и «На главную», главная —
 * в «Страница не догрузилась». Шапки с кнопкой SOS на таких экранах нет, и
 * человек без связи нажимал SOS и попадал на «Связи нет» («и сос не та
 * страница»).
 *
 * Сторож держит:
 *   - каждая граница ошибок под app/ (список — с диска, новая попадает сама)
 *     показывает звонок 112 и ссылку на /emergency при любом исходе: обычная
 *     ошибка, не догрузившийся кусок, автоперезагрузка, без сети — рендером;
 *   - граница экрана SOS ставит звонок раньше кнопки повтора — рендером;
 *   - service worker: /sos без своей копии отдаёт копию /emergency, а не
 *     «Связи нет»; своя копия /sos — по-прежнему она; обычная страница без
 *     копии — «Связи нет», как была — вызовом в песочнице vm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';
import { render, cleanup, screen, within } from '@testing-library/react';
import { resetReportState } from '@/lib/client-errors/report';
import { CHUNK_RELOAD_KEY, browserPage } from '@/lib/client-errors/chunk-load';
import { EMERGENCY_SCREEN_PATH, ERROR_EMERGENCY_TEXT } from '@/components/shared/ErrorEmergencyLinks';

const ROOT = process.cwd();

function boundaryFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'error.tsx' || e.name === 'global-error.tsx') out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'app'));
  return out.sort();
}

function chunkError(): Error {
  return Object.assign(
    new Error('Loading chunk 54449 failed.\n(missing: https://vedarai.ru/_next/static/chunks/54449-24d2717d6a1da07b.js)'),
    { name: 'ChunkLoadError' },
  );
}

function setOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
}

type BoundaryProps = { error: Error & { digest?: string }; reset: () => void };

async function load(file: string) {
  const mod = (await import(join(ROOT, file))) as { default: (p: BoundaryProps) => React.ReactElement };
  return mod.default;
}

/** Звонок и экран SOS на месте; возвращает ссылку звонка. */
function expectEmergency(): HTMLElement {
  const nav = screen.getByRole('navigation', { name: 'Экстренная помощь' });
  const call = within(nav).getByRole('link', { name: ERROR_EMERGENCY_TEXT.call });
  expect(call.getAttribute('href')).toBe('tel:112');
  const sos = within(nav).getByRole('link', { name: ERROR_EMERGENCY_TEXT.screen });
  expect(sos.getAttribute('href')).toBe(EMERGENCY_SCREEN_PATH);
  return call;
}

beforeEach(() => {
  resetReportState();
  sessionStorage.clear();
  setOnline(true);
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(() => true), configurable: true, writable: true });
  vi.spyOn(browserPage, 'reload').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('каждая граница ошибок даёт 112 и экран SOS', () => {
  const files = boundaryFiles();

  it('граница экрана SOS есть в списке', () => {
    expect(files).toContain(join('app', 'sos', 'error.tsx'));
  });

  for (const file of files) {
    describe(file, () => {
      it('обычная ошибка', async () => {
        const Boundary = await load(file);
        render(<Boundary error={new Error('render exploded')} reset={vi.fn()} />);
        expectEmergency();
      });

      it('не догрузился кусок, идёт автоперезагрузка', async () => {
        const Boundary = await load(file);
        render(<Boundary error={chunkError()} reset={vi.fn()} />);
        expectEmergency();
      });

      it('не догрузился кусок повторно — экран с кнопкой', async () => {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ path: window.location.pathname, at: Date.now() - 5_000 }));
        const Boundary = await load(file);
        render(<Boundary error={chunkError()} reset={vi.fn()} />);
        expectEmergency();
      });

      it('без сети', async () => {
        setOnline(false);
        const Boundary = await load(file);
        render(<Boundary error={chunkError()} reset={vi.fn()} />);
        expectEmergency();
      });
    });
  }
});

describe('граница экрана SOS', () => {
  it('говорит, что экран SOS не открылся, и ставит звонок раньше кнопки повтора', async () => {
    const Boundary = await load(join('app', 'sos', 'error.tsx'));
    const reset = vi.fn();
    render(<Boundary error={new TypeError('crypto.randomUUID is not a function')} reset={reset} />);
    expect(screen.getByRole('heading', { name: 'Экран SOS не открылся' })).toBeTruthy();
    const call = expectEmergency();
    const retry = screen.getByRole('button', { name: 'Попробовать снова' });
    expect(call.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    retry.click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

// ── service worker в песочнице ───────────────────────────────────────────────

const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');
type Key = string | { url: string };
const keyUrl = (k: Key) => (typeof k === 'string' ? k : k.url);

function loadWorker(net: (url: string) => Promise<Response>, stored: Map<string, Response>) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const timers: Array<() => void> = [];
  const match = async (key: Key) => stored.get(keyUrl(key))?.clone();
  const cacheStore = {
    match,
    put: async (key: Key, res: Response) => { stored.set(keyUrl(key), res); },
    keys: async () => [...stored.keys()].map((url) => ({ url })),
    delete: async (key: Key) => stored.delete(keyUrl(key)),
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
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => undefined,
    Response, Headers, URL, atob, Uint8Array, Promise, console,
  });
  vm.runInContext(SW, context, { filename: 'public/sw.js' });
  return {
    navigate(path: string): Promise<unknown> | undefined {
      let answer: Promise<unknown> | undefined;
      const request = {
        method: 'GET', url: `https://vedarai.ru${path}`, mode: 'navigate', destination: 'document',
        cache: 'default', headers: new Headers(),
      };
      for (const fn of listeners.get('fetch') ?? []) {
        fn({ request, respondWith: (value: unknown) => { answer = Promise.resolve(value); } });
      }
      return answer;
    },
    fireTimers() { for (const fn of timers.splice(0)) fn(); },
  };
}

const page = (text: string) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/html' } });
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const hanging = () => new Promise<Response>(() => undefined);
const flush = () => new Promise((r) => setTimeout(r, 0));

async function text(answer: Promise<unknown> | undefined): Promise<string> {
  const value = await answer;
  expect(value).toBeInstanceOf(Response);
  return (value as Response).text();
}

describe('service worker: SOS без связи — экран SOS, а не «Связи нет»', () => {
  const copies = () => new Map<string, Response>([
    ['/offline', page('Связи нет')],
    ['/emergency', page('SOS без сети')],
  ]);

  it('сети нет, копии /sos нет — копия /emergency', async () => {
    const sw = loadWorker(offline, copies());
    expect(await text(sw.navigate('/sos'))).toBe('SOS без сети');
  });

  it('сеть висит, копии /sos нет — по таймеру копия /emergency', async () => {
    const sw = loadWorker(hanging, copies());
    const answer = sw.navigate('/sos');
    await flush();
    sw.fireTimers();
    expect(await text(answer)).toBe('SOS без сети');
  });

  it('своя копия /sos есть — отдаётся она', async () => {
    const stored = copies();
    stored.set('https://vedarai.ru/sos', page('SOS со страницы'));
    const sw = loadWorker(offline, stored);
    expect(await text(sw.navigate('/sos'))).toBe('SOS со страницы');
  });

  it('обычная страница без копии — «Связи нет», как была', async () => {
    const sw = loadWorker(offline, copies());
    expect(await text(sw.navigate('/catalog'))).toBe('Связи нет');
  });
});
