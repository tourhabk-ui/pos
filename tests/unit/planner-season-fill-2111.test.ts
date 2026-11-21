/**
 * Тест планировщика владельца 21.11, пп. 2–3: сезон тура по его полям и
 * план на N дней = N дней (пустые дни — самостоятельными местами из базы).
 * База — моки, вызовов LLM нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({ pool: { query: query } }));

import { seasonMonths, seasonCoversMonth, monthsNamedIn } from '@/lib/tours/season-month';
import { fetchActivitiesOnRequest, createPlannerCache } from '@/lib/planner/data';
import { buildTripSeason, inSeasonIn } from '@/lib/planner/trip-season';
import { fillEmptyDays, fetchSelfFillPlaces, selfTypesFor, type SelfPlace } from '@/lib/planner/self-fill';
import { formatTripPlanForChat } from '@/lib/kuzmich/trip-plan-tool';
import type { DayPlan } from '@/lib/planner/engine';

beforeEach(() => query.mockReset());

describe('сезон тура по полям season_start/season_end', () => {
  it('июль–сентябрь 2027 — ежегодный: январь вне, август в сезоне', () => {
    expect(seasonMonths('2027-07-19', '2027-09-29')).toEqual([7, 8, 9]);
    expect(seasonCoversMonth('2027-07-19', '2027-09-29', 1)).toBe(false);
    expect(seasonCoversMonth('2027-07-19', '2027-09-29', 8)).toBe(true);
  });
  it('через Новый год: 15.11–15.01 покрывает декабрь и январь, не сентябрь', () => {
    expect(seasonMonths('2026-11-15', '2027-01-15')).toEqual([11, 12, 1]);
    expect(seasonCoversMonth('2026-11-15', '2027-01-15', 9)).toBe(false);
  });
  it('сезона нет — null, а не «в сезоне»', () => {
    expect(seasonCoversMonth(null, null, 1)).toBeNull();
  });
  it('месяц из реплики человека', () => {
    expect(monthsNamedIn('рыбалка на кижуча, 4 дня, сентябрь')).toEqual([9]);
    expect(monthsNamedIn('семья с ребёнком 8 лет, 5 дней в январе')).toEqual([1]);
    expect(monthsNamedIn('Вулканы и море')).toEqual([]);
    expect(monthsNamedIn('в мае')).toEqual([5]);
  });
});

describe('туры без календаря открывают занятие только в свой сезон', () => {
  it('медведи Курильского озера (июль–сентябрь) январь не открывают', async () => {
    query.mockResolvedValue({ rows: [
      { activity_type: 'bears', season_start: '2027-07-19', season_end: '2027-09-29' },
      { activity_type: 'thermal', season_start: null, season_end: null },
    ] });
    const jan = await fetchActivitiesOnRequest(createPlannerCache(), 1);
    expect(jan?.has('bears')).toBe(false);
    expect(jan?.has('thermal') || jan?.has('hot_spring')).toBe(true); // круглый год по ориентиру
    const aug = await fetchActivitiesOnRequest(createPlannerCache(), 8);
    expect(aug?.has('bears')).toBe(true);
  });

  it('тур медведей без сезона в данных январь тоже не открывает', async () => {
    query.mockResolvedValue({ rows: [{ activity_type: 'bears', season_start: null, season_end: null }] });
    expect((await fetchActivitiesOnRequest(createPlannerCache(), 1))?.has('bears')).toBe(false);
  });

  it('сезон поездки по месяцам: январь без медведей, «только по заявке» пуст', () => {
    const scheduled = new Map([[1, new Set<string>()]]);
    const byMonth = new Map([[1, new Set<string>()]]);
    const season = buildTripSeason([1], scheduled, byMonth);
    expect(inSeasonIn(season, 'bears', 1)).toBe(false);
    expect(season.onRequestOnlyIn(1).has('bears')).toBe(false);
    // Прежний вызов одним множеством — как раньше (совместимость).
    const old = buildTripSeason([1], scheduled, new Set(['bears']));
    expect(inSeasonIn(old, 'bears', 1)).toBe(true);
  });
});

const SITE = 'https://vedarai.ru';
const day = (n: number, title: string, type: DayPlan['type'] = 'activity'): DayPlan => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: 'volcano', priceFrom: 0, priceTo: 0,
  coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'], difficulty: 'easy',
  childFriendly: true, minChildAge: 0, dayWarnings: [],
});
const PLACES: SelfPlace[] = [
  { name: 'Музей Камчатского края', href: '/places/muzej', type: 'museum', lat: 53.02, lng: 158.65 },
  { name: 'Халактырский пляж', href: '/places/halaktyr', type: 'beach', lat: 53.1, lng: 158.8 },
];

describe('план на 7 дней — 7 дней', () => {
  const six = [1, 2, 3, 4, 5, 7].map((n) => day(n, n === 1 ? 'Прилёт' : n === 7 ? 'Вылет' : `Занятие ${n}`, n === 1 ? 'arrival' : n === 7 ? 'departure' : 'activity'));

  it('пустой день 6 — самостоятельное место со ссылкой на /places', () => {
    const { days, filled } = fillEmptyDays(six, 7, PLACES, SITE);
    expect(days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(filled).toEqual([6]);
    expect(days[5]).toMatchObject({ title: 'Самостоятельно: Музей Камчатского края', activityMode: 'self', placeHref: `${SITE}/places/muzej` });
    expect(days[5].realTour).toBeUndefined();
  });

  it('в чате нет «Не заполнен», есть ссылка на место; дней ровно 7', () => {
    const { days } = fillEmptyDays(six, 7, PLACES, SITE);
    const text = formatTripPlanForChat(days, [], null, { refusal: '', plannedFor: '10 августа 2027' });
    expect(text).not.toMatch(/Не заполнен/);
    expect(text).toContain(`${SITE}/places/muzej`);
    expect(text.match(/^День \d+\./gm)).toHaveLength(7);
  });

  it('база не ответила — дни как были, без выдумки', () => {
    const { days, filled } = fillEmptyDays(six, 7, null, SITE);
    expect(days).toHaveLength(6);
    expect(filled).toEqual([]);
  });

  it('хвост поездки тоже заполняется, места не повторяются, пока есть другие', () => {
    const { days } = fillEmptyDays([day(1, 'Прилёт', 'arrival')], 3, PLACES, SITE);
    expect(days.map((d) => d.placeHref)).toEqual([undefined, `${SITE}/places/muzej`, `${SITE}/places/halaktyr`]);
  });

  it('места для дня без гида: только безопасные типы; зимой без пляжа', async () => {
    expect(selfTypesFor(1)).not.toContain('beach');
    expect(selfTypesFor(8)).toContain('beach');
    query.mockResolvedValue({ rows: [{ id: '1', slug: 'muzej', ark_id: null, name: 'Музей', location_type: 'museum', lat: '53.02', lng: '158.65' }] });
    const got = await fetchSelfFillPlaces(1);
    expect(got).toEqual([{ name: 'Музей', href: '/places/muzej', type: 'museum', lat: 53.02, lng: 158.65 }]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/registration_required/);
    expect(sql).toMatch(/sat_communicator_required/);
    expect(query.mock.calls[0][1][0]).not.toContain('volcano');
  });
});

describe('/trip хранит ссылку самостоятельного дня', () => {
  it('схема поездки не срезает placeHref /places/…, а чужую ссылку не пускает', async () => {
    const { TripDayPlanSchema } = await import('@/lib/trips/trip-schema');
    const { selfPlaceDay } = await import('@/lib/planner/self-fill');
    const day = selfPlaceDay(6, { id: 1, name: 'Краеведческий музей', type: 'museum', lat: 53.02, lng: 158.65, href: '/places/kraevedchesky-muzey' } as never, 'https://vedarai.ru');
    const parsed = TripDayPlanSchema.parse(day);
    expect(parsed.placeHref).toBe('https://vedarai.ru/places/kraevedchesky-muzey');
    expect(TripDayPlanSchema.safeParse({ ...day, placeHref: 'https://evil.example/x' }).success).toBe(false);
  });
});
