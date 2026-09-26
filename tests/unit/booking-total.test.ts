/**
 * Сумма брони по единице цены (24.09, «сделай цену за группу правильной»).
 * Одно правило — на все двери: сервер брони и экраны, где турист видит сумму.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingTotal, normalizePriceUnit } from '@/lib/tours/booking-total';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('bookingTotal', () => {
  it('за группу — цена не множится на участников', () => {
    expect(bookingTotal({ basePrice: 40000, priceUnit: 'per_tour', participants: 4 })).toBe(40000);
    expect(bookingTotal({ basePrice: 40000, priceUnit: 'per_tour', participants: 1 })).toBe(40000);
  });

  it('за человека — цена × участники', () => {
    expect(bookingTotal({ basePrice: 10000, priceUnit: 'per_person', participants: 4 })).toBe(40000);
  });

  it('за человека в день — ещё и × дни тура (правило календаря)', () => {
    expect(bookingTotal({
      basePrice: 5000, priceUnit: 'per_day_per_person', participants: 2,
      duration: { multi_day_count: 3, duration_hours: null },
    })).toBe(30000);
    expect(bookingTotal({
      basePrice: 5000, priceUnit: 'per_day_per_person', participants: 2,
      duration: { multi_day_count: null, duration_hours: 30 },
    })).toBe(20000);
  });

  it('NULL и незнакомая единица — DEFAULT колонки, за человека', () => {
    expect(normalizePriceUnit(null)).toBe('per_person');
    expect(normalizePriceUnit('per_banana')).toBe('per_person');
    expect(bookingTotal({ basePrice: 1000, priceUnit: undefined, participants: 3 })).toBe(3000);
  });
});

describe('все двери считают одной функцией', () => {
  const DOORS: Array<[string, string]> = [
    ['lib/bookings/reserve.ts', 'форма заявки, корзина, Кузьмич'],
    // 26.09: /api/bookings/tour удалён, агентская бронь и модалка брони
    // заводятся через reserveBooking / BookingFormClient (сторож agent-pack-a).
    ['app/hub/agent/bookings/_AgentBookingsPageClient.tsx', 'сумма в заявке агента'],
    ['app/api/hub/operator/bookings/route.ts', 'ручная бронь оператора'],
    ['lib/bookings/booking.service.ts', 'перенос на другой тур'],
    ['components/marketplace/BookingFormClient.tsx', 'сумма в форме тура'],
    ['app/hub/tourist/cart/checkout/_CheckoutClient.tsx', 'итог корзины'],
    ['app/kuzmich/_KuzmichClient.tsx', 'сумма в чате'],
  ];

  it.each(DOORS)('%s (%s) — bookingTotal, не base_price × участники', (path) => {
    const src = read(path);
    expect(src).toMatch(/bookingTotal\(/);
    expect(src).not.toMatch(/base_price\)?\s*\*\s*(input\.)?participants\b/);
    expect(src).not.toMatch(/\bbasePrice \* (input\.)?participants\b/);
  });
});
