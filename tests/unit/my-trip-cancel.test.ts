/**
 * tests/unit/my-trip-cancel.test.ts
 *
 * «Отменить заявку» под «Моей поездкой» (1427, слово владельца 11.11: отмена
 * «как самим человеком»; пока оператор не ответил — сразу, после ответа —
 * просьбой ему).
 *
 * Что держит — вызовом:
 *  - кнопки: разбор туда-обратно; «Да» — подписанная запись в 64 байта,
 *    вопрос — чтение; оба нажатия MAX идут полосой переписки;
 *  - кнопки под списком: «Отменить заявку» в MAX и Telegram, номер — при двух
 *    заявках; под списком — вопрос, а не запись;
 *  - вопрос: что именно произойдёт по «Да» — отмена сразу, отмена заявки без
 *    адресата или просьба оператору; ничего не пишет; закрытая, отменённая,
 *    прошедшая, чужая заявка и сбой — каждое своими словами;
 *  - «Да»: оператор не ответил — условная запись, событие в ленту от туриста,
 *    сообщение оператору без ПД, исход доставки в журнал; оператор ответил
 *    (сразу или между вопросом и «Да»), есть бронь или «Договорились» —
 *    просьба, заявка не трогается; повтор — без второго сообщения;
 *  - оператору не дошло или адресата нет — строка без ПД менеджеру, и человеку
 *    сказано, что оператор не узнал;
 *  - просьба помнит, кому дошла: повтор отвечает «оператору», «менеджеру» или
 *    «отправляется»; не дошла никому — так и сказано, запись уходит из
 *    единственных, и следующее нажатие отправляет заново; зависшая без исхода
 *    освобождается перед новой;
 *  - бронь не отменяется никогда: у ядра нет записи в брони;
 *  - сбой базы — «не удалось», ничего не отправлено.
 * Сам SQL на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), reach: vi.fn(), alert: vi.fn(), event: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => h.reach(...a) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => h.alert(...a) }));
vi.mock('@/lib/crm/events', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/events')>()),
  recordSourceEventQuietly: (...a: unknown[]) => h.event(...a),
}));

import {
  pressMyTripCancel, cancelReplyText, MY_TRIP_CANCEL_LEAD_SQL,
  myTripCancelAskPayload, myTripCancelYesPayload, parseMyTripCancel, isMyTripCancelPayload,
} from '@/lib/requests/my-trip-cancel';
import {
  CANCEL_NOW_SQL, CANCEL_REQUEST_SQL, CANCEL_DELIVERY_SQL, CANCEL_REQUEST_UNDELIVERED_SQL, CANCEL_REQUEST_RELEASE_SQL,
  cancelBlock, cancelMode, priorCancelRequest, operatorCancelText, managerCancelText, type CancelRequestMark,
} from '@/lib/requests/cancel-request';
import { myTripButtons, type MyTrip } from '@/lib/requests/my-trip';
import { CALLBACK_MAX_BYTES, isWritePayload, signPayload, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { pressActionOf } from '@/lib/max/verified-press';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_CLIENT_CANCELLED, LEAD_STATUSES, MANUAL_LEAD_STATUSES, UNATTENDED_LEAD_STATUSES } from '@/lib/types/statuses';
import { LEAD_STATUSES as SETTABLE_LEAD_STATUSES } from '@/lib/leads/owner-lead-status';
import { LEAD_WAITING_STATUSES, OWNER_LEAD_STATUSES, leadAlreadyText, ownerLeadActionsFor } from '@/lib/leads/owner-lead-words';
import { CLIENT_CANCELLED_HUMAN, leadState } from '@/lib/mcp/request-status';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OPERATOR = '11111111-2222-4333-8444-555555555555';
const CHAT = 9_400_012;
// Сегодня по Камчатке — 01.07.2027.
const NOW = Date.parse('2027-06-30T20:00:00Z');

interface Lead {
  status: string; operator_id: string | null; date: string | null; participants: number | null; tour_title: string | null;
  booking_status: string | null; booking_date: string | null; answered: boolean; cancel_request: CancelRequestMark | null;
}
const baseLead = (over: Partial<Lead> = {}): Lead => ({
  status: 'new', operator_id: OPERATOR, date: '2027-07-15', participants: 3, tour_title: 'Горелый & кратер <малый>',
  booking_status: null, booking_date: null, answered: false, cancel_request: null, ...over,
});
/** Запись прежней просьбы: кому дошла и свежа ли. */
const mark = (delivery: string | null, manager: string | null, fresh = false): CancelRequestMark => ({ delivery, manager, fresh });
const SENT_TO_OPERATOR = mark('max', 'not_needed');
const SENT_TO_MANAGER = mark('none', 'told');

interface World {
  /** Что отдаёт чтение заявки: по очереди, последнее повторяется. */
  reads: Array<Lead | null | Error>;
  /** Строка условной отмены; null — запись не прошла. */
  now: { log_id: string; prev_status: string; operator_id: string | null } | null | Error;
  /** Строка журнала просьбы; null — просьба уже была или заявку закрыли. */
  request: string | null | Error;
}
let world: World;

