/**
 * Отказ начисления комиссии не проглатывается молча.
 *
 * Перепись схемы 22.08 показала, что таблицы `operator_commissions` на
 * боевой базе НЕТ: миграция 084 числилась применённой, а её действия в базе
 * не было (тот же дефект трекинга, что и у 906 — задача #58). Значит каждая
 * вставка комиссии падала на «relation does not exist».
 *
 * Увидеть это было неоткуда: `catch` был пустой. Молчание выбрано осознанно
 * и правильно — платёж уже прошёл, и падение учёта не должно приводить к
 * повтору всего вебхука. Но «не прерывать» и «не сообщать» — разные вещи, и
 * вторая превратила поломку в «продаж нет» (§4.0).
 *
 * Сторож держит обе стороны: причина уходит в лог, а поток по-прежнему не
 * прерывается — исключение наружу не летит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/payments/commission.ts'), 'utf-8');
const FN = SRC.slice(SRC.indexOf('export async function recordCommissionFromBooking'));

describe('recordCommissionFromBooking', () => {
  it('не глушит отказ: причина уходит в лог', () => {
    expect(FN).not.toMatch(/\}\s*catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/);
    expect(FN).toMatch(/catch\s*\(\s*err\s*\)/);
    expect(FN).toMatch(/console\.error/);
  });

  it('в логе есть SQLSTATE — по нему отличают «таблицы нет» от «дубль ключа»', () => {
    expect(FN).toMatch(/sqlstate/);
    expect(FN).toMatch(/\.code/);
  });

  it('поток платежа не прерывается — исключение наружу не летит', () => {
    // Если бы отказ учёта начал бросать, CloudPayments повторял бы вебхук,
    // и один платёж пошёл бы по кругу. Это было бы хуже потерянной записи.
    const tail = FN.slice(FN.indexOf('} catch'));
    expect(tail).not.toMatch(/\bthrow\b/);
  });

  it('идемпотентность остаётся на invoice_id', () => {
    // CloudPayments повторяет вебхук до кода 0; без ключа одна оплата дала бы
    // несколько начислений.
    expect(FN).toMatch(/ON CONFLICT \(invoice_id\) DO NOTHING/);
  });
});

describe('таблица комиссий объявлена восстановленной', () => {
  it('миграция 907 создаёт operator_commissions с booking_id под operator_bookings.id', () => {
    // В 084 стоял `booking_id UUID`, а operator_bookings.id — bigint: даже
    // при существующей таблице вставка не прошла бы ни разу.
    const sql = readFileSync(join(process.cwd(), 'migrations/907_repair_lost_objects.sql'), 'utf-8');
    const create = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS operator_commissions'));
    const body = create.slice(0, create.indexOf('\n);'));
    expect(body).toMatch(/booking_id\s+BIGINT/);
    expect(body).not.toMatch(/booking_id\s+UUID/);
  });
});
