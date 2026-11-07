/**
 * Страница готового плана /plans/[slug] (аудит планировщика 07.11, волна 2.7,
 * H16): «5 дней» — пять календарных, дни подряд (пропуск — свободный день),
 * строка «Наполнили N из M» видна, тур дня — тот, что поставил движок.
 * Правила — lib/plans/preset-plan (вызовом), страница — рендером.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';

const m = vi.hoisted(() => ({
  recommendTrip: vi.fn(),
  toursByIds: vi.fn(),
  topToursByActivity: vi.fn(),
}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/lib/planner', () => ({ recommendTrip: m.recommendTrip }));
vi.mock('@/lib/tours/top-tour-by-activity', () => ({ toursByIds: m.toursByIds, topToursByActivity: m.topToursByActivity }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/plans/OtherPlans', () => ({ OtherPlans: () => null }));

import PlanPresetPage from '@/app/plans/[slug]/page';
import { presetPlanDates, planFillNote, presetCalendarDays, presetDayTour, PRESET_FREE_DAY_TEXT } from '@/lib/plans/preset-plan';
import { PLAN_PRESETS } from '@/lib/plans/presets';
import { PLAN_TOUR_RULE_RU } from '@/components/plans/PlanKindOffers';

const day = (n: number, extra: Record<string, unknown> = {}) => ({
  day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, description: '', activityType: 'volcano',
  priceFrom: 0, priceTo: 0, coords: [53.0, 158.6], ...extra,
});
const tour = (id: string, title: string) => ({
  id, slug: null, title, base_price: '15000', operator_name: 'Оператор', operator_slug: null, operator_public: false, offers_of_kind: 3,
});
const bookingHref = (article: HTMLElement, title: string) =>
  within(article).getByRole('link', { name: `${title}: оставить заявку` }).getAttribute('href');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('даты пресета — N календарных дней', () => {
  it('«5 дней» — прилёт и отъезд через четыре дня, а не через пять', () => {
    const { arrival, departure } = presetPlanDates(5, ['volcano'], new Date('2026-11-07T00:00:00Z'));
    // Вулканы — с июля: ближайший старт в сезоне.
    expect(arrival).toBe('2027-07-10');
    expect(departure).toBe('2027-07-14');
    const one = presetPlanDates(1, [], new Date('2026-11-07T00:00:00Z'));
    expect(one.departure).toBe(one.arrival);
  });
});

describe('строка недобора — от движка', () => {
  it('берётся «Наполнили …», а не любое предупреждение о длительности', () => {
    const fill = 'Наполнили 4 дня из 5: подтверждённых выходов на остальные дни у нас нет. Остальные дни не придумываем.';
    expect(planFillNote([
      { type: 'duration', message: 'Поездка короткая для Западной зоны' },
      { type: 'duration', message: fill },
      { type: 'season', message: 'Не сезон' },
    ])).toBe(fill);
    expect(planFillNote([{ type: 'duration', message: 'Поездка короткая' }])).toBeNull();
    expect(planFillNote(undefined)).toBeNull();
  });
});

describe('дни подряд и тур дня', () => {
  it('пропуск в номерах — свободный день со своим текстом; после вылета дней нет', () => {
    const out = presetCalendarDays([day(1), day(2), day(4, { type: 'departure', activityType: 'departure' })], 6);
    expect(out.map((d) => [d.day, d.type])).toEqual([[1, 'activity'], [2, 'activity'], [3, 'rest'], [4, 'departure']]);
    expect(out[2]).toMatchObject({ title: 'Свободный день', description: PRESET_FREE_DAY_TEXT });
  });

  it('тур движка — первым; нет его или снят с витрины — подбор по виду с пометкой', () => {
    const engine = { 70: 'Горелый' };
    const kind = { volcano: 'Любой вулкан' };
    expect(presetDayTour({ activityType: 'volcano', realTour: { tourId: '70' } }, engine, kind)).toEqual({ tour: 'Горелый', source: 'plan' });
    expect(presetDayTour({ activityType: 'volcano', realTour: { tourId: '99' } }, engine, kind)).toEqual({ tour: 'Любой вулкан', source: 'kind' });
    expect(presetDayTour({ activityType: 'volcano' }, engine, kind)).toEqual({ tour: 'Любой вулкан', source: 'kind' });
    expect(presetDayTour({ activityType: 'fishing' }, engine, kind)).toBeNull();
  });
});

describe('страница /plans/[slug]', () => {
  const preset = PLAN_PRESETS.find((p) => p.days === 5)!;
  beforeEach(() => {
    m.recommendTrip.mockResolvedValue({
      days: [
        day(1, { type: 'arrival', activityType: 'arrival', title: 'Прилёт' }),
        day(2, { title: 'Авачинский вулкан', realTour: { tourId: '70' }, availableDate: '2027-07-12' }),
        day(3, { title: 'Термальные источники' }),
        day(5, { type: 'departure', activityType: 'departure', title: 'Вылет' }),
      ],
      warnings: [{ type: 'duration', severity: 'important', message: 'Наполнили 4 дня из 5: подтверждённых выходов на остальные дни у нас нет. Остальные дни не придумываем.' }],
    });
    m.toursByIds.mockResolvedValue({ 70: tour('70', 'Горелый — тур движка') });
    m.topToursByActivity.mockResolvedValue({ volcano: tour('99', 'Подобран по виду') });
  });

  it('пять календарных дней подряд, недобор назван, тур дня — движка', async () => {
    render(await PlanPresetPage({ params: Promise.resolve({ slug: preset.slug }) }));
    // Движок спрошен на пять дней, а не на шесть.
    const asked = m.recommendTrip.mock.calls[0]![0] as { arrivalDate: string; departureDate: string };
    expect((Date.parse(asked.departureDate) - Date.parse(asked.arrivalDate)) / 86_400_000).toBe(4);
    expect(screen.getByText('5 дней (4 ночи)')).toBeTruthy();
    expect(screen.getByTestId('plan-fill-note').textContent).toMatch(/^Наполнили 4 дня из 5/);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['День 1. Прилёт', 'День 2. Авачинский вулкан', 'День 3. Термальные источники', 'День 4. Свободный день', 'День 5. Вылет']);
    // День 2 — тур движка; день 3 без тура движка — подбор по виду, правило названо.
    const day2 = screen.getByText('День 2. Авачинский вулкан').closest('article')!;
    expect(within(day2).getByText(/Горелый — тур движка/)).toBeTruthy();
    expect(within(day2).queryByText(/Подобран по виду/)).toBeNull();
    const day3 = screen.getByText('День 3. Термальные источники').closest('article')!;
    expect(within(day3).getByText(/Подобран по виду/)).toBeTruthy();
    // Подбор по виду — только дням без тура движка; правило подбора названо
    // один раз, «ещё N этого вида» — только у подобранного.
    expect(m.topToursByActivity).toHaveBeenCalledWith(['volcano'], expect.anything());
    expect(screen.getAllByText(PLAN_TOUR_RULE_RU)).toHaveLength(1);
    expect(within(day2).queryByText(/Этого вида ещё/)).toBeNull();
    expect(within(day3).getByText(/Этого вида ещё 2 предложения/)).toBeTruthy();
    // Дата дня — в форму брони (B-3): слот движка, иначе расчётная дата дня.
    expect(bookingHref(day2, 'Горелый — тур движка')).toMatch(/\?date=2027-07-12$/);
    const day3Date = new Date(Date.parse(asked.arrivalDate) + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(bookingHref(day3, 'Подобран по виду')).toBe(`/catalog/tours/99?date=${day3Date}`);
  });

  it('все туры дня — движка: подбора по виду нет, правило подбора не нужно; без недобора строки нет', async () => {
    m.recommendTrip.mockResolvedValueOnce({
      days: [
        day(1, { type: 'arrival', activityType: 'arrival', title: 'Прилёт' }),
        day(2, { title: 'Авачинский вулкан', realTour: { tourId: '70' } }),
        day(3, { title: 'Мутновский вулкан', realTour: { tourId: '71' } }),
        day(4, { type: 'rest', activityType: 'rest', title: 'Отдых' }),
        day(5, { type: 'departure', activityType: 'departure', title: 'Вылет' }),
      ],
      warnings: [{ type: 'duration', severity: 'info', message: 'Поездка короткая для Западной зоны' }],
    });
    m.toursByIds.mockResolvedValueOnce({ 70: tour('70', 'Тур семьдесят'), 71: tour('71', 'Тур семьдесят один') });
    render(await PlanPresetPage({ params: Promise.resolve({ slug: preset.slug }) }));
    expect(m.toursByIds).toHaveBeenCalledWith(['70', '71']);
    expect(m.topToursByActivity).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plan-fill-note')).toBeNull();
    expect(screen.queryByText(PLAN_TOUR_RULE_RU)).toBeNull();
    expect(screen.queryByText(/Этого вида ещё/)).toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(5);
  });
});
