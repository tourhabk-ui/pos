/**
 * tests/unit/guide-tours-sql.test.ts
 *
 * GET /api/guide/tours — legacy-БАГ: SQL обращался к несуществующим колонкам
 * tour_availability (ta.tour_id, ta.available_date — реальные имена
 * operator_tour_id и date, migrations 040/041), из-за чего страница
 * «Мои туры» гида всегда получала 500 и показывала «Ошибка загрузки».
 * Контракт: SQL использует реальные колонки; ответ маппится в camelCase
 * с futureSlots (его читает _GuideToursClient); ошибка БД → честный 500
 * с русским сообщением, а не голое исключение.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn().mockResolvedValue({ userId: 'user-guide-1', role: 'guide' }),
}));

const getGuidePartnerIdMock = vi.fn();
vi.mock('@/lib/auth/guide-helpers', () => ({
  getGuidePartnerId: (...args: unknown[]) => getGuidePartnerIdMock(...args),
}));

import { GET } from '@/app/api/guide/tours/route';

const TOUR_ROW = {
  id: '7',
  title: 'Морская прогулка к Трём Братьям',
  slug: 'tri-brata',
  description: 'Бухта Авачинская',
  activity_type: 'boat_trip',
  duration_hours: '4',
  base_price: '9500',
  max_participants: '12',
  is_published: true,
  includes_guide: true,
  includes_equipment: false,
  operator_id: '3',
  operator_name: 'Камчатка Тур',
  operator_phone: '+79990000000',
  upcoming_slots: '5',
  future_slots: '5',
};

function req(): NextRequest {
  return new Request('http://localhost/api/guide/tours') as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getGuidePartnerIdMock.mockResolvedValue('guide-partner-1');
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('guide_operator_id')) {
      return Promise.resolve({ rows: [{ guide_operator_id: '3' }] });
    }
    if (sql.includes('FROM operator_tours')) {
      return Promise.resolve({ rows: [TOUR_ROW] });
    }
    throw new Error('unexpected SQL: ' + sql);
  });
});

describe('GET /api/guide/tours — реальные колонки tour_availability', () => {
  it('SQL использует operator_tour_id и ta.date, не legacy-имена', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);

    const toursCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM operator_tours'));
    expect(toursCall).toBeTruthy();
    const [sql] = toursCall as [string];
    expect(sql).toContain('ta.operator_tour_id');
    expect(sql).toContain('ta.date');
    expect(sql).not.toContain('available_date');
    expect(sql).not.toContain('ta.tour_id');
  });

  it('ответ маппится в контракт _GuideToursClient (futureSlots и camelCase)', async () => {
    const res = await GET(req());
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.operatorLinked).toBe(true);
    const tour = json.data.tours[0];
    expect(tour.futureSlots).toBe(5);
    expect(tour.upcomingSlots).toBe(5);
    expect(tour.basePrice).toBe(9500);
    expect(tour.maxParticipants).toBe(12);
    expect(tour.operatorName).toBe('Камчатка Тур');
  });

  it('гид без привязки к оператору → operatorId NULL, operatorLinked=false', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('guide_operator_id')) return Promise.resolve({ rows: [{ guide_operator_id: null }] });
      if (sql.includes('FROM operator_tours')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.operatorLinked).toBe(false);
    expect(json.data.tours).toEqual([]);

    const toursCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM operator_tours')) as [string, unknown[]];
    expect(toursCall[1]).toEqual([null]);
  });

  it('ошибка БД → 500 с русским сообщением, не голое исключение', async () => {
    queryMock.mockRejectedValue(new Error('column ta.available_date does not exist'));

    const res = await GET(req());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Не удалось загрузить туры');
  });

  it('нет профиля гида → 404', async () => {
    getGuidePartnerIdMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(404);
  });
});
