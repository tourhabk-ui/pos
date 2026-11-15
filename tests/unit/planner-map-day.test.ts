/**
 * День с карты не выдумывает сложность, возраст и цену (разбор планера 14.11,
 * экран-3; цена — слово владельца 14.11 «5 -1»: у дня без тура её нет).
 * Правило — вызовом на граничных данных (CLAUDE.md §4).
 */
import { describe, it, expect } from 'vitest';
import { mapDayDetails } from '@/lib/planner/map-day';
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';

describe('день с карты', () => {
  it('вид занятия записан — сложность и возраст из таблицы движка, цены нет', () => {
    const c = ACTIVITY_CONSTRAINTS.volcano;
    expect(mapDayDetails('volcano')).toEqual({
      priceFrom: 0, priceTo: 0,
      difficulty: c.difficulty, childFriendly: false, minChildAge: c.minChildAge,
    });
    // «для всех возрастов» — только там, где порог возраста в таблице 0.
    expect(mapDayDetails('hot_spring').childFriendly).toBe(ACTIVITY_CONSTRAINTS.hot_spring.minChildAge === 0);
  });

  it('ни у одного вида занятия день с карты цены не несёт', () => {
    for (const kind of Object.keys(ACTIVITY_CONSTRAINTS)) {
      const d = mapDayDetails(kind);
      expect([d.priceFrom, d.priceTo], kind).toEqual([0, 0]);
    }
  });

  it('вид занятия не записан или незнаком — ничего не утверждается, цены нет', () => {
    for (const a of [null, undefined, '', 'unknown_kind']) {
      expect(mapDayDetails(a)).toEqual({
        priceFrom: 0, priceTo: 0, difficulty: 'moderate', childFriendly: false, minChildAge: 0, detailsUnknown: true,
      });
    }
  });
});
