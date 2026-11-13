/**
 * Боевой прогон планера 13.11 (#3338): 20–24.11.2026, двое, вулканы и
 * термальные.
 *
 * 1. Карточка дня 21.11 звала на «Восхождение на Горелый» с выездами
 *    15.07–15.10.2027: ссылка на тур бралась одна на вид занятия, без даты.
 *    Теперь — тур с выездом в этот день по правилу движка (tourFitsDate).
 * 2. Над «Отправить заявку» не было сказано, что заявка — не бронь, её
 *    подтверждает человек и оплаты через Ведар нет.
 * 3. Цены дня прилёта, отдыха и отъезда стояли на карточках и не входили в
 *    итог; блок «Зоны» показывал балл зоны («Восточная 10%») при плане целиком
 *    в Авачинской.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { catalogRowFitsDay } from '@/lib/planner/tour-day-fit';
import { GET as toursForDay } from '@/app/api/planner/tours-for-day/route';
import { RequestNotBooking } from '@/components/planner/RequestSummary';
import { PlanZones } from '@/components/planner/PlanZones';
import { estimateGroup, calculatePriceBreakdown, type EstimateDay, type EstimateProfile } from '@/lib/planner/estimate';

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const TODAY = '2026-11-13';

/** Горелый гида: календаря нет, сезон 15.07–15.10.2027, один день. */
const GORELY = {
  id: '101', slug: 'zaporozhets-vulkan-gorelyy', title: 'Восхождение на вулкан Горелый и лавовые пещеры',
  short_description: null, base_price: '15000', price_unit: 'per_person', duration_hours: 12,
  tour_image: null, operator_name: 'Андрей Запорожец', operator_slug: 'andrey-zaporozhets', nearest_free_date: null,
  season_start: '2027-07-15', season_end: '2027-10-15', duration_type: 'day', multi_day_count: null,
  keeps_schedule: false, free_on_date: null,
};

describe('1. тур в карточке дня — только с выездом в этот день', () => {
  it('тур без календаря вне сезона — не подходит, в сезоне — подходит', () => {
    expect(catalogRowFitsDay(GORELY, '2026-11-21', TODAY)).toBe(false);
    expect(catalogRowFitsDay(GORELY, '2027-08-10', TODAY)).toBe(true);
    expect(catalogRowFitsDay(GORELY, '2027-10-16', TODAY)).toBe(false);
  });

  it('сезон не записан — дату согласует оператор (как у движка)', () => {
    expect(catalogRowFitsDay({ ...GORELY, season_start: null, season_end: null }, '2026-11-21', TODAY)).toBe(true);
  });

  it('тур с календарём — только если в этот день есть свободные места', () => {
    const dated = { ...GORELY, keeps_schedule: true };
    expect(catalogRowFitsDay({ ...dated, free_on_date: '2026-11-21' }, '2026-11-21', TODAY)).toBe(true);
    expect(catalogRowFitsDay({ ...dated, free_on_date: null }, '2026-11-21', TODAY)).toBe(false);
  });

  it('роут с датой дня: Горелый на 21.11 не предлагается, тур с местами в этот день — да', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T02:00:00Z'));
    const thermal = { ...GORELY, id: '202', slug: 'paratunka', title: 'Источники Паратунки', season_start: null, season_end: null, keeps_schedule: true, free_on_date: '2026-11-21' };
    poolQuery.mockResolvedValue({ rows: [GORELY, thermal] });
    const res = await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=volcano&zone=avachinsky&date=2026-11-21&limit=3'));
    const body = await res.json() as { success: boolean; tours: Array<Record<string, unknown>> };
    expect(body.success).toBe(true);
    expect(body.tours.map((t) => t.title)).toEqual(['Источники Паратунки']);
    // Служебные столбцы проверки дня наружу не уходят.
    expect(Object.keys(body.tours[0]!)).not.toContain('season_start');
    expect(Object.keys(body.tours[0]!)).not.toContain('keeps_schedule');
    const [text, params] = poolQuery.mock.calls[0]! as [string, unknown[]];
    expect(params).toEqual(['volcano', 'avachinsky', '2026-11-21']);
    expect(text).toMatch(/AS free_on_date/);
  });

  it('в зоне подходящего нет — общий запрос с той же датой; и там нет — пусто', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T02:00:00Z'));
    poolQuery.mockResolvedValue({ rows: [GORELY] });
    const res = await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=volcano&zone=avachinsky&date=2026-11-21'));
    const body = await res.json() as { success: boolean; tours: unknown[] };
    expect(body.tours).toEqual([]);
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect((poolQuery.mock.calls[1]! as [string, unknown[]])[1]).toEqual(['volcano', '2026-11-21']);
  });

  it('без даты — как раньше: проверки дня нет', async () => {
    poolQuery.mockResolvedValue({ rows: [GORELY] });
    const res = await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=volcano&zone=avachinsky'));
    const body = await res.json() as { tours: Array<{ title: string }> };
    expect(body.tours.map((t) => t.title)).toEqual([GORELY.title]);
    expect((poolQuery.mock.calls[0]! as [string, unknown[]])[1]).toEqual(['volcano', 'avachinsky']);
  });
});

