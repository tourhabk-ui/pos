/**
 * День с карты не выдумывает сложность, возраст и цену (разбор планера 14.11,
 * экран-3). Правило — вызовом на граничных данных (CLAUDE.md §4).
 */
import { describe, it, expect } from 'vitest';
import { mapDayDetails } from '@/lib/planner/map-day';
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';

describe('день с карты', () => {
  it('вид занятия записан — сложность, возраст и вилка из таблицы движка', () => {
    const c = ACTIVITY_CONSTRAINTS.volcano;
    expect(mapDayDetails('volcano')).toEqual({
      priceFrom: c.pricePerPerson[0], priceTo: c.pricePerPerson[1],
      difficulty: c.difficulty, childFriendly: false, minChildAge: c.minChildAge,
    });
    // «для всех возрастов» — только там, где порог возраста в таблице 0.
    expect(mapDayDetails('hot_spring').childFriendly).toBe(ACTIVITY_CONSTRAINTS.hot_spring.minChildAge === 0);
  });

  it('вилка медведей — та же, что у движка, а не вписанная в экран', () => {
    const d = mapDayDetails('bears');
    expect([d.priceFrom, d.priceTo]).toEqual(ACTIVITY_CONSTRAINTS.bears.pricePerPerson);
  });

  it('вид занятия не записан или незнаком — ничего не утверждается, цены нет', () => {
    for (const a of [null, undefined, '', 'unknown_kind']) {
      expect(mapDayDetails(a)).toEqual({
        priceFrom: 0, priceTo: 0, difficulty: 'moderate', childFriendly: false, minChildAge: 0, detailsUnknown: true,
      });
    }
  });
});
