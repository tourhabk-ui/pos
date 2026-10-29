/**
 * Выбор тура по названию — три исхода (слово владельца 29.10, «1в 2б 3 да»).
 *
 * До 29.10 резолвер отдавал ОДИН тур: при равном ранге названия побеждало
 * короче название, затем самый дешёвый. Заявка «на Горелый» уходила той
 * компании, чьё название короче, и телефон человека получал продавец,
 * которого он не называл. Бронь в мессенджере жила своим findTour с пустым
 * catch: отказ базы звучал «не нашёл подходящий тур».
 *
 * Что держит сторож — вызовом настоящих функций с подменённой базой:
 *   - лучший ранг у туров двух компаний — `ambiguous`, кандидаты в порядке
 *     правила 1в; у одной компании — `one`, тур внутри неё — по правилу;
 *   - точное название у одной компании — `one`, хотя у других есть вхождение;
 *   - номер («61», «ID61») — тот самый тур или «нет», без поиска по словам;
 *   - отказ базы — исключение, а не «нет»;
 *   - бронь в мессенджере: туры разных компаний — список и шаг «тур», ответ
 *     номером выбирает тур, отказ базы — «не смог проверить».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  transaction: vi.fn(),
}));

import { resolveTourChoice, resolveTourByQuery, candidateLines } from '@/lib/kuzmich/tour-availability-tool';
import { handleBookingStep, startBooking, type PendingBooking } from '@/lib/kuzmich/core';
import { orderOffersBy } from '@/lib/tours/offer-order';

type Row = Record<string, unknown>;

const row = (id: number, operator: string, extra: Row = {}): Row => ({
  id, title: `Вулкан Горелый ${id}`, operator_id: operator, operator_name: `Компания ${operator.toUpperCase()}`,
  base_price: 15000, price_unit: 'per_person', slug: `gorely-${id}`, multi_day_count: 1, duration_hours: null,
  duration_type: 'single_day', season_start: null, season_end: null, main_place_id: null,
  place_name: null, place_slug: null, place_ark_id: null, nearest_free_date: null, rank: 2,
  ...extra,
});

function answer(rows: Row[]): void {
  query.mockImplementation(async (sql: string) => (/FROM operator_tours ot/.test(sql) ? { rows } : { rows: [] }));
}

// Тело в фигурных скобках: функция, возвращённая из beforeEach, — это уборка
// после теста, и vitest вызвал бы сам мок.
beforeEach(() => { query.mockReset(); });

describe('resolveTourChoice', () => {
  it('«Горелый» у двух компаний — неоднозначно, кандидаты в порядке правила 1в', async () => {
    // У 72 есть свободная дата, у 61 нет: правило ставит 72 первым, хотя
    // номер и название у 61 «меньше».
    answer([row(61, 'a'), row(72, 'b', { nearest_free_date: '2027-07-26' })]);
    const choice = await resolveTourChoice('Горелый');
    expect(choice.kind).toBe('ambiguous');
    if (choice.kind !== 'ambiguous') return;
    expect(choice.candidates.map((c) => c.id)).toEqual([72, 61]);
    expect(choice.candidates.map((c) => c.operator_name)).toEqual(['Компания B', 'Компания A']);
    // Старый вход «один тур» за человека не выбирает.
    expect(await resolveTourByQuery('Горелый')).toBeNull();
  });

  it('без дат порядок кандидатов — жребий дня, а не номер и не цена', async () => {
    const rows = [row(61, 'a', { base_price: 5000 }), row(72, 'b', { base_price: 90000 }), row(83, 'c')];
    answer(rows);
    const choice = await resolveTourChoice('Горелый');
    if (choice.kind !== 'ambiguous') throw new Error(`ожидалось ambiguous, пришло ${choice.kind}`);
    const expected = orderOffersBy(rows, (r) => ({ id: Number(r.id), nearestFreeDate: null })).map((r) => Number(r.id));
    expect(choice.candidates.map((c) => c.id)).toEqual(expected);
  });

  it('два тура одной компании — один исход, тур выбран правилом, а не длиной названия', async () => {
    answer([
      row(61, 'a', { title: 'Горелый' }),
      row(62, 'a', { title: 'Горелый с ночёвкой в палатках', nearest_free_date: '2027-08-01' }),
    ]);
    const choice = await resolveTourChoice('Горелый');
    expect(choice.kind).toBe('one');
    if (choice.kind === 'one') expect(choice.tour.id).toBe(62);
  });

  it('точное название у одной компании — один исход, вхождение у другой не мешает', async () => {
    answer([row(61, 'a', { rank: 0 }), row(72, 'b', { rank: 2 })]);
    const choice = await resolveTourChoice('Вулкан Горелый 61');
    expect(choice.kind).toBe('one');
    if (choice.kind === 'one') expect(choice.tour.id).toBe(61);
  });

  it('номер — тот самый тур или «нет», без поиска по словам', async () => {
    answer([row(61, 'a')]);
    const one = await resolveTourChoice('ID61');
    expect(one.kind).toBe('one');
    expect(query.mock.calls[0][1]).toEqual([61]);
    expect(String(query.mock.calls[0][0])).not.toMatch(/ILIKE/);

    query.mockReset();
    answer([]);
    expect((await resolveTourChoice('7')).kind).toBe('none');
    expect(query.mock.calls.some((c) => /ILIKE/.test(String(c[0])))).toBe(false);
  });

  it('отказ базы — исключение, а не «тура нет»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    await expect(resolveTourChoice('Горелый')).rejects.toMatchObject({ code: '57014' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('строки кандидатов: номер, название, компания, цена словами; больше десяти — «и ещё»', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, title: `Тур ${i + 1}`, operator_id: `o${i}`, operator_name: `Компания ${i}`, slug: null,
      base_price: 15000, price_unit: 'per_person', main_place_id: null, place: null, nearest_free_date: null,
    }));
    const lines = candidateLines(many);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toMatch(/^- ID1 «Тур 1» — Компания 0 — 15\s000 ₽ за человека$/);
    expect(lines[10]).toBe('- и ещё 2 — get_tours');
  });
});

describe('бронь в мессенджере выбирает тур общим резолвером', () => {
  const CHAT = 4242;

  function stepTour(): Map<number, PendingBooking> {
    return new Map([[CHAT, { step: 'tour', started_at: Date.now() }]]);
  }

  it('туры разных компаний — список с номерами и компаниями, шаг остаётся «тур»', async () => {
    answer([row(61, 'a'), row(72, 'b')]);
    const pending = stepTour();
    const reply = vi.fn();
    expect(await handleBookingStep(CHAT, 'хочу на вулкан', 'tg', pending, reply, 'telegram_bot')).toBe(true);
    const text = String(reply.mock.calls[0][1]);
    expect(text).toContain('туры разных компаний — напишите номер тура');
    expect(text).toContain('<b>61</b>');
    expect(text).toContain('Компания A');
    expect(text).toContain('<b>72</b>');
    expect(text).toContain('Компания B');
    expect(text).toContain('Место в списке не продаётся.');
    expect(pending.get(CHAT)?.step).toBe('tour');
    expect(pending.get(CHAT)?.tour).toBeUndefined();
  });

  it('ответ номером выбирает тур, и заявка называет компанию', async () => {
    answer([row(61, 'a')]);
    const pending = stepTour();
    const reply = vi.fn();
    expect(await handleBookingStep(CHAT, '61', 'tg', pending, reply, 'telegram_bot')).toBe(true);
    expect(pending.get(CHAT)?.step).toBe('name');
    expect(pending.get(CHAT)?.tour?.id).toBe(61);
    expect(String(reply.mock.calls[0][1])).toContain('Заявка оператору: <b>Вулкан Горелый 61</b> — <b>Компания A</b>');
  });

  it('отказ базы — «не смог проверить», а не «не нашёл»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours ot/.test(sql)) throw Object.assign(new Error('boom'), { code: '57014' });
      return { rows: [] };
    });
    const reply = vi.fn();
    expect(await handleBookingStep(CHAT, 'хочу на вулкан', 'tg', stepTour(), reply, 'telegram_bot')).toBe(true);
    expect(String(reply.mock.calls[0][1])).toContain('Не смог проверить туры');
    expect(String(reply.mock.calls[0][1])).not.toContain('Не нашёл');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[kuzmich] тур для брони не прочитан'))).toBe(true);
    spy.mockRestore();
  });

  it('начало брони при турах разных компаний — список, а не первый по цене', async () => {
    answer([row(61, 'a', { base_price: 5000 }), row(72, 'b')]);
    const pending = new Map<number, PendingBooking>();
    const reply = vi.fn();
    const history = [{ role: 'user' as const, content: 'расскажи про вулкан Горелый' }];
    expect(await startBooking(CHAT, 'бронирую', 'tg', history, pending, reply)).toBe(true);
    expect(String(reply.mock.calls[0][1])).toContain('напишите номер тура');
    expect(pending.get(CHAT)?.step).toBe('tour');
    expect(pending.get(CHAT)?.tour).toBeUndefined();
  });
});
