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
    // Приведение к тексту переехало в общий модуль достижимости
    // (lib/partners/reach): BIGINT приходит из pg то строкой, то числом.
    // У запроса осталась сама колонка — и рядом ВТОРАЯ телеграмная
    // (users.telegram_id через partners.user_id), найденная 08.09.
    expect(code).toMatch(/p\.max_chat_id/);
    expect(code).toMatch(/u_reach\.telegram_id AS user_telegram_id/);
    // «Есть хотя бы один канал» решает reachFrom — одинаково у всех
    // читателей платформы: своя копия условия здесь разошлась бы с
    // доставкой, что и было причиной обеих правок 08.09.
    expect(code).toMatch(/reachable = rows\.filter\(r => reachFrom\(r\)\.reachable\)/);
  });

  it('паттерн поведения пишется ТОЛЬКО тому, до кого заявка дошла', () => {
    // Запись «бронирований без ответа» — факт о поведении оператора. Для
    // недостижимого это факт о нас, записанный как факт о нём.
    const at = code.indexOf('for (const row of reachable)');
    expect(at, 'разбор перестал делить операторов на достижимых и нет').toBeGreaterThan(0);
    const body = code.slice(at, at + 900);
    expect(body).toMatch(/бронирований без ответа/);
    expect(body).toMatch(/knowledgeBase\.upsert/);
    // У недостижимых — свой цикл, и записи в Brain там нет.
    const un = code.indexOf('for (const row of unreachable)');
    expect(un).toBeGreaterThan(0);
    expect(code.slice(un, un + 600)).not.toMatch(/knowledgeBase\.upsert/);
  });

  it('след недоставки остаётся, и назван нашими словами', () => {
    expect(code).toMatch(/недоставка платформы, не молчание оператора/);
  });

  it('тревога называет недоставку недоставкой', () => {
    expect(code).toMatch(/НЕ ДОШЛИ/);
    expect(code).toMatch(/наша недоставка/);
  });
});
