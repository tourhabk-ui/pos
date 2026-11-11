/**
 * tests/unit/my-trip-date.test.ts
 *
 * «Изменить дату» под «Моей поездкой» (#2970, шаг 3, слово владельца 11.11):
 * свободной датой тура прямо в чате; пока оператор не ответил — дата в
 * заявке меняется сразу и оператору уходит «турист перенёс», после ответа —
 * просьба оператору, заявка не трогается.
 *
 * Что держит — вызовом:
 *  - кнопки: разбор туда-обратно, выбор даты — подписанная запись в 64
 *    байта, показ дат — чтение; оба нажатия MAX идут полосой переписки;
 *    битая дата (31.02) — не дата;
 *  - кнопки под списком: «Изменить дату» в MAX и Telegram, «Написать
 *    оператору» — только MAX; номер — при двух заявках и больше;
 *  - меню: свободные даты кнопками без текущей; правило «сразу / просьбой»
 *    словами; нет расписания, нет дат, сбой календаря, закрытая заявка,
 *    заявка не этого чата, отказ базы, лимит за сутки — каждый своими словами;
 *  - выбор: дата снова проверяется; оператор не ответил — условная запись
 *    с прежней датой и сообщение оператору «перенёс» без ПД, исход доставки
 *    в журнал; запись не прошла (оператор ответил между чтением и записью)
 *    или оператор уже ответил — просьба, дата не меняется; оператору не
 *    дошло — туристу так и сказано.
 * Сам SQL на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), reach: vi.fn(), alert: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => h.reach(...a) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => h.alert(...a) }));

import {
  pressMyTripDate, operatorDateText, myTripDateMenuPayload, myTripDatePickPayload, parseMyTripDate, isMyTripDatePayload,
  MY_TRIP_DATE_LEAD_SQL, MY_TRIP_DATE_CHANGE_SQL, MY_TRIP_DATE_DELIVERY_SQL, MY_TRIP_DATE_REQUEST_LOG_SQL, MY_TRIP_DATE_DAILY_LIMIT,
} from '@/lib/requests/my-trip-date';
import { FREE_DATES_SQL, TOUR_HAS_CALENDAR_SQL } from '@/lib/tours/nearest-free-date';
import { myTripButtons, type MyTrip } from '@/lib/requests/my-trip';
import { CALLBACK_MAX_BYTES, isWritePayload, signPayload, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { pressActionOf } from '@/lib/max/verified-press';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OPERATOR = '11111111-2222-4333-8444-555555555555';
const CHAT = 9_400_002;

interface Lead {
  status: string; date: string | null; tour_id: number | null; participants: number | null; tour_title: string | null;
  booking_status: string | null; booking_date: string | null; answered: boolean; date_actions: number;
}
const baseLead = (over: Partial<Lead> = {}): Lead => ({
  status: 'new', date: '2027-07-15', tour_id: 42, participants: 3, tour_title: 'Горелый & кратер <малый>',
  booking_status: null, booking_date: null, answered: false, date_actions: 0, ...over,
});

interface World {
  lead: Lead | null | Error;
  free: { date: string; free: number }[] | Error;
  hasCalendar: boolean;
  /** Строка журнала, которую вернёт условная запись; null — запись не прошла. */
  changed: string | null | Error;
}
let world: World;

beforeEach(() => {
  h.query.mockReset();
  h.reach.mockReset();
  h.alert.mockReset();
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
  world = { lead: baseLead(), free: [], hasCalendar: true, changed: '501' };
  h.reach.mockResolvedValue({ maxChatId: '777', telegramChatId: null, reachable: true });
  h.alert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено' });
  h.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql === MY_TRIP_DATE_LEAD_SQL) {
      if (world.lead instanceof Error) throw world.lead;
      return { rows: world.lead ? [{ id: LEAD, operator_id: OPERATOR, ...world.lead }] : [] };
    }
    if (sql === FREE_DATES_SQL) {
      if (world.free instanceof Error) throw world.free;
      const only = params[3] as string | null;
      const rows = only ? world.free.filter((d) => d.date === only) : world.free;
      return { rows: rows.slice(0, Number(params[2])) };
    }
    if (sql === TOUR_HAS_CALENDAR_SQL) return { rows: [{ has: world.hasCalendar }] };
    if (sql === MY_TRIP_DATE_CHANGE_SQL) {
      if (world.changed instanceof Error) throw world.changed;
      return { rows: world.changed ? [{ log_id: world.changed }] : [] };
    }
    if (sql === MY_TRIP_DATE_DELIVERY_SQL || sql === MY_TRIP_DATE_REQUEST_LOG_SQL) return { rows: [] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  });
});

