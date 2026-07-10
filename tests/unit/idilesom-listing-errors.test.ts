import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAllIds, importIdilesomPlaces } from '@/lib/services/idilesom-importer';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('idilesom importer — честный отчёт о недоступном листинге', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('403 на всех страницах листинга — ошибки в listingErrors, а не тихие «0 страниц»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const { ids, listingErrors } = await fetchAllIds(3);

    expect(ids).toHaveLength(0);
    expect(listingErrors.length).toBeGreaterThanOrEqual(2); // первая страница + сводка AJAX
    expect(listingErrors[0]).toContain('403');
    expect(listingErrors.join(' ')).toContain('AJAX');
  });

  it('HTML без ссылок /kam/places/N — явное сообщение про вёрстку', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('page=')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ empty: true }) });
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

  it('нормальный листинг — listingErrors пуст, ids собраны', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('page=')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ empty: true }) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve('<a href="/kam/places/12">A</a> <a href="/kam/places/34">B</a>') });
    }));

    const { ids, listingErrors } = await fetchAllIds(3);

    expect(ids.sort()).toEqual(['12', '34']);
    expect(listingErrors).toHaveLength(0);
  });
});
