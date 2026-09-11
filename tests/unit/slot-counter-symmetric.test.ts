/**
 * Счётчик мест двусторонний: что оплата заняла, отмена возвращает.
 *
 * ── Чем это оплачено (#1816, воспроизведено 11.09) ────────────────────────
 *
 * `tour_availability.booked_slots` увеличивали два платёжных вебхука, а
 * уменьшал никто. На таблице при этом висит
 * `CHECK (booked_slots >= 0 AND booked_slots <= available_slots)`.
 *
 * Прогон на реальном определении таблицы (temp-копия INCLUDING CONSTRAINTS,
 * всё в транзакции с откатом):
 *
 *     оплачено 10 из 10  -> booked_slots = 10
 *     все 10 отменены    -> booked_slots = 10   (уменьшать некому)
 *     следующая оплата   -> ERROR: violates check constraint "booked_valid"
 *
 * ОДНОГО цикла «дату выкупили — дату отменили» хватало, чтобы эта дата тура
 * больше не приняла оплату: инкремент стоит внутри транзакции оплаты, и его
 * отказ роняет всю обработку — бронь не оплачена, `tour_payments` нет, банк
 * повторяет вебхук. По экранам это не видно: витрины считают занятость из
 * реальных броней, так что дата выглядит свободной и при этом мертва.
 *
 * Тот же CHECK уже ронял оплату однажды — из-за двойного инкремента
 * (комментарий в `app/api/bookings/tour/route.ts`). Тогда вылечили скорость
 * переполнения, а не односторонность.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * 1. Вычитание живёт в ОДНОМ месте и зовётся из обоих рабочих путей отмены.
 * 2. Оно привязано к ПЕРЕХОДУ, а не к факту вызова: повторная отмена не
 *    вычитает дважды.
 * 3. Оно идёт в ТОЙ ЖЕ транзакции, что и смена статуса.
 * 4. `GREATEST(0, ...)` — вторая линия от ухода в минус: отмена не должна
 *    падать из-за учёта мест.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('вычитание мест — одно на всю платформу', () => {
  const CODE = strip(read('lib/payments/slot-counter.ts'));

  it('не уводит счётчик в минус', () => {
    expect(CODE).toMatch(/GREATEST\(0, ta\.booked_slots - b\.participants\)/);
  });

  it('вычитает только у ОПЛАЧЕННЫХ броней: счётчик про оплаченных участников', () => {
    expect(CODE).toMatch(/b\.payment_status = 'paid'/);
  });

  it('работает внутри чужой транзакции, а не открывает свою', () => {
    expect(CODE).toMatch(/client: PoolClient/);
    expect(CODE, 'своя транзакция разошлась бы со сменой статуса').not.toMatch(/BEGIN|pool\.connect/);
  });
});

describe('оба рабочих пути отмены возвращают места', () => {
  it('оператор: PATCH брони — только на переходе, внутри транзакции', () => {
    const CODE = strip(read('app/api/hub/operator/bookings/[id]/route.ts'));
    expect(CODE).toMatch(/releaseSlotsForCancelledBooking\(client, BigInt\(id\)\)/);
    // Переход, а не факт вызова: повторная отмена не вычтет дважды.
    expect(CODE).toMatch(/input\.booking_status === 'cancelled' && prevStatus !== 'cancelled'/);
  });

  it('турист: отмена своей брони — атомарный переход, внутри транзакции', () => {
    const CODE = strip(read('app/api/bookings/[id]/cancel/route.ts'));
    expect(CODE).toMatch(/releaseSlotsForCancelledBooking\(client, opId\)/);
    // Условие перенесено В САМ UPDATE: две вкладки не отменят дважды.
    expect(CODE).toMatch(/WHERE id = \$1 AND booking_status IN \('new', 'confirmed'\)/);
    expect(CODE).toMatch(/if \(upd\.rowCount === 0\) return false;/);
  });
});

describe('ответ об отмене не выдумывает решение о возврате', () => {
  const SRC = read('app/api/bookings/[id]/cancel/route.ts');
  const CODE = strip(SRC);

  it('нарисованного «возврат 0 рублей» больше нет', () => {
    // Ответ УТВЕРЖДАЛ, что возврата не будет, хотя решения никто не принимал
    // и механизма возврата в платформе нет вовсе (#1813). Турист читал этот
    // ноль как отказ.
    expect(CODE).not.toMatch(/refund: \{ amount: 0, reason: '' \}/);
    expect(CODE).toMatch(/refund: null/);
  });

  it('шапка не выдаёт несуществующий расчёт возврата за действующий', () => {
    // Правило 10.09: докстрока, обещающая путь, которого нет, — дефект кода.
    //
    // Проверять «нет строки 24-48ч = 50%» нельзя: шапка ЦИТИРУЕТ прежнее
    // обещание, объясняя, почему его убрали, — и запрет на подстроку
    // покраснел бы именно на честном объяснении. Это тот же случай, что с
    // собственными комментариями сторожей (#1799). Спрашиваем не отсутствие
    // цитаты, а наличие опровержения рядом с ней.
    const head = SRC.slice(0, SRC.indexOf('import '));
    if (/24-48ч = 50%/.test(head)) {
      expect(head, 'старое обещание упомянуто без опровержения — читатель примет его за правду')
        .toMatch(/Прежняя редакция|Ни одно из\s*\n?\s*\*?\s*этого не происходит/);
    }
    expect(head, 'шапка обязана назвать разбор, а не молчать о нём').toMatch(/#1813/);
    expect(head).toMatch(/#1814/);
  });
});
