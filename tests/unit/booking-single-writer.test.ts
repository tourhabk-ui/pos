/**
 * tests/unit/booking-single-writer.test.ts
 *
 * Бронь заводится ОДНИМ кодом — `lib/bookings/reserve.ts`.
 *
 * Копий было две, и они разошлись по трём признакам: Кузьмич не читал
 * календарь оператора (бронь принималась на закрытую им дату), ставил статус
 * `pending_payment` и не писал `user_id`. Последнее и есть потерянная бронь:
 * `loadUserSituation` ищет по `user_id` и по статусам `('new','confirmed')` —
 * бронь из чата не проходила ни по одному условию, и тот же Кузьмич через
 * минуту отвечал туристу, что броней у него нет. Кабинет оператора считает
 * новые заявки по `booking_status = 'new'` — там она тоже не показывалась.
 *
 * Сторож держит закрытие: один писатель, один статус, и этот статус знают оба
 * читателя — «ситуация туриста» и календарь оператора.
 *
 * ── Перепись писателей по коду (аудит 15.10, P2-01) ─────────────────────────
 *
 * До 15.10 сторож читал ровно четыре файла по имени и был зелёным, пока
 * строку `operator_bookings` писали ещё четыре: ручная бронь оператора, OCTO,
 * `/api/tours/[id]/book` и `bookingService.create`. Правило многодневности
 * 14.09 до трёх живых из них не дошло. Теперь писатели находятся обходом
 * `app/` и `lib/`: файл со вставкой в `operator_bookings` обязан стоять в
 * `WRITERS` с причиной, файл, зовущий общую вставку мимо `reserveBooking`
 * (то есть мимо гейта), — в `ROW_DOORS` с тем, где у него гейт. Оба списка
 * самоустаревающие. Поведение этих дверей — вызовом:
 * `tests/unit/booking-doors-one-writer.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const RESERVE  = read('lib/bookings/reserve.ts');
const CORE     = read('lib/kuzmich/core.ts');
const CREATE   = read('app/api/hub/bookings/create/route.ts');
const CALENDAR = read('app/api/hub/operator/bookings-calendar/route.ts');

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQueryMock(...args) }),
}));

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { createBooking } from '@/lib/kuzmich/core';
import { NEW_BOOKING_STATUS, BOOKING_ROW_COLUMNS, insertBookingRow, reserveBooking } from '@/lib/bookings/reserve';

const TOUR = { id: 7, title: 'Вулкан Горелый', base_price: 9000, multi_day_count: null };

const PENDING = {
  tour: TOUR,
  name: 'Иван Иванов',
  phone: '+79991234567',
  participants: 2,
  date: '2099-07-01',
};

/** Вызов INSERT в operator_bookings: сам SQL и его параметры. */
function insertCall(): [string, unknown[]] {
  const call = clientQueryMock.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO operator_bookings'));
  expect(call, 'INSERT в operator_bookings не вызван').toBeTruthy();
  return call as [string, unknown[]];
}

/** Значение колонки по ИМЕНИ, а не по месту в массиве параметров. */
function inserted(column: string): unknown {
  const [sql, params] = insertCall();
  const columns = /INSERT INTO operator_bookings\s*\(([^)]*)\)/i.exec(sql)?.[1];
  const values  = /VALUES\s*\(([^)]*)\)/i.exec(sql)?.[1];
  expect(columns, 'не разобран список колонок INSERT').toBeTruthy();
  expect(values, 'не разобран список значений INSERT').toBeTruthy();

  const names = columns!.split(',').map(s => s.trim());
  const slots = values!.split(',').map(s => s.trim());
  expect(names.length, 'колонок и значений разное число').toBe(slots.length);

  const at = names.indexOf(column);
  expect(at, `колонки ${column} нет в INSERT`).toBeGreaterThanOrEqual(0);
  const n = Number(/^\$(\d+)/.exec(slots[at]!)?.[1]);
  expect(Number.isFinite(n), `значение ${column} — не параметр: ${slots[at]}`).toBe(true);
  return params[n - 1];
}

