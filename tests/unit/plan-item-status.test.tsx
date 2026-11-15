// @vitest-environment jsdom
/**
 * Метка у каждого пункта дня плана (#3399, п. 7; слово владельца 15.11
 * «делай»).
 *
 * До этого у плана было три словаря, и карточка дня на сайте о местах не
 * говорила вовсе: «С оператором» стояло и у тура с проверенными местами, и у
 * тура, где на дату мест нет. Кузьмич писал «Собрал план по дням», даже когда
 * места половины туров не прочитались.
 *
 * Сторож держит: правило метки на граничных днях (тур с местами, без мест,
 * без расписания, не перечитан после правки, продолжение, сам, идея); одни
 * слова на карточке (рендер), в тексте Кузьмича и MCP и в заявке; «черновик»
 * вместо «план» при непроверенных пунктах.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { planItemStatus, uncheckedItemsLine, PLAN_ITEM_STATUS, type PlanItemDay } from '@/lib/planner/item-status';
import { TOUR_PRICE_PENDING_TEXT } from '@/lib/planner/calendar-days';
import { PlanItemBadge } from '@/components/planner/PlanItemBadge';
import { formatTripPlanForChat, tourAvailabilityLine } from '@/lib/kuzmich/trip-plan-tool';
import { planForLead, planLeadLines } from '@/lib/planner/plan-for-lead';
import type { DayPlan } from '@/lib/planner';

afterEach(cleanup);

const CHECKED = '2026-11-07T02:05:00.000Z';

const tourDay = (over: Partial<PlanItemDay> = {}): PlanItemDay => ({
  type: 'activity', activityMode: 'operator', realTour: { tourId: '27' }, realPrice: 28000,
  availability: 'open', availabilityCheckedAt: CHECKED, ...over,
});

describe('правило метки', () => {
  it('день не про занятие — метки нет', () => {
    for (const type of ['arrival', 'rest', 'buffer', 'travel', 'departure']) {
      expect(planItemStatus({ type })).toBeNull();
    }
  });

  it('без тура: маршрут из базы — «сам», ничего — «идея»', () => {
    expect(planItemStatus({ type: 'activity', activityMode: 'self' })).toBe('self');
    expect(planItemStatus({ type: 'activity', activityMode: 'open' })).toBe('idea');
    expect(planItemStatus({ type: 'activity' })).toBe('idea');
  });

  it('места на дату прочитаны и время записано — «места есть»', () => {
    expect(planItemStatus(tourDay())).toBe('seats');
  });

  it('места есть, но времени проверки нет — не подтверждены', () => {
    expect(planItemStatus(tourDay({ availabilityCheckedAt: undefined }))).toBe('unconfirmed');
    expect(planItemStatus(tourDay({ availabilityCheckedAt: 'вчера' }))).toBe('unconfirmed');
  });

  it('мест меньше, чем людей, — не «места есть»', () => {
    expect(planItemStatus(tourDay({ capacityWarning: 'Свободно 2 места, вас 4' }))).toBe('short');
  });

  it('мест нет: расписание есть — «мест нет», нет — «дату подтвердит оператор», не знаем — так и сказано', () => {
    expect(planItemStatus(tourDay({ availability: 'none', realTour: { tourId: '27', calendar: 'dated' } }))).toBe('full');
    expect(planItemStatus(tourDay({ availability: 'none', realTour: { tourId: '27', calendar: 'request' } }))).toBe('on_request');
    expect(planItemStatus(tourDay({ availability: 'none' }))).toBe('no_slot');
    // Запасной путь — проверка Кузьмича, когда день поля не несёт.
    expect(planItemStatus(tourDay({ availability: 'none' }), 'request')).toBe('on_request');
    // Поле дня важнее запасного пути.
    expect(planItemStatus(tourDay({ availability: 'none', realTour: { tourId: '27', calendar: 'dated' } }), 'request')).toBe('full');
  });

  it('занятость не прочиталась — не подтверждены', () => {
    expect(planItemStatus(tourDay({ availability: 'unread' }))).toBe('unconfirmed');
    // Цена есть, а занятость не читалась (сохранённая поездка) — тоже.
    expect(planItemStatus(tourDay({ availability: undefined, availabilityCheckedAt: undefined }))).toBe('unconfirmed');
  });

  it('после перестановки, пока не перечитали, — «не перепроверено», даже при прежних местах', () => {
    expect(planItemStatus(tourDay({ priceMissing: TOUR_PRICE_PENDING_TEXT, realPrice: undefined }))).toBe('stale');
  });

  it('день продолжения многодневного тура — «продолжение», а не «не подтверждено»', () => {
    expect(planItemStatus({ type: 'activity', realTour: { tourId: '27' } })).toBe('continues');
  });

  it('у каждой метки есть подпись и подсказка', () => {
    for (const v of Object.values(PLAN_ITEM_STATUS)) {
      expect(v.label.length).toBeGreaterThan(3);
      expect(v.hint.length).toBeGreaterThan(10);
    }
  });
});

describe('итог плана', () => {
  it('непроверенные пункты названы по дням; проверенный план строки не получает', () => {
    expect(uncheckedItemsLine([{ day: 1, status: 'seats' }, { day: 2, status: 'idea' }, { day: 3, status: 'full' }])).toBeNull();
    const line = uncheckedItemsLine([{ day: 2, status: 'unconfirmed' }, { day: 4, status: 'stale' }, { day: 5, status: 'seats' }]);
    expect(line).toContain('дни 2, 4');
    expect(line).toContain('не перечитаны после правки');
    expect(uncheckedItemsLine([{ day: 3, status: 'on_request' }])).toContain('день 3');
  });
});

describe('карточка дня на сайте', () => {
  it('рисует подпись и подсказку метки', () => {
    render(<PlanItemBadge day={tourDay({ availability: 'none', realTour: { tourId: '27', calendar: 'dated' } })} />);
    const badge = screen.getByText(PLAN_ITEM_STATUS.full.label);
    expect(badge.getAttribute('title')).toBe(PLAN_ITEM_STATUS.full.hint);
  });

  it('у дня отдыха метки нет', () => {
    const { container } = render(<PlanItemBadge day={{ type: 'rest' }} />);
    expect(container.textContent).toBe('');
  });
});

const realTour: NonNullable<DayPlan['realTour']> = {
  tourId: '27', operatorName: 'Тест', operatorSlug: 'test', operatorRating: 0,
  tourRating: null, reviewCount: 0, verified: true, maxParticipants: 8,
  weatherDependent: true, durationHours: 10, priceUnit: 'per_person', lodgingIncluded: false,
};

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Летняя рыбалка',
  description: '', activityType: 'fishing', priceFrom: 28000, priceTo: 36000,
  coords: [53.0, 158.6], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'easy' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [], activityMode: 'operator',
  realTour, realPrice: 28000, availability: 'open', availableDate: '2027-07-10', availabilityCheckedAt: CHECKED,
  ...over,
});

const chat = (days: DayPlan[], keepsSchedule?: Map<string, boolean | null>) =>
  formatTripPlanForChat(days, [], null, { refusal: '', plannedFor: '10.07.2027', arrivalIso: '2027-07-10', keepsSchedule });

describe('Кузьмич и MCP', () => {
  it('у каждого пункта — метка теми же словами, что на сайте', () => {
    const text = chat([
      day({}),
      day({ day: 2, realTour: undefined, realPrice: undefined, availability: undefined, availabilityCheckedAt: undefined, activityMode: 'open', title: 'Свободный день у океана' }),
    ]);
    expect(text).toContain(`Статус: ${PLAN_ITEM_STATUS.seats.label}`);
    expect(text).toContain(`Статус: ${PLAN_ITEM_STATUS.idea.label}`);
  });

  it('все туры с местами — «Собрал план»; есть непроверенный — «черновик» и строка с днями', () => {
    expect(chat([day({})]).startsWith('Собрал план по дням')).toBe(true);
    const text = chat([day({}), day({ day: 2, availability: 'unread' })]);
    expect(text.startsWith('Собрал черновик плана по дням')).toBe(true);
    expect(text).toContain('Не всё проверено: день 2');
  });

  it('мест нет у тура без расписания — «дату подтвердит оператор» и по полю дня, и по проверке Кузьмича', () => {
    const byDay = chat([day({ availability: 'none', availableDate: undefined, realTour: { ...realTour, calendar: 'request' } })]);
    expect(byDay).toContain(`Статус: ${PLAN_ITEM_STATUS.on_request.label}`);
    const byCheck = chat([day({ availability: 'none', availableDate: undefined })], new Map([['27', false]]));
    expect(byCheck).toContain(`Статус: ${PLAN_ITEM_STATUS.on_request.label}`);
  });

  it('строка мест берёт расписание с тура, когда проверки Кузьмича нет', () => {
    const line = tourAvailabilityLine(
      day({ availability: 'none', availableDate: undefined, realTour: { ...realTour, calendar: 'request' } }),
      '2027-07-10', undefined,
    );
    expect(line).toContain('расписания в системе нет');
  });
});

describe('заявка из плана', () => {
  it('метка уходит в заявку, и непроверенный пункт назван строкой', () => {
    const plan = planForLead(
      [
        { day: 1, type: 'activity', zone: 'avachinsky', title: 'Рыбалка', priceFrom: 0, priceTo: 0,
          realTour: { tourId: '27', lodgingIncluded: false, priceUnit: 'per_person' }, realPrice: 28000,
          availability: 'unread', availabilityCheckedAt: CHECKED },
        { day: 2, type: 'activity', zone: 'avachinsky', title: 'Берег', priceFrom: 0, priceTo: 0, activityMode: 'open' },
      ],
      { adults: 2, children: [], budgetTier: 'comfort', arrivalDate: '2027-07-10' },
    );
    expect(plan.days.map((d) => d.status)).toEqual(['unconfirmed', 'idea']);
    expect(planLeadLines(plan)).toContain('Не всё проверено: день 1 — места тура не подтверждены. Подтверждает оператор по заявке.');
  });

  it('заявка до 15.11 без меток строки не получает', () => {
    const plan = planForLead(
      [{ day: 1, type: 'activity', zone: 'avachinsky', title: 'Рыбалка', priceFrom: 0, priceTo: 0,
        realTour: { tourId: '27', lodgingIncluded: false }, realPrice: 28000, availability: 'unread' }],
      { adults: 2, children: [], budgetTier: 'comfort', arrivalDate: '2027-07-10' },
    );
    const old = { ...plan, days: plan.days.map(({ status: _s, ...d }) => d) };
    expect(planLeadLines(old).some((l) => l.startsWith('Не всё проверено'))).toBe(false);
  });
});
