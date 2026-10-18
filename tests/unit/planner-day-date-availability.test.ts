/**
 * Доступность и цена дня считаются на дату именно этого дня (усиление №1
 * из research/trip-planner-weakness.md, W2).
 *
 * До правки день брал `slots[0]` — первый свободный слот диапазона поездки:
 * день 3 мог показать остаток дня 1 и цену правила чужой даты. Страница плана
 * (share-API) считала честно по дате дня, и две поверхности расходились.
 *
 * `fetchAvailabilityForTour` отдаёт только даты со свободными местами
 * (remaining > 0), поэтому полная дата в списке отсутствует — это и есть
 * сценарий «на день 1 места есть, на день 3 нет».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slotOnTripDay, dateOfTripDay } from '@/lib/planner/flow-balance';

const ENGINE = readFileSync(join(process.cwd(), 'lib/planner/engine.ts'), 'utf-8');
const ARRIVAL = '2027-07-10';

describe('slotOnTripDay: слот именно даты дня', () => {
  it('места есть на день 1 и нет на день 3 — день 3 не получает остаток дня 1', () => {
    // День 3 заполнен, поэтому в выдаче занятости его нет вовсе.
    const slots = [{ date: '2027-07-10', remaining: 6 }];
    expect(slotOnTripDay(slots, ARRIVAL, 1)).toEqual({ date: '2027-07-10', remaining: 6 });
    expect(slotOnTripDay(slots, ARRIVAL, 3)).toBeNull();
  });

  it('у каждого дня свой остаток, а не остаток первого слота', () => {
    const slots = [
      { date: '2027-07-10', remaining: 6 },
      { date: '2027-07-12', remaining: 2 },
    ];
    expect(slotOnTripDay(slots, ARRIVAL, 3)?.remaining).toBe(2);
    expect(slotOnTripDay(slots, ARRIVAL, 1)?.remaining).toBe(6);
  });

  it('дата дня считается тем же dateOfTripDay, что и цена дня', () => {
    expect(dateOfTripDay(ARRIVAL, 3)).toBe('2027-07-12');
    expect(slotOnTripDay([{ date: '2027-07-12', remaining: 4 }], ARRIVAL, 3)?.date)
      .toBe(dateOfTripDay(ARRIVAL, 3));
  });

  it('битая дата прилёта — слота нет, а не первый попавшийся', () => {
    expect(slotOnTripDay([{ date: '2027-07-10', remaining: 6 }], 'чепуха', 1)).toBeNull();
  });
});

describe('движок: день не берёт чужую дату', () => {
  const at = ENGINE.indexOf('// Check availability for this tour');
  const block = ENGINE.slice(at, ENGINE.indexOf('// Contingency alternatives', at));

  it('остаток дня — слот даты дня через slotOnTripDay', () => {
    expect(block).toContain('slotOnTripDay(slots, profile.arrivalDate, dayNum)');
    expect(block).toMatch(/availability = slots === null \? 'unread' : daySlot \? 'open' : 'none';/);
  });

  it('первого слота диапазона в блоке дня больше нет', () => {
    expect(block).not.toContain('slots[0]');
  });

  it('цена дня считается на дату дня, а не на availableDate чужой даты', () => {
    expect(block).toContain('tourDate: dayDate,');
    expect(block).toContain('const dayDate = profile.arrivalDate ? dateOfTripDay(profile.arrivalDate, dayNum) : null;');
    expect(block).not.toContain('availableDate ??');
  });
});
