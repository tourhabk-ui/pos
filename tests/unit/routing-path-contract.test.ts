/**
 * GET /api/routing/path — JSON-контракт (владелец 28.08).
 *
 * 28.08 логика решений вынесена в lib/routing/road-graph-route.ts, а этот
 * эндпоинт стал тонкой обёрткой, мапящей RoadGraphRouteResult в прежний
 * JSON. Никто в проде этот эндпоинт сегодня не вызывает (проверено:
 * подключён только roadGraphCarProvider через ядро напрямую, не через
 * HTTP), но контракт зафиксирован ради будущих клиентов — рефакторинг,
 * которым уже никто не пользуется, легче всего сломать незаметно. Тест
 * мокает lib/routing/road-graph-route, чтобы проверить именно маппинг
 * GET-обработчика, а не A-star/БД (уже покрыты tests/unit/road-graph-route.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { RoadGraphRouteResult } from '@/lib/routing/road-graph-route';
import { GET } from '@/app/api/routing/path/route';

const mockRoadGraphRoute = vi.fn();
vi.mock('@/lib/routing/road-graph-route', () => ({
  roadGraphRoute: (...args: unknown[]) => mockRoadGraphRoute(...args),
}));

beforeEach(() => vi.clearAllMocks());

function req(qs: string): NextRequest {
  return new NextRequest(`https://vedarai.ru/api/routing/path?${qs}`);
}

const OK: RoadGraphRouteResult = {
  ok: true, mode: 'car', distanceM: 2000, durationS: 200,
  geometry: [[53.00, 158.00], [53.01, 158.02]],
  start: { lat: 53.00, lng: 158.00, snapM: 12 },
  goal: { lat: 53.01, lng: 158.02, snapM: 7 },
  graph: { nodes: 4, edges: 4, routable: 4 },
};

describe('GET /api/routing/path — контракт на успехе', () => {
  it('отдаёт distance_m/duration_s/geometry/start_snap_m/end_snap_m/mode, без graph', async () => {
    mockRoadGraphRoute.mockResolvedValue(OK);
    const res = await GET(req('from_lat=53&from_lng=158&to_lat=53.01&to_lng=158.02&mode=car'));
    const body = await res.json();
    expect(body).toEqual({
      ok: true, mode: 'car', distance_m: 2000, duration_s: 200,
      geometry: [[53.00, 158.00], [53.01, 158.02]],
      start_snap_m: 12, end_snap_m: 7,
    });
  });
});

describe('GET /api/routing/path — контракт на отказе', () => {
  it('empty_graph (нет узлов) — без start_snap_m/end_snap_m', async () => {
    mockRoadGraphRoute.mockResolvedValue({
      ok: false, reason: 'empty_graph', graph: { nodes: 0, edges: 0 },
      message: 'Дорог в этом районе у нас в данных нет',
    } satisfies RoadGraphRouteResult);
    const res = await GET(req('from_lat=53&from_lng=158&to_lat=53.01&to_lng=158.02&mode=car'));
    const body = await res.json();
    expect(body).toEqual({
      ok: false, reason: 'empty_graph', mode: 'car',
      graph: { nodes: 0, edges: 0 },
      message: 'Дорог в этом районе у нас в данных нет',
    });
    expect(body.start_snap_m).toBeUndefined();
    expect(body.end_snap_m).toBeUndefined();
  });

  it('too_far_from_road — со start_snap_m/end_snap_m', async () => {
    mockRoadGraphRoute.mockResolvedValue({
      ok: false, reason: 'too_far_from_road', graph: { nodes: 2, edges: 1 },
      start: { lat: 53, lng: 158, snapM: 8000 }, goal: { lat: 53.01, lng: 158.02, snapM: 40 },
      message: 'До ближайшей дороги слишком далеко — подъезд не строим',
    } satisfies RoadGraphRouteResult);
    const res = await GET(req('from_lat=53&from_lng=158&to_lat=53.01&to_lng=158.02&mode=car'));
    const body = await res.json();
    expect(body.start_snap_m).toBe(8000);
    expect(body.end_snap_m).toBe(40);
    expect(body.reason).toBe('too_far_from_road');
  });

  it('400 на некорректные параметры — не доходит до roadGraphRoute', async () => {
    const res = await GET(req('from_lat=999&from_lng=158&to_lat=53.01&to_lng=158.02'));
    expect(res.status).toBe(400);
    expect(mockRoadGraphRoute).not.toHaveBeenCalled();
  });

  it('исключение ядра — ok:false, reason:error, не 500', async () => {
    mockRoadGraphRoute.mockRejectedValue(new Error('db down'));
    const res = await GET(req('from_lat=53&from_lng=158&to_lat=53.01&to_lng=158.02&mode=car'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: 'error', error: 'db down' });
  });
});
