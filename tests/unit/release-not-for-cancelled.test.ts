/**
 * Деньги за отменённую бронь не уезжают оператору сами — и не пропадают из виду.
 *
 * ── Что было до 11.09 (#1813) ─────────────────────────────────────────────
 *
 * `tour_payments.status` двигали только вперёд: `PENDING → HELD` при оплате,
 * `HELD → RELEASED` при выплате. Отмена брони не трогала платёж нигде. Релиз
 * выбирал `WHERE status = 'HELD' AND release_after <= NOW()` и брони не
 * спрашивал вообще — значит платил оператору за тур, который отменён.
 *
 * Отдельно показательно, что админский отказ УЖЕ говорил «они уже выплачены,
 * ОТМЕНЕНЫ или принадлежат другому оператору»: слово в сообщении было,
 * проверки — нет. Ровно тот же разрыв между описанием и кодом, что в лестнице
 * комиссии (#1812) и в `booking.service` (#1814).
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * 1. Оба места, которые ОТПУСКАЮТ деньги, спрашивают бронь.
 * 2. Условие живёт в одном модуле: правило, написанное трижды, — три правила,
 *    и они разойдутся (урок §12 про линии на карте и #887 про две SOS-кнопки).
 * 3. Придержанное ВИДНО: у него своя тревога Watchdog, а не тишина.
 *    Убрать отменённые из тревоги о молчащем кроне и не завести им своей —
 *    это спрятать чужие деньги, а не убрать шум.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANCELLED_BOOKING_STATUSES,
  CANCELLED_STATUS_PARAM,
  notCancelledBookingSql,
  cancelledBookingSql,
} from '@/lib/payments/release-eligibility';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('предикат отменённой брони — один на всех', () => {
  it('условие параметризовано, а не склеено из статусов', () => {
    const sql = notCancelledBookingSql('tp', 1);
    expect(sql).toMatch(/ob\.booking_status = ANY\(\$1::text\[\]\)/);
    // Ни одного статуса внутри самого SQL: они уходят параметром.
    for (const s of CANCELLED_BOOKING_STATUSES) {
      expect(sql, `статус ${s} склеен в текст запроса`).not.toContain(s);
    }
  });

  it('прямое и обратное условие различаются только EXISTS/NOT EXISTS', () => {
    expect(notCancelledBookingSql('tp', 1).replace('NOT EXISTS', 'EXISTS'))
      .toBe(cancelledBookingSql('tp', 1));
  });

  it('список статусов — суперсет: придержать лишнее обратимо, заплатить — нет', () => {
    // Живой код сегодня пишет только 'cancelled'; остальные знает интерфейс
    // туриста и пытается писать booking.service (#1814). CHECK на колонке нет.
    expect(CANCELLED_STATUS_PARAM).toContain('cancelled');
    expect(CANCELLED_STATUS_PARAM).toContain('cancelled_by_tourist');
    expect(CANCELLED_STATUS_PARAM).toContain('cancelled_by_operator');
    expect(CANCELLED_STATUS_PARAM).toContain('refunded');
  });
});

describe('оба места, отпускающие деньги, спрашивают бронь', () => {
  const releasers = [
    'app/api/cron/payouts/route.ts',
    'app/api/admin/finance/payouts/route.ts',
  ];

  it.each(releasers)('%s зовёт общий предикат, а не пишет свой', (f) => {
    const code = strip(read(f));
    expect(code, 'выборка платежей к выплате без проверки отмены брони')
      .toMatch(/notCancelledBookingSql\(/);
    expect(code).toMatch(/CANCELLED_STATUS_PARAM/);
  });

  it.each(releasers)('%s не собирает список статусов руками', (f) => {
    const code = strip(read(f));
    expect(code, 'свой список статусов отмены разойдётся с общим').not.toMatch(
      /'cancelled_by_tourist'|'cancelled_by_operator'/,
    );
  });
});

describe('придержанное видно, а не спрятано', () => {
  const WD = read('lib/agents/watchdog.ts');
  const CODE = strip(WD);

  it('отменённые убраны из тревоги о молчащем кроне', () => {
    const stuck = CODE.slice(CODE.indexOf('async function checkStuckPayouts'));
    const body = stuck.slice(0, stuck.indexOf('async function checkHeldForCancelled'));
    expect(body, 'иначе они звенели бы вечно и утопили бы настоящий сигнал')
      .toMatch(/notCancelledBookingSql\(/);
  });

  it('у них своя тревога, и она заведена вместе с производителем', () => {
    expect(CODE).toMatch(/async function checkHeldForCancelled/);
    expect(CODE).toMatch(/type: 'payment_held_for_cancelled_booking'/);
    // Правило 10.09: тип объявлен — значит его кто-то производит И зовёт.
    expect(CODE).toMatch(/'payment_held_for_cancelled_booking'/);
    expect(CODE, 'проверка не подключена к прогону — тип есть, производителя нет')
      .toMatch(/checkHeldForCancelled,/);
  });

  it('отказ проверки не выдаётся за «нарушений нет» (§4.0)', () => {
    const fn = CODE.slice(CODE.indexOf('async function checkHeldForCancelled'));
    expect(fn.slice(0, 2000)).toMatch(/checkFailure\('checkHeldForCancelled'/);
    expect(fn.slice(0, 2000)).toMatch(/console\.error\('\[watchdog\] checkHeldForCancelled:'/);
  });

  it('релиз отчитывается о придержанном, а не молчит', () => {
    const code = strip(read('app/api/cron/payouts/route.ts'));
    expect(code).toMatch(/withheld_cancelled/);
    expect(code).toMatch(/cancelledBookingSql\(/);
  });
});
