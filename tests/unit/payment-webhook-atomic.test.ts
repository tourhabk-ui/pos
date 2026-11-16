/**
 * Оплата пишет три таблицы атомарно (issue #1318).
 *
 * handlePaid в hub-вебхуке CloudPayments менял бронь, платёж и занятость тремя
 * отдельными query() без транзакции. Падение между UPDATE брони и INSERT
 * платежа оставляло бронь confirmed, а деньги неучтёнными; параллельный дубль
 * вебхука (CloudPayments шлёт их намеренно) проходил проверку «ещё не оплачено»
 * дважды.
 *
 * Это деньги и app/api/payments (CLAUDE.md §7). Сторож проверяет по коду, что
 * атомарность и блокирующее чтение на месте, а не полагается на память.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/hub/operator/payments/webhook/route.ts'),
  'utf-8',
);

/** Тело handlePaid — судим только его, чтобы правки соседних веток не мешали. */
function handlePaidBody(): string {
  const start = SRC.indexOf('async function handlePaid');
  expect(start).toBeGreaterThan(-1);
  const next = SRC.indexOf('\nasync function ', start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
}

describe('оплата атомарна и защищена от гонки', () => {
  const body = handlePaidBody();

  it('запись идёт в транзакции, а не отдельными query()', () => {
    expect(body).toMatch(/await transaction\(async \(client\) =>/);
    // Внутри транзакции обращения идут через client, а не через пул.
    expect(body).toMatch(/client\.query/);
  });

  it('бронь читается блокирующе — FOR UPDATE', () => {
    // Без блокировки два параллельных вебхука оба видят «не оплачено».
    expect(body).toMatch(/FOR UPDATE/);
  });

  it('блокировка без NOWAIT: дубль ждёт и становится no-op, а не 409', () => {
    // NOWAIT вернул бы дублю ложный отказ; правильный исход дубля — тишина.
    expect(body).not.toMatch(/FOR UPDATE\s+NOWAIT/);
  });

  it('идемпотентность читается ПОД блокировкой', () => {
    // «Уже оплачено» — окончательный факт только после FOR UPDATE.
    const lockPos = body.indexOf('FOR UPDATE');
    const idemPos = body.indexOf("payment_status === 'paid'");
    expect(idemPos).toBeGreaterThan(lockPos);
  });

  it('все три таблицы пишутся внутри одной транзакции', () => {
    const txStart = body.indexOf('await transaction');
    const txBody = body.slice(txStart);
    // До закрытия транзакции (return true) должны быть все три записи.
    const untilReturn = txBody.slice(0, txBody.indexOf('return true'));
    expect(untilReturn).toMatch(/UPDATE operator_bookings/);
    // Строка платежа — общей дверью, на том же клиенте транзакции (25.09).
    expect(untilReturn).toMatch(/await holdTourPayment\(client,/);
    expect(untilReturn).toMatch(/UPDATE tour_availability/);
  });

  it('комиссия — в транзакции оплаты, уведомление — после коммита; дубль до них не доходит', () => {
    // Комиссия — в той же транзакции, на её клиенте (#3433 п. 2): после
    // коммита её терял упавший процесс. Свой отказ она откатывает до точки
    // сохранения (lib/payments/commission), транзакция оплаты не «aborted» —
    // это судит вызовом payment-receivers-always-on.
    const txEnd = body.indexOf("return { kind: 'paid'");
    const commissionPos = body.indexOf('recordCommissionFromBooking(bookingId, webhook.InvoiceId, client)');
    expect(commissionPos).toBeGreaterThan(-1);
    expect(commissionPos).toBeLessThan(txEnd);
    const duplicatePos = body.indexOf("{ kind: 'duplicate'");
    expect(duplicatePos).toBeGreaterThan(-1);
    expect(duplicatePos).toBeLessThan(commissionPos);
    expect(body.indexOf('notifyBookingPaid(')).toBeGreaterThan(body.indexOf("if (inserted.kind === 'duplicate') return"));
  });
});
