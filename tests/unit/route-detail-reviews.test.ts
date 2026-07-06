/**
 * tests/unit/route-detail-reviews.test.ts
 *
 * GET /api/routes/[id] — объединение двух карточек маршрута: канонический
 * эндпоинт теперь отдаёт reviews[] и pdfUrl (перенесены из удалённого
 * /api/routes/detail/[id]). Контракт: отзывы читаются по legacy ark_id
 * (fallback на id), при отсутствии отзывов — честный пустой массив;
 * ошибка запроса отзывов не роняет карточку.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import { GET } from '@/app/api/routes/[id]/route';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const ARK_ID = '99999999-8888-7777-6666-555555555555';

const ROUTE_ROW = {
  id: ROUTE_ID,
  route_dedupe_key: 'avachinsky',
  route_id: null,
  category: 'route',
  location_type: null,
  activity_type: 'trekking',
  title: 'Авачинский перевал',
  description: 'Классика',
  lat: '53.2', lng: '158.8',
  source_url: null, source_name: null,
  payload: {},
  created_at: '2026-01-01',
  kuzmich_review: null,
  has_ai_image: false,
  mchs_registration_required: true,
  mchs_phone: '+74152300000',
  park_name: null,
  park_approval_url: null,
  hazards: null,
  kr_equipment: null,
  distance_km: '14',
  elevation_gain_m: 700,
  kr_duration_hours: '8',
  pdf_url: 'https://visitkamchatka.ru/passport.pdf',
  kr_ark_id: ARK_ID,
};

const REVIEW_ROW = {
  id: 5,
  rating: 5,
  comment: 'Отличный маршрут',
  created_at: '2026-06-01',
  author_name: 'Иван',
};

function req(): NextRequest {
  return new Request(`http://localhost/api/routes/${ROUTE_ID}`) as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: ROUTE_ID }) };

function mockQueries(reviews: unknown[] | Error) {
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM agent_route_knowledge')) return Promise.resolve({ rows: [ROUTE_ROW] });
    if (sql.includes('FROM v_route_marketplace')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM route_waypoints')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM reviews')) {
      return reviews instanceof Error ? Promise.reject(reviews) : Promise.resolve({ rows: reviews });
    }
    throw new Error('unexpected SQL: ' + sql);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/routes/[id] — reviews + pdfUrl (объединение карточек)', () => {
  it('отдаёт pdfUrl и отзывы, отзывы запрашиваются по ark_id', async () => {
    mockQueries([REVIEW_ROW]);

    const res = await GET(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.pdfUrl).toBe('https://visitkamchatka.ru/passport.pdf');
    expect(json.data.reviews).toEqual([{
      id: '5', rating: 5, comment: 'Отличный маршрут',
      authorName: 'Иван', createdAt: '2026-06-01',
    }]);

    const reviewsCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM reviews')) as [string, unknown[]];
    expect(reviewsCall[1]).toEqual([ARK_ID]);
  });

  it('нет отзывов → пустой массив, не выдуманные данные', async () => {
    mockQueries([]);

    const res = await GET(req(), ctx);
    const json = await res.json();
    expect(json.data.reviews).toEqual([]);
  });

  it('ошибка запроса отзывов не роняет карточку (fail-soft)', async () => {
    mockQueries(new Error('relation reviews does not exist'));

    const res = await GET(req(), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.reviews).toEqual([]);
    expect(json.data.title).toBe('Авачинский перевал');
  });
});
