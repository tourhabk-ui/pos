/**
 * Недостижимый оператор виден ДО того, как о нём узнает турист.
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Недостижимость уже ловилась — но внутри `checkOperatorNoResponse`, то есть
 * только ПОСЛЕ того, как заявка пролежала без ответа сорок восемь часов.
 * Порядок выходил такой: турист оставил бронь, двое суток ждал, и лишь потом
 * платформа узнавала, что отправлять её было некуда. Цена задержки — не
 * строка в логе, а человек, который за эти двое суток купил поездку у
 * кого-то другого.
 *
 * Условие при этом стоячее: у партнёра есть активные туры и нет ни одного
 * канала. Заявка для проверки не нужна вовсе.
 *
 * ── Почему это перестало быть теорией ─────────────────────────────────────
 *
 * Замер 11.09 (`GET /api/cron/operator-reach`, прогон маркера prod-check 51):
 * `operators_with_live_tours: 2, reachable: 0, unreachable: 2,
 * tours_behind_unreachable: 12, verdict: "gap"`. Недостижимы не отдельные
 * операторы, а ВСЕ, и двенадцать живых туров продаются так, что продавец о
 * продаже не узнает. Перепись это знала — но её никто не зовёт: она ручная.
 *
 * ── Что здесь проверяется ─────────────────────────────────────────────────
 *
 * Поднять весь Watchdog в тесте нельзя (БД и Telegram), поэтому проверяется
 * исходник — но не наличие слов, а три свойства, каждое из которых уже
 * ломалось в этом файле по-своему: источник один с доставкой, счёт идёт без
 * условия на брони, и отказ не выдаётся за чистоту.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf8');

/** Тело проверки: имя, упомянутое в чужом комментарии, здесь ни при чём. */
const FN = SRC.slice(
  SRC.indexOf('async function checkUnreachableOperators'),
  SRC.indexOf('async function checkOperatorNoResponse'),
);

describe('Watchdog видит недостижимого оператора до первой заявки', () => {
  it('проверка существует и включена в прогон', () => {
    expect(FN.length, 'checkUnreachableOperators не найдена').toBeGreaterThan(100);
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
    const block = /const CHECKS\b[^[]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(code);
    expect(block, 'список CHECKS не найден').not.toBeNull();
    expect(block![1]).toContain('checkUnreachableOperators');
  });

  it('достижимость спрашивается у того же модуля, что и доставка', () => {
    // Свой SQL про telegram_chat_id здесь уже разошёлся однажды с реальной
    // доставкой: колонок с адресом ДВЕ (профиль партнёра и аккаунт человека),
    // и проверка, читавшая одну, молчала про операторов со второй.
    expect(FN).toContain('partnerReachCensus()');
    expect(SRC).toContain("partnerReachCensus, type PartnerReachRow } from '@/lib/partners/reach'");
    expect(FN, 'свой запрос про каналы — это вторая правда о достижимости')
      .not.toMatch(/telegram_chat_id|max_chat_id/);
  });

  it('условие стоячее: ни одной ссылки на брони и сроки', () => {
    // Весь смысл отдельной проверки — что заявки ЖДАТЬ НЕ НАДО. Появится
    // здесь operator_bookings или INTERVAL — и она превратится в копию
    // checkOperatorNoResponse, то есть снова будет узнавать постфактум.
    expect(FN).not.toMatch(/operator_bookings/);
    expect(FN).not.toMatch(/INTERVAL/);
    expect(FN).not.toMatch(/48 hours/);
  });

  it('оператор назван по имени, а адрес наружу не уходит', () => {
    // «Двое операторов» не даёт начать действовать, имя даёт. Но перепись
    // намеренно не отдаёт chat_id — это чужой идентификатор, и для ответа
    // «дойдёт ли заявка» он не нужен.
    expect(FN).toMatch(/r\.name/);
    expect(FN).not.toMatch(/chatId|chat_id/);
  });

  it('отказ проверки — не «нарушений нет» (§4.0)', () => {
    expect(FN).toContain("checkFailure('checkUnreachableOperators'");
    expect(FN, 'пустой catch превратил бы поломку в тишину').not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });

  it('тип алерта объявлен в союзе WatchdogAlert', () => {
    expect(SRC).toMatch(/'operator_unreachable'/);
  });

  it('не КРИТ: чинится живым контактом с оператором, а не ночной правкой', () => {
    // КРИТ не дебаунсится и будет долбить каждые полчаса, пока не найдут
    // телефон. Красное, что не гаснет работой, приучают пролистывать — и
    // следом пролистают настоящее.
    expect(FN).not.toMatch(/critical:\s*true/);
  });
});
