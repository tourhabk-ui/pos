// @vitest-environment node
/**
 * Заявка, о которой оператор не узнал, — потерянная продажа (04.09).
 *
 * Разбор воронки (88 визитов → 22 просмотра → 1 заявка → 0 оплат) вскрыл на
 * пути денег два молчания подряд:
 *
 *  1. `app/api/hub/bookings/create/route.ts` — весь блок «уведомить оператора
 *     + синк U-ON» стоял под пустым `catch {}`. Упало — бронь в базе есть,
 *     оператор не знает, в логе ни строки;
 *  2. `lib/notifications/operator-booking.ts` — отправка оператору шла под
 *     `if (есть адрес)` БЕЗ `else`. Оператор без MAX и Telegram не получал
 *     заявку никогда, и это со стороны неотличимо от «оператор видит и
 *     молчит»: Watchdog в такой ситуации винит оператора, а чинить надо у нас.
 *
 * Оба молчания — про §4.0: «не смог доставить» и «доставил» обязаны
 * различаться, и «некуда доставлять» — третий исход, а не отсутствие события.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const CREATE = read('app/api/hub/bookings/create/route.ts');
const NOTIFY = read('lib/notifications/operator-booking.ts');
const REACH = read('app/api/cron/operator-reach/route.ts');

describe('создание брони: отказ уведомления не глушится', () => {
  it('catch вокруг уведомления оператору пишет в лог', () => {
    expect(CREATE).toMatch(/\[bookings\/create\] уведомление оператору не отправлено/);
  });

  it('соседние отказы того же пути тоже названы: CRM оператора и письмо туристу', () => {
    // Синк U-ON: не доехало — заявки нет в CRM оператора, он работает по
    // неполной картине. Письмо туристу: ссылка на оплату живёт ТОЛЬКО в нём,
    // потерять его молча значит молча потерять продажу.
    expect(CREATE).toMatch(/\[bookings\/create\] синк U-ON не прошёл/);
    expect(CREATE).toMatch(/\[bookings\/create\] письмо туристу не ушло/);
  });

  it('на пути «заявка → оператор → оплата» не осталось пустых catch', () => {
    const block = CREATE.slice(CREATE.indexOf('Уведомление оператору'));
    expect(block).not.toMatch(/catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/);
    expect(block).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*(\/\*[^*]*\*\/\s*)*\}\)/);
  });
});

describe('оператор без канала связи назван вслух', () => {
  it('у ветки отправки есть else с диагностикой', () => {
    expect(NOTIFY).toMatch(/нет ни MAX, ни Telegram/);
  });

  it('сообщение называет и оператора, и номер брони — иначе искать нечем', () => {
    const tail = NOTIFY.slice(NOTIFY.indexOf('нет ни MAX, ни Telegram') - 400);
    expect(tail).toMatch(/payload\.operator_name/);
    expect(tail).toMatch(/payload\.booking_id/);
  });
});

describe('перепись достижимости считает то, что продаётся', () => {
  it('берёт только операторов с живыми турами', () => {
    expect(REACH).toMatch(/JOIN operator_tours t ON t\.operator_id = p\.id AND t\.is_active = true/);
  });

  it('пустой telegram_chat_id не считается каналом', () => {
    expect(REACH).toMatch(/NULLIF\(TRIM\(p\.telegram_chat_id\), ''\)/);
  });

  it('называет цену молчания — туры за недостижимыми операторами', () => {
    expect(REACH).toMatch(/tours_behind_unreachable/);
  });

  it('отказ переписи — «не смог», а не «все достижимы»', () => {
    expect(REACH).toMatch(/verdict: 'unknown'/);
    expect(REACH).toMatch(/console\.error\('\[operator-reach\]/);
  });
});
