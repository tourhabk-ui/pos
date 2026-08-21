/**
 * Оплата — одно событие, одна транзакция (#1318).
 *
 * handlePaid писал бронь, платёж и занятость тремя независимыми запросами:
 * сбой между ними оставлял бронь confirmed без учтённых денег, а два
 * параллельных вебхука одного платежа проходили неблокирующую проверку
 * идемпотентности оба — и booked_slots инкрементился дважды.
 *
 * Сторож держит черты фикса, которые нельзя потерять правкой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'app/api/hub/operator/payments/webhook/route.ts'), 'utf-8',
);

describe('вебхук оплаты оператора — атомарность handlePaid', () => {
  it('бронь читается под замком внутри транзакции', () => {
    expect(src).toMatch(/transaction\(async \(client\)/);
    expect(src).toMatch(/FROM operator_bookings[\s\S]{0,120}FOR UPDATE/);
  });

  it('замок без NOWAIT: ретрай CloudPayments — штатный дубль, не ошибка', () => {
    // Слово живёт в комментарии-обосновании — судим только SQL.
    expect(src).not.toMatch(/FOR UPDATE\s+NOWAIT/);
  });

  it('платёж и занятость пишутся тем же client, что и бронь', () => {
    // Внутри handlePaid не должно остаться записей мимо транзакции.
    const handlePaidBody = src.slice(
      src.indexOf('async function handlePaid'),
      src.indexOf('async function handleFailed'),
    );
    expect(handlePaidBody).toMatch(/client\.query\([\s\S]{0,200}INSERT INTO tour_payments/);
    expect(handlePaidBody).toMatch(/client\.query\([\s\S]{0,200}UPDATE tour_availability/);
    expect(handlePaidBody).not.toMatch(/await query\([\s\S]{0,200}UPDATE tour_availability/);
  });

  it('комиссия — единственным способом, после COMMIT', () => {
    expect(src).toContain('recordCommissionFromBooking(bookingId');
    expect(src).not.toContain('INSERT INTO operator_commissions');
  });

  it('повторный вебхук уходит идемпотентно, не начисляя комиссию заново', () => {
    expect(src).toMatch(/if \(!paidNow\) return;/);
  });
});
