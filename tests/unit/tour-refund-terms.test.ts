/**
 * Возврат при отмене тура — «как у оператора» (решение владельца 24.09).
 *
 * Держит связку целиком (§10.09 «сторож держит связку, а не половину»):
 *   - правило: оператор отменил / условий нет — 100%; до срока — 100%,
 *     позже — процент оператора; дни календарные по Камчатке;
 *   - производитель: обе двери отмены зовут recordRefundDue в транзакции
 *     отмены, а он пишет tour_payments.refund_due;
 *   - потребитель: отметка возврата админом пишет refund_due, список
 *     «Ждут возврата» показывает её;
 *   - данные: миграция 1012 заводит числа и заполняет их только для
 *     дословного правила владельца;
 *   - оператор переписал текст условий — числа сбрасываются, а не врут;
 *   - обещаний без исполнителя нет: «3-5 рабочих дней», «Полный возврат
 *     (решение владельца 11.09)» и calculateRefund ушли.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeTourRefund, daysBeforeTour, kamchatkaDate } from '@/lib/payments/tour-refund';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TERMS = { freeDays: 3, lateRefundPercent: 50 };
/** Момент в UTC, соответствующий полудню указанной даты на Камчатке (UTC+12). */
const kamNoon = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

describe('правило', () => {
  it('тур 10-го: отмена 7-го (за 3 дня) — 100%', () => {
    const r = computeTourRefund({ paidAmount: 13000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-07'), terms: TERMS, byOperator: false });
    expect(r).toMatchObject({ percent: 100, amount: 13000, basis: 'free_window' });
  });

  it('тур 10-го: отмена 8-го — 50%', () => {
    const r = computeTourRefund({ paidAmount: 13000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-08'), terms: TERMS, byOperator: false });
    expect(r).toMatchObject({ percent: 50, amount: 6500, basis: 'late' });
    expect(r.reason).toMatch(/50%/);
  });

  it('после даты тура — тоже процент оператора, не отрицательные дни в плюс', () => {
    const r = computeTourRefund({ paidAmount: 10000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-12'), terms: TERMS, byOperator: false });
    expect(r.percent).toBe(50);
  });

  it('оператор отменил — 100% даже в день тура', () => {
    const r = computeTourRefund({ paidAmount: 10000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-10'), terms: TERMS, byOperator: true });
    expect(r).toMatchObject({ percent: 100, amount: 10000, basis: 'operator_cancel' });
  });

  it('условий нет (любое из чисел NULL) — 100% (решение владельца 24.09)', () => {
    for (const terms of [{ freeDays: null, lateRefundPercent: 50 }, { freeDays: 3, lateRefundPercent: null }, { freeDays: null, lateRefundPercent: null }]) {
      const r = computeTourRefund({ paidAmount: 10000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-09'), terms, byOperator: false });
      expect(r).toMatchObject({ percent: 100, amount: 10000, basis: 'no_terms' });
    }
  });

  it('мусор в условиях — как «нет условий», а не 0%', () => {
    const r = computeTourRefund({ paidAmount: 10000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-09'), terms: { freeDays: -1, lateRefundPercent: 150 }, byOperator: false });
    expect(r.basis).toBe('no_terms');
    expect(r.percent).toBe(100);
  });

  it('0% позже срока — честное «возврата нет», не «50%»', () => {
    const r = computeTourRefund({ paidAmount: 10000, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-09'), terms: { freeDays: 3, lateRefundPercent: 0 }, byOperator: false });
    expect(r).toMatchObject({ percent: 0, amount: 0 });
    expect(r.reason).toMatch(/возврата нет/);
  });

  it('копейки не теряются на нечётной сумме', () => {
    const r = computeTourRefund({ paidAmount: 10001, tourDate: '2026-10-10', cancelledAt: kamNoon('2026-10-09'), terms: TERMS, byOperator: false });
    expect(r.amount).toBe(5000.5);
  });
});

describe('день — камчатский, не серверный UTC', () => {
  it('23:30 UTC 6-го — это уже 7-е на Камчатке', () => {
    const at = new Date('2026-10-06T23:30:00Z');
    expect(kamchatkaDate(at)).toBe('2026-10-07');
    expect(daysBeforeTour('2026-10-10', at)).toBe(3);
  });

  it('11:59 UTC 7-го — ещё 7-е, 12:00 UTC 7-го — уже 8-е', () => {
    expect(kamchatkaDate(new Date('2026-10-07T11:59:00Z'))).toBe('2026-10-07');
    expect(kamchatkaDate(new Date('2026-10-07T12:00:00Z'))).toBe('2026-10-08');
  });
});

describe('производитель и потребитель', () => {
  const service = read('lib/bookings/booking.service.ts');
  const cancelRoute = read('app/api/bookings/[id]/cancel/route.ts');
  const record = read('lib/payments/record-refund-due.ts');
  const refunds = read('app/api/admin/finance/refunds/route.ts');
  const payouts = read('app/api/admin/finance/payouts/route.ts');

  it('обе двери отмены зовут recordRefundDue', () => {
    expect(service).toMatch(/await recordRefundDue\(client, bookingId, isOperatorCancel\)/);
    expect(cancelRoute).toMatch(/await recordRefundDue\(client, opId, false\)/);
  });

  it('в cancelBooking сумма считается ПОСЛЕ записи отмены (дата отмены записанная)', () => {
    const fn = service.slice(service.indexOf('export async function cancelBooking'));
    expect(fn.indexOf("SET booking_status = 'cancelled'")).toBeGreaterThan(0);
    expect(fn.indexOf('recordRefundDue(')).toBeGreaterThan(fn.indexOf("SET booking_status = 'cancelled'"));
  });

  it('recordRefundDue считает единым правилом и пишет refund_due только по HELD', () => {
    expect(record).toMatch(/computeTourRefund\(/);
    expect(record).toMatch(/tp\.status = 'HELD'/);
    expect(record).toMatch(/SET refund_due = \$2, refund_due_reason = \$3/);
  });

  it('админ отмечает возврат суммой refund_due, список показывает её', () => {
    expect(refunds).toMatch(/refund_amount = COALESCE\(refund_due, retail_amount\)/);
    expect(payouts).toMatch(/COALESCE\(tp\.refund_due, tp\.retail_amount\) AS refund_due/);
  });

  it('лестницы в обход правила нет: calculateRefund удалена, «решение 11.09» не обещается', () => {
    expect(service).not.toMatch(/function calculateRefund/);
    expect(cancelRoute).not.toMatch(/решение владельца 11\.09\)/);
    expect(cancelRoute).not.toMatch(/percent:\s*100,/);
  });
});

describe('данные и правка условий оператором', () => {
  const mig = read('migrations/1012_tour_refund_terms.sql');
  const patch = read('app/api/hub/operator/tours/[id]/route.ts');

  it('миграция заполняет числа только для дословного правила владельца', () => {
    expect(mig).toMatch(/SET cancellation_free_days = 3,\s*cancellation_late_refund_percent = 50/);
    expect(mig).toMatch(/= 'Бесплатная отмена за 3 дня до тура, позже удерживается 50%'/);
    expect(mig).toMatch(/WHERE cancellation_free_days IS NULL\s+AND cancellation_late_refund_percent IS NULL/);
  });

  it('оператор переписал текст условий — числа сбрасываются в NULL', () => {
    expect(patch).toMatch(/cancellation_free_days = CASE WHEN cancellation_policy IS DISTINCT FROM \$\{p\}::text THEN NULL/);
    expect(patch).toMatch(/cancellation_late_refund_percent = CASE WHEN cancellation_policy IS DISTINCT FROM \$\{p\}::text THEN NULL/);
  });
});

describe('обещаний без исполнителя нет', () => {
  it('ни письмо, ни Telegram не обещают срок «3-5 рабочих дней»', () => {
    expect(read('lib/notifications/email-service.ts')).not.toMatch(/3\\u20135 рабочих дней|3-5 рабочих дней/);
    expect(read('lib/notifications/booking-notifications.ts')).not.toMatch(/Средства поступят на карту/);
  });

  it('ноль к возврату не называется «не предусмотрен» без причины', () => {
    expect(read('lib/telegram/booking-notify.ts')).not.toMatch(/Возврат:<\/b> не предусмотрен/);
    expect(read('lib/notifications/email-service.ts')).not.toMatch(/Согласно условиям отмены, возврат средств не предусмотрен/);
  });
});
