/**
 * Страница по ссылке (аудит планировщика 07.11, волна 2.6):
 * - H13 — тур дня у опубликованной поездки — сохранённый, а не «лучший по
 *   типу»; подбор по виду остаётся только дням без тура плана;
 * - H14 — места на дату сравниваются с группой: одно место на двоих — не
 *   «места есть»; число людей наружу не уходит;
 * - H15 — ссылку можно закрыть: старый токен перестаёт открывать план.
 * Что читается из плана — tests/unit/shared-plan-tours.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
  readSharedPlan: vi.fn(),
  toursByIds: vi.fn(),
  topToursByActivity: vi.fn(),
  fetchAvailabilityForTour: vi.fn(),
  tourKeepsSchedule: vi.fn(),
  query: vi.fn(),
  userId: 'u1' as string | null,
}));
vi.mock('@/lib/trips/shared-plan', () => ({ readSharedPlan: m.readSharedPlan }));
vi.mock('@/lib/tours/top-tour-by-activity', () => ({ toursByIds: m.toursByIds, topToursByActivity: m.topToursByActivity }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: m.fetchAvailabilityForTour,
  fetchForecastDays: async () => ({ ok: false }),
  fetchContingencyAlternatives: async () => [],
}));
vi.mock('@/lib/seat-requests/service', () => ({ tourKeepsSchedule: m.tourKeepsSchedule }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: async () => (m.userId ? { userId: m.userId } : NextResponse.json({ success: false }, { status: 401 })),
}));
vi.mock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: async () => {}, MCP_ATTRIBUTION: { cookieName: 'x' } }));

import { GET } from '@/app/api/trips/share/[token]/route';
import { DELETE } from '@/app/api/trips/[id]/share/route';
import { dayAvailabilityLine } from '@/lib/trips/day-availability';
import { TRIP_SELECT } from '@/lib/trips/trip-write';

const TOKEN = '00000000-0000-4000-8000-000000000613';
const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const ARRIVAL = isoIn(200);
const dayDate = (n: number) => new Date(Date.parse(`${ARRIVAL}T00:00:00Z`) + (n - 1) * 86_400_000).toISOString().slice(0, 10);
const tour = (id: string, title: string) => ({
  id, slug: null, title, base_price: '15000', operator_name: 'Оператор', operator_slug: null, operator_public: false,
});
const day = (n: number, activityType = 'volcano') => ({
  day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, activityType, priceFrom: 0, priceTo: 0, coords: [53.01, 158.65],
});
const plan = (extra: Record<string, unknown> = {}) => ({
  kind: 'found',
  plan: {
    source: 'trip', id: 't1', title: 'План', arrival_date: ARRIVAL, departure_date: isoIn(204),
    places: [], activities: [], transport_by_day: {},
    days: [day(2), day(3), day(4, 'fishing')],
    day_tour_ids: { 2: '70' },
    people: 2,
    ...extra,
  },
});
const get = async () => {
  const res = await GET(new NextRequest(`http://x/api/trips/share/${TOKEN}`), { params: Promise.resolve({ token: TOKEN }) });
  return (await res.json() as { data: Record<string, unknown> }).data;
};

describe('тур дня у опубликованной поездки — сохранённый (H13)', () => {
  beforeEach(() => {
    m.readSharedPlan.mockResolvedValue(plan());
    m.toursByIds.mockResolvedValue({ 70: tour('70', 'Горелый — выбранный') });
    m.topToursByActivity.mockResolvedValue({ volcano: tour('99', 'Другой вулкан'), fishing: tour('5', 'Рыбалка') });
    m.fetchAvailabilityForTour.mockResolvedValue([]);
    m.tourKeepsSchedule.mockResolvedValue(false);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('день с туром плана — его тур; подбор по виду — только дням без тура', async () => {
    const data = await get();
    expect(data.day_tours).toEqual({ 2: tour('70', 'Горелый — выбранный') });
    expect(m.toursByIds).toHaveBeenCalledWith(['70']);
    expect(m.topToursByActivity).toHaveBeenCalledWith(['volcano', 'fishing']);
    // Места считаются для выбранного тура, а не для подменённого.
    expect(m.fetchAvailabilityForTour.mock.calls.find((c) => c[1] === dayDate(2))?.[0]).toBe('70');
    expect(m.fetchAvailabilityForTour.mock.calls.find((c) => c[1] === dayDate(3))?.[0]).toBe('99');
  });

  it('у всех дней тур плана — подбора по виду нет вовсе', async () => {
    m.readSharedPlan.mockResolvedValue(plan({ days: [day(2)] }));
    await get();
    expect(m.topToursByActivity).not.toHaveBeenCalled();
  });

  it('число людей наружу не уходит: состав группы по ссылке не виден', async () => {
    const data = await get();
    expect(data).not.toHaveProperty('people');
    expect(JSON.stringify(data)).not.toMatch(/"people"/);
  });
});

describe('места на дату — против группы (H14)', () => {
  beforeEach(() => {
    m.readSharedPlan.mockResolvedValue(plan({ days: [day(2)] }));
    m.toursByIds.mockResolvedValue({ 70: tour('70', 'Горелый') });
    m.topToursByActivity.mockResolvedValue({});
    m.tourKeepsSchedule.mockResolvedValue(true);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('одно место на двоих — «не хватит», ближайшая дата — где хватит на всех', async () => {
    m.fetchAvailabilityForTour.mockImplementation(async (_id: string, from: string, to: string) => (from === to
      ? [{ date: from, remaining: 1 }]
      : [{ date: dayDate(4), remaining: 1 }, { date: dayDate(6), remaining: 3 }]));
    const data = await get();
    expect((data.availability as Record<string, unknown>)[2]).toMatchObject({ date: dayDate(2), remaining: 1, state: 'short', next: dayDate(6) });
  });

  it('мест нет — ближайшая дата тоже на всю группу, а не на одного', async () => {
    m.fetchAvailabilityForTour.mockImplementation(async (_id: string, from: string, to: string) => (from === to
      ? []
      : [{ date: dayDate(3), remaining: 1 }, { date: dayDate(5), remaining: 2 }]));
    const data = await get();
    expect((data.availability as Record<string, unknown>)[2]).toMatchObject({ state: 'none', next: dayDate(5) });
  });

  it('мест хватает — «есть»; группа не записана — как раньше, на одного', async () => {
    m.fetchAvailabilityForTour.mockResolvedValue([{ date: dayDate(2), remaining: 2 }]);
    expect(((await get()).availability as Record<string, unknown>)[2]).toMatchObject({ state: 'open', remaining: 2 });
    m.readSharedPlan.mockResolvedValue(plan({ days: [day(2)], people: null }));
    m.fetchAvailabilityForTour.mockResolvedValue([{ date: dayDate(2), remaining: 1 }]);
    expect(((await get()).availability as Record<string, unknown>)[2]).toMatchObject({ state: 'open', remaining: 1 });
  });
});

describe('строка «на всю группу не хватит»', () => {
  it('с ближайшей датой — ведёт на неё; без неё — к оператору на дату дня', () => {
    expect(dayAvailabilityLine({ date: '2027-07-11', remaining: 1, state: 'short', next: '2027-07-15' })).toEqual({
      tone: 'warn',
      text: 'на 11.07 свободно 1 место — на всю группу не хватит; ближайшая дата, где хватит на всех, — 15.07',
      cta: 'заявка на 15.07', ctaDate: '2027-07-15',
    });
    expect(dayAvailabilityLine({ date: '2027-07-11', remaining: 2, state: 'short' })).toMatchObject({
      text: 'на 11.07 свободно 2 места — на всю группу не хватит', cta: 'спросить оператора', ctaDate: '2027-07-11',
    });
  });
});

describe('закрыть ссылку (H15)', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  const del = (id = ID) => DELETE(new NextRequest(`http://x/api/trips/${id}/share`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
  beforeEach(() => { m.query.mockReset(); m.userId = 'u1'; });

  it('публикация снята, токен сменён — старая ссылка больше не открывает план', async () => {
    m.query.mockResolvedValue({ rows: [{ id: ID }] });
    const res = await del();
    expect(res.status).toBe(200);
    const [sql, params] = m.query.mock.calls[0]!;
    expect(sql).toMatch(/SET is_public = FALSE, share_token = gen_random_uuid\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/);
    expect(params).toEqual([ID, 'u1']);
  });

  it('чужая, удалённая или не та — 404; без входа — 401', async () => {
    m.query.mockResolvedValue({ rows: [] });
    expect((await del()).status).toBe(404);
    m.query.mockClear();
    expect((await del('не-uuid')).status).toBe(404);
    expect(m.query).not.toHaveBeenCalled();
    m.userId = null;
    expect((await del()).status).toBe(401);
  });

  it('страница поездки знает, открыта ли ссылка: колонка в чтении поездки владельцем', () => {
    expect(TRIP_SELECT).toMatch(/\bis_public\b/);
    expect(TRIP_SELECT).not.toMatch(/\bshare_token\b/);
  });

  it('отказ базы — в лог с SQLSTATE, наружу общие слова', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.query.mockRejectedValue(Object.assign(new Error('relation "user_trips" does not exist'), { code: '42P01' }));
    const res = await del();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation|42P01/);
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/42P01/);
    spy.mockRestore();
  });
});
