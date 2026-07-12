/**
 * Ремонт данных: dry-run не мутирует, хелперы детерминированы.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));
vi.mock('@/lib/services/geocode', () => ({
  geocodeAddress: vi.fn().mockResolvedValue(null),
  withinKamchatka: (lat: number, lng: number) => lat >= 50 && lat <= 64 && lng >= 155 && lng <= 167,
}));

import { runDataRepair, nameWordSet, trackDestination } from '@/lib/services/data-repair';

describe('хелперы', () => {
  it('nameWordSet: «Озеро Курильское» == «Курильское озеро», ё=е', () => {
    expect(nameWordSet('Озеро Курильское')).toBe(nameWordSet('Курильское озеро'));
    expect(nameWordSet('Голубые озёра')).toBe(nameWordSet('Голубые озера'));
    expect(nameWordSet('Кутхины баты')).toBe(nameWordSet('Кутхины Баты'));
    expect(nameWordSet('Озеро Курильское')).not.toBe(nameWordSet('Озеро Толмачево'));
  });

  it('trackDestination: последняя валидная точка [lng,lat]', () => {
    expect(trackDestination([[158.1, 52.5], [158.2, 52.6]])).toEqual({ lat: 52.6, lng: 158.2 });
    expect(trackDestination([])).toBeNull();
  });
});

describe('runDataRepair (dry-run)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('dry-run не шлёт ни одного UPDATE', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('HAVING COUNT(*) >= 3') && sql.includes('SELECT lat')) {
        return Promise.resolve({ rows: [{ lat: 55, lng: 160, n: 3 }] });
      }
      if (sql.includes('JOIN (')) {
        return Promise.resolve({
          rows: [{ id: 'p1', ark_id: 'a1', name: 'Бухта Русская', lat: 55, lng: 160 }],
        });
      }
      if (sql.includes('COUNT(*)::int AS n FROM kamchatka_routes')) {
        return Promise.resolve({ rows: [{ n: 85 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(true);
    expect(result.dry_run).toBe(true);
    expect(result.bogus_clusters).toBe(1);
    expect(result.normalized_sources).toBe(85);
    // Без трека и с недоступным геокодером место уходит в «скрыть»
    expect(result.hidden_unfixable).toBe(1);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('UPDATE')).toBe(false);
    }
  });

  it('apply: фейковая координата чинится из финиша strong-трека и трек привязывается', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('HAVING COUNT(*) >= 3') && s.includes('GROUP BY lat, lng') && !s.includes('JOIN (')) {
        return Promise.resolve({ rows: [{ lat: 55, lng: 160, n: 3 }] });
      }
      if (s.includes('JOIN (')) {
        return Promise.resolve({
          rows: [{ id: 'p1', ark_id: 'a1', name: 'Бухта Русская', lat: 55, lng: 160 }],
        });
      }
      if (s.includes(`metadata->>'place_ark_id') IS NULL`)) {
        return Promise.resolve({
          rows: [{
            id: 't1',
            title: 'Бухта Русская',
            geometry: { coordinates: [[158.0, 52.0], [158.42, 52.35]] },
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    expect(result.coords_from_track).toBe(1);
    expect(updates.some(u => u.includes('UPDATE places SET lat') && u.includes('52.35'))).toBe(true);
    expect(updates.some(u => u.includes(`place_ark_id`) && u.includes('"a1"'))).toBe(true);
  });

  it('apply: дубли-маршруты сливаются, туры перевешены на keeper с треком; разный activity не сливается', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('FROM kamchatka_routes') && s.includes('has_geometry')) {
        return Promise.resolve({
          rows: [
            // Дубль-пара: одинаковый title+activity+координаты; keeper — с треком
            { id: 'r1', title: 'Вилючинский водопад', activity_type: 'trekking', lat: 52.7, lng: 158.3, desc_len: 500, has_geometry: true, is_visible: true },
            { id: 'r2', title: 'Водопад Вилючинский', activity_type: 'trekking', lat: 52.7, lng: 158.3, desc_len: 100, has_geometry: false, is_visible: true },
            // Тот же word-set, но другой activity_type — НЕ дубль
            { id: 'r3', title: 'Вачкажец горный массив', activity_type: 'ski', lat: 53.0, lng: 158.0, desc_len: 200, has_geometry: false, is_visible: true },
            { id: 'r4', title: 'Горный массив Вачкажец', activity_type: 'snowmobile', lat: 53.0, lng: 158.0, desc_len: 200, has_geometry: false, is_visible: true },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    // Слит ровно один дубль (r2 -> r1); r3/r4 разошлись по activity_type
    expect(result.merged_routes).toBe(1);
    // Туры дубля перевешены на keeper r1, дубль r2 скрыт
    expect(updates.some(u => u.includes('UPDATE operator_tours SET route_id') && u.includes('["r1","r2"]'))).toBe(true);
    expect(updates.some(u => u.includes('UPDATE kamchatka_routes SET is_visible = false') && u.includes('"r2"'))).toBe(true);
    // r1 (keeper) НЕ скрывается
    expect(updates.some(u => u.includes('is_visible = false') && u.includes('"r1"'))).toBe(false);
  });

  it('dry-run по маршрутам: считает merged_routes, но не шлёт UPDATE', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM kamchatka_routes') && s.includes('has_geometry')) {
        return Promise.resolve({
          rows: [
            { id: 'r1', title: 'Вулкан Горелый', activity_type: 'trekking', lat: 52.5, lng: 158.0, desc_len: 300, has_geometry: true, is_visible: true },
            { id: 'r2', title: 'Горелый вулкан', activity_type: 'trekking', lat: 52.5, lng: 158.0, desc_len: 100, has_geometry: false, is_visible: true },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(true);
    expect(result.merged_routes).toBe(1);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('UPDATE')).toBe(false);
    }
  });
});
