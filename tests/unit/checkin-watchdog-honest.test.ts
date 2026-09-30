/**
 * Сторож невозвращения говорит правду о доставке (30.09).
 *
 * До этого дня: (1) ответ Telegram не читался — контакт, не писавший боту,
 * получал 403, а шаг записывался `sent`; (2) контакт без Telegram молча
 * `skipped`, и позвонить ему было некому; (3) контрольное время считалось по
 * часам Node (UTC), тревога уходила на 12 часов позже. Пункт (3) держит
 * checkin-escalation.test.ts; здесь — доставка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/checkin-watchdog/route.ts'), 'utf-8');
const REG = readFileSync(join(process.cwd(), 'app/api/safety/register/route.ts'), 'utf-8');

describe('доставка тревоги', () => {
  it('исход отправки берётся из ответа Telegram, а не из факта вызова', () => {
    expect(SRC).toMatch(/async function sendTelegram\([^)]*\): Promise<SendResult>/);
    expect(SRC).toMatch(/if \(res\.ok && body\?\.ok\) return \{ ok: true \}/);
  });

  it('контакт без Telegram или с отказом — в админ-чат с его телефоном, а не молчаливый skipped', () => {
    const fn = SRC.slice(SRC.indexOf('async function notifyContact'), SRC.indexOf('async function recordNotification'));
    expect(fn).toContain('ПОЗВОНИТЕ КОНТАКТУ');
    expect(fn).toContain('reg.emergency_contact_phone');
    expect(fn).toMatch(/recordNotification\(reg\.id, step, 'admin_only', 'admin'\)/);
    // Отказ доставки контакту записывается как failed с причиной.
    expect(fn).toMatch(/'failed', r\.error\)/);
  });

  it('soft и hard идут через notifyContact — второй копии логики нет', () => {
    expect(SRC).toMatch(/if \(step === 'soft' \|\| step === 'hard'\) \{\s*await notifyContact\(reg, step, msg\);/);
    expect(SRC).not.toMatch(/await sendTelegram\(reg\.emergency_contact_telegram_chat_id/);
  });

  it('недоставленная МЧС-тревога — failed и красный прогон, не skipped', () => {
    const mchs = SRC.slice(SRC.indexOf('МЧС-ТРЕВОГА'), SRC.indexOf('escalated++'));
    expect(mchs).toMatch(/'failed', r\.error\)/);
    expect(mchs).toContain('throw new Error');
    expect(mchs).not.toMatch(/'skipped'/);
  });
});

describe('срок регистрации — по Камчатке', () => {
  it('регистрация строит срок через kamchatkaWallTime, а не new Date без пояса', () => {
    expect(REG).toContain('kamchatkaWallTime(data.end_date, data.expected_return_time)');
    expect(REG).not.toMatch(/new Date\(`\$\{data\.end_date\}T/);
  });
});
