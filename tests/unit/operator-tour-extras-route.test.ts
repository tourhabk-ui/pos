/**
 * Кабинет оператора правит программу дня, правила безопасности, видео и
 * подпись снимков тура (08.11) — те же поля и пределы, что у формы гида.
 *
 * До этого дня UpdateTourSchema этих полей не знала, Zod их молча выбрасывал,
 * и программа, правила и клипы оператора правились только миграцией или
 * чатом. Сторож — вызовом роута: что уходит в UPDATE тура, что — в карту
 * авторов партнёра, что отвергается, и что GET отдаёт форме.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { clientQuery, getTourByIdMock, auth } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  getTourByIdMock: vi.fn(),
  auth: { value: { userId: 'user-op', role: 'operator' } as { userId: string; role: string } },
}));

vi.mock('@/lib/auth/middleware', () => ({ requireOperator: vi.fn(async () => auth.value) }));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => 'op-mestechko') }));
vi.mock('@/lib/operators/team-access', () => ({ requireTeamPermission: vi.fn(async () => null) }));
vi.mock('@/lib/operators/team-money', () => ({ changesTourPrice: () => false }));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));
vi.mock('@/lib/db/column-types', () => ({ getColumnTypes: vi.fn(async () => new Map()), valueForColumn: (v: unknown) => v }));
vi.mock('@/lib/storage/s3', () => ({ s3PublicUrl: (k: string) => `https://s3.test/bucket/${k}` }));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof clientQuery }) => unknown) => fn({ query: clientQuery }),
}));
vi.mock('@/lib/api/operator-tours', async (orig) => {
  const real = await orig<typeof import('@/lib/api/operator-tours')>();
  return { ...real, getTourById: getTourByIdMock, softDeleteTour: vi.fn() };
});

import { GET, PATCH } from '@/app/api/hub/operator/tours/[id]/route';

const ctx = { params: Promise.resolve({ id: '51' }) };
const patch = (body: unknown) => PATCH(
  new NextRequest('https://vedarai.ru/api/hub/operator/tours/51', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  ctx,
);
const CLIP = { key: 'videos/mestechko/clip-kurilskoe.mp4', poster: 'videos/mestechko/clip-kurilskoe.poster.jpg', label: 'Над озером' };

/** SQL и значения всех запросов транзакции. */
const calls = () => clientQuery.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: values as unknown[] }));
const tourUpdate = () => calls().find((c) => /UPDATE operator_tours/.test(c.sql));
const creditWrite = () => calls().find((c) => /UPDATE partners/.test(c.sql));

beforeEach(() => {
  auth.value = { userId: 'user-op', role: 'operator' };
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [{ id: '51', title: 'Курильское озеро (вертолёт)', updated_at: 'now' }] });
  getTourByIdMock.mockReset();
  getTourByIdMock.mockResolvedValue({ id: '51', operator_id: 'op-mestechko', base_price: 180000 });
});

