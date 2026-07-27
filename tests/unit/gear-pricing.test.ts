/**
 * Единый расчёт цены аренды снаряжения (lib/gear/pricing).
 *
 * Регрессия аудита 27.07: форма показывала одну сумму (10 дней = цена одной
 * недели, страховка — выдуманные 10%), сервер записывал другую (недели+дни,
 * страховка 0). Обе стороны обязаны считать этим модулем; тесты фиксируют
 * декомпозицию тарифа и поведение страховки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { calcRentalDays, calcGearPrice } from '@/lib/gear/pricing';

describe('calcRentalDays', () => {
  it('обычный диапазон', () => {
    expect(calcRentalDays('2026-08-01', '2026-08-04')).toBe(3);
  });

  it('конец раньше начала → null (раньше уезжало отрицательной ценой в БД)', () => {
    expect(calcRentalDays('2026-08-04', '2026-08-01')).toBeNull();
  });

  it('равные даты → null (минимальная аренда — сутки)', () => {
    expect(calcRentalDays('2026-08-01', '2026-08-01')).toBeNull();
  });

  it('мусор вместо даты → null, а не NaN', () => {
    expect(calcRentalDays('не-дата', '2026-08-01')).toBeNull();
  });
});

describe('calcGearPrice — декомпозиция тарифа', () => {
  it('10 дней при недельном тарифе = неделя + 3 дня (а не «цена одной недели»)', () => {
    const p = calcGearPrice({ days: 10, quantity: 1, pricePerDay: 500, pricePerWeek: 2800 });
    expect(p.breakdown).toEqual({ months: 0, weeks: 1, days: 3 });
    expect(p.basePrice).toBe(2800 + 3 * 500);
  });

  it('без недельного тарифа — посуточно', () => {
    const p = calcGearPrice({ days: 10, quantity: 2, pricePerDay: 500 });
    expect(p.basePrice).toBe(10 * 500 * 2);
  });

  it('35 дней при месячном тарифе = месяц + 5 дней', () => {
    const p = calcGearPrice({ days: 35, quantity: 1, pricePerDay: 500, pricePerMonth: 9000 });
    expect(p.breakdown).toEqual({ months: 1, weeks: 0, days: 5 });
    expect(p.basePrice).toBe(9000 + 5 * 500);
  });

  it('нулевой/отрицательный тариф не участвует в декомпозиции', () => {
    const p = calcGearPrice({ days: 10, quantity: 1, pricePerDay: 500, pricePerWeek: 0 });
    expect(p.breakdown.weeks).toBe(0);
    expect(p.basePrice).toBe(10 * 500);
  });
});

describe('calcGearPrice — страховка', () => {
  it('считается из реального тарифа за день, за все дни и единицы', () => {
    const p = calcGearPrice({
      days: 4, quantity: 2, pricePerDay: 500, insurancePerDay: 100, insurance: true,
    });
    expect(p.insuranceCost).toBe(4 * 100 * 2);
    expect(p.totalPrice).toBe(p.basePrice + p.insuranceCost);
    expect(p.insuranceUnavailable).toBe(false);
  });

  it('галка без тарифа — insuranceUnavailable, а не молчаливый ноль', () => {
    const p = calcGearPrice({ days: 4, quantity: 1, pricePerDay: 500, insurance: true });
    expect(p.insuranceCost).toBe(0);
    expect(p.insuranceUnavailable).toBe(true);
  });

  it('без галки страховка не считается даже при тарифе', () => {
    const p = calcGearPrice({ days: 4, quantity: 1, pricePerDay: 500, insurancePerDay: 100 });
    expect(p.insuranceCost).toBe(0);
    expect(p.insuranceUnavailable).toBe(false);
  });
});

describe('обе стороны считают одним модулем (структурно)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

  it('POST /api/gear/rentals использует calcGearPrice и calcRentalDays', () => {
    const route = read('app/api/gear/rentals/route.ts');
    expect(route).toContain("from '@/lib/gear/pricing'");
    expect(route).toContain('calcGearPrice(');
    expect(route).toContain('calcRentalDays(');
  });

  it('форма использует те же функции и не шлёт цену на сервер', () => {
    const form = read('components/gear/GearBookingForm.tsx');
    expect(form).toContain("from '@/lib/gear/pricing'");
    expect(form).toContain('calcGearPrice(');
    expect(form).not.toMatch(/pricing:\s*\{/);
    // Выдуманные «10%» страховки ушли.
    expect(form).not.toContain('0.1');
  });
});
