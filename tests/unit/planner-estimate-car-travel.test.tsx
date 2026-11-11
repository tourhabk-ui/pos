/**
 * Смета плана (аудит планировщика 07.11, волна 2.5):
 * - машина напрокат — трансфер аэропорта не считается, если его не просили
 *   отдельно, а прокат назван словами: цены до заявки нет (E7);
 * - ночь дня переезда — в зоне, куда приехали, и в смете, и в подборе жилья
 *   (E11, nightZoneOf);
 * - переезд без цены в данных (вертолётное ребро зон) — строка «цену
 *   называет перевозчик», а не молчаливый ноль.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';
import { estimateGroup, calculatePriceBreakdown, type EstimateDay, type EstimateProfile } from '@/lib/planner/estimate';
import { lodgingStays } from '@/lib/planner/trip-extras';
import { planForLead } from '@/lib/planner/plan-for-lead';
import { GroupEstimateBlock } from '@/components/planner/GroupEstimate';

afterEach(cleanup);

const d = (day: number, type: EstimateDay['type'], zone: EstimateDay['zone'], extra: Partial<EstimateDay> = {}): EstimateDay => ({
  day, type, zone, title: `День ${day}`, priceFrom: 0, priceTo: 0, ...extra,
});
const PROFILE: EstimateProfile = { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' };
/** Прилёт и вылет: одна ночь в Авачинской зоне, 7 000 ₽ на человека. */
const SHORT = [d(1, 'arrival', 'avachinsky'), d(2, 'departure', 'avachinsky')];
const hasTransfer = (days: EstimateDay[], profile: EstimateProfile) =>
  estimateGroup(days, profile).lines.some((l) => l.label === 'Трансферы аэропорта');

describe('машина напрокат вместо трансфера (E7)', () => {
  it('машина — трансфера нет, итог без него, прокат назван словами', () => {
    const withCar = estimateGroup(SHORT, { ...PROFILE, needs: { car: true } });
    expect(withCar.lines.some((l) => l.label === 'Трансферы аэропорта')).toBe(false);
    expect(withCar.total).toEqual([14000, 14000]);
    expect(withCar.assumptions).toContain('Трансфер аэропорта не посчитан: в плане машина напрокат. Прокат в смету не входит — цену подтверждает прокатчик.');
    expect(estimateGroup(SHORT, PROFILE).total).toEqual([19000, 24000]);
  });

  it('машина и трансфер отмечены оба — трансфер остаётся', () => {
    const e = estimateGroup(SHORT, { ...PROFILE, needs: { car: true, transfer: true } });
    expect(e.lines.some((l) => l.label === 'Трансферы аэропорта')).toBe(true);
    expect(e.assumptions).toContain('Машина напрокат в смету не входит — цену подтверждает прокатчик.');
  });

  it('местный с машиной — трансфера нет и не было, прокат назван', () => {
    const e = estimateGroup(SHORT, { ...PROFILE, tripOrigin: 'local', needs: { car: true } });
    expect(e.lines.some((l) => l.label === 'Трансферы аэропорта')).toBe(false);
    expect(e.assumptions).toContain('Машина напрокат в смету не входит — цену подтверждает прокатчик.');
  });

  it('не записано или без машины — как раньше', () => {
    expect(hasTransfer(SHORT, PROFILE)).toBe(true);
    expect(hasTransfer(SHORT, { ...PROFILE, needs: { car: false } })).toBe(true);
    expect(estimateGroup(SHORT, PROFILE).assumptions.join(' ')).not.toMatch(/напрокат/);
  });

  it('заявка считает так же, как экран', () => {
    const needs = { lodging: false, transfer: false, car: true };
    const plan = planForLead(SHORT, { ...PROFILE, arrivalDate: '2030-08-01' }, undefined, needs);
    expect(plan.estimate.total).toEqual([14000, 14000]);
    expect(plan.estimate.lines.map((l) => l.label)).not.toContain('Трансферы аэропорта');
  });
});

