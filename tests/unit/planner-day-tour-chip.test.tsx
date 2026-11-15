/**
 * Тур в карточке дня планировщика (разбор планера 14.11, экран-2/12, смета-3).
 *
 * Судится то, что видит человек: ссылка на тур дня — рендером, правило — вызовом,
 * пометка «в другой зоне» — ответом роута (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
// Планер — только после входа (14.11, «6-3»): здесь проверяется сам роут,
// вход держит tests/unit/planner-api-login.test.ts.
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u-planner' })) }));

import { DayTourChip } from '@/components/planner/DayTourChip';
import { planTourChip, dayTourPriceText } from '@/lib/planner/day-tour-chip';
import { GET as toursForDay } from '@/app/api/planner/tours-for-day/route';

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { cleanup(); });

describe('тур плана — он и есть тур дня', () => {
  const gorely = {
    type: 'activity', title: 'Горелый', realPrice: 48000,
    realTour: { tourId: '12', operatorSlug: 'op', priceUnit: 'per_tour' },
  };

  it('день с туром — ссылка на этот тур, цена с единицей', () => {
    const chip = planTourChip(gorely)!;
    expect(chip).toMatchObject({ id: '12', title: 'Горелый', base_price: '48000', price_unit: 'per_tour' });
    render(<DayTourChip chip={chip} href="/catalog/tours/12#booking" />);
    const link = screen.getByTestId('day-tour-chip');
    expect(link.getAttribute('href')).toBe('/catalog/tours/12#booking');
    expect(link.textContent?.replace(/ /g, ' ')).toContain('Горелый');
    expect(link.textContent?.replace(/ /g, ' ')).toContain('от 48 000 ₽/группа · оставить заявку');
  });

  it('день продолжения многодневного тура и день без тура — ссылки из плана нет', () => {
    expect(planTourChip({ type: 'activity', title: 'Горелый — день 2 из 3', realTour: gorely.realTour })).toBeNull();
    expect(planTourChip({ type: 'activity', title: 'Вулканы' })).toBeNull();
  });

  it('цены для группы нет — «цену называет оператор», а не «от 0 ₽»', () => {
    const chip = planTourChip({ ...gorely, realPrice: undefined, priceMissing: 'цену называет оператор' })!;
    expect(dayTourPriceText(chip)).toBe('цену называет оператор');
  });

  it('единица не записана — сказано, а не выдано за «с человека»', () => {
    expect(dayTourPriceText({ base_price: '15000', price_unit: 'per_person' })).toBe('от 15 000 ₽/чел.');
    expect(dayTourPriceText({ base_price: '15000', price_unit: null })).toMatch(/за что — уточните$/);
  });
});

describe('тур из другой зоны помечен', () => {
  const row = {
    id: '7', slug: null, title: 'Вулкан Мутновский', short_description: null, base_price: '9000', price_unit: 'per_person',
    duration_hours: 10, tour_image: null, operator_name: 'Оператор', operator_slug: 'op', nearest_free_date: null,
  };

  it('в зоне дня подходящего нет — общий ответ с other_zone, и карточка это говорит', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    const res = await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=volcano&zone=eastern'));
    const body = await res.json() as { tours: Array<Record<string, unknown>> };
    expect(body.tours[0]).toMatchObject({ id: '7', other_zone: true });
    render(<DayTourChip chip={body.tours[0] as never} href="#" />);
    expect(screen.getByTestId('day-tour-chip').textContent).toContain('в другой зоне');
  });

  it('тур из зоны дня — без пометки', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [row] });
    const res = await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=volcano&zone=avachinsky'));
    const body = await res.json() as { tours: Array<Record<string, unknown>> };
    expect(body.tours[0]).not.toHaveProperty('other_zone');
  });
});
