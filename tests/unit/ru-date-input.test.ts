import { describe, it, expect } from 'vitest';
import { isoToRuDate, maskRuDate, ruDateToIso } from '@/components/forms/RuDateInput';
import { maskRuPhone } from '@/lib/mcp/normalize-phone';

describe('русская дата', () => {
  it('маска ставит точки, ISO туда и обратно, 31 февраля — не дата', () => {
    expect(maskRuDate('15062035')).toBe('15.06.2035');
    expect(maskRuDate('15')).toBe('15');
    expect(maskRuDate('1506')).toBe('15.06');
    expect(ruDateToIso('15.06.2035')).toBe('2035-06-15');
    expect(isoToRuDate('2035-06-15')).toBe('15.06.2035');
    expect(ruDateToIso('31.02.2035')).toBeNull();
    expect(ruDateToIso('')).toBeNull();
    expect(isoToRuDate('')).toBe('');
  });
});

describe('маска телефона +7', () => {
  it('десять цифр, восьмёрка и пустое поле', () => {
    expect(maskRuPhone('9001234567')).toBe('+7 900 123-45-67');
    expect(maskRuPhone('89001234567')).toBe('+7 900 123-45-67');
    expect(maskRuPhone('')).toBe('');
    expect(maskRuPhone('+44 20 7946 0958')).toBe('+442079460958');
  });
});
