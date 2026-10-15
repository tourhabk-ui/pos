/**
 * Публичные отзывы не отдают полное имя автора (аудит 15.10, Д4-3).
 *
 * GET /api/reviews (отзывы о турах) и GET /api/places/[id]/reviews открыты
 * анониму (lib/auth/public-api-routes.ts). Первый отдавал author_name как
 * есть, второй — COALESCE(rv.author_name, u.name): если автор не вписал имя,
 * наружу шло полное имя аккаунта. Тот же запрос стоял в загрузчике
 * публичной карточки места (lib/places/place-detail.ts).
 *
 * Правило — publicReviewerName (lib/reviews/public-name.ts): «Имя Ф.», пусто —
 * «Гость». Проверка вызовом роутов на подменённой базе: что видит аноним.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/places/aliases', async (orig) => ({
  ...(await orig<typeof import('@/lib/places/aliases')>()),
  resolveMergedTarget: vi.fn(async () => null),
}));

import { GET as tourReviewsGET } from '@/app/api/reviews/route';
import { GET as placeReviewsGET } from '@/app/api/places/[id]/reviews/route';
import { loadPlaceDetail } from '@/lib/places/place-detail';

const FULL = 'Иван Петрович Сидоров';
const ARK = '9f1c2d3e-0000-4000-8000-000000000001';

/** SQL, ушедшие в базу за вызов: по ним видно, выбирал ли роут имя аккаунта. */
function sqlSent(): string[] {
  return query.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  query.mockReset();
});

describe('GET /api/reviews — отзывы о турах', () => {
  it('полное имя автора уходит анониму как «Имя Ф.»', async () => {
    query.mockResolvedValue({
      rows: [{
        id: 1, tour_id: 51, author_name: FULL, rating: 5, comment: 'Отлично',
        photos: [], created_at: '2026-09-01T00:00:00Z', tour_name: 'Авачинский',
      }],
    });
    const res = await tourReviewsGET(new NextRequest('https://vedarai.ru/api/reviews?tourId=51'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ authorName: string }> };
    expect(body.data[0]?.authorName).toBe('Иван П.');
    const text = JSON.stringify(body);
    expect(text).not.toContain('Сидоров');
    expect(text).not.toContain('Петрович');
  });
});

describe('GET /api/places/[id]/reviews — отзывы о месте', () => {
  function placeDb(reviewRows: Array<Record<string, unknown>>) {
    query.mockImplementation(async (sql: string) => {
      if (/FROM reviews rv/.test(sql)) return { rows: reviewRows };
      if (/SELECT ark_id FROM places/.test(sql)) return { rows: [{ ark_id: ARK }] };
      return { rows: [] };
    });
  }
  const call = () => placeReviewsGET(
    new NextRequest(`https://vedarai.ru/api/places/${ARK}/reviews`),
    { params: Promise.resolve({ id: ARK }) },
  );

  it('имя, вписанное автором, — «Имя Ф.»', async () => {
    placeDb([{ id: 'r1', rating: 5, comment: 'Красиво', created_at: '2026-09-01T00:00:00Z', author_name: FULL }]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ authorName: string }> };
    expect(body.data[0]?.authorName).toBe('Иван П.');
    expect(JSON.stringify(body)).not.toContain('Сидоров');
  });

  it('имя не вписано — «Гость», имя аккаунта (users.name) роут не выбирает', async () => {
    placeDb([{ id: 'r2', rating: 4, comment: null, created_at: '2026-09-01T00:00:00Z', author_name: null }]);
    const res = await call();
    const body = await res.json() as { data: Array<{ authorName: string }> };
    expect(body.data[0]?.authorName).toBe('Гость');
    const reviewSql = sqlSent().filter((s) => /FROM reviews rv/.test(s));
    expect(reviewSql).toHaveLength(1);
    // Запрет: имя аккаунта в публичный отзыв не выбирается вовсе.
    expect(reviewSql[0]).not.toMatch(/\busers\b|\bu\.name\b/);
  });
});

describe('карточка места (loadPlaceDetail) — те же отзывы на публичной странице', () => {
  function cardDb(reviewRows: Array<Record<string, unknown>>) {
    query.mockImplementation(async (sql: string) => {
      if (/FROM reviews rv/.test(sql)) return { rows: reviewRows };
      if (/SELECT ark_id::text AS ark_id, slug FROM places/.test(sql)) return { rows: [{ ark_id: ARK, slug: 'mys' }] };
      if (/FROM places p/.test(sql) && /WHERE \(p\.ark_id::text = \$1/.test(sql)) {
        return { rows: [{ id: 'mys', ark_id: ARK, place_pk: 'mys', slug: 'mys', name: 'Мыс', location_type: 'cape',
          lat: '52.95', lng: '158.71', photo_count: 0, images: [], gallery_urls: [] }] };
      }
      return { rows: [] };
    });
  }

  it('полное имя — «Имя Ф.», пустое — «Гость»; users.name не выбирается', async () => {
    cardDb([
      { id: 'r1', rating: 5, comment: 'Красиво', created_at: '2026-09-01T00:00:00Z', author_name: FULL },
      { id: 'r2', rating: 4, comment: null, created_at: '2026-09-02T00:00:00Z', author_name: null },
    ]);
    const res = await loadPlaceDetail(ARK, { countView: false });
    expect(res.status).toBe(200);
    const data = res.body.data as { reviews: Array<{ authorName: string }> };
    expect(data.reviews.map((r) => r.authorName)).toEqual(['Иван П.', 'Гость']);
    expect(JSON.stringify(res.body)).not.toContain('Сидоров');
    const reviewSql = sqlSent().filter((s) => /FROM reviews rv/.test(s));
    expect(reviewSql).toHaveLength(1);
    expect(reviewSql[0]).not.toMatch(/\busers\b|\bu\.name\b/);
  });
});
