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
 *
 * Имя продавца и частичное совпадение (ловушка MCP 29.10, name-search) — ниже,
 * на поддельной базе, которая отвечает на запросы резолвера по их смыслу
 * (фраза, основы, продавцы, отличительность, круг продавцов). Ревью того же
 * дня — отдельным блоком: список внутри продавца вместо первого тура, часть
 * имени без исхода «один тур», имя из общих слов без поднятия продавца, слово
 * из описания и вида отдыха, слова «есть в других турах» вместо «не
 * найдено», мессенджер — продавец раньше слов вида отдыха. Имена компаний и
 * гидов вымышленные. Настоящий SQL на схеме прода (и «ё» в нём) держит
 * tests/integration/public-tour-gate.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  transaction: vi.fn(),
}));

import {
  resolveTourChoice, resolveTourByQuery, candidateLines, matchSellerName, sameWord, queryRemainder,
  getTourAvailabilityForKuzmich,
} from '@/lib/kuzmich/tour-availability-tool';
import { handleBookingStep, startBooking, bookingSumLine, getTourDetails, type PendingBooking } from '@/lib/kuzmich/core';
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

/** Разряды toLocaleString — неразрывный пробел; сравниваем с обычным. */
const nb = (t: string) => t.replace(/[\u00a0\u202f]/g, ' ');

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

  it('два тура одной компании — список на выбор, порядок правилом, а не длиной названия (экзамен 01.11)', async () => {
    answer([
      row(61, 'a', { title: 'Горелый' }),
      row(62, 'a', { title: 'Горелый с ночёвкой в палатках', nearest_free_date: '2027-08-01' }),
    ]);
    const choice = await resolveTourChoice('Горелый');
    expect(choice.kind).toBe('ambiguous');
    if (choice.kind === 'ambiguous') expect(choice.candidates[0].id).toBe(62);
  });

  it('слово вида отдыха при трёх турах одной компании — список, а не первый тур', async () => {
    answer([
      row(4, 'fish', { title: 'Осенняя рыбалка (октябрь-ноябрь)', activity_type: 'fishing' }),
      row(36, 'fish', { title: 'Зимняя рыбалка: ноябрь — январь', activity_type: 'fishing' }),
      row(37, 'fish', { title: 'Зимняя рыбалка: январь — март', activity_type: 'fishing' }),
    ]);
    const choice = await resolveTourChoice('рыбалка');
    expect(choice.kind).toBe('ambiguous');
    if (choice.kind === 'ambiguous') expect(choice.candidates.map((c) => c.id).sort()).toEqual([36, 37, 4]);
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
    expect(await handleBookingStep(CHAT, '61', 'tg', pending, reply, 'max_bot')).toBe(true);
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

  // Ревью 29.10: тур без цены звучал «от 0 р. с человека», а цена за группу —
  // «с человека» в сообщении сразу после списка, где она была «за группу».
  it('тур без цены — «цену назовёт оператор», а не «от 0 р.»', async () => {
    answer([row(61, 'a', { base_price: null })]);
    const pending = stepTour();
    const reply = vi.fn();
    await handleBookingStep(CHAT, '61', 'tg', pending, reply, 'max_bot');
    const text = String(reply.mock.calls[0][1]);
    expect(text).toContain('Цену назовёт оператор.');
    expect(text).not.toMatch(/\b0 р\.|с человека/);
    expect(pending.get(CHAT)?.tour?.base_price).toBeNull();
    expect(bookingSumLine(pending.get(CHAT)!.tour!, 3)).toBe('Сумма: цену назовёт оператор.');
  });

  it('цена за группу — «за группу» и в списке, и в заявке; сумма не умножается на людей', async () => {
    answer([row(61, 'a', { base_price: 140000, price_unit: 'per_tour' }), row(72, 'b')]);
    const pending = stepTour();
    const reply = vi.fn();
    await handleBookingStep(CHAT, 'хочу на вулкан', 'tg', pending, reply, 'telegram_bot');
    const list = String(reply.mock.calls[0][1]);
    expect(nb(list)).toContain('140 000 ₽ за группу');
    expect(list).not.toContain('не называй');
    await handleBookingStep(CHAT, '61', 'tg', pending, reply, 'max_bot');
    const next = String(reply.mock.calls.at(-1)![1]);
    expect(nb(next)).toContain('Стоимость: <b>140 000 ₽ за группу</b>.');
    expect(next).not.toContain('с человека');
    const sum = bookingSumLine(pending.get(CHAT)!.tour!, 4);
    expect(nb(sum)).toContain('140 000 ₽ за группу');
    expect(sum).toContain('сумму назовёт оператор');
    expect(sum).not.toContain('560');
  });

  it('цена за человека — сумма умножается на число людей', () => {
    expect(nb(bookingSumLine({ id: 1, title: 'Т', base_price: 15000, price_unit: 'per_person', multi_day_count: 1 }, 3)))
      .toBe('Сумма: <b>45 000 р.</b>');
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

// ── Имя продавца и частичное совпадение слов (ловушка MCP 29.10, name-search) ──

describe('сопоставление имени продавца — чистые правила', () => {
  it('одно слово в разных падежах — да; соседнее по началу — нет', () => {
    expect(sameWord('кедровца', 'кедровец')).toBe(true);
    expect(sameWord('кедровцем', 'кедровец')).toBe(true); // беглая гласная
    expect(sameWord('заимкой', 'заимка')).toBe(true);
    expect(sameWord('тихой', 'тихая')).toBe(true);
    expect(sameWord('вулканы', 'вулканов')).toBe(true);
    expect(sameWord('рыбака', 'рыбалка')).toBe(false);
    expect(sameWord('брусника', 'брусничкин')).toBe(false);
    expect(sameWord('сопка', 'сопло')).toBe(false);
    expect(sameWord('лагуна', 'лагутин')).toBe(false);
    expect(sameWord('заимка', 'зимовье')).toBe(false);
  });

  it('фамилия гида в любом падеже — часть имени; имя и фамилия в любом порядке — полное', () => {
    for (const q of ['Кедровец', 'Кедровца', 'у Кедровцем']) {
      expect(matchSellerName(q, 'Савва Кедровец')?.coverage, q).toBe('partial');
    }
    expect(matchSellerName('Кедровец Савва', 'Савва Кедровец')?.coverage).toBe('full');
    expect(matchSellerName('туры у Саввы Кедровца', 'Савва Кедровец')?.coverage).toBe('full');
    expect(matchSellerName('тихой заимки', '«Тихая Заимка»')?.coverage).toBe('full');
    expect(matchSellerName('ООО «Тихая-Заимка»', 'Тихая Заимка')?.coverage).toBe('full');
    expect(matchSellerName('заимка', 'Тихая Заимка')?.coverage).toBe('partial');
  });

  it('нет совпадения, пустое имя и имя из коротких слов — null, а не «подходит»', () => {
    expect(matchSellerName('Горелый', 'Тихая Заимка')).toBeNull();
    expect(matchSellerName('Тихая Заимка', null)).toBeNull();
    expect(matchSellerName('Тихая Заимка', '')).toBeNull();
    expect(matchSellerName('ООО ИП Ли', 'ООО ИП Ли')).toBeNull();
    // Служебное слово запроса имени не покрывает: «туры» — не «Туры Севера».
    expect(matchSellerName('туры', 'Туры Севера')).toBeNull();
  });

  it('ключ отличительности — общее начало слов, не длиннее короткой основы', () => {
    expect(matchSellerName('Кедровцем', 'Савва Кедровец')?.keys).toEqual(['кедров']);
    expect(matchSellerName('тихой заимки', 'Тихая Заимка')?.keys).toEqual(['тих', 'заим']);
  });

  it('остаток запроса — без слов имени, служебных слов и коротких слов по краям', () => {
    const q = 'Ольховый у Кедровца';
    expect(queryRemainder(q, matchSellerName(q, 'Савва Кедровец')!.used)).toBe('Ольховый');
    const bare = 'туры гида Саввы Кедровца';
    expect(queryRemainder(bare, matchSellerName(bare, 'Савва Кедровец')!.used)).toBeNull();
  });
});

// Поддельная база: отвечает на запросы резолвера по их смыслу. ILIKE — как
// «содержит без учёта регистра и разницы «ё»/«е»» (yo в SQL); в каких полях
// ищет запрос по основам и за какое поле держится кандидат — читается из
// самого запроса, чтобы правка SQL не пряталась за подделкой; круг продавцов
// — из параметра запроса.
interface FakeTour {
  id: number;
  title: string;
  operator_id: string | null;
  short_description?: string;
  location_name?: string;
  activity_type?: string;
  nearest_free_date?: string | null;
}
interface FakeSeller { id: string; name: string; category: string; slug: string | null; is_public: boolean }

function fakeDb(tours: FakeTour[], sellers: FakeSeller[]) {
  const norm = (t: string | undefined) => (t ?? '').toLowerCase().replace(/ё/g, 'е');
  const unpattern = (p: unknown) => norm(String(p).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1'));
  const like = (text: string | undefined, pattern: unknown) => norm(text).includes(unpattern(pattern));
  const nameOf = (id: string | null) => sellers.find((x) => x.id === id)?.name ?? null;
  const titleOrPlace = (t: FakeTour) => [t.title, t.location_name];
  const fourFields = (t: FakeTour) => [t.title, t.location_name, t.short_description, t.activity_type];
  const asRow = (t: FakeTour, extra: Row = {}): Row => ({
    id: t.id, title: t.title, operator_id: t.operator_id, operator_name: nameOf(t.operator_id),
    base_price: 15000, price_unit: 'per_person', slug: `t-${t.id}`, multi_day_count: 1, duration_hours: null,
    duration_type: 'single_day', season_start: null, season_end: null, main_place_id: null,
    place_name: null, place_slug: null, place_ark_id: null, nearest_free_date: t.nearest_free_date ?? null, ...extra,
  });
  return async (sql: string, params: unknown[] = []) => {
    const scope = /ot\.operator_id = ANY\(\$(\d+)::uuid\[\]\)/.exec(sql);
    const scoped = scope
      ? ((ids: string[]) => (/NOT \(ot\.operator_id = ANY/.test(sql)
        ? tours.filter((t) => !ids.includes(String(t.operator_id)))
        : tours.filter((t) => ids.includes(String(t.operator_id)))))(params[Number(scope[1]) - 1] as string[])
      : tours;
    if (/FROM partners p/.test(sql) && /seller_name/.test(sql)) {
      return { rows: sellers.filter((x) => tours.some((t) => t.operator_id === x.id)).map((x) => ({
        seller_id: x.id, seller_name: x.name, seller_category: x.category, seller_slug: x.slug, seller_is_public: x.is_public,
      })) };
    }
    if (/unnest\(\$1::uuid\[\]/.test(sql)) {
      const [ids, keys, patterns] = params as [string[], string[], string[]];
      return { rows: ids.map((id, i) => ({
        seller_id: id, key: keys[i],
        elsewhere: tours.some((t) => t.operator_id !== id && fourFields(t).some((f) => like(f, patterns[i]))),
      })) };
    }
    if (/stem_hits/.test(sql)) {
      const patterns = params.filter((p) => typeof p === 'string');
      // Где ищет отметка stem_hits и за что держится кандидат — по тексту запроса.
      const hitsAll = /short_description/.test(sql.slice(0, sql.indexOf('AS stem_hits')).slice(sql.indexOf('ARRAY[')));
      const anchorAll = /short_description/.test(sql.slice(sql.indexOf('AS stem_title_hits')));
      return { rows: scoped.map((t) => ({
        t,
        all: patterns.map((p) => (hitsAll ? fourFields(t) : titleOrPlace(t)).some((f) => like(f, p))),
        four: patterns.map((p) => fourFields(t).some((f) => like(f, p))),
        tl: patterns.map((p) => titleOrPlace(t).some((f) => like(f, p))),
      })).filter((x) => (anchorAll ? x.four : x.tl).some(Boolean))
        .map((x) => asRow(x.t, { stem_hits: x.all, stem_title_hits: x.tl })) };
    }
    if (/AS rank/.test(sql)) {
      const [pattern, q, starts] = params as [string, string, string];
      const typesAt = /activity_type = ANY\(\$(\d+)::text\[\]\)/.exec(sql);
      const types = typesAt ? params[Number(typesAt[1]) - 1] as string[] : [];
      return { rows: scoped.filter((t) => fourFields(t).some((f) => like(f, pattern)) || types.includes(t.activity_type ?? ''))
        .map((t) => asRow(t, { rank: norm(t.title) === norm(q) ? 0
          : norm(t.title).startsWith(unpattern(starts)) ? 1 : like(t.title, pattern) ? 2 : 3 })) };
    }
    if (/ot\.id = \$1/.test(sql)) return { rows: tours.filter((t) => t.id === Number(params[0])).map((t) => asRow(t)) };
    if (scope) return { rows: scoped.map((t) => asRow(t)) };
    return { rows: [] };
  };
}

const GUIDE: FakeSeller = { id: 'g-1', name: 'Савва Кедровец', category: 'guide', slug: 'savva-kedrovets', is_public: true };
const ZAIMKA: FakeSeller = { id: 'c-1', name: 'Тихая Заимка', category: 'operator', slug: 'tikhaya-zaimka', is_public: true };
const NORTH: FakeSeller = { id: 'c-2', name: 'Северная Рыбалка', category: 'operator', slug: null, is_public: false };
const DRAFTY: FakeSeller = { id: 'c-3', name: 'Глухой Распадок', category: 'operator', slug: 'gluhoy', is_public: true };
const TOURS: FakeTour[] = [
  { id: 101, title: 'Перевал Ольховый', operator_id: 'g-1', location_name: 'Ольховый' },
  { id: 102, title: 'Озеро Хрустальное', operator_id: 'g-1', nearest_free_date: '2027-07-01' },
  { id: 201, title: 'Бухта Тюленья', operator_id: 'c-1' },
  { id: 202, title: 'Рыбалка на северной протоке', operator_id: 'c-1' },
  { id: 301, title: 'Сплав с ночёвкой', operator_id: 'c-2' },
];
const SELLERS = [GUIDE, ZAIMKA, NORTH, DRAFTY];

const sortedIds = (ts: ReadonlyArray<{ id: number }>) => ts.map((t) => t.id).sort((a, b) => a - b);

describe('резолвер: продавец по имени и частичное совпадение слов', () => {
  beforeEach(() => { query.mockImplementation(fakeDb(TOURS, SELLERS)); });

  it('фамилия гида в родительном падеже — его туры по правилу 1в и страница, а не «тура нет»', async () => {
    const choice = await resolveTourChoice('Кедровца');
    expect(choice.kind).toBe('seller');
    if (choice.kind !== 'seller') return;
    expect(choice.basis).toBe('own');
    expect(choice.sellers.map((x) => x.name)).toEqual(['Савва Кедровец']);
    expect(choice.tours.map((t) => t.id)).toEqual([102, 101]); // свободная дата — первым (1в)
    expect(choice.partialName).toBe(true);
    expect(choice.others).toBeNull();
    expect(choice.rest).toBeNull();
    expect(await resolveTourByQuery('Кедровца')).toBeNull();
  });

  it('продавец и слово ЧУЖОГО тура — не тур другой компании: «по словам не нашлось» и все его туры', async () => {
    const choice = await resolveTourChoice('Тихая Заимка Ольховый');
    expect(choice.kind).toBe('seller');
    if (choice.kind !== 'seller') return;
    expect(choice.rest).toEqual({ text: 'Ольховый', found: false });
    expect(choice.tours.map((t) => t.operator_id)).toEqual(['c-1', 'c-1']);
    expect(choice.others).toBeNull();
  });

  it('полное имя и слово его тура — этот тур; часть имени — его тур списком, не заявкой', async () => {
    const full = await resolveTourChoice('Ольховый у Саввы Кедровца');
    expect(full.kind === 'one' && full.tour.id).toBe(101);
    // Только фамилия: запрос может быть и не о гиде — исхода «один тур» нет.
    const part = await resolveTourChoice('Ольховый у Кедровца');
    expect(part.kind).toBe('seller');
    if (part.kind !== 'seller') return;
    expect(part.partialName).toBe(true);
    expect(part.tours.map((t) => t.id)).toEqual([101]);
    expect(part.rest).toEqual({ text: 'Ольховый', found: true });
    expect(part.others?.tours).toEqual([]);
  });

  it('имя из одних общих слов — продавец не поднят: туры всех компаний по словам, его — только где слова есть (§0)', async () => {
    const choice = await resolveTourChoice('Северная Рыбалка');
    expect(choice.kind).toBe('seller');
    if (choice.kind !== 'seller') return;
    expect(choice.basis).toBe('words');
    expect(choice.sellers.map((x) => x.name)).toEqual(['Северная Рыбалка']);
    // Тур другой компании, где слова есть, — в списке; тур продавца без этих
    // слов («Сплав с ночёвкой») — нет: имя его не поднимает.
    expect(choice.tours.map((t) => t.id)).toEqual([202]);
    const text = await getTourDetails('Северная Рыбалка');
    expect(text).toContain('ID202');
    expect(text).not.toContain('ID301');
    expect(text).not.toContain('Это имя продавца');
    expect(text).toContain('Своей страницы на Ведаре у компании «Северная Рыбалка» нет.');
  });

  it('имя из общих слов и ещё слово — продавца в ответе нет, тур другой компании не спрятан и не выбран (§0)', async () => {
    // До ревью 29.10 остаток «сплав» сужал до тура продавца — заявка ушла бы ему.
    const choice = await resolveTourChoice('Северная Рыбалка сплав');
    expect(choice.kind).toBe('weak');
    if (choice.kind !== 'weak') return;
    expect(choice.candidates.map((t) => t.id)).toEqual([202]);
    expect(choice.matched).toEqual(['Северная', 'Рыбалка']);
    expect(choice.apart).toEqual(['сплав']);
    expect(await resolveTourByQuery('Северная Рыбалка сплав')).toBeNull();
  });

  it('одно общее слово из имени — не продавец: «северной» ищется как обычно', async () => {
    const choice = await resolveTourChoice('северной');
    expect(choice.kind).not.toBe('seller');
    expect(choice.kind === 'one' && choice.tour.id).toBe(202);
    // Нет и фразы в названиях — «тура нет», а не туры продавца с общим именем.
    expect((await resolveTourChoice('северная')).kind).toBe('none');
  });

  it('фраза в названии чужого тура и общее имя продавца — ответ по названию, продавец не поднимается', async () => {
    const choice = await resolveTourChoice('северной протоке');
    expect(choice.kind === 'one' && choice.tour.id).toBe(202);
  });

  it('имя из общих слов стоит фразой в названии ЧУЖОГО тура — ответ по названию: имя продавца не поднимает его (§0)', async () => {
    // Иначе продавец с именем «Рыбалка» звучал бы в ответе на каждую «рыбалку».
    query.mockImplementation(fakeDb([
      { id: 301, title: 'Сплав с ночёвкой', operator_id: 'c-2' },
      { id: 401, title: 'Северная рыбалка у устья', operator_id: 'c-1' },
    ], SELLERS));
    const choice = await resolveTourChoice('Северная Рыбалка');
    expect(choice.kind === 'one' && choice.tour.id).toBe(401);
  });

  it('отличительное имя стоит в скобках СВОЕГО тура — его список, а не этот тур (ревью 29.10)', async () => {
    query.mockImplementation(fakeDb([
      { id: 501, title: 'Бухта Тюленья (Тихая Заимка)', operator_id: 'c-1' },
      { id: 502, title: 'Мыс Скалистый', operator_id: 'c-1' },
      { id: 101, title: 'Перевал Ольховый', operator_id: 'g-1' },
    ], SELLERS));
    const choice = await resolveTourChoice('Тихая Заимка');
    expect(choice.kind).toBe('seller');
    if (choice.kind !== 'seller') return;
    expect(choice.basis).toBe('own');
    expect(sortedIds(choice.tours)).toEqual([501, 502]);
  });

  it('точное название тура — без поиска продавца', async () => {
    const choice = await resolveTourChoice('Бухта Тюленья');
    expect(choice.kind === 'one' && choice.tour.id).toBe(201);
    expect(query.mock.calls.some(([sql]) => /FROM partners p/.test(String(sql)))).toBe(false);
  });

  it('продавец только с черновиками — не продавец', async () => {
    expect((await resolveTourChoice('Глухой Распадок')).kind).toBe('none');
  });

  it('отличительность не проверилась — слово отличительным не считается (§4.0)', async () => {
    const real = fakeDb(TOURS, SELLERS);
    query.mockImplementation(async (sql: string, params?: unknown[]) => (/unnest\(\$1::uuid\[\]/.test(sql) ? { rows: [] } : real(sql, params)));
    // «Тихая Заимка» без ответа об отличительности — как имя из общих слов:
    // продавец назван, но не поднят; не «тура нет» и не сужение до его туров.
    const choice = await resolveTourChoice('Тихая Заимка');
    expect(choice.kind).toBe('seller');
    if (choice.kind === 'seller') expect(choice.basis).toBe('words');
    // Часть имени без ответа — не продавец.
    expect((await resolveTourChoice('Заимка')).kind).toBe('none');
  });

  it('совпала только часть основ у туров ОДНОЙ компании — «weak», а не «one»', async () => {
    const choice = await resolveTourChoice('Ольховый Несуществующий');
    expect(choice.kind).toBe('weak');
    if (choice.kind !== 'weak') return;
    expect(choice.candidates.map((t) => t.id)).toEqual([101]);
    expect(choice.matched).toEqual(['Ольховый']);
    expect(choice.missing).toEqual(['Несуществующий']);
    expect(choice.apart).toEqual([]);
    expect(await resolveTourByQuery('Ольховый Несуществующий')).toBeNull();
  });

  it('все основы у одного тура — по-прежнему тур; служебное «туры» покрытия не требует', async () => {
    expect(await resolveTourChoice('Ольховый перевал').then((c) => c.kind === 'one' && c.tour.id)).toBe(101);
    expect(await resolveTourChoice('туры Ольховый').then((c) => c.kind === 'one' && c.tour.id)).toBe(101);
  });

  it('get_tour_details и get_tour_availability на имя продавца — список и страница, без «ТУР:» и без дат', async () => {
    const details = await getTourDetails('Тихая Заимка');
    const dates = await getTourAvailabilityForKuzmich({ tour: 'Тихая Заимка' });
    for (const text of [details, dates]) {
      expect(text).toContain('компания «Тихая Заимка»');
      expect(text).toContain('ID201');
      expect(text).toContain('ID202');
      expect(text).toContain('https://vedarai.ru/operators/tikhaya-zaimka');
      expect(text).not.toContain('ТУР:');
      expect(text).not.toContain('Тур на платформе не найден');
      expect(text).not.toMatch(/свободно \d|реальная занятость/);
      expect(text).not.toContain('get_tours(activity_type');
    }
    const guide = await getTourDetails('Кедровец');
    expect(guide).toContain('гид «Савва Кедровец»');
  });

  it('get_tour_details и get_tour_availability на частичное совпадение — какие слова совпали и какие нет, без деталей и дат тура', async () => {
    const details = await getTourDetails('Ольховый Несуществующий');
    const dates = await getTourAvailabilityForKuzmich({ tour: 'Ольховый Несуществующий' });
    for (const text of [details, dates]) {
      expect(text).toContain('совпали только слова «Ольховый»; «Несуществующий» — нет ни в одном из туров, найденных по другим словам');
      expect(text).toContain('ID101');
      expect(text).not.toContain('ТУР:');
      expect(text).not.toMatch(/свободно для заявки|свободно \d|create_booking_request с датой/);
    }
  });

  it('начало брони на имя продавца — его список и шаг «тур», брони нет', async () => {
    // Слов вида отдыха нет — резолвер получает начало сообщения как есть.
    const pending = new Map<number, PendingBooking>();
    const reply = vi.fn();
    const history = [{ role: 'user' as const, content: 'туры Тихой Заимки' }];
    expect(await startBooking(4243, 'бронирую', 'tg', history, pending, reply)).toBe(true);
    const text = String(reply.mock.calls[0][1]);
    expect(text).toContain('<b>Тихая Заимка</b> — продавец, а не тур');
    expect(text).toContain('<b>201</b>');
    expect(text).toContain('<b>202</b>');
    expect(pending.get(4243)?.step).toBe('tour');
    expect(pending.get(4243)?.tour).toBeUndefined();
  });

  it('шаг «тур» в мессенджере: совпала часть слов — список, тур не выбран', async () => {
    // «рыбалка» и «вулкан» — слова словаря; тура с обоими нет, есть с одним.
    const pending = new Map<number, PendingBooking>([[4245, { step: 'tour', started_at: Date.now() }]]);
    const reply = vi.fn();
    expect(await handleBookingStep(4245, 'рыбалка и вулкан', 'tg', pending, reply, 'telegram_bot')).toBe(true);
    expect(String(reply.mock.calls[0][1])).toContain('совпала только часть');
    expect(String(reply.mock.calls[0][1])).toContain('<b>202</b>');
    expect(pending.get(4245)?.step).toBe('tour');
    expect(pending.get(4245)?.tour).toBeUndefined();
  });

  it('начало брони на частичном совпадении — список, а не первый тур', async () => {
    const pending = new Map<number, PendingBooking>();
    const reply = vi.fn();
    const history = [{ role: 'user' as const, content: 'Ольховый Несуществующий' }];
    expect(await startBooking(4244, 'бронирую', 'tg', history, pending, reply)).toBe(true);
    expect(String(reply.mock.calls[0][1])).toContain('совпала только часть');
    expect(pending.get(4244)?.step).toBe('tour');
    expect(pending.get(4244)?.tour).toBeUndefined();
  });

  // Ревью 29.10: имя компании со словом вида отдыха («Рыбалка») мессенджер
  // превращал в ключ «рыбалка», и бронь начиналась на туре ДРУГОЙ компании.
  it('мессенджер: имя компании со словом вида отдыха — сначала продавец, а не ключ «рыбалка»', async () => {
    const pending = new Map<number, PendingBooking>();
    const reply = vi.fn();
    const history = [{ role: 'user' as const, content: 'Северная Рыбалка' }];
    expect(await startBooking(4246, 'бронирую', 'tg', history, pending, reply)).toBe(true);
    const text = String(reply.mock.calls[0][1]);
    expect(text).toContain('<b>Северная Рыбалка</b> — так называется и продавец');
    expect(text).toContain('<b>202</b>');
    expect(pending.get(4246)?.step).toBe('tour');
    expect(pending.get(4246)?.tour).toBeUndefined();

    // Шаг «тур» — то же: список, тур не выбран.
    const step = new Map<number, PendingBooking>([[4247, { step: 'tour', started_at: Date.now() }]]);
    const reply2 = vi.fn();
    expect(await handleBookingStep(4247, 'Северная Рыбалка', 'tg', step, reply2, 'telegram_bot')).toBe(true);
    expect(String(reply2.mock.calls[0][1])).toContain('<b>202</b>');
    expect(step.get(4247)?.step).toBe('tour');
    expect(step.get(4247)?.tour).toBeUndefined();

    // Отличительное имя и вид отдыха с одним его туром — этот тур, его компании.
    const own = new Map<number, PendingBooking>();
    const reply3 = vi.fn();
    expect(await startBooking(4248, 'бронирую', 'tg', [{ role: 'user', content: 'Тихая Заимка рыбалка' }], own, reply3)).toBe(true);
    expect(own.get(4248)?.step).toBe('name');
    expect(own.get(4248)?.tour?.id).toBe(202);
  });
});

// ── Ревью 29.10: остаток запроса, слова в описании, «ё», вид отдыха ─────────

const EFIM: FakeSeller = { id: 'g-2', name: 'Ефим Брусников', category: 'guide', slug: 'efim-brusnikov', is_public: true };
const REVIEW_TOURS: FakeTour[] = [
  { id: 701, title: 'Вулкан Пологий', operator_id: 'g-2', short_description: 'выход к подножию Мутного ключа', nearest_free_date: '2027-07-02' },
  { id: 702, title: 'Вулкан Синий', operator_id: 'g-2' },
  { id: 703, title: 'Облёт кальдеры', operator_id: 'g-2', activity_type: 'helicopter' },
  { id: 711, title: 'Пологий: облёт с воды', operator_id: 'c-1' },
  { id: 712, title: 'Хрустальное озеро', operator_id: 'c-1', short_description: 'нерка и медведи у истока' },
  { id: 713, title: 'Сопка Толстая', operator_id: 'c-1' },
];

describe('ревью 29.10: остаток внутри продавца и слова тура', () => {
  beforeEach(() => { query.mockImplementation(fakeDb(REVIEW_TOURS, [EFIM, ZAIMKA])); });

  it('полное имя и слово двух его туров — список внутри продавца, а не первый по 1в', async () => {
    const choice = await resolveTourChoice('Ефим Брусников вулкан');
    expect(choice.kind).toBe('seller');
    if (choice.kind !== 'seller') return;
    expect(choice.rest).toEqual({ text: 'вулкан', found: true });
    expect(sortedIds(choice.tours)).toEqual([701, 702]);
    expect(await resolveTourByQuery('Ефим Брусников вулкан')).toBeNull();
    const text = await getTourDetails('Ефим Брусников вулкан');
    expect(text).toContain('ID701');
    expect(text).toContain('ID702');
    expect(text).not.toContain('ТУР:');
    // Ровно один его тур по слову — этот тур.
    const one = await resolveTourChoice('Ефим Брусников Синий');
    expect(one.kind === 'one' && one.tour.id).toBe(702);
  });

  it('часть имени и слово, которое есть и у других компаний, — оба списка, тура не выбрано', async () => {
    const choice = await resolveTourChoice('Пологий с Ефимом');
    expect(choice.kind).toBe('seller');
    if (choice.kind !== 'seller') return;
    expect(choice.partialName).toBe(true);
    expect(choice.tours.map((t) => t.id)).toEqual([701]);
    expect(choice.others?.tours.map((t) => t.id)).toEqual([711]);
    const text = await getTourDetails('Пологий с Ефимом');
    expect(text).toContain('совпала часть имени продавца');
    expect(text).toContain('ID701');
    expect(text).toContain('ID711');
  });

  it('вид отдыха словами («вертолёт») находит тур этого вида у продавца', async () => {
    const choice = await resolveTourChoice('Ефим Брусников вертолёт');
    expect(choice.kind === 'one' && choice.tour.id).toBe(703);
  });

  it('слово остатка в другом падеже в описании его тура — находится, а не «нет»', async () => {
    const choice = await resolveTourChoice('Ефим Брусников Мутный');
    expect(choice.kind === 'one' && choice.tour.id).toBe(701);
  });

  it('остаток не нашёлся — «по словам не нашлось, проверь список», а не «у продавца такого тура нет»', async () => {
    const text = await getTourDetails('Ефим Брусников рафтинг');
    expect(text).toContain('По словам «рафтинг» среди туров продавца совпадений не нашлось');
    expect(text).toContain('а не ответ «такого тура нет»');
    expect(text).not.toMatch(/у продавца нет|Тура «рафтинг» у/);
    for (const id of [701, 702, 703]) expect(text).toContain(`ID${id}`);
  });

  it('слово из описания тура — совпавшее: все слова у одного тура дают тур, а не «weak»', async () => {
    const choice = await resolveTourChoice('Хрустальное озеро медведи');
    expect(choice.kind === 'one' && choice.tour.id).toBe(712);
  });

  it('слово, которое есть только в других турах, — не «не найдено»', async () => {
    const choice = await resolveTourChoice('Хрустальное озеро Толстая');
    expect(choice.kind).toBe('weak');
    if (choice.kind !== 'weak') return;
    expect(choice.candidates.map((t) => t.id)).toEqual([712]);
    expect(choice.matched).toEqual(['Хрустальное', 'озеро']);
    expect(choice.apart).toEqual(['Толстая']);
    expect(choice.missing).toEqual([]);
    const text = await getTourDetails('Хрустальное озеро Толстая');
    expect(text).toContain('«Толстая» — есть в других турах, без этих слов');
    expect(text).not.toMatch(/«Толстая» — нет ни в одном/);
  });

  it('мессенджер: часть имени и слово — два списка, у каждого свой предел; туры других компаний не срезаны', async () => {
    // У гида девять туров по слову — склейка под один срез в восемь
    // строк спрятала бы тур другой компании целиком.
    query.mockImplementation(fakeDb([
      ...Array.from({ length: 9 }, (_, i) => ({ id: 801 + i, title: `Вулкан номер ${i + 1}`, operator_id: 'g-2' })),
      { id: 901, title: 'Вулкан Дальний', operator_id: 'c-1' },
    ], [EFIM, ZAIMKA]));
    const pending = new Map<number, PendingBooking>();
    const reply = vi.fn();
    expect(await startBooking(4249, 'бронирую', 'tg', [{ role: 'user', content: 'вулкан с Ефимом' }], pending, reply)).toBe(true);
    const text = String(reply.mock.calls[0][1]);
    expect(text).toContain('совпала часть имени продавца');
    expect(text).toContain('Туры других компаний по словам «вулкан»');
    expect(text).toContain('<b>901</b>');
    expect(pending.get(4249)?.step).toBe('tour');
    expect(pending.get(4249)?.tour).toBeUndefined();
  });
});

// Ревью 29.10 (filter-coverage): get_tours имён продавцов не ищет и сам
// отсылает к get_tour_details — подсказка «и ещё N — get_tours» в ответе о
// продавце вела по кругу.
describe('ответ о продавце: остальные туры — не по кругу через get_tours', () => {
  const BIG_PAGE: FakeSeller = { id: 'c-8', name: 'Бурундучья Сопка', category: 'operator', slug: 'burunduchya-sopka', is_public: true };
  const BIG_NO_PAGE: FakeSeller = { id: 'c-9', name: 'Медвежий Угол', category: 'operator', slug: null, is_public: false };
  const many = (seller: FakeSeller, from: number): FakeTour[] => Array.from({ length: 12 }, (_, i) => (
    { id: from + i, title: `Маршрут номер ${from + i}`, operator_id: seller.id }
  ));

  it('страница есть — первые десять и «остальные на странице продавца»', async () => {
    query.mockImplementation(fakeDb(many(BIG_PAGE, 800), [BIG_PAGE]));
    const text = await getTourDetails('Бурундучья Сопка');
    expect(text).toContain('https://vedarai.ru/operators/burunduchya-sopka');
    expect(text).toContain('- и ещё 2 — все на странице продавца');
    expect(text).not.toMatch(/— get_tours/);
  });

  it('страницы нет — список целиком, без отсылки к get_tours', async () => {
    query.mockImplementation(fakeDb(many(BIG_NO_PAGE, 900), [BIG_NO_PAGE]));
    const text = await getTourDetails('Медвежий Угол');
    expect(text).toContain('Своей страницы на Ведаре у продавца нет.');
    for (let id = 900; id < 912; id++) expect(text).toContain(`ID${id} `);
    expect(text).not.toMatch(/и ещё \d+|— get_tours/);
  });
});
