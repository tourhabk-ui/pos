/**
 * lib/on-route/road-graph-car-provider.ts — CarRouteProvider поверх своего
 * дорожного графа (владелец 28.08, «собираем свой» вместо bake-off
 * Yandex/2ГИС). Мокает lib/routing/road-graph-route (тем же приёмом, что
 * tests/unit/routes-build-api.test.ts мокает lib/on-route/route-provider) —
 * маппинг проверяется изолированно от A-star/БД, которые уже покрыты
 * tests/unit/road-graph-route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoadGraphRouteResult } from '@/lib/routing/road-graph-route';
import { roadGraphCarProvider, ROAD_GRAPH_CAR_PROVIDER_LABEL } from '@/lib/on-route/road-graph-car-provider';

const mockRoadGraphRoute = vi.fn();
vi.mock('@/lib/routing/road-graph-route', () => ({
  roadGraphRoute: (...args: unknown[]) => mockRoadGraphRoute(...args),
}));

beforeEach(() => vi.clearAllMocks());

const QUERY = { originLat: 53.00, originLon: 158.00, destLat: 53.01, destLon: 158.02 };

describe('roadGraphCarProvider — found', () => {
  it('переворачивает координаты [lat,lng] → GeoJSON [lng,lat]', async () => {
    const ok: RoadGraphRouteResult = {
      ok: true, mode: 'car', distanceM: 2000, durationS: 180,
      geometry: [[53.00, 158.00], [53.01, 158.00], [53.01, 158.02]],
      start: { lat: 53.00, lng: 158.00, snapM: 5 },
      goal: { lat: 53.01, lng: 158.02, snapM: 3 },
      graph: { nodes: 4, edges: 4, routable: 4 },
    };
    mockRoadGraphRoute.mockResolvedValue(ok);

    const result = await roadGraphCarProvider.route(QUERY);
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.route.geometry.coordinates).toEqual([
      [158.00, 53.00], [158.00, 53.01], [158.02, 53.01],
    ]);
    expect(result.route.distanceM).toBe(2000);
    expect(result.route.durationS).toBe(180);
  });

  it('originSnapped/destinationSnapped — точка НА ГРАФЕ (снапнутый узел), не исходный запрос', async () => {
    const ok: RoadGraphRouteResult = {
      ok: true, mode: 'car', distanceM: 100, durationS: 10,
      geometry: [[53.00, 158.00], [53.001, 158.001]],
      start: { lat: 53.0001, lng: 158.0002, snapM: 42 },
      goal: { lat: 53.0011, lng: 158.0012, snapM: 17 },
      graph: { nodes: 2, edges: 1, routable: 2 },
    };
    mockRoadGraphRoute.mockResolvedValue(ok);

    const result = await roadGraphCarProvider.route(QUERY);
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.route.originSnapped).toEqual({ lat: 53.0001, lon: 158.0002, snapDistanceM: 42 });
    expect(result.route.destinationSnapped).toEqual({ lat: 53.0011, lon: 158.0012, snapDistanceM: 17 });
  });

  it('честные поля первого релиза: свой граф, без трафика, без навигации/сохранения', async () => {
    const ok: RoadGraphRouteResult = {
      ok: true, mode: 'car', distanceM: 100, durationS: 10,
      geometry: [[53, 158], [53.01, 158.01]],
      start: { lat: 53, lng: 158, snapM: 0 },
      goal: { lat: 53.01, lng: 158.01, snapM: 0 },
      graph: { nodes: 2, edges: 1, routable: 2 },
    };
    mockRoadGraphRoute.mockResolvedValue(ok);

    const result = await roadGraphCarProvider.route(QUERY);
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.route.provider).toBe(ROAD_GRAPH_CAR_PROVIDER_LABEL);
    expect(result.route.traffic).toBe(false);
    expect(result.route.mayDisplay).toBe(true);
    expect(result.route.mayNavigate).toBe(false);
    expect(result.route.mayPersist).toBe(false);
    expect(result.route.kind).toBe('calculated_car');
    expect(() => new Date(result.route.builtAt).toISOString()).not.toThrow();
  });

  it('вызывает roadGraphRoute с запрошенными координатами и mode: car', async () => {
    mockRoadGraphRoute.mockResolvedValue({
      ok: true, mode: 'car', distanceM: 1, durationS: 1,
      geometry: [[53, 158], [53, 158]],
      start: { lat: 53, lng: 158, snapM: 0 }, goal: { lat: 53, lng: 158, snapM: 0 },
      graph: { nodes: 1, edges: 1, routable: 1 },
    });
    await roadGraphCarProvider.route(QUERY);
    expect(mockRoadGraphRoute).toHaveBeenCalledWith(53.00, 158.00, 53.01, 158.02, 'car');
  });
});

describe('roadGraphCarProvider — not_found', () => {
  it('каждая честная причина ядра доходит до провайдера как not_found с тем же текстом', async () => {
    const reasons: Array<RoadGraphRouteResult & { ok: false }> = [
      { ok: false, reason: 'empty_graph', message: 'Дорог в этом районе у нас в данных нет' },
      { ok: false, reason: 'too_far_from_road', message: 'До ближайшей дороги слишком далеко — подъезд не строим' },
      { ok: false, reason: 'disconnected', message: 'Связного пути по нашим данным нет' },
      { ok: false, reason: 'mode_blocked', message: 'Дорога есть, но проехать по ней нельзя — только пешком' },
    ];
    for (const r of reasons) {
      mockRoadGraphRoute.mockResolvedValue(r);
      // eslint-disable-next-line no-await-in-loop
      const result = await roadGraphCarProvider.route(QUERY);
      expect(result, r.reason).toEqual({ status: 'not_found', reason: r.message });
    }
  });
});

describe('roadGraphCarProvider — error', () => {
  it('исключение из ядра (БД недоступна и т.п.) — status: error, retryable: true', async () => {
    mockRoadGraphRoute.mockRejectedValue(new Error('connection refused'));
    const result = await roadGraphCarProvider.route(QUERY);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('connection refused');
  });
});
