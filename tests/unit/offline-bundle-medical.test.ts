/**
 * Офлайн-пакет маршрута несёт расстояние до медпомощи у точек (карт-бланш
 * владельца 27.11, шаг 2: «опасности, снаряжение, телефоны МЧС, ближайшая
 * медпомощь»). Сторож вызывает сам обработчик пакета: нет расстояния в
 * профиле места — null («не записано»), а не ноль километров, и карточка
 * фактов в телефоне берёт медпомощь именно из этого ответа.
 *
 * Сам запрос точек проверяется на настоящем PostgreSQL —
 * tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: db.query }));

import { GET } from '@/app/api/routes/[id]/offline-bundle/route';
import { OFFLINE_BUNDLE_WAYPOINTS_SQL } from '@/lib/offline/bundle-sql';
import { routeFactsFromBundle } from '@/lib/offline/route-facts';

const ROUTE_ID = '0b1e0000-0000-4000-8000-00000000c001';

db.query.mockImplementation(async (sql: string) => {
  if (sql === OFFLINE_BUNDLE_WAYPOINTS_SQL) {
    return {
      rows: [
        { position: 0, place_name: 'Парковка', lat: '52.40', lng: '158.20', nearest_medical_km: '48.60' },
        { position: 1, place_name: 'Кратер', lat: '52.45', lng: '158.25', nearest_medical_km: null },
      ],
    };
  }
  if (sql.includes('FROM kamchatka_routes')) {
    return {
      rows: [{
        id: ROUTE_ID, title: 'Вулкан Горелый', description: null, lat: '52.4', lng: '158.2',
        difficulty: null, distance_km: null, elevation_gain_m: null, duration_hours: null, season: null,
        hazards: ['Камнепад'], equipment: null, mchs_registration_required: true, mchs_phone: null,
        park_name: null, geometry: null,
      }],
    };
  }
  return { rows: [] };
});

describe('офлайн-пакет: медпомощь у точек маршрута', () => {
  it('расстояние — числом, нет записи — null; карточка фактов берёт его из ответа', async () => {
    const res = await GET(new Request(`https://vedarai.ru/api/routes/${ROUTE_ID}/offline-bundle`), {
      params: Promise.resolve({ id: ROUTE_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waypoints: Array<{ name: string; nearest_medical_km: number | null }> };
    expect(body.waypoints.map((w) => [w.name, w.nearest_medical_km])).toEqual([['Парковка', 48.6], ['Кратер', null]]);
    expect(routeFactsFromBundle(body)?.medical).toEqual([{ place: 'Парковка', km: 48.6 }]);
  });
});
