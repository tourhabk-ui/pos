/**
 * tests/unit/guide-tours-sql.test.ts
 *
 * GET /api/guide/tours — «Мои туры» гида.
 *
 * История: сперва SQL обращался к несуществующим колонкам tour_availability
 * (ta.tour_id, ta.available_date), потом — к `ot.operator_id = $1::bigint`
 * при uuid-колонке и к несуществующим includes_guide/includes_equipment:
 * привязанный гид получал 500 на каждом запросе, а непривязанный видел под
 * заголовком «Мои туры» ВСЕ туры платформы.
 *
 * 25.09 (пакет B) этот тест переписан ОСОЗНАННО: прежняя редакция закрепляла
 * именно то поведение, которое было ложью, — `operatorLinked=false` с
 * параметром NULL и фолбэком на все туры. Теперь контракт: туры — только
 * оператора команды (SQL из lib/guides/team-queries, его исполняет pg-тест
 * guide-team.pg), нет команды — `operator: null` и пустой список без
 * запроса туров, отказ базы — 500 с русским текстом и следом в логе.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { TEAM_SQL } from '@/lib/guides/team-queries';

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

const OPERATOR = '9f0c2a57-2b8c-4d7e-9e1a-3c4b5d6e7f80';

const TOUR_ROW = {
  id: '7',
  title: 'Морская прогулка к Трём Братьям',
  slug: 'tri-brata',
  description: 'Бухта Авачинская',
  activity_type: 'boat_trip',
  duration_hours: '4',
  base_price: '9500',
  max_participants: 12,
  future_slots: 5,
  my_assignments: 2,
};

function req(): NextRequest {
  return new Request('http://localhost/api/guide/tours') as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getGuidePartnerIdMock.mockResolvedValue('guide-partner-1');
  queryMock.mockImplementation((sql: string) => {
    if (sql === TEAM_SQL.membership) {
      return Promise.resolve({ rows: [{ operator_id: OPERATOR, operator_name: 'Камчатка Тур', operator_phone: '+79990000000' }] });
    }
    if (sql === TEAM_SQL.operatorTours) return Promise.resolve({ rows: [TOUR_ROW] });
    throw new Error('unexpected SQL: ' + sql);
  });
});

describe('GET /api/guide/tours — туры оператора команды', () => {
  it('туры спрашиваются по uuid оператора команды и id гида, без приведения к bigint', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const call = queryMock.mock.calls.find(([sql]) => sql === TEAM_SQL.operatorTours) as [string, unknown[]];
    expect(call[1]).toEqual([OPERATOR, 'guide-partner-1']);
    expect(TEAM_SQL.operatorTours).not.toMatch(/::bigint/);
    expect(TEAM_SQL.operatorTours).toContain('ta.operator_tour_id');
    expect(TEAM_SQL.operatorTours).toContain('ta.date');
    expect(TEAM_SQL.operatorTours).not.toMatch(/includes_guide|includes_equipment/);
  });

  it('ответ маппится в контракт _GuideToursClient', async () => {
    const json = await (await GET(req())).json();
    expect(json.success).toBe(true);
    expect(json.data.operator).toEqual({ id: OPERATOR, name: 'Камчатка Тур', phone: '+79990000000' });
    expect(json.data.tours[0]).toMatchObject({
      id: '7', futureSlots: 5, myAssignments: 2, basePrice: 9500, maxParticipants: 12, durationHours: 4,
    });
  });

  it('гид не в команде → operator: null, пустой список, туры платформы НЕ запрашиваются', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql === TEAM_SQL.membership) return Promise.resolve({ rows: [{ operator_id: null, operator_name: null, operator_phone: null }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ operator: null, tours: [] });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('ошибка БД → 500 с русским сообщением и следом в логе', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    queryMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '42883' }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Не удалось загрузить туры');
    expect(spy.mock.calls.flat().join(' ')).toContain('sqlstate=42883');
    spy.mockRestore();
  });

  it('нет профиля гида → 404', async () => {
    getGuidePartnerIdMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(404);
  });
});
