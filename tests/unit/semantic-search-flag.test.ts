/**
 * Флаг SEMANTIC_SEARCH и состояние модели поиска по смыслу (аудит 15.10, A21,
 * решение (б)): по умолчанию — как было, выключенный флаг не грузит модель
 * вовсе, отказ загрузки назван в логе и в health, а health отдаёт память
 * процесса — чтобы решать о модели в веб-процессе по числам.
 *
 * Сторож судит поведение (CLAUDE.md §4, 13.10): разбор флага — на граничных
 * значениях; модель — вызовом настоящего lib/ai/embeddings с подменённым
 * @huggingface/transformers (считается, ИМПОРТИРОВАЛИ ли его вообще);
 * health — вызовом настоящего GET.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  importCount: 0,
  pipeline: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => {
  h.importCount += 1;
  return { pipeline: (...args: unknown[]) => h.pipeline(...args) };
});
vi.mock('@/lib/database', () => ({ query: (...args: unknown[]) => h.query(...args) }));

import { parseSemanticSearchFlag } from '@/lib/ai/semantic-search-state';
import { processMemoryMb } from '@/lib/observability/process-memory';

const MODEL_KEY = Symbol.for('vedar.embeddingModel');
const envBefore = process.env.SEMANTIC_SEARCH;

function resetModelState(): void {
  delete (globalThis as Record<symbol, unknown>)[MODEL_KEY];
}

/** Нормированный вектор «запроса» и маршрут с тем же вектором — сходство 1. */
const VEC = [1, 0, 0];
const ROUTE_ROW = {
  id: 'r-1', title: 'Вулкан Горелый', description: null, category: 'volcano',
  source_url: null, source_name: null, lat: '52.55', lng: '158.03', embedding: VEC,
};

async function freshEmbeddings() {
  vi.resetModules();
  return import('@/lib/ai/embeddings');
}

beforeEach(() => {
  h.importCount = 0;
  h.pipeline.mockReset();
  h.query.mockReset();
  h.query.mockResolvedValue({ rows: [ROUTE_ROW] });
  resetModelState();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (envBefore === undefined) delete process.env.SEMANTIC_SEARCH;
  else process.env.SEMANTIC_SEARCH = envBefore;
  resetModelState();
});

describe('разбор флага SEMANTIC_SEARCH', () => {
  it('нет переменной или пусто — включён: умолчание «как было»', () => {
    expect(parseSemanticSearchFlag(undefined)).toBe(true);
    expect(parseSemanticSearchFlag(null)).toBe(true);
    expect(parseSemanticSearchFlag('')).toBe(true);
    expect(parseSemanticSearchFlag('   ')).toBe(true);
  });

  it('0 / false / off — выключен, регистр и пробелы не мешают', () => {
    for (const raw of ['0', 'false', 'off', 'FALSE', ' Off ', 'OFF\n']) {
      expect(parseSemanticSearchFlag(raw), JSON.stringify(raw)).toBe(false);
    }
  });

  it('всё прочее — включён: список выключающих значений явный', () => {
    for (const raw of ['1', 'true', 'on', 'yes', 'выкл', 'disabled', 'no']) {
      expect(parseSemanticSearchFlag(raw), raw).toBe(true);
    }
  });
});

describe('модель при выключенном флаге не грузится вовсе', () => {
  it('semanticSearch отказывает, @huggingface/transformers не импортирован, база не тронута', async () => {
    process.env.SEMANTIC_SEARCH = 'off';
    const { semanticSearch } = await freshEmbeddings();
    await expect(semanticSearch('где медведи', 5)).rejects.toMatchObject({ name: 'SemanticSearchDisabledError' });
    expect(h.importCount).toBe(0);
    expect(h.pipeline).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('прогрев тоже не грузит её', async () => {
    process.env.SEMANTIC_SEARCH = '0';
    const { warmModel } = await freshEmbeddings();
    await expect(warmModel()).rejects.toMatchObject({ name: 'SemanticSearchDisabledError' });
    expect(h.importCount).toBe(0);
  });
});

describe('флаг включён — как раньше, и состояние видно', () => {
  it('модель грузится один раз, поиск отвечает по сходству, состояние loaded', async () => {
    delete process.env.SEMANTIC_SEARCH;
    h.pipeline.mockResolvedValue(async () => ({ data: Float32Array.from(VEC) }));
    const { semanticSearch } = await freshEmbeddings();
    const { embeddingModelStatus } = await import('@/lib/ai/semantic-search-state');

    expect(embeddingModelStatus().state).toBe('not_loaded');
    const hits = await semanticSearch('вулкан', 5);
    await semanticSearch('вулкан ещё раз', 5);

    expect(h.pipeline).toHaveBeenCalledTimes(1);
    expect(hits).toEqual([expect.objectContaining({ id: 'r-1', title: 'Вулкан Горелый', similarity: 1 })]);
    const s = embeddingModelStatus();
    expect(s).toMatchObject({ enabled: true, state: 'loaded', error: null });
    expect(typeof s.load_ms).toBe('number');
  });

  it('модель не загрузилась — отказ доходит до зовущего, назван в логе и в состоянии', async () => {
    delete process.env.SEMANTIC_SEARCH;
    h.pipeline.mockRejectedValue(new Error('Could not load sharp on musl'));
    const { semanticSearch } = await freshEmbeddings();
    const { embeddingModelStatus } = await import('@/lib/ai/semantic-search-state');

    await expect(semanticSearch('вулкан', 5)).rejects.toThrow(/sharp/);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[embeddings] модель поиска по смыслу не загрузилась'),
      expect.stringContaining('sharp'),
    );
    expect(embeddingModelStatus()).toMatchObject({ state: 'load_failed', error: 'Could not load sharp on musl' });
  });
});

describe('память процесса в мегабайтах', () => {
  it('округляет байты до МБ по каждому полю', () => {
    const MB = 1024 * 1024;
    expect(processMemoryMb({
      rss: 812.4 * MB, heapUsed: 301.6 * MB, heapTotal: 400 * MB, external: 52 * MB, arrayBuffers: 0,
    })).toEqual({ rss_mb: 812, heap_mb: 302, heap_total_mb: 400, external_mb: 52 });
  });
});

describe('GET /api/health отдаёт память и состояние модели', () => {
  async function health(): Promise<Record<string, unknown>> {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    return await res.json() as Record<string, unknown>;
  }

  it('rss_mb и heap_mb — числа процесса; модель ещё не грузили — not_loaded', async () => {
    delete process.env.SEMANTIC_SEARCH;
    const body = await health();
    const memory = body.memory as Record<string, unknown>;
    expect(typeof memory.rss_mb).toBe('number');
    expect(memory.rss_mb as number).toBeGreaterThan(0);
    expect(typeof memory.heap_mb).toBe('number');
    expect(body.semantic_search).toMatchObject({ enabled: true, model: 'not_loaded' });
  });

  it('флаг выключен — disabled', async () => {
    process.env.SEMANTIC_SEARCH = 'false';
    expect((await health()).semantic_search).toMatchObject({ enabled: false, model: 'disabled' });
  });

  it('загрузка упала — load_failed, но текст ошибки в открытый роут не уходит', async () => {
    delete process.env.SEMANTIC_SEARCH;
    const { markModelLoadFailed } = await import('@/lib/ai/semantic-search-state');
    markModelLoadFailed(new Error('ENOENT /app/node_modules/sharp/build'), 1200);
    const body = await health();
    expect(body.semantic_search).toMatchObject({ model: 'load_failed', load_ms: 1200 });
    expect(JSON.stringify(body)).not.toContain('/app/node_modules');
  });
});
