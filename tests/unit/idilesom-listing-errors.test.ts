import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAllIds, importIdilesomPlaces } from '@/lib/services/ingest/idilesom-importer';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('idilesom importer — честный отчёт и BrightData-фоллбэк', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BRIGHTDATA_API_TOKEN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRIGHTDATA_API_TOKEN;
  });

  it('403 на всех страницах, токена BrightData нет — ошибки в listingErrors с подсказкой', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const { ids, listingErrors } = await fetchAllIds(3);

    expect(ids).toHaveLength(0);
    expect(listingErrors.length).toBeGreaterThanOrEqual(2); // первая страница + сводка AJAX
    expect(listingErrors[0]).toContain('403');
    expect(listingErrors[0]).toContain('BRIGHTDATA_API_TOKEN');
    expect(listingErrors.join(' ')).toContain('AJAX');
  });

  it('403 напрямую, но BrightData пробился — ids собраны, ошибок нет', async () => {
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('api.brightdata.com')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('<a href="/kam/places/77">A</a> <a href="/kam/places/88">B</a>'),
        });
      }
      return Promise.resolve({ ok: false, status: 403 }); // прямые запросы режет бот-защита
    }));

    const { ids, listingErrors } = await fetchAllIds(3);

    expect(ids.sort()).toEqual(['77', '88']);
    // AJAX-страницы через BrightData возвращают ту же HTML — стоп по «нет новых id», без ошибок
    expect(listingErrors).toHaveLength(0);
  }, 15_000);

  it('HTML без ссылок /kam/places/N — явное сообщение про вёрстку', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('page=')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{"empty":true}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve('<html><body>Проверка браузера...</body></html>') });
    }));

    const { ids, listingErrors } = await fetchAllIds(3);

    expect(ids).toHaveLength(0);
    expect(listingErrors[0]).toContain('вёрстка');
  });

  it('importIdilesomPlaces прокидывает listing_errors в итоговый отчёт', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const result = await importIdilesomPlaces({ dry_run: true });

    expect(result.total).toBe(0);
    expect(result.listing_errors.length).toBeGreaterThan(0);
    expect(result.listing_errors[0]).toContain('403');
  }, 25_000); // fetchAllIds(50) держит паузу 300мс между AJAX-страницами

  it('нормальный листинг — listingErrors пуст, ids собраны, JSON-слэши разэкранируются', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('page=2')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{"empty":false,"list":"<a href=\\"\\/kam\\/places\\/56\\">C</a>"}') });
      }
      if (String(url).includes('page=')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{"empty":true}') });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('<a href="/kam/places/12">A</a> <a href="/kam/places/34">B</a>') });
    }));

    const { ids, listingErrors } = await fetchAllIds(4);

    expect(ids.sort()).toEqual(['12', '34', '56']);
    expect(listingErrors).toHaveLength(0);
  });
});
