/**
 * Тур к дню плана — по правилу 1в (слово владельца 29.10), а не по рейтингу
 * и цене (ревью 29.10). Публичные /plans/[slug] и страница общего плана зовут
 * topToursByActivity: до ревью там стоял `ORDER BY rating DESC, base_price ASC
 * LIMIT 1`, и день плана навсегда отдавал продавца одной компании.
 *
 * Держит вызовом на граничных данных и рендером:
 *   - тур со свободной датой выше тура с рейтингом и низкой ценой;
 *   - без дат — жребий дня (тот же, что у orderOffers), в SQL нет ORDER BY и LIMIT;
 *   - offers_of_kind — сколько туров вида; строка «ещё N» ведёт в каталог с
 *     фильтром вида, один тур — строки нет;
 *   - подпись правила кончается «Место в списке не продаётся.»;
 *   - отказ подбора — в лог, без тура, а не падение страницы.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { topToursByActivity } from '@/lib/tours/top-tour-by-activity';
import { orderOffers } from '@/lib/tours/offer-order';
import { PlanKindOffers, PlanTourRule, PLAN_TOUR_RULE_RU } from '@/components/plans/PlanKindOffers';

afterEach(() => { cleanup(); poolQuery.mockReset(); vi.restoreAllMocks(); });

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id), slug: `t${id}`, title: `Тур ${id}`, base_price: '10000', weather_dependent: false,
  operator_name: `Компания ${id}`, operator_slug: null, operator_public: null, nearest_free_date: null, ...over,
});

describe('topToursByActivity — правило 1в', () => {
  it('тур со свободной датой выше тура с рейтингом и низкой ценой; в SQL нет ORDER BY и LIMIT', async () => {
    poolQuery.mockResolvedValue({ rows: [
      row(1, { base_price: '5000', rating: 4.9 }),
      row(2, { base_price: '40000', nearest_free_date: '2026-11-12' }),
    ] });
    const r = await topToursByActivity(['volcano'], { day: '2026-10-29' });
    expect(r.volcano.id).toBe('2');
    expect(r.volcano.offers_of_kind).toBe(2);
    expect(r.volcano).not.toHaveProperty('nearest_free_date');
    const sql = String(poolQuery.mock.calls[0]![0]);
    expect(sql).not.toMatch(/ot\.rating|ORDER BY ot\./);
    expect(sql.trim()).not.toMatch(/LIMIT\s+\d+$/);
    expect(sql).toMatch(/nearest_free_date/);
  });

  it('без дат — первый по жребию дня, и за месяц первыми бывают разные компании', async () => {
    const rows = [row(10), row(11), row(12)];
    poolQuery.mockResolvedValue({ rows });
    const firsts = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const day = `2026-11-${String(d).padStart(2, '0')}`;
      const r = await topToursByActivity(['jeep'], { day });
      const expected = orderOffers(rows.map((x) => ({ ...x, nearestFreeDate: null })), { day })[0]!.id;
      expect(r.jeep.id).toBe(expected);
      firsts.add(r.jeep.id);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });

  it('отказ подбора — в лог, без тура; соседний вид не падает', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'rafting') throw Object.assign(new Error('boom'), { code: '57014' });
      return { rows: [row(5)] };
    });
    const r = await topToursByActivity(['rafting', 'fishing'], { day: '2026-10-29' });
    expect(r.rafting).toBeUndefined();
    expect(r.fishing.id).toBe('5');
    expect(r.fishing.offers_of_kind).toBe(1);
    expect(err).toHaveBeenCalledWith('[top-tour-by-activity] подбор не выполнен', expect.objectContaining({ code: '57014' }));
  });
});

describe('строка «ещё N» и подпись правила (рендер)', () => {
  it('три тура вида — «ещё 2 предложения», ссылка в каталог с фильтром вида', () => {
    render(<PlanKindOffers activityType="jeep_safari" offers={3} />);
    expect(screen.getByText(/Этого вида ещё 2 предложения/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'все в каталоге' })).toHaveAttribute('href', '/catalog?activity_type=jeep_safari');
    expect(document.body.textContent).not.toMatch(/дешевле|лучше|выгодн/i);
  });

  it('один тур вида или число не пришло — строки нет', () => {
    const { container } = render(<><PlanKindOffers activityType="jeep" offers={1} /><PlanKindOffers activityType="jeep" /></>);
    expect(container.textContent).toBe('');
  });

  it('подпись правила кончается «Место в списке не продаётся.»', () => {
    render(<PlanTourRule />);
    expect(screen.getByText(PLAN_TOUR_RULE_RU).textContent).toMatch(/Место в списке не продаётся\.$/);
  });
});
