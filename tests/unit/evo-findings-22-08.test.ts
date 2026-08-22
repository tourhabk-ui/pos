/**
 * Сторожа четырёх находок эволюции, разобранных 22.08.2026 (issue #1331, #1332).
 *
 * Все четыре — один класс: код уверенно сообщал то, чего не проверял.
 * Пустой список туров вместо отказа запроса, «места ещё есть» без чтения
 * занятости, «предложение отправлено» при неудачной отправке, ссылка на
 * маршрут по id тура. Правила ниже читают исходники: без базы иначе никак,
 * а именно этот класс ошибок не ловят ни tsc, ни тесты с моками.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('контекст оператора у Кузьмича', () => {
  const src = read('lib/kuzmich/operator-chat.ts');

  it('тур связан с оператором через partners.id, а не через user_id', () => {
    // operator_tours.operator_id REFERENCES partners(id) — миграция 040.
    // Сравнение с partners.user_id давало оператору вечно пустой кабинет.
    expect(src).not.toMatch(/user_id\s+FROM\s+partners/i);
    expect(src).toMatch(/operator_id = \$1/);
  });

  it('отказ запроса не выдаётся за пустоту', () => {
    // Три блока контекста уходят в системный промпт. Упавший запрос обязан
    // сказать «не смог», иначе Кузьмич уверенно врёт оператору о его бизнесе.
    expect(src).toMatch(/НЕ УДАЛОСЬ ПРОЧИТАТЬ/);
    const marks = src.match(/НЕ УДАЛОСЬ ПРОЧИТАТЬ/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(3);
    // Отказ ещё и логируется: имя проверки и SQLSTATE (§4.0).
    expect(src).toMatch(/console\.error\([\s\S]*?SQLSTATE/);
  });

  it('счётчик предстоящих броней допускает «не знаю»', () => {
    // pendingCount: number вынуждал показать 0 при отказе запроса.
    expect(src).toMatch(/pendingCount[\s\S]{0,200}:\s*null/);
  });
});

describe('напоминание туристу', () => {
  const src = read('lib/kuzmich/engagement.ts');

  it('ссылка ведёт на карточку тура, а не на маршрут по id тура', () => {
    expect(src).not.toMatch(/\/routes\/\$\{row\.tour_id\}/);
    expect(src).toMatch(/\/marketplace\/tours\/\$\{row\.tour_id\}/);
  });

  it('адрес берётся из конфига, а не зашит в текст', () => {
    expect(src).toMatch(/getPublicBaseUrl\(\)/);
    expect(src).not.toMatch(/`vedarai\.ru/);
  });

  it('наличие мест не утверждается без чтения занятости', () => {
    // Правило, а не запрет фразы: обещать места можно только тому, кто
    // прочитал занятость (CLAUDE.md §8: критичные факты — из БД).
    const claimsSeats = /(Места|мест[оа]?)\s+(ещё\s+)?есть/i.test(src);
    const readsAvailability = /tour_availability/.test(src);
    expect(claimsSeats && !readsAvailability, 'обещание мест без чтения занятости').toBe(false);
  });
});

describe('отправка предложения клиенту', () => {
  const src = read('lib/leads/proposal-delivery.ts');

  it('лид занимается условным UPDATE до отправки, а не после', () => {
    const claim = /UPDATE leads SET status = 'proposal_sent'[\s\S]{0,200}?WHERE id = \$1 AND status IS DISTINCT FROM 'proposal_sent'/;
    expect(src).toMatch(claim);
    // Захват стоит ДО отправки в Telegram — иначе гонка остаётся.
    const claimAt = src.search(claim);
    const sendAt = src.indexOf('await tgSend(');
    expect(claimAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThan(0);
    expect(claimAt).toBeLessThan(sendAt);
  });

  it('безусловного перевода в proposal_sent не осталось', () => {
    expect(src).not.toMatch(/UPDATE leads SET status = 'proposal_sent', updated_at = NOW\(\) WHERE id = \$1`/);
  });

  it('захват откатывается, если не ушло ничего', () => {
    // Иначе сбой Telegram навсегда пометил бы лид отправленным, и клиент
    // не получил бы предложение никогда.
    expect(src).toMatch(/releaseClaim/);
    expect(src).toMatch(/sent\.length === 0/);
    expect(src).toMatch(/not_delivered/);
  });

  it('новый исход доставки имеет свой HTTP-код у ручки', () => {
    const route = read('app/api/leads/[id]/proposal/send/route.ts');
    expect(route).toMatch(/not_delivered:\s*\d{3}/);
  });
});
