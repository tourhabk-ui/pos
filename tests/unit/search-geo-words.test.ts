// @vitest-environment node
/**
 * Поиск в шапке сайта ищет места, маршруты и парки по словам (05.11).
 *
 * До этого дня /api/search подставлял всю строку в ILIKE одним куском:
 * «озеро Курильское» и «Kurile Lake» не находили «Курильское озеро», а
 * скрытое место (is_visible = false) находилось. Сторож держит вызов роута:
 * каждое слово — свой параметр-шаблон, английское — русской основой, «%» —
 * буквой, места — только видимые. Исполнение SQL на настоящей схеме —
 * tests/integration/mcp-search.pg.test.ts (поиск в шапке).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/ai/semantic-search-state', () => ({ semanticSearchEnabled: () => false, noteSemanticSearchOff: () => undefined }));
vi.mock('@/lib/search/tour-query-match', () => ({
  findToursForQuery: vi.fn().mockResolvedValue([]),
  tourPriceFrom: () => null,
}));

import { GET } from '@/app/api/search/route';

const req = (q: string) => ({ url: `http://x/api/search?q=${encodeURIComponent(q)}` }) as unknown as NextRequest;

function callFor(table: string): [string, unknown[]] {
  const call = queryMock.mock.calls.find((c) => String(c[0]).includes(`FROM ${table}`));
  expect(call, `запрос к ${table} не ушёл`).toBeDefined();
  return [String(call![0]), call![1] as unknown[]];
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('/api/search: места, маршруты, парки — по словам запроса', () => {
  it('«озеро Курильское»: каждое слово — свой шаблон основы, у мест, маршрутов и парков', async () => {
    await GET(req('озеро Курильское'));
    for (const table of ['places', 'kamchatka_routes', 'parks']) {
      const [, params] = callFor(table);
      expect(params).toContain('%озер%');
      expect(params).toContain('%курильск%');
    }
  });

  it('по-английски: «volcano» ищется русской основой «вулкан»', async () => {
    await GET(req('volcano'));
    const [, params] = callFor('places');
    expect(params).toContain('%вулкан%');
    expect(params).not.toContain('%volcano%');
  });

  it('места — только видимые и не слитые', async () => {
    await GET(req('Горелый'));
    const [sql] = callFor('places');
    expect(sql).toMatch(/p\.is_visible\s*=\s*TRUE/i);
    expect(sql).toMatch(/p\.merged_into_id IS NULL/);
  });

  it('«%» ищется буквой, а не маской «всё подряд»', async () => {
    await GET(req('%'));
    const [, params] = callFor('places');
    expect(params).toContain('%\\%%');
    expect(params).not.toContain('%%%');
  });

  it('место из ответа базы доходит до выдачи ссылкой на карточку', async () => {
    queryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: sql.includes('FROM places') ? [{ id: 'kurilskoe', title: 'Курильское озеро', location_type: 'lake', hits: 2 }] : [] }));
    const res = await GET(req('озеро Курильское'));
    const json = await res.json();
    expect(json.data).toContainEqual(expect.objectContaining({ type: 'place', title: 'Курильское озеро', subtitle: 'Озеро', href: '/places/kurilskoe' }));
  });
});
