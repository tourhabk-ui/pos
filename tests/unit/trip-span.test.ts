import { describe, it, expect } from 'vitest';
import { tripStayPhrase, stayPhraseFromCounts } from '@/lib/planner/trip-span';

describe('дни и ночи поездки — одна подпись', () => {
  it('1–8 июля: 8 календарных дней и 7 ночей', () => {
    expect(tripStayPhrase('2027-07-01', '2027-07-08')).toBe('8 календарных дней · 7 ночей');
  });

  it('один день — без ночёвки; перевёрнутые даты — не ноль', () => {
    expect(tripStayPhrase('2027-07-01', '2027-07-01')).toBe('1 календарный день · без ночёвки');
    expect(tripStayPhrase('2027-07-08', '2027-07-01')).toBeNull();
  });

  it('склонение: 2 дня, 5 дней', () => {
    expect(stayPhraseFromCounts(2, 1)).toBe('2 календарных дня · 1 ночь');
    expect(stayPhraseFromCounts(5, 4)).toBe('5 календарных дней · 4 ночи');
  });
});
