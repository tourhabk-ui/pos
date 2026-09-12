/**
 * Возврат за отменённую туровую бронь — 100%, зафиксирован явно (#1813).
 *
 * Решение владельца 11.09: «пока 100%» — лестница 100/50/0% по часам до
 * тура снята. Она и раньше не исполнялась (значение уходило в письмо/ответ
 * API, а не в реальный возврат — платёжного API платформа не вызывает), но
 * обещание тиража без тиража хуже отсутствия обещания: турист читал «50%» и
 * ждал ровно половину.
 *
 * Второй кусок — сам механизм отметки возврата (`/api/admin/finance/refunds`)
 * не вызывает никакой платёжный API: он ФИКСИРУЕТ факт ручного перевода,
 * сделанного администратором вне платформы. Три вещи здесь обязательны и
 * проверяются по тексту роута (без БД — интеграционная сторона уже прогнана
 * PREPARE на настоящем PostgreSQL при разработке):
 *
 *   1. Гейт по `cancelledBookingSql` — отметить можно только платёж
 *      ОТМЕНЁННОЙ брони, не любой HELD;
 *   2. `FOR UPDATE` — тот же приём, что у выплат (#1217), чтобы два
 *      одновременных запроса не отметили один платёж дважды;
 *   3. Причина обязательна и не короче восьми символов — «отметил и забыл»
 *      здесь стоит денег, а не удобства.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculateRefund } from '@/lib/bookings/booking.service';

describe('calculateRefund: 100% всегда (решение владельца 11.09)', () => {
  const inWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it('турист, за неделю до тура — 100%', () => {
    const r = calculateRefund(10000, inWeek, false);
    expect(r.percent).toBe(100);
    expect(r.amount).toBe(10000);
  });

  it('турист, за два часа до тура — ВСЁ РАВНО 100% (не 0%, как было в снятой лестнице)', () => {
    const r = calculateRefund(10000, inTwoHours, false);
    expect(r.percent).toBe(100);
    expect(r.amount).toBe(10000);
  });

  it('турист отменяет постфактум (дата тура уже прошла) — 100%, не 0%', () => {
    const r = calculateRefund(10000, yesterday, false);
    expect(r.percent).toBe(100);
    expect(r.amount).toBe(10000);
  });

  it('оператор отменяет — 100%, как и было', () => {
    const r = calculateRefund(10000, inTwoHours, true);
    expect(r.percent).toBe(100);
    expect(r.amount).toBe(10000);
  });

  it('сумма — ровно totalPrice, без округления в минус', () => {
    // Прежняя лестница на 50% округляла Math.floor(totalPrice * 0.5) — с
    // фиксированными 100% округлять уже нечего, но проверяем явно, чтобы
    // регрессия (возврат Math.floor на нечётной сумме) не прошла тихо.
    const r = calculateRefund(10001, inWeek, false);
    expect(r.amount).toBe(10001);
  });

  it('reason у обеих ролей называет решение владельца или причину отмены оператором', () => {
    expect(calculateRefund(1000, inWeek, false).reason).toMatch(/полный возврат/i);
    expect(calculateRefund(1000, inWeek, true).reason).toMatch(/полный возврат/i);
  });
});

describe('POST /api/admin/finance/refunds — предохранители (по тексту роута)', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/admin/finance/refunds/route.ts'),
    'utf-8',
  );

  it('гейтится cancelledBookingSql — не любой HELD-платёж, а только отменённой брони', () => {
    expect(src).toMatch(/cancelledBookingSql/);
    // Важно НЕ спутать с notCancelledBookingSql (обратный предикат у payouts):
    // импорт должен явно называть нужную функцию, а не полагаться на подстроку.
    expect(src).toMatch(/import\s*\{[^}]*\bcancelledBookingSql\b[^}]*\}\s*from\s*['"]@\/lib\/payments\/release-eligibility['"]/);
  });

  it('блокирует строки FOR UPDATE — как у выплат (#1217), защита от двойной отметки', () => {
    expect(src).toMatch(/FOR UPDATE/);
  });

  it('требует непустую причину не короче восьми символов', () => {
    expect(src).toMatch(/z\.string\(\)[^;]*\.min\(8/);
  });

  it('пишет отдельно кто (refunded_by), когда (refunded_at) и сколько (refund_amount)', () => {
    expect(src).toMatch(/refunded_by/);
    expect(src).toMatch(/refunded_at/);
    expect(src).toMatch(/refund_amount/);
    expect(src).toMatch(/refund_reason/);
  });

  it('сумма возврата берётся из retail_amount самой строки (100%), не из входа запроса', () => {
    // `refund_amount = retail_amount` в UPDATE — сервер не доверяет клиенту
    // сумму, вычисляет её сам. Инъекция чужой суммы через тело запроса
    // невозможна, потому что тело её вообще не содержит.
    expect(src).toMatch(/refund_amount\s*=\s*retail_amount/);
    expect(src).not.toMatch(/body\.amount|amount:\s*z\./);
  });

  it('находит не все запрошенные платежи — отказ, а не частичная отметка (как у payouts #1217)', () => {
    expect(src).toMatch(/found\.rows\.length\s*!==\s*paymentIds\.length/);
  });
});

describe('GET /api/admin/finance/payouts — pendingRefunds не путается с readyForPayout', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/admin/finance/payouts/route.ts'),
    'utf-8',
  );

  it('readyForPayout (выплата оператору) исключает отменённые брони', () => {
    // До 11.09 группа "готовы к выплате" включала платежи отменённых броней,
    // хотя POST того же роута их всё равно отвергал — админ видел ложную
    // сумму и получал 409 на весь батч.
    const readyBlock = src.slice(src.indexOf('readyResult = await query'), src.indexOf('pendingRefundsResult'));
    expect(readyBlock).toMatch(/notCancelledBookingSql/);
  });

  it('pendingRefunds (возврат туристу) — обратный предикат, только отменённые', () => {
    // Срез строго до объявления `s` — иначе он утекает в POST-обработчик
    // ниже, у которого своё законное употребление notCancelledBookingSql
    // (создание выплаты), и тест ловит не то.
    const start = src.indexOf('pendingRefundsResult = await query');
    const end = src.indexOf('const s = statsResult.rows[0]');
    const refundBlock = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(refundBlock).toMatch(/cancelledBookingSql/);
    expect(refundBlock).not.toMatch(/notCancelledBookingSql/);
  });

  it('оба ответа возвращаются вызывающему — не посчитаны и выброшены', () => {
    expect(src).toMatch(/readyForPayout:\s*readyResult\.rows/);
    expect(src).toMatch(/pendingRefunds:\s*pendingRefundsResult\.rows/);
  });
});
