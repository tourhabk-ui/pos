/**
 * Условия отмены в форме заявки (27.09): строка до отправки обязана
 * совпадать с тем, что вернётся при отмене (computeTourRefund).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancellationTermsLine, computeTourRefund } from '@/lib/payments/tour-refund';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TERMS = { freeDays: 3, lateRefundPercent: 50 };
// Полдень по Камчатке (UTC+12) — 00:00 UTC того же дня.
const kam = (d: string) => new Date(`${d}T00:00:00Z`);

describe('cancellationTermsLine', () => {
  it('без даты — правило словами', () => {
    expect(cancellationTermsLine(TERMS, null)).toBe(
      'Бесплатная отмена не позднее чем за 3 дня до тура, позже возвращается 50%.');
  });

  it('тур 10 октября, «за 3 дня»: бесплатно до 7 октября включительно', () => {
    expect(cancellationTermsLine(TERMS, '2026-10-10', kam('2026-10-01'))).toBe(
      'Бесплатная отмена до 7 октября включительно, позже возвращается 50%.');
  });

  it('граница совпадает с настоящим возвратом: 7-го — 100%, 8-го — 50%', () => {
    const on7 = computeTourRefund({ paidAmount: 1000, tourDate: '2026-10-10', cancelledAt: kam('2026-10-07'), terms: TERMS, byOperator: false });
    const on8 = computeTourRefund({ paidAmount: 1000, tourDate: '2026-10-10', cancelledAt: kam('2026-10-08'), terms: TERMS, byOperator: false });
    expect(on7.percent).toBe(100);
    expect(on8.percent).toBe(50);
    expect(cancellationTermsLine(TERMS, '2026-10-10', kam('2026-10-07'))).toContain('до 7 октября включительно');
    expect(cancellationTermsLine(TERMS, '2026-10-10', kam('2026-10-08'))).toBe(
      'До тура меньше 3 дней: по условиям оператора при отмене возвращается 50%.');
  });

  it('условий нет — полный возврат, как в computeTourRefund', () => {
    const none = { freeDays: null, lateRefundPercent: null };
    expect(cancellationTermsLine(none, '2026-10-10')).toBe('Условия отмены оператор не записал — при отмене вернём всю сумму.');
    expect(computeTourRefund({ paidAmount: 1, tourDate: '2026-10-10', cancelledAt: new Date(), terms: none, byOperator: false }).percent).toBe(100);
  });

  it('ноль процентов позже — «возврата нет»', () => {
    expect(cancellationTermsLine({ freeDays: 1, lateRefundPercent: 0 }, null)).toBe(
      'Бесплатная отмена не позднее чем за 1 день до тура, позже возврата нет.');
  });
});

describe('строка доходит до формы', () => {
  it('запрос карточки берёт числа условий', () => {
    const q = read('lib/tours/tour-detail-query.ts');
    expect(q).toContain('ot.cancellation_free_days, ot.cancellation_late_refund_percent');
  });
  it('карточка передаёт их в форму, форма рисует строку под итогом', () => {
    expect(read('app/marketplace/tours/[id]/_TourDetailClient.tsx')).toContain('cancellationTerms={{');
    const form = read('components/marketplace/BookingFormClient.tsx');
    expect(form).toContain('cancellationTermsLine(cancellationTerms, formData.booking_date || null)');
  });
  it('после отправки турист знает, что будет при молчании оператора', () => {
    expect(read('app/booking-success/[id]/_BookingSuccessClient.tsx')).toContain('её увидит администратор платформы');
    // …и это правда: сторож поднимает заявку старше суток.
    expect(read('lib/agents/watchdog.ts')).toMatch(/unconfirmed_booking/);
  });
});
