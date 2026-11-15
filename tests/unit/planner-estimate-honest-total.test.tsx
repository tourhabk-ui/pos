/**
 * Итог сметы: «не посчитано», а не «0 ₽», и одно «на человека» у Кузьмича и
 * экрана (разбор планера 14.11, смета-2, -4, -7).
 *
 * С 14.11 (слово владельца «5 -1») в сумме только цены с источником — туры
 * операторов и выбранное жильё; поэтому итога нет у любого плана без цены
 * тура, а не только у жителя края. Слова «цен нет» — одни на экран, печать и
 * заявку (`NO_PRICES_YET`, строка заявки `toursLine`).
 *
 * Судится то, что читает человек: блок сметы — рендером, строки заявки,
 * печать и ответ Кузьмича — вызовом на настоящей формуле `estimateGroup`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { estimateGroup, calculatePriceBreakdown, NO_PRICES_YET, type EstimateDay, type EstimateProfile } from '@/lib/planner/estimate';
import { GroupEstimateBlock } from '@/components/planner/GroupEstimate';
import { planForLead, planLeadLines } from '@/lib/planner/plan-for-lead';
import { buildPlanPrintHtml } from '@/lib/planner/print-html';
import { formatPlanPrice } from '@/lib/kuzmich/trip-plan-tool';

afterEach(() => { cleanup(); });

const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
const LOCAL: EstimateProfile = { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'local' };
/** Житель края, один день: тур без цены для группы (ступени цены — от 6 человек). */
const NO_PRICE: EstimateDay[] = [{
  day: 1, type: 'activity', zone: 'avachinsky', title: 'Горелый', priceFrom: 0, priceTo: 0,
  priceMissing: 'Для группы из 2 чел. цену называет оператор.',
  realTour: { tourId: '12', priceUnit: 'per_person', lodgingIncluded: false },
}];

const printHtml = (est: ReturnType<typeof estimateGroup>) => buildPlanPrintHtml({
  dateRange: '2027-07-10', adults: 2, childAges: [], days: [], warnings: [], fmt: (n) => String(n),
  estimate: { people: est.people, lines: est.lines, total: est.total, perPerson: est.perPerson, assumptions: est.assumptions, unpriced: est.unpriced },
});

describe('итога нет — так и сказано', () => {
  const est = estimateGroup(NO_PRICE, LOCAL);

  it('формула: итог 0 — признак «нечего сложить»', () => {
    expect(est.total).toEqual([0, 0]);
    expect(est.unpriced.length).toBe(1);
  });

  it('экран: «не посчитано», а не «0 ₽»', () => {
    render(<GroupEstimateBlock estimate={est} />);
    const text = plain(screen.getByTestId('price-estimate').textContent ?? '');
    expect(text).toContain('Итого на группуне посчитано');
    expect(text).not.toMatch(/\b0 ₽/);
    expect(text).toContain(NO_PRICES_YET);
    expect(text).not.toContain('На человека');
  });

  it('заявка: «цен туров в плане нет», а не «0 ₽»', () => {
    const lines = planLeadLines(planForLead(NO_PRICE.map((d) => ({ ...d })), { ...LOCAL, arrivalDate: '2027-07-10' }));
    expect(lines[1]).toBe('Цен туров в плане нет · без цены: 1');
  });

  it('печать: «не посчитано», без «0 ₽»', () => {
    const html = printHtml(est);
    expect(html).toContain('<span>Итого на группу</span><span>не посчитано</span>');
    expect(html).toContain(NO_PRICES_YET);
    expect(html).not.toMatch(/Итого на группу<\/span><span>0/);
  });

  it('Кузьмич: «Итог не посчитан», без «0 ₽ на группу»', () => {
    const text = plain(formatPlanPrice(calculatePriceBreakdown(NO_PRICE), true, est).join('\n'));
    expect(text).toContain('Итог не посчитан: ни у одной строки сметы нет цены');
    expect(text).not.toMatch(/Итого на .*: 0 ₽/);
  });
});

describe('итог есть — строки без цены названы', () => {
  it('печать: «не вошло в итог» рядом с итогом', () => {
    const days: EstimateDay[] = [
      ...NO_PRICE,
      {
        day: 2, type: 'activity', zone: 'avachinsky', title: 'Авачинский', priceFrom: 9000, priceTo: 9000, realPrice: 9000,
        realTour: { tourId: '13', priceUnit: 'per_person', lodgingIncluded: false },
      },
    ];
    const html = printHtml(estimateGroup(days, LOCAL));
    expect(plain(html)).toContain('<span>Итого на группу</span><span>18000 ₽</span>');
    expect(html).toContain('Не вошло в итог: ');
  });
});

describe('«на человека» — одно число у Кузьмича и экрана', () => {
  // Тур за группу: в цены туров «на человека» не входит, в итог на группу — входит.
  const days: EstimateDay[] = [
    { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', priceFrom: 0, priceTo: 0 },
    {
      day: 2, type: 'activity', zone: 'avachinsky', title: 'Рыбалка', priceFrom: 0, priceTo: 0, realPrice: 45000,
      realTour: { tourId: '9', priceUnit: 'per_tour', maxParticipants: 8, lodgingIncluded: false },
    },
    { day: 3, type: 'departure', zone: 'avachinsky', title: 'Вылет', priceFrom: 0, priceTo: 0 },
  ];
  const profile: EstimateProfile = { adults: 3, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' };

  it('Кузьмич называет «на человека» итогом на группу, делённым на людей, — как на экране', () => {
    const group = estimateGroup(days, profile);
    const lines = formatPlanPrice(calculatePriceBreakdown(days), true, group).map(plain);
    render(<GroupEstimateBlock estimate={group} />);
    const screenText = plain(screen.getByTestId('price-estimate').textContent ?? '');
    expect(group.perPerson).toEqual([15000, 15000]);
    expect(lines).toContain('На человека: 15 000 ₽ — итог на группу, делённый на 3 чел., как в планировщике.');
    expect(screenText).toContain('На человека15 000 ₽');
  });
});
