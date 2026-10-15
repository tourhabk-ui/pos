/**
 * Зовущие поиска по смыслу под флагом SEMANTIC_SEARCH (аудит 15.10, A21):
 * /api/search, /api/routes/search и контекст Кузьмича (lib/ai/rag-context).
 *
 * Флаг выключен — модель не зовётся, ответ идёт по совпадению слов и говорит
 * это (поле ответа, строка в лог). Флаг включён — как раньше. Отказ модели в
 * контексте Кузьмича больше не глушится `.catch(() => [])`: результат прежний,
 * причина в логе.
 *
 * Сторож судит поведение (CLAUDE.md §4, 13.10): настоящие роуты и
 * buildRAGContext с подменёнными базой и semanticSearch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  poolQuery: vi.fn(),
  semanticSearch: vi.fn(),
  findRelevantTours: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => h.query(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => h.poolQuery(...a) } }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: (...a: unknown[]) => h.semanticSearch(...a) }));
vi.mock('@/lib/ai/route-knowledge', () => ({
  getRouteSearchCache: vi.fn(() => null),
  setRouteSearchCache: vi.fn(),
}));
vi.mock('@/lib/search/tour-query-match', () => ({
  findToursForQuery: vi.fn(async () => []),
  tourPriceFrom: () => null,
}));
vi.mock('@/lib/ai/booking-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/booking-intent')>()),
  findRelevantTours: (...a: unknown[]) => h.findRelevantTours(...a),
}));

import { GET as globalSearch } from '@/app/api/search/route';
import { GET as routesSearch } from '@/app/api/routes/search/route';
import { buildRAGContext } from '@/lib/ai/rag-context';

const envBefore = process.env.SEMANTIC_SEARCH;
const ILIKE_ROUTE = { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Вулкан Горелый', category: 'vulkani', location_type: 'volcano' };
const RAG_ROUTE = { title: 'Авачинский вулкан', description: 'Домашний вулкан', category: 'volcano', lat: 53.25, lng: 158.83 };

beforeEach(() => {
  h.query.mockReset();
  h.poolQuery.mockReset();
  h.semanticSearch.mockReset();
  h.findRelevantTours.mockReset();
  h.findRelevantTours.mockResolvedValue([]);
  h.semanticSearch.mockResolvedValue([]);
  h.query.mockImplementation(async (sql: string) => (
    /FROM kamchatka_routes/.test(sql) ? { rows: [ILIKE_ROUTE] } : { rows: [] }
  ));
  h.poolQuery.mockImplementation(async (sql: string) => (/ts_rank/.test(sql) ? { rows: [RAG_ROUTE] } : { rows: [] }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (envBefore === undefined) delete process.env.SEMANTIC_SEARCH;
  else process.env.SEMANTIC_SEARCH = envBefore;
});

function warned(pattern: RegExp): boolean {
  return vi.mocked(console.warn).mock.calls.some((args) => pattern.test(String(args[0])));
}

describe('/api/search (Ctrl+K)', () => {
  const req = (q: string) => new NextRequest(`http://x/api/search?q=${encodeURIComponent(q)}&limit=8`);

  it('флаг выключен — модель не зовётся, маршрут по словам, ответ говорит «disabled»', async () => {
    process.env.SEMANTIC_SEARCH = 'off';
    const res = await globalSearch(req('Горелый'));
    const json = await res.json();
    expect(h.semanticSearch).not.toHaveBeenCalled();
    expect(json.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'route', title: 'Вулкан Горелый', href: `/routes/${ILIKE_ROUTE.id}` }),
    ]));
    expect(json.degraded).toMatchObject({ semantic: 'disabled' });
    // Решение, а не сбой: ответ кэшируется как обычный.
    expect(res.headers.get('Cache-Control')).not.toBe('no-store');
    expect(warned(/\[search\] поиск по смыслу выключен флагом SEMANTIC_SEARCH/)).toBe(true);
  });

  it('флаг включён — семантика зовётся, как раньше, и degraded нет', async () => {
    delete process.env.SEMANTIC_SEARCH;
    const json = await (await globalSearch(req('Горелый'))).json();
    expect(h.semanticSearch).toHaveBeenCalledWith('Горелый', expect.any(Number));
    expect(json.degraded).toBeUndefined();
  });
});

describe('/api/routes/search (выбор маршрута в поле)', () => {
  const req = (q: string) => new NextRequest(`http://x/api/routes/search?q=${encodeURIComponent(q)}`);

  it('флаг выключен — модель не зовётся, ILIKE отвечает, поле semantic_search: disabled', async () => {
    process.env.SEMANTIC_SEARCH = 'false';
    const json = await (await routesSearch(req('Горелый'))).json();
    expect(h.semanticSearch).not.toHaveBeenCalled();
    expect(json.routes.map((r: { title: string }) => r.title)).toEqual(['Вулкан Горелый']);
    expect(json).toMatchObject({ semantic: false, semantic_search: 'disabled' });
    expect(warned(/\[routes\/search\] поиск по смыслу выключен/)).toBe(true);
  });

  it('флаг включён — семантика зовётся, поля disabled нет', async () => {
    delete process.env.SEMANTIC_SEARCH;
    const json = await (await routesSearch(req('Горелый'))).json();
    expect(h.semanticSearch).toHaveBeenCalledWith('Горелый', 15);
    expect(json.semantic_search).toBeUndefined();
  });
});

describe('контекст Кузьмича (buildRAGContext)', () => {
  it('флаг выключен — модель не зовётся, маршруты по словам на месте, строка в лог', async () => {
    process.env.SEMANTIC_SEARCH = '0';
    const ctx = await buildRAGContext('расскажи про Авачинский вулкан флаг выключен', 'tourist');
    expect(h.semanticSearch).not.toHaveBeenCalled();
    expect(ctx).toContain('Авачинский вулкан');
    expect(warned(/\[rag-context\] поиск по смыслу выключен/)).toBe(true);
  });

  it('модель отказала — контекст прежний (по словам), отказ назван в логе', async () => {
    delete process.env.SEMANTIC_SEARCH;
    h.semanticSearch.mockRejectedValue(new Error('Could not load sharp'));
    const ctx = await buildRAGContext('расскажи про Авачинский вулкан модель упала', 'tourist');
    expect(h.semanticSearch).toHaveBeenCalled();
    expect(ctx).toContain('Авачинский вулкан');
    expect(console.error).toHaveBeenCalledWith(
      '[rag-context] поиск по смыслу не выполнен',
      expect.objectContaining({ message: 'Could not load sharp' }),
    );
  });

  it('флаг включён, модель ответила — её маршрут входит в контекст, как раньше', async () => {
    delete process.env.SEMANTIC_SEARCH;
    h.semanticSearch.mockResolvedValue([{
      id: 'x', title: 'Мутновский вулкан', description: null, category: 'volcano',
      sourceUrl: null, sourceName: null, lat: 52.45, lng: 158.2, similarity: 0.8,
    }]);
    const ctx = await buildRAGContext('расскажи про Авачинский вулкан и соседей', 'tourist');
    expect(ctx).toContain('Мутновский вулкан');
    expect(ctx).toContain('Авачинский вулкан');
    expect(console.error).not.toHaveBeenCalled();
  });
});
