// @vitest-environment jsdom
/**
 * Экраны ошибок: «страница не догрузилась» и доклад в ловушку — рендером
 * каждой границы (дайджест ловушки 06.11).
 *
 * Внешний посетитель на /plans/kamchatka-za-5-dney-vulkany получил «Loading
 * chunk 7177 failed. (timeout: …/chunks/app/layout-….js)», род boundary.
 * Браузер не дождался куска кода сайта — это связь, а экран говорил
 * «Произошла непредвиденная ошибка» и давал «Попробовать снова»: reset()
 * не догрузившийся кусок заново не тянет.
 *
 * Сторож держит правило на всех границах сразу. Список берётся из app/ на
 * диске, и новая граница попадает под него сама. Каждая граница:
 *   - докладывает об ошибке в ловушку родом boundary (до 07.11 одиннадцать
 *     из тринадцати ловили ошибку молча);
 *   - на не догрузившемся куске один раз перезагружает страницу сама;
 *   - на повторе за минуту не перезагружает, а говорит правду и даёт кнопку,
 *     которая обновляет страницу целиком;
 *   - на обычной ошибке остаётся своим экраном с reset().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { resetReportState } from '@/lib/client-errors/report';
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_STALL_MS,
  CHUNK_RELOAD_WINDOW_MS,
  CHUNK_TEXT,
  browserPage,
  decideChunkReload,
  isChunkLoadError,
  type ReloadStorage,
} from '@/lib/client-errors/chunk-load';

const ROOT = process.cwd();

/** Все границы ошибок под app/: error.tsx в любом сегменте и корневая. */
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

/** Ошибка из дайджеста 06.11, как её отдаёт webpack. */
function chunkError(): Error {
  return Object.assign(
    new Error('Loading chunk 7177 failed.\n(timeout: https://vedarai.ru/_next/static/chunks/app/layout-8d0a94be089982f7.js)'),
    { name: 'ChunkLoadError' },
  );
}

type Sent = Record<string, unknown>;
const beaconBlobs: Blob[] = [];

async function sentPayloads(): Promise<Sent[]> {
  const out: Sent[] = [];
  for (const b of beaconBlobs) {
    const text = typeof b.text === 'function' ? await b.text() : await new Response(b).text();
    out.push(JSON.parse(text) as Sent);
  }
  return out;
}

function setOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
}

let reload: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetReportState();
  sessionStorage.clear();
  localStorage.clear();
  setOnline(true);
  beaconBlobs.length = 0;
  Object.defineProperty(navigator, 'sendBeacon', {
    value: vi.fn((_url: string, blob: Blob) => { beaconBlobs.push(blob); return true; }),
    configurable: true,
    writable: true,
  });
  reload = vi.spyOn(browserPage, 'reload').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('что считается «не догрузилось»', () => {
  it('род ChunkLoadError и сообщения загрузчиков кода — да', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    // Род решает и без знакомого текста: обёртки меняют сообщение, род остаётся.
    expect(isChunkLoadError(Object.assign(new Error('chunk 7177'), { name: 'ChunkLoadError' }))).toBe(true);
    for (const message of [
      'Loading chunk app/plans/page failed.\n(error: https://vedarai.ru/_next/static/chunks/app/plans/page-1.js)',
      'Loading chunk app/(main)/routes/[id]/page failed.\n(missing: https://vedarai.ru/_next/static/chunks/app/(main)/page.js)',
      'Loading CSS chunk 512 failed.\n(/_next/static/css/2b.css)',
      'Failed to fetch dynamically imported module: https://vedarai.ru/_next/static/chunks/42.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
  });

  it('обычная ошибка, пустота и чужие слова про «chunk» — нет', () => {
    for (const err of [
      new Error('render exploded'),
      new TypeError("Cannot read properties of undefined (reading 'length')"),
      new Error('Loading chunks of data failed'),
      null,
      undefined,
      'Loading chunk 1 failed.',
      {},
    ]) {
      expect(isChunkLoadError(err), String(err)).toBe(false);
    }
  });
});

describe('решение о перезагрузке', () => {
  const memory = (): ReloadStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
  };
  const now = 1_800_000_000_000;

  it('первая попытка на адресе — перезагрузка и запись о ней', () => {
    const s = memory();
    expect(decideChunkReload({ path: '/plans/x', now, online: true, storage: s })).toBe('reload');
    expect(JSON.parse(s.data.get(CHUNK_RELOAD_KEY) ?? '{}')).toEqual({ path: '/plans/x', at: now });
  });

  it('повтор за минуту на том же адресе — экран; позже или на другом адресе — снова перезагрузка', () => {
    const s = memory();
    decideChunkReload({ path: '/plans/x', now, online: true, storage: s });
    expect(decideChunkReload({ path: '/plans/x', now: now + 5_000, online: true, storage: s })).toBe('already-tried');
    expect(decideChunkReload({ path: '/plans/x', now: now + CHUNK_RELOAD_WINDOW_MS - 1, online: true, storage: s })).toBe('already-tried');
    expect(decideChunkReload({ path: '/plans/x', now: now + CHUNK_RELOAD_WINDOW_MS, online: true, storage: s })).toBe('reload');
    expect(decideChunkReload({ path: '/routes/7', now: now + CHUNK_RELOAD_WINDOW_MS + 1, online: true, storage: s })).toBe('reload');
  });

  it('без сети — не перезагружает и записи не оставляет', () => {
    const s = memory();
    expect(decideChunkReload({ path: '/', now, online: false, storage: s })).toBe('offline');
    expect(s.data.size).toBe(0);
  });

  it('хранилища нет или оно не пишет — не перезагружает: цикл нечем удержать', () => {
    expect(decideChunkReload({ path: '/', now, online: true, storage: null })).toBe('no-storage');
    const broken: ReloadStorage = { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } };
    expect(decideChunkReload({ path: '/', now, online: true, storage: broken })).toBe('no-storage');
  });

  it('испорченная запись — попытки не было, перезагрузка', () => {
    // Время — настоящее: выдуманная «свежая» попытка на месте испорченной
    // записи дала бы экран вместо перезагрузки.
    const at = Date.now();
    for (const junk of ['{oops', '"text"', '{"path":"/"}', '{"at":1}', 'null']) {
      const s = memory();
      s.data.set(CHUNK_RELOAD_KEY, junk);
      expect(decideChunkReload({ path: '/', now: at, online: true, storage: s }), junk).toBe('reload');
    }
  });
});

