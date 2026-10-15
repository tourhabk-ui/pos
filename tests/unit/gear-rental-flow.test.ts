/**
 * Воронка аренды снаряжения — структурные инварианты по аудиту 27.07:
 *
 * 1. POST /api/gear/rentals — ПОД ВХОДОМ с 15.10 (аудит, находка A13,
 *    вариант «а»): Edge пускает анонима к /api/gear только с GET, и прежняя
 *    шапка «публичный» была неправдой. Гостю форма показывает вход, согласие
 *    называет прокат, счёт и вставка — в одной транзакции под блокировкой.
 *    Всё это судит ВЫЗОВОМ tests/unit/gear-rental-door.test.ts (и рендер
 *    формы — gear-rental-form.test.tsx), здесь не повторяется.
 * 2. Доступность считается по ДАТАМ (пик пересекающихся аренд), а не по
 *    мгновенному стоку — раньше две брони на одни даты проходили обе.
 *    Кто держит единицу — одна формула lib/gear/availability.
 * 3. О заявке уведомляется партнёр (Telegram) — раньше заявка падала в тишину.
 * 4. Watchdog сторожит pending-аренды >24ч — симметрия с турами и жильём.
 * 5. Мёртвый календарь gear_availability из кода ушёл (никем не заполнялся,
 *    его проверка была вечным «всё свободно»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/gear/rentals/route.ts');
const HELPERS = read('lib/auth/gear-helpers.ts');
const WATCHDOG = read('lib/agents/watchdog.ts');

describe('POST /api/gear/rentals', () => {
  it('проверяет даты сервером (calcRentalDays + отказ)', () => {
    expect(ROUTE).toContain('calcRentalDays(');
    expect(ROUTE).toContain('Дата окончания должна быть позже даты начала');
  });

  it('страховка без тарифа — явный отказ, а не молчаливый ноль', () => {
    expect(ROUTE).toContain('insuranceUnavailable');
  });

  it('о заявке уведомляется партнёр', () => {
    expect(ROUTE).toContain('notifyNewGearRental');
    expect(ROUTE).toContain('telegram_chat_id');
  });
});

describe('watchdog сторожит gear', () => {
  it('есть проверка pending-аренд >24ч и она входит в прогон', () => {
    expect(WATCHDOG).toContain('checkPendingGearRentals');
    expect(WATCHDOG).toContain('pending_gear_rental');
    const checks = /const CHECKS\b[^[]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(WATCHDOG)?.[1] ?? '';
    expect(checks).toMatch(/\bcheckPendingGearRentals\b/);
  });
});

describe('мёртвый календарь удалён из кода', () => {
  it('хелперы больше не ходят в gear_availability', () => {
    expect(HELPERS).not.toContain('FROM gear_availability');
    expect(HELPERS).not.toContain('INTO gear_availability');
    // Имена живут только в комментарии-надгробии — определений нет.
    expect(HELPERS).not.toMatch(/function (checkGearAvailability|updateGearAvailability|calculateRentalCost)/);
  });

  it('витрина фильтрует по датам через пересечение аренд', () => {
    expect(HELPERS).toContain('gear_rentals');
    expect(HELPERS).toContain('generate_series');
  });
});
