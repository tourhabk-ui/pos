import { describe, expect, it } from 'vitest';
import { openDatesLine } from '@/lib/operators/live-seats';

describe('«Другая дата»: строка открытых дат только из БД', () => {
  it('нет дат — честно, без выдумки', () => {
    expect(openDatesLine([])).toBe('Других открытых дат с местами в календаре нет.');
    expect(openDatesLine(null)).toMatch(/нет/);
  });
  it('ошибка чтения не выдаётся за «мест нет» и без слов о сбоях', () => {
    const t = openDatesLine('failed');
    expect(t).not.toMatch(/нет мест|сбо|недоступн/);
  });
  it('даты и места как в базе', () => {
    expect(openDatesLine([{ date: '2026-11-07', free: 4 }, { date: '2026-11-14', free: 1 }]))
      .toBe('Открыто в календаре: 07.11 (свободно 4); 14.11 (свободно 1).');
  });
});
