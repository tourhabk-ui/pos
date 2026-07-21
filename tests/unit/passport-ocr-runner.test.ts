import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPassportOcr } from '@/lib/import/passport-ocr-runner';
import { joinOcrPages } from '@/lib/services/ingest/mistral-ocr';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const ROUTE = { id: 'r1', title: 'Паспорт: Авачинский', pdf_url: 'https://visitkamchatka.ru/p/avacha.pdf' };

function mockDb(routes: Array<typeof ROUTE>, remaining = routes.length) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ count: String(remaining) }] });
    if (sql.includes('SELECT r.id')) return Promise.resolve({ rows: routes });
    return Promise.resolve({ rows: [] }); // INSERT
  });
}

/** fetch-мок: PDF по route-URL, Mistral OCR по api.mistral.ai. */
function mockFetch(opts: { pdfOk?: boolean; ocrStatus?: number } = {}) {
  const { pdfOk = true, ocrStatus = 200 } = opts;
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('api.mistral.ai')) {
      if (ocrStatus !== 200) {
        return Promise.resolve({ ok: false, status: ocrStatus, text: () => Promise.resolve('rate limited') });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          pages: [
            { index: 1, markdown: 'Снаряжение: ботинки, палки.' },
            { index: 0, markdown: '# Паспорт маршрута' },
          ],
        }),
      });
    }
    if (!pdfOk) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('joinOcrPages (склейка постраничного markdown)', () => {
  it('сортирует по index и склеивает через пустую строку', () => {
    expect(joinOcrPages([
      { index: 1, markdown: 'вторая' },
      { index: 0, markdown: 'первая' },
    ])).toBe('первая\n\nвторая');
  });

  it('пустые страницы выбрасываются', () => {
    expect(joinOcrPages([
      { index: 0, markdown: '  ' },
      { index: 1, markdown: 'текст' },
    ])).toBe('текст');
  });
});

describe('runPassportOcr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MISTRAL_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MISTRAL_API_KEY;
  });

  it('dry-run: скачивает PDF, но НЕ ходит в Mistral и НЕ пишет в БД', async () => {
    mockDb([ROUTE]);
    const fetchMock = mockFetch();

    const res = await runPassportOcr({ limit: 3, dryRun: true, delayMs: 0 });

    expect(res.succeeded).toBe(1);
    expect(res.details[0].status).toBe('dry_run');
    expect(res.details[0].pdf_kb).toBeDefined();
    const mistralCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('api.mistral.ai'));
    expect(mistralCalls).toHaveLength(0);
    const inserts = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT'));
    expect(inserts).toHaveLength(0);
  });

  it('боевой прогон: PDF → Mistral OCR → upsert склеенного markdown', async () => {
    mockDb([ROUTE]);
    mockFetch();

    const res = await runPassportOcr({ limit: 3, dryRun: false, delayMs: 0 });

    expect(res.succeeded).toBe(1);
    expect(res.details[0]).toMatchObject({ status: 'ocr_done', pages: 2 });
    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO route_passport_ocr'));
    expect(insert).toBeDefined();
    const [, params] = insert as [string, unknown[]];
    expect(params[0]).toBe('r1');
    expect(params[2]).toBe('# Паспорт маршрута\n\nСнаряжение: ботинки, палки.');
    expect(params[3]).toBe(2);
  });

  it('ошибка Mistral (429) копится в errors, партия не падает', async () => {
    mockDb([ROUTE]);
    mockFetch({ ocrStatus: 429 });

    const res = await runPassportOcr({ limit: 3, dryRun: false, delayMs: 0 });

    expect(res.succeeded).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('429');
    expect(res.details[0].status).toBe('error');
  });

  it('недоступный PDF — ошибка маршрута без похода в Mistral', async () => {
    mockDb([ROUTE]);
    const fetchMock = mockFetch({ pdfOk: false });

    const res = await runPassportOcr({ limit: 3, dryRun: false, delayMs: 0 });

    expect(res.errors[0]).toContain('PDF HTTP 404');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('api.mistral.ai'))).toHaveLength(0);
  });

  it('offset прокидывается в SELECT — сдвиг мимо упавших при batched-прогоне', async () => {
    mockDb([]);
    mockFetch();

    await runPassportOcr({ limit: 3, dryRun: false, offset: 7, delayMs: 0 });

    const select = mockQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT r.id'));
    expect(select?.[1]).toEqual([3, 7]);
  });
});