beforeEach(() => {
  for (const f of [h.query, h.reach, h.alert, h.event]) f.mockReset();
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
  world = { reads: [baseLead()], now: { log_id: '701', prev_status: 'new', operator_id: OPERATOR }, request: '702' };
  h.reach.mockResolvedValue({ maxChatId: '777', telegramChatId: null, reachable: true });
  h.alert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено' });
  h.event.mockResolvedValue(undefined);
  h.query.mockImplementation(async (sql: string) => {
    if (sql === MY_TRIP_CANCEL_LEAD_SQL) {
      const next = world.reads.length > 1 ? world.reads.shift()! : world.reads[0]!;
      if (next instanceof Error) throw next;
      return { rows: next ? [{ id: LEAD, ...next }] : [] };
    }
    if (sql === CANCEL_NOW_SQL) {
      if (world.now instanceof Error) throw world.now;
      return { rows: world.now ? [world.now] : [] };
    }
    if (sql === CANCEL_REQUEST_SQL) {
      if (world.request instanceof Error) throw world.request;
      return { rows: world.request ? [{ log_id: world.request }] : [] };
    }
    if (sql === CANCEL_DELIVERY_SQL || sql === CANCEL_REQUEST_UNDELIVERED_SQL || sql === CANCEL_REQUEST_RELEASE_SQL) return { rows: [] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  });
});

const callsOf = (sql: string) => h.query.mock.calls.filter(([s]) => s === sql).map(([, p]) => p as unknown[]);
const ask = () => pressMyTripCancel(myTripCancelAskPayload(LEAD), 'max', CHAT, { now: NOW });
const yes = (channel: 'max' | 'telegram' = 'max') => pressMyTripCancel(myTripCancelYesPayload(LEAD), channel, CHAT, { now: NOW });
const HEAD = 'Тур «Горелый &amp; кратер &lt;малый&gt;», 15.07.2027, участников 3';
/** Сообщения оператору (с адресом) и менеджеру (без адреса). */
const toOperator = () => h.alert.mock.calls.map(([p]) => p as { text: string; stub: string; to?: unknown }).filter((p) => p.to !== undefined);
const toManager = () => h.alert.mock.calls.map(([p]) => p as { text: string; stub: string; to?: unknown }).filter((p) => p.to === undefined);

describe('кнопки «Отменить заявку»', () => {
  it('разбор туда-обратно; мусор и обрезанный номер — не кнопка', () => {
    expect(parseMyTripCancel(myTripCancelAskPayload(LEAD))).toEqual({ kind: 'ask', leadId: LEAD });
    expect(parseMyTripCancel(myTripCancelYesPayload(LEAD))).toEqual({ kind: 'yes', leadId: LEAD });
    for (const bad of ['mc:', 'mx:', 'mc:zz', `mc:${'a'.repeat(31)}`, `mx:${'a'.repeat(33)}`, `md:${'a'.repeat(32)}`, '']) {
      expect(parseMyTripCancel(bad), bad).toBeNull();
    }
    expect(isMyTripCancelPayload(myTripCancelAskPayload(LEAD))).toBe(true);
    expect(isMyTripCancelPayload(myTripCancelYesPayload(LEAD))).toBe(true);
    expect(isMyTripCancelPayload(`md:${'a'.repeat(32)}`)).toBe(false);
  });

  it('«Да» — запись: подписывается, влезает в 64 байта и без подписи не проходит; вопрос — чтение', () => {
    const yesRaw = myTripCancelYesPayload(LEAD);
    expect(isWritePayload(yesRaw)).toBe(true);
    const signed = signPayload(yesRaw, NOW);
    expect(signed).not.toBe(yesRaw);
    expect(Buffer.byteLength(signed)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    expect(unwrapPress(signed, NOW)).toEqual({ ok: true, payload: yesRaw });
    // Собранная руками «Да» после срока прежних кнопок — отказ; просроченная подписанная — тоже.
    // (Тестовая среда держит окно прежних кнопок открытым — здесь оно закрыто, как на проде.)
    const legacy = process.env.CALLBACK_LEGACY_UNTIL_MS;
    vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', '1');
    expect(unwrapPress(yesRaw, NOW)).toEqual({ ok: false, reason: 'expired' });
    vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', legacy ?? '');
    expect(unwrapPress(signed, NOW + 4 * 24 * 3600_000)).toEqual({ ok: false, reason: 'expired' });
    const askRaw = myTripCancelAskPayload(LEAD);
    expect(isWritePayload(askRaw)).toBe(false);
    expect(signPayload(askRaw, NOW)).toBe(askRaw);
  });

  it('оба нажатия в MAX идут полосой переписки по заявке — только по заверенному апдейту', () => {
    expect(pressActionOf(myTripCancelAskPayload(LEAD))).toBe('request_chat');
    expect(pressActionOf(myTripCancelYesPayload(LEAD))).toBe('request_chat');
  });

  it('под списком — вопрос, а не запись; в MAX и Telegram; номер — при двух заявках', () => {
    const item = (cancel: string | null) => ({ what: 'Горелый', date: '2027-07-15', human: 'x', situation: { kind: 'none' as const }, write: null, dateChange: null, cancel });
    const one: MyTrip = { outcome: 'ok', items: [item(LEAD)] };
    for (const channel of ['max', 'telegram'] as const) {
      expect(myTripButtons(one, channel)).toEqual([{ text: 'Отменить заявку', payload: myTripCancelAskPayload(LEAD) }]);
    }
    const two: MyTrip = { outcome: 'ok', items: [item(null), item(LEAD)] };
    expect(myTripButtons(two, 'max')).toEqual([{ text: 'Отменить заявку · 2', payload: myTripCancelAskPayload(LEAD) }]);
  });
});

describe('вопрос «отменить?» — только чтение', () => {
  it('оператор не ответил: сказано, что отменится сразу и что вернуть нельзя; кнопка «Да» подписана; ничего не записано и не отправлено', async () => {
    const r = await ask();
    expect(r.text).toBe([
      'Отменить заявку?', `${HEAD}.`,
      'Оператор ещё не ответил — заявка отменится сразу, оператору уйдёт сообщение.',
      'Вернуть отменённую заявку нельзя: понадобится новая.',
      'Передумали — ничего нажимать не нужно.',
    ].join('\n'));
    expect(r.buttons).toHaveLength(1);
    const b = r.buttons[0] as { text: string; payload: string };
    expect(b.text).toBe('Да, отменить заявку');
    // Кнопка подписана: это не сырой payload (его после срока прежних кнопок не примут).
    expect(b.payload).not.toBe(myTripCancelYesPayload(LEAD));
    expect(unwrapPress(b.payload)).toEqual({ ok: true, payload: myTripCancelYesPayload(LEAD) });
    expect(callsOf(MY_TRIP_CANCEL_LEAD_SQL)).toEqual([['max', String(CHAT), LEAD]]);
    expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(0);
    expect(callsOf(CANCEL_REQUEST_SQL)).toHaveLength(0);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('заявка без адресата (группу передали другим): отменится сразу, и дальше её не передадут', async () => {
    world.reads = [baseLead({ operator_id: null, answered: true, status: 'contacted' })];
    const r = await ask();
    expect(r.text).toContain('Оператора у заявки сейчас нет — она отменится сразу, и дальше её никому не передадут.');
    expect((r.buttons[0] as { text: string }).text).toBe('Да, отменить заявку');
  });

  it('оператор ответил или есть бронь: «Да» — это просьба, и так и названо', async () => {
    const cases: Array<[Lead, string]> = [
      // Брони нет — о брони ни слова: её не существует.
      [baseLead({ answered: true }), 'Оператор уже ответил по заявке, поэтому отменяет он: ему уйдёт ваша просьба. Заявка действует, пока он её не закроет.'],
      [baseLead({ booking_status: 'confirmed', booking_date: '2027-07-16' }), 'Оператор уже ответил по заявке, поэтому отменяет он: ему уйдёт ваша просьба. Заявка и бронь действуют, пока он их не закроет.'],
    ];
    for (const [lead, words] of cases) {
      world.reads = [lead];
      const r = await ask();
      expect(r.text).toMatch(/^Попросить оператора отменить заявку\?\n/);
      expect(r.text.split('\n')[2]).toBe(words);
      expect((r.buttons[0] as { text: string }).text).toBe('Да, попросить об отмене');
    }
    // Дата в вопросе — день брони, если оператор завёл её на другой день.
    expect((await ask()).text).toContain('16.07.2027');
  });

  it('«Договорились» или бронь у заявки без адресата: просьба — менеджеру Ведара, и так и названо', async () => {
    for (const lead of [
      baseLead({ operator_id: null, status: 'converted', answered: true }),
      baseLead({ operator_id: null, booking_status: 'confirmed', answered: true }),
    ]) {
      world.reads = [lead];
      const r = await ask();
      expect(r.text).toBe([
        'Попросить отменить заявку?', `${HEAD}.`,
        'По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба уйдёт менеджеру Ведара. Заявка действует, пока её не закроют.',
        'Передумали — ничего нажимать не нужно.',
      ].join('\n'));
      expect((r.buttons[0] as { text: string }).text).toBe('Да, попросить об отмене');
    }
  });

  it('просьба уже есть — второй не предлагаем и говорим, кому она дошла на деле', async () => {
    const cases: Array<[CancelRequestMark, RegExp]> = [
      [SENT_TO_OPERATOR, /^Просьба об отмене по этой заявке уже отправлена оператору — повторно не отправляю\./],
      [mark('telegram', 'not_needed'), /уже отправлена оператору/],
      [SENT_TO_MANAGER, /^Просьба об отмене по этой заявке уже передана менеджеру Ведара — повторно не отправляю\. Заявка действует, пока её не закроют\.$/],
      [mark('no_addressee', 'told'), /уже передана менеджеру Ведара/],
      [mark(null, null, true), /^Просьба об отмене по этой заявке уже отправляется — второе нажатие ничего не добавило\./],
    ];
    for (const [cancel_request, re] of cases) {
      world.reads = [baseLead({ answered: true, cancel_request })];
      const r = await ask();
      expect(r.text).toMatch(re);
      expect(r.buttons).toEqual([]);
    }
    // Зависшая без исхода (старше срока) — вопрос задаётся снова: «Да» отправит заново.
    world.reads = [baseLead({ answered: true, cancel_request: mark(null, null, false) })];
    const r = await ask();
    expect(r.text).toMatch(/^Попросить оператора отменить заявку\?/);
    expect(r.buttons).toHaveLength(1);
    // Вопрос ничего не пишет — и зависшую не освобождает.
    expect(callsOf(CANCEL_REQUEST_RELEASE_SQL)).toHaveLength(0);
  });

  it('отменена, закрыта отказом или закрытой бронью, поездка прошла, чужая заявка, сбой — каждое своими словами и без кнопки', async () => {
    const cases: Array<[Lead | null | Error, RegExp]> = [
      [baseLead({ status: 'cancelled' }), /^Заявка уже отменена — ничего не изменено\.$/],
      [baseLead({ status: 'lost' }), /^Заявка уже закрыта — отменять нечего\.$/],
      [baseLead({ status: 'converted', booking_status: 'completed' }), /^Заявка уже закрыта — отменять нечего\.$/],
      [baseLead({ status: 'converted', booking_status: 'cancelled' }), /^Заявка уже закрыта — отменять нечего\.$/],
      [baseLead({ date: '2027-06-30' }), /^Поездка по заявке уже прошла — отменять нечего\.$/],
      [null, /не подключена к этому чату — отменить её здесь нельзя/],
      [Object.assign(new Error('boom'), { code: '57P01' }), /^Не удалось отменить заявку — это сбой на нашей стороне\. Ничего не изменено/],
    ];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [lead, re] of cases) {
      world.reads = [lead];
      const r = await ask();
      expect(r.text).toMatch(re);
      expect(r.buttons).toEqual([]);
    }
    expect(String(spy.mock.calls.at(-1))).toContain('SQLSTATE=57P01');
    spy.mockRestore();
    // Сегодняшняя поездка ещё не прошла; заявку без даты отменить можно.
    world.reads = [baseLead({ date: '2027-07-01' })];
    expect((await ask()).buttons).toHaveLength(1);
    world.reads = [baseLead({ date: null })];
    expect((await ask()).text).toContain('Тур «Горелый &amp; кратер &lt;малый&gt;», участников 3.');
  });

  it('кнопка не распознана — ничего не читается', async () => {
    expect((await pressMyTripCancel('mx:zz', 'max', CHAT)).text).toMatch(/^Кнопка не распознана — ничего не изменено/);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('«Да»: отмена сразу, пока оператор не ответил', () => {
  it('условная запись, событие от туриста, сообщение оператору без ПД, исход доставки в журнале', async () => {
    const r = await yes('telegram');
    expect(r.text).toBe(`Заявка отменена: ${HEAD}. Оператору ушло сообщение. Новую заявку можно оставить здесь же, в чате.`);
    expect(r.buttons).toEqual([]);
    expect(callsOf(CANCEL_NOW_SQL)).toEqual([[LEAD, 'telegram']]);
    expect(callsOf(CANCEL_REQUEST_SQL)).toHaveLength(0);
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'status_change', sourceKind: 'lead', sourceId: LEAD, actorKind: 'tourist',
      payload: { from: 'new', to: 'cancelled', via: 'telegram' },
    }));
    expect(h.reach).toHaveBeenCalledWith(OPERATOR);
    expect(toOperator()).toHaveLength(1);
    const sent = toOperator()[0]!;
    expect(sent.text).toBe([
      '<b>Турист отменил заявку</b>', `${HEAD}.`,
      'Отменил сам турист в чате Ведара, пока вы не ответили. Заявка закрыта: отвечать по ней и держать места не нужно.',
    ].join('\n'));
    expect(sent.stub).toBe(sent.text);
    expect(sent.to).toEqual({ maxChatId: '777', telegramChatId: null });
    expect(toManager()).toHaveLength(0);
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'max', 'not_needed']]);
  });

  it('оператору сообщение ушло заглушкой в Telegram — тоже «узнал»', async () => {
    h.alert.mockResolvedValue({ channel: 'telegram-stub', delivered: false, reason: 'заглушка' });
    expect((await yes()).text).toContain('Оператору ушло сообщение.');
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'telegram', 'not_needed']]);
    expect(toManager()).toHaveLength(0);
  });

  it('у оператора нет чата, его адрес не прочитался или сообщение не дошло — строка без ПД менеджеру, человеку сказано, что оператор не узнал', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: Array<[() => void, string]> = [
      [() => h.reach.mockResolvedValue({ maxChatId: null, telegramChatId: null, reachable: false }), 'none'],
      [() => h.reach.mockResolvedValue(null), 'unknown'],
      [() => h.alert.mockImplementation(async (p: { to?: unknown }) => (p.to
        ? { channel: 'none', delivered: false, reason: 'бот заблокирован' }
        : { channel: 'max', delivered: true, reason: 'доставлено' })), 'none'],
    ];
    for (const [arrange, delivery] of cases) {
      h.query.mockClear();
      h.alert.mockReset();
      h.alert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено' });
      h.reach.mockResolvedValue({ maxChatId: '777', telegramChatId: null, reachable: true });
      arrange();
      const r = await yes();
      expect(r.text).toBe(`Заявка отменена: ${HEAD}. Сообщить оператору сейчас не удалось — в кабинете он увидит её отменённой. Менеджер Ведара предупреждён. Новую заявку можно оставить здесь же, в чате.`);
      const m = toManager();
      expect(m).toHaveLength(1);
      expect(m[0]!.text).toBe([
        '<b>Клиент отменил заявку</b>', `Заявка <code>${LEAD}</code>: ${HEAD}.`,
        'Оператору сообщить не удалось — сообщите ему: он может держать места.',
      ].join('\n'));
      expect(m[0]!.stub).toBe(m[0]!.text);
      expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', delivery, 'told']]);
    }
    // И менеджеру не дошло — «предупреждён» не говорим.
    h.query.mockClear();
    h.alert.mockReset();
    h.alert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'нет чата' });
    const r = await yes();
    expect(r.text).toBe(`Заявка отменена: ${HEAD}. Сообщить оператору сейчас не удалось — в кабинете он увидит её отменённой. Новую заявку можно оставить здесь же, в чате.`);
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'none', 'failed']]);
    // Менеджеру отправка бросила — отмена всё равно состоялась, и это сказано.
    h.query.mockClear();
    h.alert.mockReset();
    h.alert.mockImplementation(async (p: { to?: unknown }) => {
      if (!p.to) throw new Error('сеть');
      return { channel: 'none', delivered: false, reason: 'нет чата' };
    });
    expect((await yes()).text).toMatch(/^Заявка отменена: /);
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'none', 'failed']]);
    spy.mockRestore();
  });

  it('заявка без адресата: оператору не пишем, менеджеру — «нет адресата», человеку — «дальше не передадут»', async () => {
    world.reads = [baseLead({ operator_id: null })];
    world.now = { log_id: '701', prev_status: 'new', operator_id: null };
    const r = await yes();
    expect(r.text).toBe(`Заявка отменена: ${HEAD}. Оператора у неё не было — дальше её никому не передадут. Новую заявку можно оставить здесь же, в чате.`);
    expect(h.reach).not.toHaveBeenCalled();
    expect(toOperator()).toHaveLength(0);
    expect(toManager()).toHaveLength(1);
    expect(toManager()[0]!.text).toContain('У заявки нет адресата (передана другим операторам или была у вас): дальше её никому не передаём.');
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'no_addressee', 'told']]);
  });

  it('менеджеру строка ушла заглушкой в Telegram — тоже «предупреждён»: ПД в ней нет, она одна на оба канала', async () => {
    world.reads = [baseLead({ operator_id: null })];
    world.now = { log_id: '701', prev_status: 'new', operator_id: null };
    h.alert.mockResolvedValue({ channel: 'telegram-stub', delivered: false, reason: 'заглушка' });
    await yes();
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'no_addressee', 'told']]);
  });

  it('адресат берётся из записи под блокировкой, а не из прочитанного: оператора сняли между чтением и «Да» — ему не пишем', async () => {
    world.now = { log_id: '701', prev_status: 'new', operator_id: null };
    await yes();
    expect(h.reach).not.toHaveBeenCalled();
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['701', 'no_addressee', 'told']]);
  });

  it('прежний статус в ленте клиента — тоже из записи: разбор успел перевести заявку между чтением и «Да»', async () => {
    world.now = { log_id: '701', prev_status: 'ai_qualified', operator_id: OPERATOR };
    await yes();
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ payload: { from: 'ai_qualified', to: 'cancelled', via: 'max' } }));
  });

  it('повтор «Да» по уже отменённой — «уже отменена», ни записи, ни сообщений', async () => {
    world.reads = [baseLead({ status: 'cancelled' })];
    expect((await yes()).text).toBe('Заявка уже отменена — ничего не изменено.');
    expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(0);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
  });

  it('сбой записи — «не удалось», ничего не отправлено', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.now = Object.assign(new Error('boom'), { code: '40001' });
    expect((await yes()).text).toMatch(/^Не удалось отменить заявку — это сбой на нашей стороне\. Ничего не изменено/);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
    expect(String(spy.mock.calls.at(-1))).toContain('SQLSTATE=40001');
    spy.mockRestore();
  });

  it('исход доставки не записался — отмена состоялась, человеку сказана правда', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql === CANCEL_DELIVERY_SQL) throw Object.assign(new Error('boom'), { code: '57P01' });
      return base(sql, params);
    });
    expect((await yes()).text).toContain('Заявка отменена:');
    spy.mockRestore();
  });
});