/**
 * `calendar` остался тем же аргументом с тем же смыслом — строка календаря
 * оператора на дату, — но с 14.09 календарь и занятость приходят ОДНИМ
 * запросом по дням диапазона: раньше их было два, и счёт занятости искал
 * брони равенством дат, не видя многодневных.
 */
function mockDb(opts: { calendar?: Array<{ available_slots: number; is_cancelled: boolean }>; user?: unknown[] } = {}) {
  const slot = opts.calendar?.[0] ?? null;
  clientQueryMock.mockImplementation((sql: string) => {
    const s = String(sql);
    if (s.includes('FROM operator_tours'))    return Promise.resolve({ rows: [{ operator_id: 'op-1', title: TOUR.title, base_price: '9000', max_participants: 10, multi_day_count: null, duration_hours: 6 }] });
    if (s.includes('generate_series'))        return Promise.resolve({ rows: [{
      date: PENDING.date,
      occupied: '0',
      available_slots: slot ? slot.available_slots : null,
      is_cancelled: slot ? slot.is_cancelled : null,
    }] });
    if (s.includes('INSERT INTO operator_bookings'))
      return Promise.resolve({ rows: [{ id: 101, access_token: '11111111-2222-3333-4444-555555555555' }] });
    // Цена брони считается правилами `tour_pricing_rules` (27.09,
    // lib/tours/honest-price): бронь читает их и занятость даты клиентом ТОЙ
    // ЖЕ транзакции. Правил нет и слота нет — цена остаётся ценой оператора,
    // то есть прежнее поведение этих проверок.
    if (s.includes('FROM tour_pricing_rules')) return Promise.resolve({ rows: [] });
    // Ступени цены по размеру группы (миграция 1173): у тестового тура их нет.
    if (s.includes('FROM tour_price_tiers')) return Promise.resolve({ rows: [] });
    if (s.includes('v_tour_daily_occupancy')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + s);
  });
  poolQueryMock.mockImplementation((sql: string) => {
    if (String(sql).includes('FROM users WHERE telegram_id')) {
      return Promise.resolve({ rows: opts.user ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb();
});

describe('писатель брони один на обе поверхности', () => {
  it('свою вставку в operator_bookings не делает ни веб-роут, ни Кузьмич', () => {
    for (const [name, src] of [['веб-роут', CREATE], ['Кузьмич', CORE]] as const) {
      expect(src, `${name}: своя копия вставки неизбежно разойдётся с общей`)
        .not.toMatch(/INSERT\s+INTO\s+operator_bookings/i);
      expect(src, `${name}: бронь заводится через общий модуль`).toMatch(/reserveBooking\(/);
    }
  });

  it('лок, календарь и счёт занятости стоят в общем модуле, а не в одной из копий', () => {
    // Приметы обновлены 14.09 вместе с самим гейтом: календарь и занятость
    // теперь приходят ОДНИМ запросом по дням диапазона, поэтому прежних
    // `already_booked` и `FROM tour_availability` в модуле больше нет. Смысл
    // проверки прежний — всё три вещи живут здесь, а не в копии.
    expect(RESERVE, 'лок строки тура').toMatch(/FOR UPDATE/);
    expect(RESERVE, 'календарь оператора').toMatch(/tour_availability/);
    expect(RESERVE, 'счёт занятости по дням').toMatch(/generate_series/);
  });
});

describe('бронь из чата видна там, где её ищут', () => {
  it('статус — тот же, что у веб-брони, и это не pending_payment', async () => {
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    expect(NEW_BOOKING_STATUS).toBe('new');
    expect(inserted('booking_status')).toBe(NEW_BOOKING_STATUS);
  });

  it('«ситуация туриста» принимает этот статус — иначе бронь снова невидима', () => {
    const situation = /booking_status IN \(([^)]*)\)/.exec(CORE)?.[1] ?? '';
    expect(situation, 'не найден список статусов в loadUserSituation').not.toBe('');
    expect(situation).toContain(`'${NEW_BOOKING_STATUS}'`);
  });

  it('календарь оператора считает этот статус новой заявкой', () => {
    expect(CALENDAR).toContain(`booking_status === '${NEW_BOOKING_STATUS}'`);
  });

  it('аккаунт по чату Telegram проставляется в user_id', async () => {
    mockDb({ user: [{ id: 'user-42' }] });
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    expect(inserted('user_id')).toBe('user-42');
  });

  it('аккаунта нет — null, а не выдуманная связь; метка канала остаётся', async () => {
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    expect(inserted('user_id')).toBeNull();
    expect(JSON.parse(String(inserted('metadata')))).toMatchObject({ tg_chat_id: 555, platform: 'tg' });
  });

  it('у MAX сопоставления по chat_id нет — аккаунт не угадывается', async () => {
    mockDb({ user: [{ id: 'user-42' }] });
    await createBooking(PENDING as never, 'kuzmich_max', 555, 'max');
    expect(inserted('user_id')).toBeNull();
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('FROM users WHERE telegram_id')))
      .toBe(false);
  });

  it('бронь из чата находится и по метке канала — у старых записей user_id пуст', () => {
    expect(CORE).toMatch(/metadata->>'tg_chat_id'/);
  });
});

describe('согласие на ПД — в той же вставке, что бронь', () => {
  it('reserveBooking пишет четыре колонки согласия одной вставкой, без второго запроса', async () => {
    // Отдельный UPDATE после INSERT — окно, в котором бронь есть, а записи
    // согласия нет (класс дедупа алертов 13.09).
    const at = new Date('2026-10-15T08:00:00Z');
    await reserveBooking({
      tourId: TOUR.id, touristName: 'Иван', touristPhone: '+79991234567', participants: 1,
      date: PENDING.date, createdVia: 'website',
      pdConsent: { at, ip: '203.0.113.7', source: 'web-form', version: 'v1' },
    });
    expect(inserted('pd_consent_at')).toBe(at);
    expect(inserted('pd_consent_ip')).toBe('203.0.113.7');
    expect(inserted('pd_consent_source')).toBe('web-form');
    expect(inserted('pd_consent_version')).toBe('v1');
    expect(clientQueryMock.mock.calls.some(([sql]) => /UPDATE operator_bookings/.test(String(sql)))).toBe(false);
  });
});

describe('календарь оператора уважается обоими путями', () => {
  it('дата закрыта оператором → бронь из чата не заводится', async () => {
    mockDb({ calendar: [{ available_slots: 10, is_cancelled: true }] });
    await expect(createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg')).rejects.toThrow(/закрыл приём заявок/);
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO operator_bookings'))).toBe(false);
  });
});

/* ─── Перепись писателей operator_bookings — по коду, не по именам ────────── */

/**
 * Файлы, которым разрешено писать `INSERT INTO operator_bookings`. Каждый с
 * причиной. Новая вставка мимо `insertBookingRow` — красный тест: правило,
 * которое ляжет в общую вставку завтра (как многодневность 14.09), до неё не
 * дойдёт.
 */
const WRITERS: Readonly<Record<string, string>> = {
  'lib/bookings/reserve.ts':
    'единственная вставка строки брони — insertBookingRow; её зовут reserveBooking и двери из ROW_DOORS',
  'app/api/cron/payment-test-setup/route.ts':
    'служебная бронь пробы оплаты на CURRENT_DATE у скрытого тура без туриста; форма INSERT ... SELECT WHERE NOT EXISTS стоит в реестре sql-shape-check, проверяемом PREPARE на проде',
  'app/api/cron/sql-shape-check/route.ts':
    'только PREPARE: текст запроса из реестра, вывод типов на разборе, ни одна строка не вставляется',
};

/**
 * Двери, которые зовут общую вставку МИМО reserveBooking — то есть мимо его
 * гейта. Каждая обязана назвать, где у неё гейт или почему его нет.
 */
const ROW_DOORS: Readonly<Record<string, string>> = {
  'lib/octo/service.ts':
    'холд реселлера: гейт общий (readTourDays + assertDaysOpen под FOR UPDATE тура), цена опции и холд — внешний контракт OCTO',
  'app/api/hub/operator/bookings/route.ts':
    'ручная бронь оператора: гейта нет намеренно — оператор записывает договорённость, которая уже состоялась',
};

const INSERT_RE = /INSERT\s+INTO\s+(?:public\.)?operator_bookings\b/gi;

/**
 * Код без комментариев, начинающихся с начала строки: шапки и JSDoc могут
 * называть вставку по имени, исполняется — код. Хвостовой комментарий после
 * кода не снимается — строже, а не мягче.
 */
function codeOf(src: string): string {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]
  .map((abs) => ({ rel: relative(ROOT, abs), code: codeOf(readFileSync(abs, 'utf-8')) }));

describe('писатели operator_bookings находятся по коду', () => {
  const writers = SOURCES.filter((f) => f.code.match(INSERT_RE));
  const rowDoors = SOURCES.filter((f) => f.rel !== 'lib/bookings/reserve.ts' && /\binsertBookingRow\(/.test(f.code));

  it('перепись не пуста (ноль — сломан обход, а не чистый код)', () => {
    expect(writers.map((f) => f.rel)).toContain('lib/bookings/reserve.ts');
    expect(rowDoors.length).toBeGreaterThan(0);
  });

  it('прямой вставки мимо insertBookingRow нет ни в одном файле вне реестра', () => {
    const outside = writers.map((f) => f.rel).filter((rel) => !(rel in WRITERS));
    expect(outside, 'своя вставка в operator_bookings — вести через insertBookingRow (lib/bookings/reserve.ts)').toEqual([]);
  });

  it('дверь, зовущая общую вставку мимо reserveBooking, названа и объяснена', () => {
    const outside = rowDoors.map((f) => f.rel).filter((rel) => !(rel in ROW_DOORS));
    expect(outside, 'новая дверь мимо гейта reserveBooking — запись в ROW_DOORS: где у неё гейт или почему его нет').toEqual([]);
  });

  it('оба реестра самоустаревают: запись только у живого писателя, причина названа', () => {
    for (const [rel, reason] of Object.entries(WRITERS)) {
      expect(writers.some((f) => f.rel === rel), `${rel} больше не вставляет в operator_bookings — убрать из WRITERS`).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(40);
    }
    for (const [rel, reason] of Object.entries(ROW_DOORS)) {
      expect(rowDoors.some((f) => f.rel === rel), `${rel} больше не зовёт insertBookingRow — убрать из ROW_DOORS`).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(40);
    }
  });

  it('в reserve.ts вставка одна, и это тело insertBookingRow', () => {
    const reserve = SOURCES.find((f) => f.rel === 'lib/bookings/reserve.ts')!.code;
    const hits = [...reserve.matchAll(INSERT_RE)].map((m) => m.index ?? -1);
    expect(hits, 'вторая вставка в общем модуле — снова две копии').toHaveLength(1);
    const from = reserve.indexOf('export async function insertBookingRow(');
    const to = reserve.indexOf('\nexport ', from + 1);
    expect(from).toBeGreaterThan(0);
    expect(hits[0]).toBeGreaterThan(from);
    expect(hits[0]).toBeLessThan(to);
  });
});

describe('общая вставка: колонки — те, что есть в базе', () => {
  it('каждая колонка BOOKING_ROW_COLUMNS есть у operator_bookings в снимке схемы с настоящей базы', () => {
    const doc = readFileSync(join(ROOT, 'docs/DB_SCHEMA.md'), 'utf-8').split('\n');
    const at = doc.findIndex((l) => l.startsWith('**operator_bookings**'));
    expect(at, 'в DB_SCHEMA.md нет таблицы operator_bookings').toBeGreaterThan(0);
    const line = doc.slice(at + 1).find((l) => l.startsWith('`')) ?? '';
    const real = new Set([...line.matchAll(/`([a-z_0-9]+) /g)].map((m) => m[1]));
    expect(real.size).toBeGreaterThan(40);
    expect(BOOKING_ROW_COLUMNS.filter((c) => !real.has(c))).toEqual([]);
  });
});

describe('общая вставка: длительность выводит она сама', () => {
  function fakeExec() {
    const calls: Array<[string, unknown[]]> = [];
    return {
      calls,
      exec: {
        query: (sql: string, params: unknown[]) => {
          calls.push([sql, params]);
          return Promise.resolve({ rows: [{ id: 9, access_token: 't', octo_uuid: 'u' }] });
        },
      },
    };
  }

  /** Значение колонки по имени в единственной вставке. */
  function columnValue(call: [string, unknown[]], column: string): unknown {
    const [sql, params] = call;
    const names = /INSERT INTO operator_bookings\s*\(([^)]*)\)/.exec(sql)![1].split(',').map((x) => x.trim());
    const slots = /VALUES\s*\(([^)]*)\)/.exec(sql)![1].split(',').map((x) => x.trim());
    const i = names.indexOf(column);
    if (i < 0) return undefined;
    return params[Number(/^\$(\d+)/.exec(slots[i]!)![1]) - 1];
  }

  const ROW = {
    operator_tour_id: 7, booking_date: '2026-11-20', participants: 2,
    booking_status: 'new' as const, base_total_price: 10000, final_price: 10000, created_via: 'test',
  };

  it('пятидневный тур: end_date — последний день, duration_days — 5', async () => {
    const { calls, exec } = fakeExec();
    await insertBookingRow(exec as never, ROW, { multi_day_count: 5, duration_hours: null });
    expect(calls).toHaveLength(1);
    expect(columnValue(calls[0]!, 'end_date')).toBe('2026-11-24');
    expect(columnValue(calls[0]!, 'duration_days')).toBe(5);
  });

  it('тур на 30 часов занимает два календарных дня', async () => {
    const { calls, exec } = fakeExec();
    await insertBookingRow(exec as never, ROW, { multi_day_count: null, duration_hours: 30 });
    expect(columnValue(calls[0]!, 'end_date')).toBe('2026-11-21');
    expect(columnValue(calls[0]!, 'duration_days')).toBe(2);
  });

  it('однодневный: конец равен старту, а не пустоте', async () => {
    const { calls, exec } = fakeExec();
    await insertBookingRow(exec as never, ROW, { multi_day_count: null, duration_hours: 8 });
    expect(columnValue(calls[0]!, 'end_date')).toBe('2026-11-20');
    expect(columnValue(calls[0]!, 'duration_days')).toBe(1);
  });

  it('непереданная колонка в запросе не упоминается — работает умолчание базы', async () => {
    const { calls, exec } = fakeExec();
    await insertBookingRow(exec as never, ROW, { multi_day_count: null, duration_hours: null });
    const [sql] = calls[0]!;
    expect(sql).not.toMatch(/payment_status|lead_id|octo_api_key_id/);
  });

  it('колонка вне строки брони — ошибка кода, а не молча пропавшее поле', async () => {
    const { calls, exec } = fakeExec();
    await expect(insertBookingRow(exec as never, { ...ROW, end_date: '2099-01-01' } as never,
      { multi_day_count: null, duration_hours: null })).rejects.toThrow(/end_date/);
    expect(calls).toHaveLength(0);
  });
});
