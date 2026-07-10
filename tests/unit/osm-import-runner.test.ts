import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runOsmGeometryImport } from '@/lib/import/osm-import-runner';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// Маршрут в точке (53.0, 158.0); way стартует в ~70 м от неё — проходит
// фильтр близости MAX_START_DIST_KM=4 из lib/import/osm-geometry.
const ROUTE = { id: 'r1', title: 'Тестовый маршрут', lat: '53.0', lng: '158.0' };
const NEARBY_WAY = {
  id: 1,
  tags: { highway: 'path' },
  geometry: [
    { lat: 53.0005, lon: 158.0 },
    { lat: 53.01, lon: 158.01 },
    { lat: 53.02, lon: 158.02 },
  ],
};
// Way в ~100+ км — фильтр близости его отбрасывает → skipped.
const FAR_WAY = {
  id: 2,
  tags: { highway: 'track' },
  geometry: [
    { lat: 54.5, lon: 159.5 },
    { lat: 54.51, lon: 159.51 },
    { lat: 54.52, lon: 159.52 },
  ],
};

function mockDb(routes: Array<typeof ROUTE>, remaining = routes.length) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ count: String(remaining) }] });
    if (sql.includes('SELECT id, title')) return Promise.resolve({ rows: routes });
    return Promise.resolve({ rows: [] }); // UPDATE
  });
}

function mockOverpass(ways: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ elements: ways }),
  }));
}

describe('runOsmGeometryImport (общий раннер admin-роута и /api/cron/osm-import)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('dry-run: считает imported, но НЕ пишет UPDATE в БД', async () => {
    mockDb([ROUTE]);
    mockOverpass([NEARBY_WAY]);

    const res = await runOsmGeometryImport({ limit: 8, dryRun: true, delayMs: 0 });

    expect(res.imported).toBe(1);
    expect(res.details[0].status).toBe('dry_run');
    const updates = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE'));
    expect(updates).toHaveLength(0);
  });

  it('боевой прогон: пишет GeoJSON LineString в kamchatka_routes', async () => {
    mockDb([ROUTE]);
    mockOverpass([NEARBY_WAY]);

    const res = await runOsmGeometryImport({ limit: 8, dryRun: false, delayMs: 0 });

    expect(res.imported).toBe(1);
    expect(res.details[0].status).toBe('imported');
    const update = mockQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE kamchatka_routes'));
    expect(update).toBeDefined();
    const [, params] = update as [string, [string, string]];
    expect(JSON.parse(params[0]).type).toBe('LineString');
    expect(params[1]).toBe('r1');
  });

  it('offset прокидывается в SELECT — batched-прогон сдвигается мимо skipped-маршрутов', async () => {
    mockDb([]);
    mockOverpass([]);

    await runOsmGeometryImport({ limit: 5, dryRun: true, offset: 12, delayMs: 0 });

    const select = mockQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT id, title'));
    expect(select?.[1]).toEqual([5, 12]);
  });

  it('маршрут без подходящего трека в OSM — skipped, без записи', async () => {
    mockDb([ROUTE]);
    mockOverpass([FAR_WAY]);

    const res = await runOsmGeometryImport({ limit: 8, dryRun: false, delayMs: 0 });

    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.details[0].status).toBe('skipped');
  });

  it('406 на основном Overpass — фолбэк на зеркало Kumi Systems с нашими заголовками', async () => {
    mockDb([ROUTE]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 406 }) // primary: etiquette-фильтр
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ elements: [NEARBY_WAY] }) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await runOsmGeometryImport({ limit: 8, dryRun: true, delayMs: 0 });

    expect(res.imported).toBe(1);
    expect(res.errors).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('overpass.kumi.systems');
    // Оба вызова идут с идентифицирующим User-Agent — требование Overpass etiquette
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('KamchatourHub') });
    }
  });

  it('оба эндпоинта Overpass упали — ошибка маршрута с последней причиной', async () => {
    mockDb([ROUTE]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 406 });
    vi.stubGlobal('fetch', fetchMock);

    const res = await runOsmGeometryImport({ limit: 8, dryRun: true, delayMs: 0 });

    expect(res.imported).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('406');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ошибка Overpass по одному маршруту не роняет партию — копится в errors', async () => {
    const route2 = { ...ROUTE, id: 'r2', title: 'Второй маршрут' };
    mockDb([ROUTE, route2]);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Overpass HTTP 429')) // маршрут 1: primary
      .mockRejectedValueOnce(new Error('Overpass HTTP 429')) // маршрут 1: зеркало
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ elements: [NEARBY_WAY] }) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await runOsmGeometryImport({ limit: 8, dryRun: true, delayMs: 0 });

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('Тестовый маршрут');
    expect(res.imported).toBe(1); // второй маршрут обработан несмотря на ошибку первого
    expect(res.processed).toBe(2);
  });
});
