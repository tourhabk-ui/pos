/**
 * Столкновение авто-отмены и приёмника оплаты.
 *
 * Находка эволюции #1360 назвала здесь гонку: авто-отмена якобы перезаписывает
 * статус брони, оплаченной параллельно. В описанном виде это неверно — один
 * UPDATE в READ COMMITTED перепроверяет своё условие на новой версии строки
 * после блокировки и строку, ставшую `confirmed`, пропускает сам.
 *
 * Настоящее столкновение идёт в обратную сторону и через приёмник Точки: он
 * читает бронь, УХОДИТ СПРАШИВАТЬ БАНК — сетевой вызов — и только потом пишет
 * подтверждение. В этом окне отмена успевает отменить, условный UPDATE
 * приёмника записывает ноль строк, а деньги у банка приняты. Результат не
 * проверялся, и дальше безусловно шёл учёт: комиссия начислялась, оператору
 * уходило «оплата получена», а на самой броне не было ни `paid_at`, ни статуса.
 *
 * Сторож держит обе половины починки: отмена отказывается от строки с деньгами,
 * приёмник смотрит на число записанных строк и не выдаёт проигранную гонку за
 * подтверждение.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const CRON    = code('app/api/cron/abandoned-bookings/route.ts');
const WEBHOOK = code('app/api/payments/tochka/webhook/route.ts');

describe('авто-отмена не трогает бронь с деньгами', () => {
  it('условие отмены отказывается от paid_at', () => {
    // Дважды: у роута две ветки одного условия — сухая выборка и сама отмена.
    // Разойдись они, `?dry=1` показывал бы партию, отличную от отменяемой.
    expect((CRON.match(/paid_at IS NULL/g) ?? []).length).toBe(2);
  });

  it('условие отмены отказывается от payment_status = paid', () => {
    expect((CRON.match(/payment_status <> 'paid'/g) ?? []).length).toBe(2);
  });
});

describe('пульс крона говорит настоящий исход', () => {
  // Эту половину #1360 закрыл параллельный разбор («Крон отчитывался об успехе
  // до того, как начал работу»). Проверки оставлены здесь же: они держат то же
  // свойство, а два сторожа одного файла лучше, чем ноль после следующей
  // правки.
  it('успех пишется после работы, а не до неё', () => {
    const first = CRON.indexOf("recordCronRun('payments'");
    const query = CRON.indexOf('pool.query');
    expect(first).toBeGreaterThan(query);
  });

  it('отказ пишется как отказ и попадает в лог', () => {
    expect(CRON).toMatch(/recordCronRun\('payments', startedAt, 'failed'/);
    expect(CRON).toMatch(/console\.error\('\[abandoned-bookings\]/);
  });
});

describe('приёмник Точки не выдаёт проигранную гонку за подтверждение', () => {
  it('число записанных строк проверяется', () => {
    expect(WEBHOOK).toMatch(/confirmed\.rowCount === 0/);
  });

  it('учёт идёт только после реальной записи', () => {
    // afterConfirmed обязан стоять ПОСЛЕ выхода по нулю строк, иначе комиссия
    // начисляется по броне, которой подтверждение не досталось.
    const guard = WEBHOOK.indexOf('rowCount === 0');
    const after = WEBHOOK.indexOf('await afterConfirmed(');
    expect(guard).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(guard);
  });

  it('разбор различает повтор вебхука и уход брони из ожидания', () => {
    expect(WEBHOOK).toMatch(/handleLostRace/);
    expect(WEBHOOK).toMatch(/booking_status === 'confirmed'/);
    expect(WEBHOOK).toMatch(/booking_left_pending/);
  });

  it('на ушедшей броне записывается факт оплаты, но не статус брони', () => {
    // Судим SQL, а не окружающий его JS: `booking_status` законно встречается
    // и в разборе состояния, и в ответе роута. Спрашивать надо у запроса.
    const lost = WEBHOOK.slice(WEBHOOK.indexOf('async function handleLostRace'));
    const body = lost.slice(0, lost.indexOf('async function afterConfirmed'));
    const update = body.slice(body.indexOf('UPDATE operator_bookings'));
    const sql = update.slice(0, update.indexOf('`'));
    expect(sql).toMatch(/payment_status = 'paid'/);
    expect(sql).toMatch(/paid_at\s*=\s*COALESCE/);
    // Статус брони самовольно не меняем: отменить могли по делу, а возврат —
    // решение человека.
    expect(sql).not.toMatch(/booking_status\s*=/);
  });

  it('комиссия по ушедшей броне не начисляется', () => {
    const lost = WEBHOOK.slice(WEBHOOK.indexOf('async function handleLostRace'));
    const body = lost.slice(0, lost.indexOf('async function afterConfirmed'));
    expect(body).not.toMatch(/recordCommissionFromBooking/);
  });

  it('владельца зовут, а не глушат', () => {
    expect(WEBHOOK).toMatch(/console\.error\(\s*'\[tochka\/webhook\]/);
    expect(WEBHOOK).toMatch(/notifyOwnerPaidAfterExit/);
  });

  it('пропавшая строка — «не знаю», а не «оплата не наша»', () => {
    expect(WEBHOOK).toMatch(/retryLater\('booking_vanished'\)/);
  });
});
