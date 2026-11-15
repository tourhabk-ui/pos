/**
 * Разбор 14.11, смета-5: цена тура зависит от даты (правило брони), а
 * перестановка дней на экране держала цену прежней даты. Правила:
 *   - день с туром, сменивший дату, теряет цену и подпись цены и ждёт
 *     перечитывания (`renumberByPosition`); продолжение многодневного тура
 *     цены не несёт и пометки не получает;
 *   - ответ роута ложится только на тот же тур, который всё ещё ждёт
 *     (`applyTourDayRead`); неответ — «проверить не удалось», а не прежняя цена;
 *   - роут `tours-for-day` с `tour_id` зовёт тот же `rereadTourDay`, что правка
 *     плана через Кузьмича.
 * Экран — tests/unit/planner-calendar-days-ui.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const reread = vi.fn();
/** Отказ базы — не через vi.fn: брошенное из мока vitest записывает в провал теста. */
const fail: { next: Error | null } = { next: null };
vi.mock('@/lib/planner/tour-day-reread', () => ({
  rereadTourDay: async (i: unknown) => {
    const r: unknown = reread(i);
    if (fail.next) throw fail.next;
    return r;
  },
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
// Планер — после входа (#3387): роуты судятся вошедшим.
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u-planner' })) }));

import { renumberByPosition, TOUR_PRICE_PENDING_TEXT } from '@/lib/planner/calendar-days';
import { applyTourDayRead, awaitsTourReread, parseTourDayRead } from '@/lib/planner/tour-day-apply';
import { PRICE_UNREAD_TEXT } from '@/lib/planner/price-unread';
import { dayPrice } from '@/lib/planner/day-price';
import { GET } from '@/app/api/planner/tours-for-day/route';

const tour = (id: string) => ({ tourId: id, priceUnit: 'per_person', priceLabel: 'ранняя бронь', maxParticipants: 8 });
const day = (n: number, extra: Record<string, unknown> = {}) => ({
  day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, priceFrom: 0, priceTo: 0,
  coords: [53, 158] as [number, number], ...extra,
});

describe('перестановка снимает цену прежней даты', () => {
  it('начало тура переехало — цены и подписи нет, ждёт перечитывания', () => {
    const { days } = renumberByPosition([
      day(1),
      day(3, { realTour: tour('t-1'), realPrice: 10000, availableDate: '2030-08-03' }),
      day(2, { realTour: tour('t-1') }),
    ]);
    const start = days[1]!;
    expect(start.day).toBe(2);
    expect(start).not.toHaveProperty('realPrice');
    expect(start).not.toHaveProperty('availableDate');
    expect(start.realTour).not.toHaveProperty('priceLabel');
    expect(start.priceMissing).toBe(TOUR_PRICE_PENDING_TEXT);
    expect(awaitsTourReread(start)).toBe(true);
    expect(dayPrice(start).kind).toBe('missing');
    // Продолжение многодневного: цены не было — пометки нет.
    expect(days[2]).not.toHaveProperty('priceMissing');
  });

  it('день на месте — не трогается; «цены для группы нет» переехало — тоже перечитывается', () => {
    const stay = day(1, { realTour: tour('t-1'), realPrice: 10000 });
    const { days } = renumberByPosition([stay, day(3), day(2, { realTour: tour('t-2'), priceMissing: 'вне ступеней' })]);
    expect(days[0]).toBe(stay);
    expect(days[2]!.priceMissing).toBe(TOUR_PRICE_PENDING_TEXT);
  });

  it('день без тура цену не получает', () => {
    const { days } = renumberByPosition([day(2), day(1)]);
    expect(days[0]).not.toHaveProperty('priceMissing');
  });
});

describe('ответ о цене — в день', () => {
  const pending = () => renumberByPosition([day(2, { realTour: tour('t-1'), realPrice: 10000 }), day(1)]).days[0]!;

  it('ложится: цена, места, подпись цены, время проверки', () => {
    const d = applyTourDayRead(pending(), 't-1', {
      availability: 'open', checkedAt: '2030-07-01T00:00:00.000Z', availableDate: '2030-08-01', slotsRemaining: 2, capacityWarning: 'мало мест',
      realPrice: 12000, priceFrom: 12000, priceTo: 12000, priceLabel: 'сезон',
    });
    expect(d).toMatchObject({ realPrice: 12000, slotsRemaining: 2, capacityWarning: 'мало мест', availability: 'open', availabilityCheckedAt: '2030-07-01T00:00:00.000Z' });
    expect(d.realTour!.priceLabel).toBe('сезон');
    expect(d).not.toHaveProperty('priceMissing');
  });

  it('цены для группы нет — так и сказано', () => {
    const d = applyTourDayRead(pending(), 't-1', { availability: 'none', priceFrom: 0, priceTo: 0, priceMissing: 'цену называет оператор' });
    expect(d.priceMissing).toBe('цену называет оператор');
    expect(d).not.toHaveProperty('realPrice');
  });

  it('неответ — «проверить не удалось», места не прочитаны', () => {
    const d = applyTourDayRead(pending(), 't-1', null);
    expect(d.priceMissing).toBe(PRICE_UNREAD_TEXT);
    expect(d.availability).toBe('unread');
  });

  it('ответ без цены и без причины — не «бесплатно»', () => {
    const d = applyTourDayRead(pending(), 't-1', { availability: 'open', priceFrom: 0, priceTo: 0 });
    expect(d.priceMissing).toBe(PRICE_UNREAD_TEXT);
  });

  it('чужой тур или день уже не ждёт — ответ не ложится', () => {
    const p = pending();
    expect(applyTourDayRead(p, 't-2', null)).toBe(p);
    const done = applyTourDayRead(p, 't-1', { availability: 'open', priceFrom: 9000, priceTo: 9000, realPrice: 9000 });
    expect(applyTourDayRead(done, 't-1', null)).toBe(done);
  });

  it('форма ответа проверяется', () => {
    expect(parseTourDayRead(null)).toBeNull();
    expect(parseTourDayRead({ success: false })).toBeNull();
    expect(parseTourDayRead({ success: true, read: { availability: 'maybe', priceFrom: 0, priceTo: 0 } })).toBeNull();
    expect(parseTourDayRead({ success: true, read: { availability: 'open', priceFrom: '1', priceTo: 0 } })).toBeNull();
    expect(parseTourDayRead({ success: true, read: { availability: 'open', priceFrom: 0, priceTo: 0, realPrice: 0 } }))
      .toEqual({ availability: 'open', priceFrom: 0, priceTo: 0 });
  });
});

describe('GET /api/planner/tours-for-day с tour_id', () => {
  beforeEach(() => reread.mockReset());
  const get = (q: string) => GET(new NextRequest(`http://localhost/api/planner/tours-for-day?${q}`));
  const ID = '00000000-0000-4000-8000-000000000001';

  it('зовёт перечитывание на дату и группу', async () => {
    reread.mockResolvedValue({ availability: 'open', priceFrom: 1, priceTo: 1, realPrice: 1 });
    const res = await get(`tour_id=${ID}&date=2030-08-03&participants=3&max=8`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, read: { availability: 'open', priceFrom: 1, priceTo: 1, realPrice: 1 } });
    expect(reread).toHaveBeenCalledWith({ tourId: ID, date: '2030-08-03', participants: 3, maxParticipants: 8 });
  });

  it('без потолка — null, не выдуманный', async () => {
    reread.mockResolvedValue({ availability: 'unread', priceFrom: 0, priceTo: 0 });
    await get(`tour_id=${ID}&date=2030-08-03&participants=2`);
    expect(reread).toHaveBeenCalledWith(expect.objectContaining({ maxParticipants: null }));
  });

  it('мусор — 400, перечитывания нет', async () => {
    for (const q of [`tour_id=abc&date=2030-08-03&participants=2`, `tour_id=${ID}&date=3.08&participants=2`, `tour_id=${ID}&date=2030-08-03&participants=0`, `tour_id=${ID}&date=2030-08-03`]) {
      expect((await get(q)).status, q).toBe(400);
    }
    expect(reread).not.toHaveBeenCalled();
  });

  it('отказ — 500 и лог, а не «цены нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fail.next = Object.assign(new Error('x'), { code: '57P01' });
    const res = await get(`tour_id=${ID}&date=2030-08-03&participants=2`);
    expect(res.status).toBe(500);
    expect(err).toHaveBeenCalledWith('[planner/tours-for-day] тур дня не перечитан', { sqlstate: '57P01', message: 'x' });
    err.mockRestore();
    fail.next = null;
  });
});
