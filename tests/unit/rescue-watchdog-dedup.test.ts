/**
 * EVO-3: один сторож вместо двух. SOS-таймауты и неподтверждённые брони
 * сторожит ТОЛЬКО Watchdog — держать их же в Rescue = двойные Telegram-алерты
 * владельцу об одном событии. Инвариант проверяем статически по исходникам
 * (как evo-scan-honesty): дублирующий запрос не должен вернуться в Rescue.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const rescueSrc = read('lib/agents/evo/rescue-agent.ts');
const watchdogSrc = read('lib/agents/watchdog.ts');

describe('Rescue больше не дублирует Watchdog', () => {
  it('Rescue не трогает sos_events (SOS — только Watchdog)', () => {
    expect(rescueSrc).not.toMatch(/FROM\s+sos_events/i);
  });

  it('Rescue не сторожит неподтверждённые брони >24ч (booking_status = new)', () => {
    // Погодная проверка читает operator_bookings по booking_date — это ОК;
    // запрещён именно дубль «new + 24 hours».
    expect(rescueSrc).not.toMatch(/booking_status\s*=\s*'new'[\s\S]{0,120}24 hours/i);
  });

  it('типы алертов Rescue сузились — без sos_timeout / booking_unconfirmed', () => {
    expect(rescueSrc).not.toContain("'sos_timeout'");
    expect(rescueSrc).not.toContain("'booking_unconfirmed'");
  });
});

describe('Watchdog — единственный владелец SOS-таймаута', () => {
  it('Watchdog сторожит sos_events и несёт 112 + координаты', () => {
    expect(watchdogSrc).toMatch(/FROM\s+sos_events/i);
    expect(watchdogSrc).toContain('112');
    expect(watchdogSrc).toMatch(/координат/i);
  });

  it('порог SOS-таймаута ужат до 15 минут (компенсация убранного Rescue-tier)', () => {
    expect(watchdogSrc).toMatch(/15 minutes/);
  });
});