describe('2. форма заявки планера говорит, что это не бронь', () => {
  it('приём оплаты выключен: не бронь, подтверждает человек, Ведар платежи не принимает', () => {
    render(<RequestNotBooking acceptsPayments={false} />);
    const line = screen.getByTestId('planner-request-not-booking').textContent ?? '';
    expect(line).toContain('Заявка — не бронь');
    expect(line).toMatch(/менеджер Ведара свяжется/);
    expect(line).toMatch(/подтвердят операторы/);
    expect(line).toContain('Ведар платежи не принимает');
  });

  it('приём оплаты включён — без слов «не принимает»', () => {
    render(<RequestNotBooking acceptsPayments />);
    const line = screen.getByTestId('planner-request-not-booking').textContent ?? '';
    expect(line).toContain('Заявка — не бронь');
    expect(line).not.toContain('не принимает');
  });
});

describe('3. зоны — по дням плана', () => {
  const days = [1, 2, 3, 4, 5].map(() => ({ zone: 'avachinsky' as string | null }));

  it('все дни в Авачинской — одна зона и пять дней, Восточной нет', () => {
    render(<PlanZones days={days} crowd={[{ zone: 'avachinsky', crowdScore: null }, { zone: 'eastern', crowdScore: 10 }]} />);
    const block = screen.getByTestId('plan-zones');
    expect(block.textContent).toContain('Авачинская зона');
    expect(block.textContent).toContain('5 дней');
    expect(block.textContent).not.toContain('Восточная');
    expect(block.textContent).not.toContain('%');
  });

  it('зона дня — подписанная (zoneShown), загрузка выше 70 — «загружено»', () => {
    render(<PlanZones
      days={[{ zone: 'avachinsky' }, { zone: 'avachinsky', zoneShown: 'eastern' }, { zone: 'eastern' }]}
      crowd={[{ zone: 'eastern', crowdScore: 80 }]}
    />);
    const chips = within(screen.getByTestId('plan-zones')).getAllByText(/зона$/).map((n) => n.parentElement?.textContent ?? '');
    expect(chips).toEqual(['Авачинская зона1 день', 'Восточная зона2 днязагружено']);
  });
});

describe('3. метка загрузки зоны не утверждает лишнего (перенесено из planner-zone-crowd)', () => {
  const one = [{ zone: 'avachinsky' as string | null }];
  const label = (crowdScore: number | null | undefined) => {
    cleanup();
    render(<PlanZones days={one} crowd={[{ zone: 'avachinsky', crowdScore }]} />);
    const t = screen.getByTestId('plan-zones').textContent ?? '';
    return t.includes('загружено') ? 'загружено' : t.includes('умеренно') ? 'умеренно' : 'нет метки';
  };

  it('не измерено (null, нет поля) — метки нет: молчание, а не «свободно»', () => {
    expect(label(null)).toBe('нет метки');
    expect(label(undefined)).toBe('нет метки');
  });

  it('пороги прежние: до 50 — нет, выше 50 — умеренно, выше 70 — загружено', () => {
    expect(label(50)).toBe('нет метки');
    expect(label(51)).toBe('умеренно');
    expect(label(70)).toBe('умеренно');
    expect(label(71)).toBe('загружено');
  });
});

describe('3. смета сходится с карточками дней', () => {
  const PROFILE: EstimateProfile = { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' };
  const d = (day: number, type: EstimateDay['type'], priceFrom: number, priceTo: number, title = `День ${day}`): EstimateDay => ({
    day, type, zone: 'avachinsky', title, priceFrom, priceTo,
  });
  const TRIP = [
    d(1, 'arrival', 0, 3000, 'Прилёт'),
    d(2, 'activity', 5000, 15000, 'Вулканы — Авачинская зона'),
    d(3, 'rest', 1500, 5000, 'День отдыха. Термальные источники'),
    d(4, 'activity', 5000, 15000, 'Вулканы — Авачинская зона'),
    d(5, 'departure', 0, 2500, 'Вылет'),
  ];

  it('дни прилёта, отдыха и отъезда — строками сметы, в итоге', () => {
    const est = estimateGroup(TRIP, PROFILE);
    const labels = est.lines.filter((l) => l.kind === 'activity').map((l) => l.label);
    expect(labels).toEqual(['«Прилёт», день 1', '«Вулканы — Авачинская зона», день 2', '«День отдыха. Термальные источники», день 3', '«Вулканы — Авачинская зона», день 4', '«Вылет», день 5']);
    const activity = est.lines.filter((l) => l.kind === 'activity').reduce((s, l) => [s[0] + l.total![0], s[1] + l.total![1]], [0, 0]);
    expect(activity).toEqual([2 * (0 + 5000 + 1500 + 5000 + 0), 2 * (3000 + 15000 + 5000 + 15000 + 2500)]);
  });

  it('вилка на человека считает те же дни', () => {
    expect(calculatePriceBreakdown(TRIP, PROFILE).activities).toEqual([11500, 40500]);
  });

  it('свободный день (0–0) строки не даёт', () => {
    const est = estimateGroup([...TRIP.slice(0, 2), d(3, 'rest', 0, 0, 'Свободный день'), ...TRIP.slice(3)], PROFILE);
    expect(est.lines.map((l) => l.label)).not.toContain('«Свободный день», день 3');
  });

});
