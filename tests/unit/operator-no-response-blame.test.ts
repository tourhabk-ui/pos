/**
 * tests/unit/operator-no-response-blame.test.ts
 *
 * Недоставку платформы нельзя записывать оператору как молчание.
 *
 * ── Что случилось (08.09, issue #1719) ─────────────────────────────────────
 *
 * Перепись эволюции: у 2 из 2 операторов с живыми турами нет ни MAX, ни
 * Telegram, за ними 12 живых туров. Заявка по такому туру создаётся в базе и
 * НИКУДА НЕ УЕЗЖАЕТ. А через 48 часов Watchdog находил её в `booking_status =
 * 'new'` и записывал оператору в Brain, в `patterns/operators/<slug>`, строку
 * «N бронирований без ответа >48ч» — паттерн ЕГО поведения.
 *
 * Это факт о нас, записанный как факт о нём. Хуже, чем неточность: паттерн
 * копится по датам и потом читается как история недобросовестности партнёра,
 * которому мы ни одной заявки не отправили.
 *
 * ── Второй дефект той же проверки ──────────────────────────────────────────
 *
 * Достижимость мерялась ОДНИМ `telegram_chat_id`, тогда как основной канал
 * операторов у платформы — MAX (в него им и велят написать боту Кузьмича,
 * чтобы завести адрес). Оператор с MAX и без Telegram считался «не
 * подключённым к боту» и напоминания не получал вовсе — при том что канал
 * связи с ним был.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Границу между «не ответил» и «до него не дошло». Оба следа обязаны
 * оставаться — но каждый своими словами: вычеркнуть недоставку из отчёта было
 * бы вторым способом соврать (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

/** Тело проверки — судим код, а не пояснения вокруг него. */
const CHECK = SRC.slice(
  SRC.indexOf('async function checkOperatorNoResponse'),
  SRC.indexOf('async function checkStaleLeads') > 0
    ? SRC.indexOf('async function checkStaleLeads')
    : SRC.indexOf('async function checkOperatorNoResponse') + 6000,
);

describe('достижимость меряется обоими каналами', () => {
  it('max_chat_id спрашивается у базы', () => {
    expect(CHECK).toMatch(/p\.max_chat_id::text AS max_chat_id/);
  });

  it('и участвует в группировке — иначе строка развалится на дубли', () => {
    expect(CHECK).toMatch(/GROUP BY[^`]*p\.max_chat_id/);
  });

  it('недостижим — только тот, у кого НЕТ обоих', () => {
    expect(CHECK).toMatch(/unreachable = rows\.filter\(r => !r\.telegram_chat_id && !r\.max_chat_id\)/);
    expect(CHECK).toMatch(/reachable = rows\.filter\(r => r\.telegram_chat_id \|\| r\.max_chat_id\)/);
  });
});

describe('паттерн поведения пишется только достижимому', () => {
  it('запись в Brain идёт по reachable, а не по всем строкам', () => {
    expect(CHECK).toMatch(/for \(const row of reachable\)/);
    // Ключевой регресс, от которого сторож бережёт: цикл по всем строкам
    // вернул бы недостижимым их прежний ярлык.
    expect(CHECK).not.toMatch(/for \(const row of rows\)\s*\{[\s\S]{0,400}patterns\/operators/);
  });

  it('недоставка тоже оставляет след — но нашими словами', () => {
    expect(CHECK).toMatch(/for \(const row of unreachable\)/);
    expect(CHECK).toMatch(/недоставка платформы, не молчание оператора/);
  });

  it('в сводке две беды названы порознь', () => {
    expect(CHECK).toMatch(/не ответили на бронирование > 48ч/);
    expect(CHECK).toMatch(/до них НЕ ДОШЛИ, это наша недоставка/);
  });

  it('сводка не утверждает про недостижимых, что они «не ответили»', () => {
    // Прежняя строка складывала оба случая в одно число `rows.length`.
    expect(CHECK).toMatch(/\$\{reachable\.length\} оператор\(ов\) не ответили/);
    expect(CHECK).not.toMatch(/\$\{rows\.length\} оператор\(ов\) не ответили/);
  });
});

describe('напоминание уходит в тот канал, где оператор есть', () => {
  it('MAX пробуется первым — это основной канал операторов', () => {
    const fn = SRC.slice(
      SRC.indexOf('async function notifyOperatorDirectly'),
      SRC.indexOf('async function checkOperatorNoResponse'),
    );
    expect(fn.indexOf('maxSendDm')).toBeGreaterThan(-1);
    expect(fn.indexOf('maxSendDm')).toBeLessThan(fn.indexOf('TELEGRAM_BOT_TOKEN'));
  });

  it('отказ доставки не глушится — имя оператора и причина в лог (§4.0)', () => {
    const fn = SRC.slice(
      SRC.indexOf('async function notifyOperatorDirectly'),
      SRC.indexOf('async function checkOperatorNoResponse'),
    );
    expect(fn).toMatch(/не ушло в MAX: \$\{res\.error \?\? 'причина не названа'\}/);
    expect(fn).toMatch(/не ушло в Telegram: HTTP \$\{res\.status\}/);
  });

  it('функция говорит, ушло ли и куда, а не только что попытались', () => {
    expect(SRC).toMatch(/\): Promise<'max' \| 'telegram' \| null>/);
  });
});
