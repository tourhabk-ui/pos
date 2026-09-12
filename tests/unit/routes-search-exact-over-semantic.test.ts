/**
 * /api/routes/search — точное совпадение по имени не должно теряться из-за
 * семантики (владелец 12.09: «на маршруте при кнопке сменить маршрут не
 * смог найти Вачкажец»).
 *
 * До правки успешная (даже слабая, порог 0.3) семантика обрывала функцию
 * ранним return ДО того, как отрабатывал ILIKE — единственная ветка, которая
 * ищет по точному названию маршрута/места. Если модель находила хоть что-то
 * постороннее выше порога, маршрут с ТОЧНЫМ совпадением в имени мог вообще
 * не попасть в список. ILIKE теперь считается ВСЕГДА, семантика — слой
 * поверх него, а не замена.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: vi.fn() }));
vi.mock('@/lib/ai/route-knowledge', () => ({
  getRouteSearchCache: vi.fn(() => null),
  setRouteSearchCache: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { query } from '@/lib/database';
import { semanticSearch } from '@/lib/ai/embeddings';
import { setRouteSearchCache } from '@/lib/ai/route-knowledge';
import { GET } from '@/app/api/routes/search/route';

const queryMock = vi.mocked(query);
const semanticMock = vi.mocked(semanticSearch);
const setCacheMock = vi.mocked(setRouteSearchCache);

const req = (q: string) => new NextRequest(`http://x/api/routes/search?q=${encodeURIComponent(q)}`);

const exactRow = {
  id: 'vach-1',
  title: 'Горный массив Вачкажец',
  distance_km: '12.20',
  difficulty_level: 'medium',
  elevation_gain_m: 791,
  zone: null,
  has_line: true,
  geometry_source: 'visitkamchatka',
  waypoint_names: null,
  waypoint_ids: null,
  waypoint_lats: null,
  waypoint_lngs: null,
};

const semanticSideRow = {
  id: 'other-1',
  title: 'Тропа к термальным источникам',
  distance_km: '5.00',
  difficulty_level: 'easy',
  elevation_gain_m: 100,
  zone: null,
  has_line: false,
  geometry_source: null,
  waypoint_names: null,
  waypoint_ids: null,
  waypoint_lats: null,
  waypoint_lngs: null,
};

beforeEach(() => {
  queryMock.mockReset();
  semanticMock.mockReset();
  setCacheMock.mockReset();
});

describe('/api/routes/search — ILIKE не отменяется успешной семантикой', () => {
  it('семантика нашла постороннее, но точное совпадение по имени всё равно в списке первым', async () => {
    semanticMock.mockResolvedValue([{
      id: 'other-1', title: semanticSideRow.title, description: null, category: 'trekking',
      sourceUrl: null, sourceName: null, lat: null, lng: null, similarity: 0.4,
    }]);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('r.id = ANY($1::uuid[])')) {
        return { rows: [semanticSideRow], rowCount: 1 } as never;
      }
      return { rows: [exactRow], rowCount: 1 } as never;
    });

    const res = await GET(req('Вачкажец'));
    const body = await res.json() as { routes: Array<{ id: string }>; semantic: boolean };

    expect(body.semantic).toBe(true);
    const ids = body.routes.map(r => r.id);
    expect(ids).toContain('vach-1');
    expect(ids).toContain('other-1');
    // Точное совпадение — первым: пользователь не должен листать мимо него.
    expect(ids[0]).toBe('vach-1');
  });

  it('семантика нашла ровно то же, что и ILIKE — маршрут не дублируется', async () => {
    semanticMock.mockResolvedValue([{
      id: 'vach-1', title: exactRow.title, description: null, category: 'trekking',
      sourceUrl: null, sourceName: null, lat: null, lng: null, similarity: 0.9,
    }]);
    queryMock.mockResolvedValue({ rows: [exactRow], rowCount: 1 } as never);

    const res = await GET(req('Вачкажец'));
    const body = await res.json() as { routes: Array<{ id: string }> };
    expect(body.routes.filter(r => r.id === 'vach-1')).toHaveLength(1);
  });

  it('семантика пуста — ILIKE один даёт точный ответ, semantic: false', async () => {
    semanticMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [exactRow], rowCount: 1 } as never);

    const res = await GET(req('Вачкажец'));
    const body = await res.json() as { routes: Array<{ id: string }>; semantic: boolean };
    expect(body.semantic).toBe(false);
    expect(body.routes.map(r => r.id)).toEqual(['vach-1']);
  });

  it('кэш пишется, только когда семантика реально что-то добавила', async () => {
    semanticMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [exactRow], rowCount: 1 } as never);
    await GET(req('Вачкажец'));
    expect(setCacheMock).not.toHaveBeenCalled();

    setCacheMock.mockReset();
    semanticMock.mockResolvedValue([{
      id: 'other-1', title: semanticSideRow.title, description: null, category: 'trekking',
      sourceUrl: null, sourceName: null, lat: null, lng: null, similarity: 0.4,
    }]);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('r.id = ANY($1::uuid[])')) {
        return { rows: [semanticSideRow], rowCount: 1 } as never;
      }
      return { rows: [exactRow], rowCount: 1 } as never;
    });
    await GET(req('Вачкажец'));
    expect(setCacheMock).toHaveBeenCalledTimes(1);
  });

  it('семантика упала ошибкой — ILIKE всё равно находит точное имя', async () => {
    semanticMock.mockRejectedValue(new Error('модель недоступна'));
    queryMock.mockResolvedValue({ rows: [exactRow], rowCount: 1 } as never);

    const res = await GET(req('Вачкажец'));
    expect(res.status).toBe(200);
    const body = await res.json() as { routes: Array<{ id: string }> };
    expect(body.routes.map(r => r.id)).toEqual(['vach-1']);
  });
});