const callsOf = (sql: string) => h.query.mock.calls.filter(([s]) => s === sql).map(([, p]) => p as unknown[]);
const menu = () => pressMyTripDate(myTripDateMenuPayload(LEAD), 'max', CHAT);
const pick = (date: string, channel: 'max' | 'telegram' = 'max') => pressMyTripDate(myTripDatePickPayload(LEAD, date), channel, CHAT);

describe('кнопки «Изменить дату»', () => {
  it('показ дат — чтение; выбор — подписанная запись в 64 байта; обе — полоса переписки MAX', () => {
    const menuRaw = myTripDateMenuPayload(LEAD);
    expect(parseMyTripDate(menuRaw)).toEqual({ kind: 'menu', leadId: LEAD });
    expect(isWritePayload(menuRaw)).toBe(false);
    expect(signPayload(menuRaw)).toBe(menuRaw);
    const pickRaw = myTripDatePickPayload(LEAD, '2027-07-18');
    expect(parseMyTripDate(pickRaw)).toEqual({ kind: 'pick', leadId: LEAD, date: '2027-07-18' });
    expect(isWritePayload(pickRaw)).toBe(true);
    const signed = signPayload(pickRaw);
    expect(signed).not.toBe(pickRaw);
    expect(Buffer.byteLength(signed)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    expect(unwrapPress(signed)).toEqual({ ok: true, payload: pickRaw });
    for (const raw of [menuRaw, pickRaw]) {
      expect(isMyTripDatePayload(raw)).toBe(true);
      expect(pressActionOf(raw)).toBe('request_chat');
    }
  });

  it('битая дата и чужая форма — не кнопка', () => {
    expect(parseMyTripDate(`mp:${LEAD.replace(/-/g, '')}270231`)).toBeNull();
    expect(parseMyTripDate(`mp:${LEAD.replace(/-/g, '')}271301`)).toBeNull();
    expect(parseMyTripDate('md:xyz')).toBeNull();
  });
});

describe('кнопки под «Моей поездкой»', () => {
  const trip: MyTrip = {
    outcome: 'ok',
    items: [
      { what: 'Тур 1', date: '2027-07-15', human: 'Ждёт ответа', situation: { kind: 'later' }, write: { kind: 'lead', id: LEAD }, dateChange: LEAD },
      { what: 'Жильё', date: '2027-07-16', human: 'Ждёт ответа', situation: { kind: 'none' }, write: null, dateChange: null },
    ],
  };

  it('MAX: «Написать оператору» и «Изменить дату» с номером заявки', () => {
    expect(myTripButtons(trip, 'max').map((b) => b.text)).toEqual(['Написать оператору · 1', 'Изменить дату · 1']);
    expect(myTripButtons(trip, 'max')[1]!.payload).toBe(myTripDateMenuPayload(LEAD));
  });

  it('Telegram: только «Изменить дату» — переписка клиента живёт в MAX', () => {
    expect(myTripButtons(trip, 'telegram').map((b) => b.text)).toEqual(['Изменить дату · 1']);
  });

  it('одна заявка — без номера', () => {
    expect(myTripButtons({ outcome: 'ok', items: [trip.outcome === 'ok' ? trip.items[0]! : (null as never)] }, 'telegram').map((b) => b.text)).toEqual(['Изменить дату']);
  });
});

describe('меню: свободные даты кнопками', () => {
  it('даты без текущей, места на каждой; оператор не ответил — «сразу встанет в заявку»', async () => {
    world.free = [
      { date: '2027-07-15', free: 8 }, { date: '2027-07-18', free: 5 }, { date: '2027-07-21', free: 3 },
    ];
    const r = await menu();
    expect(r.text).toContain('Тур «Горелый &amp; кратер &lt;малый&gt;», в заявке 15.07.2027, участников 3.');
    expect(r.text).toMatch(/выбранная дата сразу встанет в заявку/);
    expect(r.buttons.map((b) => b.text)).toEqual(['18.07 · мест 5', '21.07 · мест 3']);
    const payloads = r.buttons.map((b) => ('payload' in b ? unwrapPress(b.payload) : null));
    expect(payloads).toEqual([
      { ok: true, payload: myTripDatePickPayload(LEAD, '2027-07-18') },
      { ok: true, payload: myTripDatePickPayload(LEAD, '2027-07-21') },
    ]);
    // Связь проверяется этим каналом, этим чатом и этой заявкой; места — на число людей заявки.
    expect(callsOf(MY_TRIP_DATE_LEAD_SQL)[0]).toEqual(['max', String(CHAT), LEAD]);
    expect(callsOf(FREE_DATES_SQL)[0]!.slice(0, 2)).toEqual([42, 3]);
  });

  it('оператор уже ответил — даты те же, а правило другое: просьба оператору', async () => {
    world.lead = baseLead({ answered: true, status: 'contacted' });
    world.free = [{ date: '2027-07-18', free: 5 }];
    const r = await menu();
    expect(r.text).toMatch(/Оператор уже ответил по заявке, поэтому дату меняет он/);
    expect(r.buttons).toHaveLength(1);
  });

  it('у брони своя дата — она и названа текущей', async () => {
    world.lead = baseLead({ answered: true, status: 'converted', booking_status: 'confirmed', booking_date: '2027-07-16' });
    world.free = [{ date: '2027-07-16', free: 2 }, { date: '2027-07-18', free: 5 }];
    const r = await menu();
    expect(r.text).toContain('в заявке 16.07.2027');
    expect(r.buttons.map((b) => b.text)).toEqual(['18.07 · мест 5']);
  });

  it('расписания нет — «показать не могу», а не «мест нет»; дат нет — так и сказано', async () => {
    world.hasCalendar = false;
    expect((await menu()).text).toMatch(/Расписания у тура в системе нет — свободных дат показать не могу/);
    world.hasCalendar = true;
    world.free = [{ date: '2027-07-15', free: 8 }];
    const none = await menu();
    expect(none.text).toMatch(/Других свободных дат на 3 чел\. в календаре тура на год вперёд нет/);
    expect(none.buttons).toEqual([]);
  });

  it('календарь не прочитался — «сбой, а не дат нет», причина в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.free = Object.assign(new Error('timeout'), { code: '57014' });
    expect((await menu()).text).toMatch(/сбой, а не «дат нет»/);
    expect(err).toHaveBeenCalledWith('[nearest-free-date] свободные даты тура не прочитаны:', 'SQLSTATE=57014', 'timeout');
    err.mockRestore();
  });

  it('заявка не этого чата — «не подключена»; база не ответила — «не удалось проверить», не «не ваша»', async () => {
    world.lead = null;
    expect((await menu()).text).toMatch(/не подключена к этому чату/);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.lead = Object.assign(new Error('connection terminated'), { code: '08006' });
    expect((await menu()).text).toMatch(/Не удалось проверить заявку/);
    expect(err).toHaveBeenCalledWith('[my-trip-date] заявка не прочиталась:', 'SQLSTATE=08006', 'connection terminated');
    err.mockRestore();
    expect(callsOf(FREE_DATES_SQL)).toHaveLength(0);
  });

  it('заявка закрыта (отказ или отменённая бронь) — дату не меняю', async () => {
    world.lead = baseLead({ status: 'lost', answered: true });
    expect((await menu()).text).toMatch(/Заявка закрыта/);
    world.lead = baseLead({ answered: true, booking_status: 'cancelled', booking_date: '2027-07-15' });
    expect((await menu()).text).toMatch(/Заявка закрыта/);
  });

  it(`за сутки уже ${MY_TRIP_DATE_DAILY_LIMIT} смены — дальше напрямую с оператором`, async () => {
    world.lead = baseLead({ date_actions: MY_TRIP_DATE_DAILY_LIMIT });
    expect((await menu()).text).toMatch(/за сутки уже меняли/);
    expect((await pick('2027-07-18')).text).toMatch(/за сутки уже меняли/);
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toHaveLength(0);
  });
});

