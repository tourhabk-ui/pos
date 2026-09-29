/**
 * Напоминание о неподтверждённой брони, дошедшее заглушкой Telegram (29.09).
 *
 * Оператору с одним Telegram имя и телефон туриста не отправляются (152-ФЗ) —
 * уходит заглушка с номером брони, суммой и сроком. `delivered` у неё false по
 * построению, но напоминание ДОШЛО. Если считать её отказом, отметка «напомнили»
 * не ставится и то же сообщение уходит каждый час до отмены брони.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/abandoned-bookings/route.ts'), 'utf-8');

describe('напоминание оператору о неподтверждённой брони', () => {
  it('заглушка Telegram считается дошедшим напоминанием', () => {
    expect(SRC).toMatch(/const reminderReached = res\.delivered \|\| res\.channel === 'telegram-stub';/);
    expect(SRC).toMatch(/if \(!reminderReached\) \{/);
  });

  it('только настоящий отказ оставляет бронь без отметки (повтор через час) и попадает в счёт сбоев', () => {
    const i = SRC.indexOf('if (!reminderReached)');
    const branch = SRC.slice(i, SRC.indexOf('}', SRC.indexOf('continue;', i)) + 1);
    expect(branch).toMatch(/sendFailed\+\+/);
    expect(branch).toMatch(/continue;/);
    expect(branch).toMatch(/console\.error\(/);
  });
});