describe('«Да»: оператор уже ответил — просьба, заявка не трогается', () => {
  it('ответил до нажатия: условная отмена не зовётся, оператору — просьба без ПД, запись журнала с исходом', async () => {
    world.reads = [baseLead({ answered: true })];
    const r = await yes();
    expect(r.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он: просьба ему отправлена. Заявка действует, пока он её не закроет.');
    expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(0);
    expect(callsOf(CANCEL_REQUEST_SQL)).toEqual([[LEAD, 'max']]);
    expect(h.event).not.toHaveBeenCalled();
    expect(toOperator()[0]!.text).toBe([
      '<b>Турист просит отменить заявку</b>', `${HEAD}.`,
      'Вы уже ответили по заявке, поэтому закрываете её вы — и бронь, если она заведена: Ведар ничего не менял. Туристу ответьте в переписке по заявке или звонком.',
    ].join('\n'));
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['702', 'max', 'not_needed']]);
  });

  it('бронь по заявке — всегда просьба, даже если «ответа» нет; оператору названа дата брони, а не заявки', async () => {
    world.reads = [baseLead({ booking_status: 'new', booking_date: '2027-07-16', answered: false })];
    await yes();
    expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(0);
    expect(callsOf(CANCEL_REQUEST_SQL)).toHaveLength(1);
    expect(toOperator()[0]!.text).toContain('Тур «Горелый &amp; кратер &lt;малый&gt;», 16.07.2027, участников 3.');
  });

  it('ответил между вопросом и «Да»: условная запись не прошла — заявка перечитана, ушла просьба, а не «отменена»', async () => {
    world.reads = [baseLead(), baseLead({ answered: true })];
    world.now = null;
    const r = await yes();
    expect(r.text).toMatch(/^Оператор уже ответил по заявке, поэтому отменяет он: просьба ему отправлена\./);
    expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(1);
    expect(callsOf(CANCEL_REQUEST_SQL)).toHaveLength(1);
    expect(toOperator()[0]!.text).toContain('Турист просит отменить заявку');
    expect(h.event).not.toHaveBeenCalled();
  });

  it('запись не прошла, потому что заявку уже отменили в другом окне или оператор закрыл её — так и сказано, сообщений нет', async () => {
    world.now = null;
    world.reads = [baseLead(), baseLead({ status: 'cancelled' })];
    expect((await yes()).text).toBe('Заявка уже отменена — ничего не изменено.');
    world.reads = [baseLead(), baseLead({ status: 'lost' })];
    expect((await yes()).text).toBe('Заявка уже закрыта — отменять нечего.');
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('просьба уже была (в другом окне) — второго сообщения оператору нет, а слова — о том, кому она дошла', async () => {
    world.reads = [baseLead({ answered: true }), baseLead({ answered: true, cancel_request: SENT_TO_OPERATOR })];
    world.request = null;
    const r = await yes();
    expect(r.text).toMatch(/^Просьба об отмене по этой заявке уже отправлена оператору/);
    expect(h.alert).not.toHaveBeenCalled();
    // И сразу известная — запись даже не пробуется; дошедшая только менеджеру оператору не приписывается.
    for (const [cancel_request, re] of [
      [SENT_TO_OPERATOR, /уже отправлена оператору/],
      [SENT_TO_MANAGER, /^Просьба об отмене по этой заявке уже передана менеджеру Ведара — повторно не отправляю\./],
      [mark(null, null, true), /уже отправляется — второе нажатие ничего не добавило/],
    ] as Array<[CancelRequestMark, RegExp]>) {
      h.query.mockClear();
      world.reads = [baseLead({ answered: true, cancel_request })];
      expect((await yes()).text).toMatch(re);
      expect(callsOf(CANCEL_REQUEST_SQL)).toHaveLength(0);
      expect(callsOf(CANCEL_REQUEST_RELEASE_SQL)).toHaveLength(0);
    }
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('оператору просьба не дошла, менеджеру дошла — так и сказано: «передана менеджеру», и запись это помнит', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.reads = [baseLead({ answered: true })];
    h.reach.mockResolvedValue({ maxChatId: null, telegramChatId: null, reachable: false });
    const r = await yes();
    expect(r.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он. Сообщить ему сейчас не удалось — просьба передана менеджеру Ведара. Заявка остаётся в силе, пока её не закроют; надёжнее написать оператору или позвонить.');
    expect(toManager()[0]!.text).toBe([
      '<b>Клиент просит отменить заявку</b>', `Заявка <code>${LEAD}</code>: ${HEAD}.`,
      'Оператору сообщить не удалось — передайте ему просьбу: заявка (и бронь, если она заведена) пока действует.',
    ].join('\n'));
    expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['702', 'none', 'told']]);
    expect(callsOf(CANCEL_REQUEST_UNDELIVERED_SQL)).toHaveLength(0);
    spy.mockRestore();
  });

  it('просьба не дошла никому — человеку сказано, что заявка в силе; запись уходит из единственных, и «уже отправлена» она не станет', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.reads = [baseLead({ answered: true })];
    h.alert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'нет чата' });
    const r = await yes();
    expect(r.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он, но передать просьбу сейчас не удалось — ни ему, ни менеджеру Ведара. Заявка остаётся в силе. Нажмите ещё раз через пару минут или напишите оператору, позвоните ему.');
    expect(callsOf(CANCEL_REQUEST_UNDELIVERED_SQL)).toEqual([['702', 'none', 'failed']]);
    expect(callsOf(CANCEL_DELIVERY_SQL)).toHaveLength(0);
    // Менеджеру отправка бросила — тот же исход.
    h.query.mockClear();
    h.alert.mockReset();
    h.alert.mockImplementation(async (p: { to?: unknown }) => {
      if (!p.to) throw new Error('сеть');
      return { channel: 'none', delivered: false, reason: 'бот заблокирован' };
    });
    expect((await yes()).text).toMatch(/ни ему, ни менеджеру Ведара\. Заявка остаётся в силе\./);
    expect(callsOf(CANCEL_REQUEST_UNDELIVERED_SQL)).toEqual([['702', 'none', 'failed']]);
    spy.mockRestore();
  });

  it('«Договорились» или бронь у заявки без адресата: оператору не пишем, просьба — менеджеру; не дошла и ему — «заявка в силе»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const lead of [
      baseLead({ operator_id: null, status: 'converted', answered: true }),
      baseLead({ operator_id: null, booking_status: 'new', answered: true }),
    ]) {
      h.query.mockClear();
      h.alert.mockClear();
      world.reads = [lead];
      const r = await yes();
      expect(r.text).toBe('По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба об отмене передана менеджеру Ведара. Заявка действует, пока её не закроют.');
      expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(0);
      expect(h.reach).not.toHaveBeenCalled();
      expect(toOperator()).toHaveLength(0);
      expect(toManager()).toHaveLength(1);
      expect(toManager()[0]!.text).toBe([
        '<b>Клиент просит отменить заявку</b>', `Заявка <code>${LEAD}</code>: ${HEAD}.`,
        'У заявки нет адресата, но по ней записана бронь или отметка «Договорились»: заявка и бронь действуют. Закройте их сами или передайте просьбу тому, кто договаривался.',
      ].join('\n'));
      expect(callsOf(CANCEL_DELIVERY_SQL)).toEqual([['702', 'no_addressee', 'told']]);
    }
    h.query.mockClear();
    h.alert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'нет чата' });
    world.reads = [baseLead({ operator_id: null, status: 'converted', answered: true })];
    expect((await yes()).text).toBe('По заявке уже есть договорённость, поэтому сразу она не отменяется, а передать просьбу менеджеру Ведара сейчас не удалось. Заявка остаётся в силе — нажмите ещё раз через пару минут.');
    expect(callsOf(CANCEL_REQUEST_UNDELIVERED_SQL)).toEqual([['702', 'no_addressee', 'failed']]);
    expect(callsOf(CANCEL_DELIVERY_SQL)).toHaveLength(0);
    spy.mockRestore();
  });

  it('зависшая без исхода просьба (старше срока) место освобождает — и новая уходит; свежая и дошедшая не освобождаются', async () => {
    world.reads = [baseLead({ answered: true, cancel_request: mark(null, null, false) })];
    const r = await yes();
    expect(r.text).toMatch(/просьба ему отправлена/);
    expect(callsOf(CANCEL_REQUEST_RELEASE_SQL)).toEqual([[LEAD]]);
    const order = h.query.mock.calls.map(([s]) => s).filter((s) => s === CANCEL_REQUEST_RELEASE_SQL || s === CANCEL_REQUEST_SQL);
    expect(order).toEqual([CANCEL_REQUEST_RELEASE_SQL, CANCEL_REQUEST_SQL]);
    expect(toOperator()).toHaveLength(1);
    // Не дошедшая ни оператору, ни менеджеру, но с записанным исходом — та же «зависшая».
    h.query.mockClear();
    world.reads = [baseLead({ answered: true, cancel_request: mark('unknown', 'failed', false) })];
    await yes();
    expect(callsOf(CANCEL_REQUEST_RELEASE_SQL)).toEqual([[LEAD]]);
    // Обычная первая просьба ничего не освобождает.
    h.query.mockClear();
    world.reads = [baseLead({ answered: true })];
    await yes();
    expect(callsOf(CANCEL_REQUEST_RELEASE_SQL)).toHaveLength(0);
    expect(callsOf(CANCEL_REQUEST_SQL)).toHaveLength(1);
  });

  it('сбой записи просьбы — «не удалось», ничего не отправлено', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.reads = [baseLead({ answered: true })];
    world.request = Object.assign(new Error('boom'), { code: '40P01' });
    expect((await yes()).text).toMatch(/^Не удалось отменить заявку — это сбой на нашей стороне\. Ничего не изменено/);
    expect(h.alert).not.toHaveBeenCalled();
    expect(String(spy.mock.calls.at(-1))).toContain('SQLSTATE=40P01');
    spy.mockRestore();
  });

  it('состояние заявки меняется быстрее, чем читается, или перечитать не удалось — «не удалось», а не выдуманный исход', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.now = null;
    world.reads = [baseLead(), baseLead()];
    expect((await yes()).text).toMatch(/^Не удалось отменить заявку/);
    world.reads = [baseLead(), new Error('boom')];
    expect((await yes()).text).toMatch(/^Не удалось отменить заявку/);
    world.reads = [baseLead(), null];
    expect((await yes()).text).toMatch(/^Не удалось отменить заявку/);
    expect(h.alert).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('правило отмены — чистые функции', () => {
  const today = '2027-07-01';
  it('что закрыто: отменена — «уже», отказ и закрытая бронь — «закрыта», прошедшая — «прошла»; дата брони главнее даты заявки', () => {
    expect(cancelBlock(baseLead(), today)).toBeNull();
    expect(cancelBlock(baseLead({ status: 'cancelled' }), today)).toBe('cancelled');
    expect(cancelBlock(baseLead({ status: 'lost' }), today)).toBe('closed');
    for (const b of ['cancelled', 'no_show', 'completed']) expect(cancelBlock(baseLead({ booking_status: b }), today), b).toBe('closed');
    for (const b of ['new', 'confirmed', 'pending_payment']) expect(cancelBlock(baseLead({ booking_status: b }), today), b).toBeNull();
    expect(cancelBlock(baseLead({ date: '2027-06-30' }), today)).toBe('past');
    expect(cancelBlock(baseLead({ date: '2027-07-01' }), today)).toBeNull();
    expect(cancelBlock(baseLead({ date: '2027-06-30', booking_date: '2027-07-02', booking_status: 'confirmed' }), today)).toBeNull();
    expect(cancelBlock(baseLead({ date: '2027-07-20', booking_date: '2027-06-29', booking_status: 'confirmed' }), today)).toBe('past');
    expect(cancelBlock(baseLead({ date: null }), today)).toBeNull();
    expect(cancelBlock(baseLead({ date: 'скоро' }), today)).toBeNull();
  });

  it('сразу или просьбой: бронь и «Договорились» — всегда просьба; иначе без адресата — сразу, с адресатом — по ответу', () => {
    expect(cancelMode(baseLead())).toBe('now');
    expect(cancelMode(baseLead({ answered: true }))).toBe('request');
    expect(cancelMode(baseLead({ operator_id: null, answered: true, status: 'contacted' }))).toBe('now');
    expect(cancelMode(baseLead({ operator_id: null, answered: false }))).toBe('now');
    expect(cancelMode(baseLead({ booking_status: 'new' }))).toBe('request');
    expect(cancelMode(baseLead({ operator_id: null, booking_status: 'confirmed' }))).toBe('request');
    // «Договорились» без адресата: условная отмена её не возьмёт — значит, это просьба, а не вечный «сбой».
    expect(cancelMode(baseLead({ operator_id: null, status: 'converted', answered: true }))).toBe('request');
    expect(cancelMode(baseLead({ status: 'converted', answered: true }))).toBe('request');
  });

  it('прежняя просьба: нет / дошла оператору / только менеджеру / отправляется / зависла', () => {
    expect(priorCancelRequest(baseLead())).toBe('none');
    expect(priorCancelRequest(baseLead({ cancel_request: mark('max', 'not_needed') }))).toBe('operator');
    expect(priorCancelRequest(baseLead({ cancel_request: mark('telegram', 'not_needed', true) }))).toBe('operator');
    expect(priorCancelRequest(baseLead({ cancel_request: mark('none', 'told') }))).toBe('manager');
    expect(priorCancelRequest(baseLead({ cancel_request: mark('unknown', 'told', true) }))).toBe('manager');
    expect(priorCancelRequest(baseLead({ cancel_request: mark('no_addressee', 'told') }))).toBe('manager');
    expect(priorCancelRequest(baseLead({ cancel_request: mark(null, null, true) }))).toBe('pending');
    expect(priorCancelRequest(baseLead({ cancel_request: mark(null, null, false) }))).toBe('stale');
    // Исход записан, но не дошло никому (запись не успела сменить имя) — не «отправлена».
    expect(priorCancelRequest(baseLead({ cancel_request: mark('none', 'failed', false) }))).toBe('stale');
    expect(priorCancelRequest(baseLead({ cancel_request: mark('none', 'failed', true) }))).toBe('pending');
  });

  it('тексты оператору и менеджеру — без имени и телефона по построению: в них только тур, дата и число людей', () => {
    const f = { title: 'A&B', date: '2027-07-15', people: 2 };
    expect(operatorCancelText('cancelled', f)).toContain('Тур «A&amp;B», 15.07.2027, участников 2.');
    expect(operatorCancelText('request', { title: 'Тур', date: null, people: null })).toContain('Тур «Тур».');
    expect(managerCancelText('cancelled', LEAD, f, 'no_addressee')).toContain(`Заявка <code>${LEAD}</code>: Тур «A&amp;B», 15.07.2027, участников 2.`);
    expect(managerCancelText('request', LEAD, f, 'not_told')).toContain('передайте ему просьбу');
    expect(managerCancelText('request', LEAD, f, 'no_addressee')).toContain('записана бронь или отметка «Договорились»: заявка и бронь действуют');
    expect(managerCancelText('cancelled', LEAD, f, 'no_addressee')).toContain('дальше её никому не передаём');
    expect(managerCancelText('cancelled', LEAD, f, 'not_told')).toContain('он может держать места');
  });

  it('ответ человеку на каждый исход — свои слова', () => {
    const head = 'Тур «Горелый»';
    expect(cancelReplyText({ kind: 'already_cancelled' }, head)).toBe('Заявка уже отменена — ничего не изменено.');
    expect(cancelReplyText({ kind: 'closed' }, head)).toBe('Заявка уже закрыта — отменять нечего.');
    expect(cancelReplyText({ kind: 'past' }, head)).toBe('Поездка по заявке уже прошла — отменять нечего.');
    expect(cancelReplyText({ kind: 'failed' }, head)).toMatch(/^Не удалось отменить заявку/);
    expect(cancelReplyText({ kind: 'requested', told: 'unknown', manager: 'told' }, head))
      .toBe('Оператор уже ответил по заявке, поэтому отменяет он. Сообщить ему сейчас не удалось — просьба передана менеджеру Ведара. Заявка остаётся в силе, пока её не закроют; надёжнее написать оператору или позвонить.');
    expect(cancelReplyText({ kind: 'requested', told: 'telegram', manager: 'not_needed' }, head)).toMatch(/просьба ему отправлена/);
    expect(cancelReplyText({ kind: 'requested', told: 'no_addressee', manager: 'told' }, head)).toMatch(/^По заявке уже есть договорённость.*передана менеджеру Ведара/);
    expect(cancelReplyText({ kind: 'request_undelivered', addressee: true }, head)).toMatch(/ни ему, ни менеджеру Ведара/);
    expect(cancelReplyText({ kind: 'request_undelivered', addressee: false }, head)).toMatch(/передать просьбу менеджеру Ведара сейчас не удалось/);
    expect(cancelReplyText({ kind: 'already_requested', via: 'operator' }, head)).toMatch(/уже отправлена оператору/);
    expect(cancelReplyText({ kind: 'already_requested', via: 'manager' }, head)).toMatch(/уже передана менеджеру Ведара/);
    expect(cancelReplyText({ kind: 'already_requested', via: 'pending' }, head)).toMatch(/уже отправляется/);
  });
});

describe('отменённая клиентом заявка у продавца и автоматов', () => {
  it('статус ставит только отмена: его нет среди ручных, среди кнопок продавца и в словаре ручной смены; он не «ждёт» и не «без ответа»', () => {
    expect(LEAD_CLIENT_CANCELLED).toBe('cancelled');
    expect(LEAD_STATUSES).toContain('cancelled');
    expect(MANUAL_LEAD_STATUSES).not.toContain('cancelled');
    expect(OWNER_LEAD_STATUSES).not.toContain('cancelled');
    expect(SETTABLE_LEAD_STATUSES).not.toContain('cancelled');
    expect(UNATTENDED_LEAD_STATUSES).not.toContain('cancelled');
    expect(LEAD_WAITING_STATUSES).not.toContain('cancelled');
  });

  it('продавцу, нажавшему кнопку по такой заявке, сказано, что её отменил клиент; новых отметок ему не предлагают', () => {
    expect(leadAlreadyText('cancelled')).toBe('Заявка уже отмечена: «Отменена клиентом» — ничего не изменено.');
    expect(ownerLeadActionsFor('cancelled')).toEqual([]);
    // У прочих — как было: все отметки, кроме стоящей.
    expect(ownerLeadActionsFor('new')).toEqual(['contacted', 'qualified', 'converted', 'lost']);
    expect(ownerLeadActionsFor('lost')).toEqual(['contacted', 'qualified', 'converted']);
  });

  it('статус для человека и ИИ-агента: состояние «отменена», слова — про клиента, а не про бронь', () => {
    expect(leadState('cancelled', null)).toBe('cancelled');
    expect(CLIENT_CANCELLED_HUMAN).toBe('Заявка отменена клиентом.');
  });

  it('напоминание менеджеру «позвоните сегодня» отменённую клиентом заявку не берёт', () => {
    // SQL — артефакт: судим гейт выборки, а не форму строки.
    const sql = readFileSync(join(process.cwd(), 'app/api/cron/followups/route.ts'), 'utf-8');
    expect(sql).toMatch(/l\.status NOT IN \([^)]*'cancelled'[^)]*\)/);
  });
});