describe('выбор даты', () => {
  beforeEach(() => { world.free = [{ date: '2027-07-18', free: 5 }]; });

  it('оператор не ответил — условная запись с прежней датой, оператору «перенёс» без ПД, исход в журнал', async () => {
    const r = await pick('2027-07-18');
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toEqual([[LEAD, '2027-07-18', '2027-07-15', 'max']]);
    expect(h.reach).toHaveBeenCalledWith(OPERATOR);
    const sent = h.alert.mock.calls[0]![0] as { text: string; stub: string; to: unknown; buttons: Array<{ url?: string }> };
    expect(sent.text).toBe(sent.stub);
    expect(sent.text).toContain('Турист перенёс заявку на другую дату');
    expect(sent.text).toContain('было 15.07.2027, стало 18.07.2027');
    expect(sent.text).toContain('свободно мест: 5');
    expect(sent.to).toEqual({ maxChatId: '777', telegramChatId: null });
    expect(sent.buttons[0]!.url).toMatch(new RegExp(`/hub/operator/leads/${LEAD}$`));
    expect(callsOf(MY_TRIP_DATE_DELIVERY_SQL)).toEqual([['501', 'max']]);
    expect(r.text).toMatch(/^Дата в заявке изменена: тур «Горелый &amp; кратер &lt;малый&gt;», теперь 18\.07\.2027\. Оператору ушло сообщение о переносе\./);
    expect(callsOf(MY_TRIP_DATE_REQUEST_LOG_SQL)).toHaveLength(0);
  });

  it('из Telegram — тот же путь, канал записан', async () => {
    await pick('2027-07-18', 'telegram');
    expect(callsOf(MY_TRIP_DATE_LEAD_SQL)[0]).toEqual(['telegram', String(CHAT), LEAD]);
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)[0]![3]).toBe('telegram');
  });

  it('запись не прошла (оператор ответил между чтением и записью) — просьба, а не смена', async () => {
    world.changed = null;
    // Первое чтение — до ответа оператора, перечитанная после отказа записи — уже с ответом.
    let reads = 0;
    const lead = world.lead as Lead;
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql === MY_TRIP_DATE_LEAD_SQL) {
        return { rows: [{ id: LEAD, operator_id: OPERATOR, ...lead, ...(++reads > 1 ? { answered: true, status: 'contacted' } : {}) }] };
      }
      return base(sql, params);
    });
    const r = await pick('2027-07-18');
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toHaveLength(1);
    expect((h.alert.mock.calls[0]![0] as { text: string }).text).toContain('Турист просит перенести заявку');
    expect(callsOf(MY_TRIP_DATE_REQUEST_LOG_SQL)).toEqual([[LEAD, '2027-07-15', '2027-07-18', 'max', 'max']]);
    expect(r.text).toMatch(/просьба перенести на 18\.07\.2027 ему отправлена\. В заявке пока прежняя дата — 15\.07\.2027\./);
  });

  it('двойное нажатие той же даты: вторая запись не прошла, а оператор не отвечал — «уже стоит», оператору второго сообщения нет', async () => {
    world.changed = null;
    let reads = 0;
    const lead = world.lead as Lead;
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, params: unknown[]) => {
      // Первое чтение — до записи первого нажатия, второе — после: дата уже новая.
      if (sql === MY_TRIP_DATE_LEAD_SQL) return { rows: [{ id: LEAD, operator_id: OPERATOR, ...lead, ...(++reads > 1 ? { date: '2027-07-18' } : {}) }] };
      return base(sql, params);
    });
    const r = await pick('2027-07-18');
    expect(r.text).toBe('18.07.2027 уже стоит в заявке — ничего не изменено.');
    expect(h.alert).not.toHaveBeenCalled();
    expect(callsOf(MY_TRIP_DATE_REQUEST_LOG_SQL)).toHaveLength(0);
  });

  it('вторая запись не прошла, а дату сменили на другую — «изменили в другом окне», ничего не отправлено', async () => {
    world.changed = null;
    let reads = 0;
    const lead = world.lead as Lead;
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql === MY_TRIP_DATE_LEAD_SQL) return { rows: [{ id: LEAD, operator_id: OPERATOR, ...lead, ...(++reads > 1 ? { date: '2027-07-21' } : {}) }] };
      return base(sql, params);
    });
    expect((await pick('2027-07-18')).text).toMatch(/только что изменили в другом окне/);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('оператор уже ответил — дата не пишется, оператору просьба: «меняете вы»', async () => {
    world.lead = baseLead({ answered: true, status: 'contacted' });
    await pick('2027-07-18');
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toHaveLength(0);
    const text = (h.alert.mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain('сейчас 15.07.2027, просит 18.07.2027');
    expect(text).toMatch(/дату в ней и в брони меняете вы/);
  });

  it('оператору не дошло — туристу честно: оператор о просьбе не знает', async () => {
    world.lead = baseLead({ answered: true, status: 'contacted' });
    h.reach.mockResolvedValue({ maxChatId: null, telegramChatId: null, reachable: false });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await pick('2027-07-18');
    expect(h.alert).not.toHaveBeenCalled();
    expect(callsOf(MY_TRIP_DATE_REQUEST_LOG_SQL)[0]![4]).toBe('none');
    expect(r.text).toMatch(/о просьбе не знает — напишите ему или позвоните/);
    err.mockRestore();
  });

  it('смена прошла, а сообщить не удалось — дата сменена, и сказано, что оператор не знает', async () => {
    h.alert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'MAX не ответил' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await pick('2027-07-18');
    expect(callsOf(MY_TRIP_DATE_DELIVERY_SQL)).toEqual([['501', 'none']]);
    expect(r.text).toMatch(/Дата в заявке изменена/);
    expect(r.text).toMatch(/Сообщить оператору сейчас не удалось/);
    err.mockRestore();
  });

  it('дату успели занять — ничего не изменено, кнопка открыть даты заново', async () => {
    world.free = [];
    const r = await pick('2027-07-18');
    expect(r.text).toMatch(/На 18\.07\.2027 мест на 3 чел\. уже нет — ничего не изменено/);
    expect(r.buttons.map((b) => ('payload' in b ? b.payload : ''))).toEqual([myTripDateMenuPayload(LEAD)]);
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toHaveLength(0);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('та же дата — ничего не изменено; запись упала — «не удалось проверить», оператору ничего', async () => {
    expect((await pick('2027-07-15')).text).toMatch(/уже стоит в заявке/);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.changed = Object.assign(new Error('deadlock'), { code: '40P01' });
    expect((await pick('2027-07-18')).text).toMatch(/Не удалось проверить заявку/);
    expect(err).toHaveBeenCalledWith('[my-trip-date] дата заявки не записана:', 'SQLSTATE=40P01', 'deadlock');
    expect(h.alert).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('сообщение оператору', () => {
  it('без имени и телефона: тур, даты, люди, места; название экранировано', () => {
    const t = operatorDateText('changed', { title: 'Тур <b>X</b>', from: '2027-07-15', to: '2027-07-18', people: 2, free: 4 });
    expect(t).toContain('Тур «Тур &lt;b&gt;X&lt;/b&gt;», участников 2');
    expect(t).not.toMatch(/\+7|телефон/i);
  });
});
