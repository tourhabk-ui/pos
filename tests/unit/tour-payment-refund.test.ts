/**
 * Отметка возврата за отменённую туровую бронь (#1813).
 *
 * СКОЛЬКО вернуть решает правило «как у оператора» (решение владельца 24.09,
 * пересматривает 11.09 «100% всегда»): его держит tour-refund-terms.test.ts.
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

  it('сумма — посчитанная при отмене (refund_due), не из входа запроса', () => {
    // Сервер не доверяет клиенту сумму: тело её вообще не содержит. NULL —
    // отмена до 1012, когда действовало «100%».
    expect(src).toMatch(/refund_amount\s*=\s*COALESCE\(refund_due,\s*retail_amount\)/);
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
