/**
 * Раннер сверки вулканов с Global Volcanism Program — сеть и БД замоканы.
 * Главная гарантия этого файла: инструмент только читает. Ни один вызов
 * pool.query здесь не должен быть UPDATE/INSERT/DELETE — правку делает
 * человек через отдельные роуты (place-coords) или миграцию.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { runGvpCrosscheck, fetchGvpVolcanoes } from '@/lib/geo/gvp-crosscheck-runner';

const PLACE_ROW = {
  id: 'p1', name: 'Ключевской', location_type: 'volcano',
  lat: 56.056, lng: 160.642,
};

const GVP_FEATURES = [{
  type: 'Feature',
  properties: {
    VolcanoNumber: 300260, VolcanoName: 'Klyuchevskoy', Country: 'Russia',
    VolcanoType: 'Stratovolcano', LastEruption: 2025, Elevation: 4754,
    LatitudeDecimal: 56.06, LongitudeDecimal: 160.64,
  },
}];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM places/.test(sql)) return { rows: [PLACE_ROW] };
    return { rows: [] };
  });
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ type: 'FeatureCollection', features: GVP_FEATURES }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runGvpCrosscheck', () => {
  it('только читает — ни одного write-запроса', async () => {
    await runGvpCrosscheck();
    expect(
      queryMock.mock.calls.every(([sql]) => !/UPDATE|INSERT|DELETE/i.test(sql as string)),
    ).toBe(true);
  });

  it('запрос мест ограничен вулканами, живыми, с координатами', async () => {
    await runGvpCrosscheck();
    const sql = queryMock.mock.calls.find(c => /FROM places/.test(c[0] as string))?.[0] as string;
    expect(sql).toMatch(/location_type = 'volcano'/);
    expect(sql).toMatch(/is_visible = true/);
    expect(sql).toMatch(/merged_into_id IS NULL/);
    expect(sql).toMatch(/lat IS NOT NULL AND lng IS NOT NULL/);
  });

  it('находит ближайшего вулкана ГВП и считает расстояние', async () => {
    const result = await runGvpCrosscheck();
    expect(result.checkedPlacesTotal).toBe(1);
    expect(result.gvpVolcanoesTotal).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].candidates[0].distanceKm).toBeLessThan(1);
  });
});

describe('fetchGvpVolcanoes', () => {
  it('не-ok ответ — бросает ошибку с кодом', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(
      fetchGvpVolcanoes({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 }),
    ).rejects.toThrow(/503/);
  });

  it('шлёт GET с bbox по переданным границам', async () => {
    await fetchGvpVolcanoes({ latMin: 1, latMax: 2, lngMin: 3, lngMax: 4 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('bbox=3%2C1%2C4%2C2%2CEPSG%3A4326');
  });
});
