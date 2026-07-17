import { describe, it, expect } from 'vitest';
import {
  EMERGENCY_NUMBERS,
  FEDERAL_EMERGENCY,
  VERIFIED_REGIONAL,
  EMERGENCY_PRIMARY,
  telHref,
} from '@/lib/safety/emergency-numbers';

describe('emergency-numbers — единый источник экстренных номеров', () => {
  it('112 — главный и первый', () => {
    expect(EMERGENCY_PRIMARY.phone).toBe('112');
    expect(EMERGENCY_NUMBERS[0].phone).toBe('112');
    expect(EMERGENCY_NUMBERS[0].primary).toBe(true);
  });

  it('каждый номер валиден: короткий федеральный ИЛИ полный +7 c 11 цифрами', () => {
    for (const c of EMERGENCY_NUMBERS) {
      const digits = c.phone.replace(/\D/g, '');
      const isShort = /^1\d{2}$/.test(digits);
      const isFull = digits.length === 11 && digits.startsWith('7');
      expect(isShort || isFull, `невалидный номер: «${c.phone}» (${c.name})`).toBe(true);
    }
  });

  it('верифицированные регионалки (СОД/НДС, подтверждены владельцем 2026-07-17) присутствуют', () => {
    const phones = VERIFIED_REGIONAL.map((c) => c.phone.replace(/\D/g, ''));
    expect(phones).toContain('74152301089');
    expect(phones).toContain('74152200112');
    expect(phones).toContain('74152301091');
  });

  it('telHref даёт звонибельную ссылку без пробелов и скобок', () => {
    expect(telHref('+7 (4152) 30-10-89')).toBe('tel:+74152301089');
    expect(telHref('112')).toBe('tel:112');
    expect(telHref(EMERGENCY_NUMBERS.at(-1)!.phone)).toMatch(/^tel:[\d+]+$/);
  });

  it('полный список = федеральные + верифицированные, без дублей', () => {
    expect(EMERGENCY_NUMBERS).toHaveLength(FEDERAL_EMERGENCY.length + VERIFIED_REGIONAL.length);
    const digits = EMERGENCY_NUMBERS.map((c) => c.phone.replace(/\D/g, ''));
    expect(new Set(digits).size).toBe(digits.length);
  });
});