describe('PATCH: программа, правила, видео — в строку тура', () => {
  it('программа и клипы уходят JSON, правила — списком', async () => {
    const program = [{ title: 'День 1. Вылет из Елизова', text: 'Сбор в 08:00 у вертолётной площадки.' }];
    const res = await patch({ program, safety_notes: ['Слушать пилота'], video_clips: [CLIP] });
    expect(res.status).toBe(200);
    const u = tourUpdate();
    expect(u?.sql).toMatch(/program = \$\d+/);
    expect(u?.sql).toMatch(/safety_notes = \$\d+/);
    expect(u?.sql).toMatch(/video_clips = \$\d+/);
    expect(u?.values).toContain(JSON.stringify(program));
    expect(u?.values).toContainEqual(['Слушать пилота']);
    expect(u?.values).toContain(JSON.stringify([CLIP]));
  });

  it('null снимает программу и правила', async () => {
    await patch({ program: null, safety_notes: null });
    const u = tourUpdate();
    expect(u?.sql).toMatch(/program = \$1/);
    expect(u?.values.slice(0, 2)).toEqual([null, null]);
  });

  it('поля не присланы — не трогаются', async () => {
    await patch({ title: 'Курильское озеро (вертолёт)' });
    expect(tourUpdate()?.sql).not.toMatch(/program|safety_notes|video_clips/);
  });

  it('чужой адрес ролика, пустая программа, лишнее поле клипа — 400, ни строки не тронуто', async () => {
    for (const body of [
      { video_clips: [{ ...CLIP, key: 'https://evil.example/clip.mp4' }] },
      { video_clips: [{ ...CLIP, poster: 'videos/../secret.jpg' }] },
      { video_clips: [{ ...CLIP, url: 'https://x' }] },
      { program: [] },
      { program: [{ title: '', text: 'без названия' }] },
      { safety_notes: ['x'.repeat(501)] },
      { photo_credit: 'А' },
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(clientQuery).not.toHaveBeenCalled();
  });
});

describe('PATCH: подпись снимков — в карту авторов владельца тура', () => {
  it('подпись не колонка тура: UPDATE тура без неё, карта партнёра — с фото формы', async () => {
    await patch({ photos: ['/images/tours/a.jpg', '/images/tours/b.jpg'], photo_credit: '  Местечко Камчатка ' });
    expect(tourUpdate()?.sql).not.toMatch(/photo_credit/);
    const w = creditWrite();
    expect(w?.sql).toMatch(/gallery_credits = COALESCE\(gallery_credits, '\{\}'::jsonb\)/);
    expect(w?.sql).toMatch(/WHERE NOT \(COALESCE\(gallery_credits, '\{\}'::jsonb\) \? u\)/);
    expect(w?.values).toEqual(['op-mestechko', 'Местечко Камчатка', ['/images/tours/a.jpg', '/images/tours/b.jpg']]);
  });

  it('без фото в правке или без подписи — карта не трогается', async () => {
    await patch({ photo_credit: 'Местечко Камчатка', title: 'Курильское озеро (вертолёт)' });
    expect(creditWrite()).toBeUndefined();
    clientQuery.mockClear();
    await patch({ photos: ['/images/tours/a.jpg'] });
    expect(creditWrite()).toBeUndefined();
  });

  it('администратор подписывает снимки владельцу тура, а не себе', async () => {
    auth.value = { userId: 'user-admin', role: 'admin' };
    getTourByIdMock.mockResolvedValue({ id: '51', operator_id: 'op-laguna', base_price: 9000 });
    await patch({ photos: ['/images/tours/a.jpg'], photo_credit: 'Лагуна Экспедиция' });
    expect(creditWrite()?.values[0]).toBe('op-laguna');
  });

  it('тур не записан (удалён между чтением и записью) — подпись не пишется', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });
    const res = await patch({ photos: ['/images/tours/a.jpg'], photo_credit: 'Местечко Камчатка' });
    expect(res.status).toBe(404);
    expect(creditWrite()).toBeUndefined();
  });

  it('чужой тур — 404 до транзакции', async () => {
    getTourByIdMock.mockResolvedValue({ id: '51', operator_id: 'op-other' });
    const res = await patch({ photos: ['/images/tours/a.jpg'], photo_credit: 'Местечко Камчатка' });
    expect(res.status).toBe(404);
    expect(clientQuery).not.toHaveBeenCalled();
  });
});

describe('GET: форма получает клипы с адресами и подписи', () => {
  it('клип без обложки отброшен, адреса — из хранилища; подписи — только строки', async () => {
    getTourByIdMock.mockResolvedValue({
      id: '51', operator_id: 'op-mestechko', on_storefront: true,
      video_clips: [CLIP, { key: 'videos/mestechko/no-poster.mp4', label: 'без обложки' }],
      photo_credits: { '/images/tours/a.jpg': 'Местечко Камчатка', '/images/tours/b.jpg': 42 },
    });
    const res = await GET(new NextRequest('https://vedarai.ru/api/hub/operator/tours/51'), ctx);
    const json = await res.json() as { data: Record<string, unknown> };
    expect(json.data.video_clips).toEqual([{
      ...CLIP,
      url: 'https://s3.test/bucket/videos/mestechko/clip-kurilskoe.mp4',
      posterUrl: 'https://s3.test/bucket/videos/mestechko/clip-kurilskoe.poster.jpg',
    }]);
    expect(json.data.photo_credits).toEqual({ '/images/tours/a.jpg': 'Местечко Камчатка' });
    expect(json.data.on_storefront).toBe(true);
  });
});
