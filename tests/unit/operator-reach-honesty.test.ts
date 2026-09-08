/**
 * Заявка, которая не дошла, не записывается оператору в вину.
 *
 * Находка эволюции 08.09 (issue #1719, severity high): у ОБОИХ операторов с
 * живыми турами не было ни MAX, ни Telegram — 12 живых туров, и заявка по
 * любому из них создавалась в базе и никуда не уезжала. Через 48 часов
 * Watchdog записывал в Brain «N бронирований без ответа», то есть наш пробел
 * уезжал в репутацию оператора, а чинить надо было у нас.
 *
 * Два разных состояния — «доставлено, молчит» и «не доставлено» — лечатся
 * противоположными действиями: первое разговором с оператором, второе
 * подключением канала. Пока они назывались одинаково, второе не чинилось.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const NOTIFY = read('lib/notifications/operator-booking.ts');
const WATCHDOG = read('lib/agents/watchdog.ts');

describe('доставка заявки оператору: три исхода', () => {
  it('исход возвращается вызывающему, а не теряется в void', () => {
    expect(NOTIFY).toMatch(/export type OperatorDeliveryOutcome/);
    expect(NOTIFY).toMatch(/'delivered'/);
    expect(NOTIFY).toMatch(/'failed'/);
    expect(NOTIFY).toMatch(/'no_channel'/);
    expect(NOTIFY).toMatch(/Promise<OperatorDeliveryOutcome>/);
  });

  it('«канала нет» становится задачей человеку, а не строкой в логе', () => {
    // Лог не создаёт ни адресата, ни работы: заявка так и остаётся потерянной.
    const code = strip(NOTIFY);
    expect(code).toMatch(/Заявка не дойдёт до оператора — нет канала/);
    expect(code).toMatch(/sendPdAlert\(\{ text: handoff/);
    // Человеку нужно, ЧЕМ звонить.
    expect(code).toMatch(/operator_phone/);
    expect(code).toMatch(/operator_email/);
  });

  it('телефон и почта оператора действительно запрашиваются из профиля', () => {
    const create = strip(read('app/api/hub/bookings/create/route.ts'));
    expect(create).toMatch(/contacts->>'phone' AS phone/);
    expect(create).toMatch(/operator_phone:/);
  });
});

describe('Watchdog: «молчит» и «не доходило» — разные записи', () => {
  const code = strip(WATCHDOG);

  it('MAX спрашивается наравне с Telegram', () => {
    // Оператор, подключённый только к MAX, числился «не подключённым к боту».
    expect(code).toMatch(/p\.max_chat_id::text AS max_chat_id/);
    expect(code).toMatch(/r\.telegram_chat_id \|\| r\.max_chat_id/);
  });

  it('недостижимому оператору в Brain пишется НЕ «без ответа»', () => {
    expect(code).toMatch(/заявок НЕ ДОСТАВЛЕНО/);
    expect(code).toMatch(/пробел платформы, не молчание оператора/);
  });

  it('тревога называет недостижимых поимённо и говорит, где чинить', () => {
    expect(code).toMatch(/НЕДОСТИЖИМЫ/);
    expect(code).toMatch(/Это чинится у нас, а не у них/);
  });
});
