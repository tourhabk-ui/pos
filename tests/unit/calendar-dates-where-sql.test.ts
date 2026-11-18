import { describe, expect, it } from 'vitest';
import { calendarDatesWhereSql } from '@/lib/tours/open-dates';

// Строка встаёт в текст SQL: и алиас, и выражение id тура — только из
// известной формы, иначе отказ (замечание ревью безопасности на #3502).
describe('calendarDatesWhereSql', () => {
  it('принимает параметр запроса и колонку alias.column', () => {
    expect(calendarDatesWhereSql('ta', '$1')).toContain('ta.operator_tour_id = $1');
    expect(calendarDatesWhereSql('ta', 't.id')).toContain('ta.operator_tour_id = t.id');
    expect(calendarDatesWhereSql('ta', 'operator_tours.id')).toContain('= operator_tours.id');
  });

  it('отказывает выражению id тура другой формы', () => {
    for (const bad of ['1 OR 1=1', "'1'", '$0', 't.id; DROP TABLE x', 'id', '']) {
      expect(() => calendarDatesWhereSql('ta', bad)).toThrow(/выражение id тура/);
    }
  });

  it('отказывает недопустимому алиасу', () => {
    expect(() => calendarDatesWhereSql('ta x', '$1')).toThrow(/алиас/);
  });
});
