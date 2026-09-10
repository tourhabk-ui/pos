/**
 * Раннер сверки places с OSM — сеть и БД замоканы. Главная гарантия этого
 * файла: инструмент только читает. Ни один вызов pool.query здесь не должен
 * быть UPDATE/INSERT/DELETE — правку делает человек через отдельные роуты
 * (place-coords) или миграцию, не этот эндпоинт.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { runOsmCrosscheck, fetchOsmFeatures } from '@/lib/geo/osm-crosscheck-runner';

const PLACE_ROW = {
  id: 'p1', name: 'Голубые озёра', location_type: 'lake',
  lat: 53.1891933, lng: 158.3822536,
};

const OVERPASS_ELEMENTS = [
  { type: 'way', id: 100, center: { lat: 53.1561328, lon: 158.1331722 }, tags: { name: 'Голубые озёра', natural: 'water' } },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM places/.test(sql)) return { rows: [PLACE_ROW] };
    if (/similarity\(p\.place_name, o\.osm_name\)/.test(sql)) {
      return { rows: [{ place_id: 'p1', osm_key: 'way:100', sim: 1.0 }] };
    }
    return { rows: [] };
  });
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ elements: OVERPASS_ELEMENTS }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runOsmCrosscheck', () => {
  it('только читает — ни одного write-запроса', async () => {
    await runOsmCrosscheck({ minSim: 0.3 });
    expect(
      queryMock.mock.calls.every(([sql]) => !/UPDATE|INSERT|DELETE/i.test(sql as string)),
    ).toBe(true);
  });

  it('находит кандидата и считает расстояние', async () => {
    const result = await runOsmCrosscheck({ minSim: 0.3 });
    expect(result.checkedPlacesTotal).toBe(1);
    expect(result.osmFeaturesTotal).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].candidates[0].distanceKm).toBeGreaterThan(15);
  });

  it('запрос мест ограничен живыми и с координатами', async () => {
    await runOsmCrosscheck({ minSim: 0.3 });
    const placesSql = queryMock.mock.calls.find(c => /FROM places/.test(c[0] as string))?.[0] as string;
    expect(placesSql).toMatch(/is_visible = true/);
    expect(placesSql).toMatch(/merged_into_id IS NULL/);
    expect(placesSql).toMatch(/lat IS NOT NULL AND lng IS NOT NULL/);
  });
});

describe('fetchOsmFeatures — фолбэк на зеркало Overpass', () => {
  it('первый эндпоинт не-ok → используется второе зеркало', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 504, json: async () => ({}) };
      return { ok: true, json: async () => ({ elements: OVERPASS_ELEMENTS }) };
    });
    const features = await fetchOsmFeatures({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(calls).toBe(2);
    expect(features).toHaveLength(1);
  });

  it('оба эндпоинта отказали — бросает ошибку', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(
      fetchOsmFeatures({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 }),
    ).rejects.toThrow();
  });
});