describe('ночь дня переезда — в зоне, куда приехали (E11)', () => {
  // Как у движка: переезд несёт зону, ОТКУДА едут; возвращение — Авачинскую.
  const TRIP = [
    d(1, 'arrival', 'avachinsky'),
    d(2, 'travel', 'avachinsky', { title: 'Переезд: Авачинская зона → Западная зона', priceFrom: 5000, priceTo: 8000 }),
    d(3, 'activity', 'western'),
    d(4, 'travel', 'avachinsky', { title: 'Возвращение: Западная зона → Петропавловск', priceFrom: 5000, priceTo: 8000 }),
    d(5, 'departure', 'avachinsky'),
  ];

  it('смета: ночь после переезда — по цене Западной зоны', () => {
    const lodging = estimateGroup(TRIP, PROFILE).lines.filter((l) => l.kind === 'lodging');
    expect(lodging.map((l) => [l.label, l.basis])).toEqual([
      ['Проживание в Авачинской зоне', '2 ночи × 2 чел.'],
      ['Проживание в Западной зоне', '2 ночи × 2 чел.'],
    ]);
    // Вилка на человека — то же правило: 2 ночи по 7 000 и 2 по 20 000, без множителей.
    expect(calculatePriceBreakdown(TRIP, PROFILE).accommodation).toEqual([2 * 7000 + 2 * 20000, 2 * 7000 + 2 * 20000]);
  });

  it('подбор жилья: ночь переезда входит в стоянку зоны назначения', () => {
    expect(lodgingStays(TRIP, '2030-08-01', '2030-08-05').stays).toEqual([
      { zone: 'avachinsky', checkIn: '2030-08-01', checkOut: '2030-08-02', nights: 1 },
      { zone: 'western', checkIn: '2030-08-02', checkOut: '2030-08-04', nights: 2 },
      { zone: 'avachinsky', checkIn: '2030-08-04', checkOut: '2030-08-05', nights: 1 },
    ]);
  });
});

describe('переезд без цены — «цены нет», а не 0', () => {
  const TRIP = [
    d(1, 'arrival', 'avachinsky'),
    d(2, 'activity', 'western'),
    d(3, 'travel', 'western', { title: 'Переезд: Западная зона → Восточная зона' }),
    d(4, 'activity', 'eastern'),
    d(5, 'departure', 'avachinsky'),
  ];
  const LABEL = 'Переезд: Западная зона → Восточная зона, день 3';

  it('строка есть, суммы нет, в итог не входит', () => {
    const e = estimateGroup(TRIP, PROFILE);
    expect(e.lines.find((l) => l.label === LABEL)).toMatchObject({ kind: 'transport', basis: 'цену называет перевозчик', total: null });
    expect(e.unpriced).toContain(LABEL);
    const priced = e.lines.filter((l) => l.total).reduce((s, l) => s + l.total![0], 0);
    expect(e.total[0]).toBe(priced);
  });

  it('экран: «цена не указана», без «ориентир», и кто назовёт цену', () => {
    render(<GroupEstimateBlock estimate={estimateGroup(TRIP, PROFILE)} />);
    const block = screen.getByTestId('price-estimate');
    const row = within(block).getByText(LABEL).closest('li')!;
    expect(row.textContent).toContain('цена не указана');
    expect(row.textContent).toContain('Цены этого переезда в данных нет — в итог он не вошёл.');
    expect(row.textContent).not.toContain('ориентир');
    expect(block.textContent).toContain(`Не вошло в итог: ${LABEL} — цену переезда назовёт перевозчик.`);
  });

  it('тур без цены и переезд без цены — оба названы', () => {
    const days = [...TRIP.slice(0, 3), d(4, 'activity', 'eastern', { title: 'Долина', priceMissing: 'Группа больше ступеней цены оператора', realTour: { tourId: 't', priceUnit: 'per_person', lodgingIncluded: null } }), TRIP[4]!];
    render(<GroupEstimateBlock estimate={estimateGroup(days, PROFILE)} />);
    expect(screen.getByTestId('price-estimate').textContent)
      .toContain('— сумму смотрите в карточке тура, цену переезда назовёт перевозчик.');
  });
});