describe('каждая граница ошибок', () => {
  const files = boundaryFiles();

  it('список границ найден на диске, корневые в нём', () => {
    expect(files).toContain(join('app', 'global-error.tsx'));
    expect(files).toContain(join('app', 'error.tsx'));
    expect(files.length).toBeGreaterThan(2);
  });

  async function load(file: string) {
    const mod = (await import(join(ROOT, file))) as {
      default: (p: { error: Error & { digest?: string }; reset: () => void }) => React.ReactElement;
    };
    return mod.default;
  }

  for (const file of files) {
    describe(file, () => {
      it('не догрузился кусок: доклад, одна автоперезагрузка, «Обновляем страницу…» без кнопки', async () => {
        const Boundary = await load(file);
        render(React.createElement(Boundary, { error: chunkError(), reset: vi.fn() }));
        await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(await screen.findByText(CHUNK_TEXT.reloading)).toBeTruthy();
        expect(screen.queryByRole('button', { name: CHUNK_TEXT.button })).toBeNull();
        const sent = await sentPayloads();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'boundary' });
        expect(String(sent[0].message)).toContain('Loading chunk 7177 failed');
      });

      it('повтор за минуту: не перезагружает, говорит правду, кнопка обновляет страницу целиком', async () => {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ path: window.location.pathname, at: Date.now() - 5_000 }));
        const Boundary = await load(file);
        const reset = vi.fn();
        render(React.createElement(Boundary, { error: chunkError(), reset }));
        expect(await screen.findByText(CHUNK_TEXT.title)).toBeTruthy();
        expect(screen.getByText(CHUNK_TEXT.body)).toBeTruthy();
        expect(screen.queryByText(/непредвиденная ошибка/i)).toBeNull();
        expect(reload).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: CHUNK_TEXT.button }));
        expect(reload).toHaveBeenCalledTimes(1);
        expect(reset).not.toHaveBeenCalled();
      });

      it('перезагрузка не случилась за срок — появляется кнопка, второй автоперезагрузки нет', async () => {
        const Boundary = await load(file);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          render(React.createElement(Boundary, { error: chunkError(), reset: vi.fn() }));
          expect(reload).toHaveBeenCalledTimes(1);
          expect(screen.getByText(CHUNK_TEXT.reloading)).toBeTruthy();
          act(() => { vi.advanceTimersByTime(CHUNK_RELOAD_STALL_MS - 1); });
          expect(screen.queryByRole('button', { name: CHUNK_TEXT.button })).toBeNull();
          act(() => { vi.advanceTimersByTime(1); });
          expect(screen.getByText(CHUNK_TEXT.body)).toBeTruthy();
          fireEvent.click(screen.getByRole('button', { name: CHUNK_TEXT.button }));
          expect(reload).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it('без сети: не перезагружает и говорит, что связи нет', async () => {
        setOnline(false);
        const Boundary = await load(file);
        render(React.createElement(Boundary, { error: chunkError(), reset: vi.fn() }));
        expect(await screen.findByText(CHUNK_TEXT.offline)).toBeTruthy();
        expect(reload).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: CHUNK_TEXT.button })).toBeTruthy();
      });

      it('обычная ошибка: свой экран, доклад в ловушку, кнопка зовёт reset()', async () => {
        const Boundary = await load(file);
        const reset = vi.fn();
        render(React.createElement(Boundary, { error: new Error('render exploded'), reset }));
        await waitFor(async () => expect(await sentPayloads()).toHaveLength(1));
        const [sent] = await sentPayloads();
        expect(sent).toMatchObject({ kind: 'boundary', message: 'render exploded' });
        expect(screen.queryByText(CHUNK_TEXT.title)).toBeNull();
        fireEvent.click(screen.getByRole('button'));
        expect(reset).toHaveBeenCalledTimes(1);
        expect(reload).not.toHaveBeenCalled();
      });
    });
  }
});
