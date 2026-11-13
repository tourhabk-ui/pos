/**
 * tests/unit/answer-notice.test.ts
 *
 * Сообщение человеку после ответа туроператора кнопкой (план «после отказа»,
 * этап 2б; слово владельца 11.11 «мы доверяем агенту»). Судится вызовом, с
 * подложенными базой, MAX, Telegram, письмом менеджеру и сверкой подписки:
 *  - первое принятое сообщение — доставка, второй канал не трогается,
 *    менеджера не будят;
 *  - чаты не приняли и агента нет — «не доставлено», менеджеру сразу: имя и
 *    телефон только в тексте MAX, в заглушке их нет, и в MAX она не зовёт;
 *  - агент принял уведомление во внеочередной сверке — доставка, менеджер молчит;
 *    не принял — его код; уведомление ему не уходило (вид не изменился, срок,
 *    сбой) — так и названо, а не «не принял» (ревью 2б);
 *  - прочли статус посреди отправки — письма менеджеру нет;
 *  - вид заявки уже не из этого ответа — «пропущено», ничего не отправлено;
 *  - погода — без дат и без «подобрать другой тур»; большая группа — передача;
 *    после «Отказать», у части поездки, у прошедшей поездки и при исчерпанном
 *    лимите смен — без кнопок дат;
 *  - в логах нет id чата, имени и телефона;
 *  - добивка: попытка тратится при разборе, а не при захвате; отложенное по
 *    сроку прогона отпускается; третий обрыв — менеджеру словами «неизвестно»;
 *    заявка переросла ответ — менеджеру не пишем; дошедшее после письма
 *    менеджеру — одна строка «звонить не нужно»;
 *  - худшая строка успевает до срока шага workflow и супервизора;
 *  - машина целиком и прокат (этап 2б-2, слово владельца 12.11 «1 да»): «Не
 *    могу» перевозчика и прокатчика идёт той же отправкой — текст о машине, а
 *    не о туре, без дат и кнопок, без обещания «менеджер свяжется»; слова
 *    заказчика (направление, название машины) в Telegram — без телефона и
 *    почты; ответ сверяется с видом заявки по источнику и номеру;
 *  - другие компании (этап 4а): после «Нет мест» и отказа не по погоде в том же
 *    сообщении названы компании с турами к месту на дату — без ПД, без слов
 *    «лучше» и «дешевле», с подписью порядка; после отказа по погоде, «другой
 *    даты», у большой группы, машины и проката и на прошедшую дату их не читают
 *    вовсе; не прочиталось или не уложилось в срок — сообщение уходит без них.
 * Сам SQL — на настоящем PostgreSQL: tests/integration/request-chat.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Настоящая проверка дат ходит в базу и в сеть; здесь проверяется только то, что отправка
// зовёт именно её, когда подмены нет (ревью 2в: связка по умолчанию была без теста).
const realCheck = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/trips/date-check', () => ({ checkTourDates: (...a: unknown[]) => realCheck.fn(...a) }));
import {
  NOTICE_AGENT_KEYS_SQL, NOTICE_AGENT_TIMEOUT_MS, NOTICE_ATTEMPT_SQL, NOTICE_CLAIM_DUE_SQL, NOTICE_CLEARED_SQL, NOTICE_CONTACT_SQL,
  NOTICE_DELIVERED_SQL, NOTICE_FACTS_SQL, NOTICE_MANAGER_SQL, NOTICE_MANAGER_TIMEOUT_MS, NOTICE_RELEASE_SQL, NOTICE_ROW_WORST_MS,
  NOTICE_RUN_START_BUDGET_MS, NOTICE_SEND_TIMEOUT_MS, NOTICE_SKIPPED_SQL, NOTICE_TARGETS_SQL, NOTICE_UNDELIVERED_SQL,
  NOTICE_BY_VEHICLE_LEAD_SQL, NOTICE_CHAT_TARGETS_MAX, NOTICE_CHECK_CANDIDATES, NOTICE_CHECK_TIMEOUT_MS, NOTICE_DATES, NOTICE_OFFERS_TIMEOUT_MS,
  agentLegCode, deliverAnswerNotice, outcomeOfRow, readVehicleNoticeOutcome, runAnswerNotices, telegramSafeFacts, type NoticeDeps,
} from '@/lib/requests/answer-notice';
import { REQUEST_STATUS_BY_LEAD_SQL, type StatusRow } from '@/lib/mcp/request-status';
import type { NotifyRunResult } from '@/lib/mcp/request-notify';
import {
  DATE_CHECK_SHORT, MANAGER_OFFERS_MAX, NOTICE_TEXT_MAX, dateCheckWords, managerClearedText, managerUndeliveredText, operatorOutcomeLine, touristAnswerText,
  type NoticeFacts,
} from '@/lib/requests/answer-notice-text';
import { SITUATION_FORECAST_DAYS } from '@/lib/trips/situation';
import type { DateCheck } from '@/lib/trips/date-check';
import { parseMyTripDate } from '@/lib/requests/my-trip-ask';
import { unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { MAX_FETCH_TIMEOUT_MS } from '@/lib/max/max-fetch';
import { managerQueueUrl } from '@/lib/manager-queue/link';
import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CHAT_ID = '987654321';
const ROOT = join(__dirname, '..', '..');

interface World {
  row: Record<string, unknown>;
  status: Partial<StatusRow> | null;
  targets: Array<{ channel: 'max' | 'telegram'; chat_id: string; can_pick: boolean }>;
  agents: Array<{ key_id: string }>;
  /** Сколько строк вернёт перевод в «не доставлено» (0 — статус прочли раньше). */
  undeliveredRows: number;
  free: string[];
  /** Что захватит добивка. */
  due: Array<{ id: string; state: string }> | null;
}
let w: World;
const calls: Array<{ sql: string; params: unknown[] }> = [];

const baseRow = () => ({
  id: '501', lead_id: LEAD, answer_id: '77', answer: 'no_seats', decline_reason: null, state: 'pending',
  skipped_reason: null, delivered_via: null, tried: null, attempts: 0, manager_channel: null,
  manager_alerted: false, manager_cleared: false, lead_status: 'new', lead_date: '2027-01-15', people: 3, tour_id: 42,
  tour_title: 'Горелый & кратер', tour_slug: 'gorely', tour_public: true, operator_name: 'Вулканы <Север>',
  trip_part: false, refused_dates: ['2027-01-15'], date_actions: 0,
});
const baseStatus = (): Partial<StatusRow> => ({
  tool_name: 'create_booking_request', lead_id: LEAD, lead_status: 'new', booking_status: null,
  lead_answer: 'no_seats', lead_answer_id: '77', lead_decline_reason: null, lead_group_over: false,
});
/** Итог внеочередной сверки: по умолчанию — разница есть, ушло без ответа. */
const run = (over: Partial<NotifyRunResult> = {}): NotifyRunResult => ({
  status: 'ok', sqlstate: null, subscriptions_live: 1, checked: 1, changed: 1, baseline_unknown: 0, due: 1, delivered: 0,
  receiver_failed: {}, deferred: { run_budget: 0, host_run_budget: 0, host_day_budget: 0, time_budget: 0, host_failed: 0, claimed_elsewhere: 0 },
  disabled: {} as NotifyRunResult['disabled'], deleted_after_retention: 0, reset_reverted: 0, missing_view: 0, record_failed: 0,
  stall: null, duration_ms: 1, ...over,
});

function query(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (sql === NOTICE_FACTS_SQL) return Promise.resolve({ rows: [{ ...w.row }] });
  if (sql === REQUEST_STATUS_BY_LEAD_SQL) return Promise.resolve({ rows: w.status ? [w.status] : [] });
  if (sql === NOTICE_TARGETS_SQL) return Promise.resolve({ rows: w.targets });
  if (sql === NOTICE_AGENT_KEYS_SQL) return Promise.resolve({ rows: w.agents });
  if (sql === NOTICE_DELIVERED_SQL) { w.row.state = 'delivered'; w.row.delivered_via = params[1]; return Promise.resolve({ rows: [{ id: '501' }], rowCount: 1 }); }
  if (sql === NOTICE_UNDELIVERED_SQL) {
    if (w.undeliveredRows > 0) { w.row.state = 'undelivered'; w.row.tried = params[1]; }
    return Promise.resolve({ rows: [], rowCount: w.undeliveredRows });
  }
  if (sql === NOTICE_SKIPPED_SQL) { w.row.state = 'skipped'; w.row.skipped_reason = params[1]; return Promise.resolve({ rows: [], rowCount: 1 }); }
  if (sql === NOTICE_MANAGER_SQL) { w.row.manager_channel = params[1]; return Promise.resolve({ rows: [], rowCount: 1 }); }
  if (sql === NOTICE_CONTACT_SQL) return Promise.resolve({ rows: [{ name: 'Ирина Тестова', phone: '+79995550707' }] });
  if (sql === NOTICE_CLEARED_SQL) { w.row.manager_cleared = true; return Promise.resolve({ rows: [], rowCount: 1 }); }
  if (sql === NOTICE_CLAIM_DUE_SQL) return Promise.resolve({ rows: w.due ?? [{ id: '501', state: w.row.state }] });
  if (sql === NOTICE_ATTEMPT_SQL) { w.row.attempts = Number(w.row.attempts) + 1; return Promise.resolve({ rows: [{ attempts: w.row.attempts }], rowCount: 1 }); }
  if (sql === NOTICE_RELEASE_SQL) return Promise.resolve({ rows: [], rowCount: (params[0] as unknown[]).length });
  return Promise.reject(new Error(`неожиданный запрос: ${sql.slice(0, 60)}`));
}

const sendMax = vi.fn();
const sendTelegram = vi.fn();
const pdAlert = vi.fn();
const notifyRun = vi.fn();
const freeDates = vi.fn();
/** Проверка дат после отказа по погоде (2в): по умолчанию причина отказа видна, все свободные даты проходят. */
const checkDates = vi.fn();
const confirmed = (over: Partial<Extract<DateCheck, { state: 'confirmed' }>> = {}): DateCheck => ({
  state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [], risk: 0, unchecked: 0, beyond: 0,
  place: 'Горелый', zoneAssessed: true, ...over,
});
/** Другие компании к месту на дату (4а): по умолчанию их нет — прежние сообщения те же. */
const otherOffers = vi.fn();
const deps = (): NoticeDeps => ({ query, sendMax, sendTelegram, pdAlert, notifyRun, freeDates, checkDates, otherOffers });
const ran = (sql: string) => calls.filter((c) => c.sql === sql);
const managerText = () => (pdAlert.mock.calls[0]![0] as { text: string; stub: string });

beforeEach(() => {
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
  calls.length = 0;
  for (const f of [sendMax, sendTelegram, pdAlert, notifyRun, freeDates, checkDates, otherOffers]) f.mockReset();
  otherOffers.mockResolvedValue({ state: 'none' });
  checkDates.mockImplementation(async (_tour: number, _declined: string, dates: readonly string[]) => confirmed({ clear: [...dates].sort() }));
  w = {
    row: baseRow(), status: baseStatus(), targets: [{ channel: 'max', chat_id: CHAT_ID, can_pick: true }],
    agents: [], undeliveredRows: 1, free: ['2027-01-14', '2027-01-18'], due: null,
  };
  sendMax.mockResolvedValue({ ok: true });
  sendTelegram.mockResolvedValue({ ok: true });
  pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  notifyRun.mockResolvedValue(run());
  freeDates.mockImplementation(async () => ({ state: 'ok', dates: w.free.map((d) => ({ date: d, free: 5 })), hasCalendar: true }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('доставка в нажатии оператора', () => {
  it('MAX принял: доставлено, менеджера не будят; текст — дата, вывеска, даты рядом кнопками «Изменить дату»', async () => {
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toEqual({ state: 'delivered', via: 'max', dates: ['2027-01-14', '2027-01-18'] });
    expect(pdAlert).not.toHaveBeenCalled();
    expect(ran(NOTICE_DELIVERED_SQL)[0]!.params).toEqual(['501', 'max', null]);
    const [chat, text, buttons] = sendMax.mock.calls[0] as [string, string, Array<{ text: string; payload: string }>];
    expect(chat).toBe(CHAT_ID);
    // Шапка кончается одной точкой: «3 чел.» уже с ней (до 12.11 стояло «3 чел..»).
    expect(text).toContain('Тур «Горелый &amp; кратер», 15.01.2027, 3 чел.\n');
    expect(text).not.toContain('чел..');
    expect(text).toContain('Оператор «Вулканы &lt;Север&gt;» ответил: на эту дату мест нет.');
    expect(text).toContain('по календарю тура на Ведаре: 14.01, 18.01');
    expect(text).toContain('сразу встанет в заявку');
    expect(text).not.toMatch(/Ирина|79995550707/);
    // Даты — подписанные кнопки «Изменить дату» этой заявки; рядом с датой заявки, без неё и без отказанных.
    const picks = buttons.filter((b) => b.text !== 'Другие даты').map((b) => unwrapPress(b.payload));
    expect(picks.map((p) => (p.ok ? parseMyTripDate(p.payload) : null))).toEqual([
      { kind: 'pick', leadId: LEAD, date: '2027-01-14' }, { kind: 'pick', leadId: LEAD, date: '2027-01-18' },
    ]);
    expect(freeDates).toHaveBeenCalledWith(42, 3, '2027-01-15', ['2027-01-15', '2027-01-15'], 4);
  });

  it('первый чат принял — второй не трогается; первый не принял — второй пробуется, код в «куда пробовали»', async () => {
    w.targets = [{ channel: 'max', chat_id: CHAT_ID, can_pick: true }, { channel: 'telegram', chat_id: '555', can_pick: false }];
    await deliverAnswerNotice('501', deps());
    expect(sendTelegram).not.toHaveBeenCalled();

    w = { ...w, row: baseRow() };
    calls.length = 0;
    sendMax.mockResolvedValueOnce({ ok: false, code: 'api_error' });
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toMatchObject({ state: 'delivered', via: 'telegram' });
    expect(ran(NOTICE_DELIVERED_SQL)[0]!.params).toEqual(['501', 'telegram', 'max:api_error']);
    // В Telegram без кнопок дат: этот чат не вправе менять дату заявки.
    expect(sendTelegram.mock.calls[0]![2]).toEqual([]);
  });

  it('чаты не приняли, агента нет: не доставлено, менеджеру сразу; имя и телефон — только в тексте MAX; об агенте — ни слова неправды', async () => {
    sendMax.mockResolvedValue({ ok: false, code: 'bad_id' });
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toEqual({ state: 'undelivered', manager: 'max', why: { broken: false, chat: 'refused', agent: 'none' } });
    expect(notifyRun).not.toHaveBeenCalled();
    expect(pdAlert).toHaveBeenCalledTimes(1);
    const sent = pdAlert.mock.calls[0]![0] as { text: string; stub: string; to?: unknown; buttons?: Array<{ text: string; url: string }> };
    expect(sent.to).toBeUndefined();
    // Недоставленный отказ стоит в очереди менеджера (этап 3б): первая кнопка ведёт туда, где отметка «Взял».
    expect(sent.buttons?.map((b) => b.text)).toEqual(['Очередь менеджера', 'Заявки в админке']);
    expect(sent.buttons?.[0]?.url).toBe(managerQueueUrl());
    expect(sent.text).toContain('+79995550707');
    expect(sent.text).toContain('Ирина Тестова');
    expect(sent.text).toContain('MAX не принял (bad_id); подписки ИИ-агента нет.');
    // Строка заявки кончается одной точкой — и в письме, и в заглушке.
    expect(sent.text).toContain('15.01.2027, 3 чел.\n');
    expect(sent.stub).toContain('15.01.2027, 3 чел. Ответ оператора');
    expect(`${sent.text}${sent.stub}`).not.toContain('чел..');
    expect(sent.stub).not.toMatch(/Ирина|79995550707/);
    expect(ran(NOTICE_MANAGER_SQL)[0]!.params).toEqual(['501', 'max']);
    const line = operatorOutcomeLine(o);
    expect(line).toBe('Туристу сообщить не удалось: чат не принял сообщение. Заявку с телефоном получил менеджер Ведара — он позвонит.');
  });

  it('заглушка менеджеру уходит, когда MAX не принял, — и в MAX за телефоном не зовёт', async () => {
    sendMax.mockResolvedValue({ ok: false, code: 'bad_id' });
    pdAlert.mockResolvedValue({ channel: 'telegram-stub', delivered: true, reason: 'max_failed' });
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toMatchObject({ state: 'undelivered', manager: 'telegram-stub' });
    const { stub } = managerText();
    expect(stub).toContain('MAX не сработал: имя и телефон — в админке');
    expect(stub).not.toMatch(/в MAX/);
    expect(operatorOutcomeLine(o)).toMatch(/номер он видит в админке/);
  });

  it('чатов нет, у ключа живая подписка ИИ-агента: внеочередная сверка приняла — доставка, менеджер молчит', async () => {
    w.targets = [];
    w.agents = [{ key_id: 'k-1' }];
    notifyRun.mockImplementation(async () => { w.row.state = 'delivered'; w.row.delivered_via = 'agent_webhook'; return run({ delivered: 1 }); });
    const o = await deliverAnswerNotice('501', deps());
    expect(notifyRun).toHaveBeenCalledWith(['k-1']);
    expect(o).toEqual({ state: 'delivered', via: 'agent_webhook', dates: [] });
    expect(pdAlert).not.toHaveBeenCalled();
    expect(ran(NOTICE_UNDELIVERED_SQL)).toHaveLength(0);
  });

  it('приёмник агента ответил отказом — его код; прочли статус посреди отправки — письма нет', async () => {
    w.targets = [];
    w.agents = [{ key_id: 'k-1' }];
    notifyRun.mockResolvedValue(run({ receiver_failed: { http_503: 1 } }));
    const o = await deliverAnswerNotice('501', deps());
    expect(ran(NOTICE_UNDELIVERED_SQL)[0]!.params).toEqual(['501', 'agent:http_503']);
    expect(managerText().text).toContain('чата с человеком нет; ИИ-агент уведомления не принял (http_503)');
    expect(operatorOutcomeLine(o)).toMatch(/^Туристу сообщить не удалось: чат с ним не подключён, ИИ-агент уведомления не принял\./);

    w = { ...w, row: baseRow(), undeliveredRows: 0 };
    calls.length = 0;
    pdAlert.mockClear();
    // Перевод в «не доставлено» не прошёл: статус успели прочитать — строка уже «доставлено».
    const q2 = (sql: string, p: unknown[] = []) => {
      if (sql === NOTICE_UNDELIVERED_SQL) { w.row.state = 'delivered'; w.row.delivered_via = 'agent_read'; }
      return query(sql, p);
    };
    const o2 = await deliverAnswerNotice('501', { ...deps(), query: q2 });
    expect(o2).toMatchObject({ state: 'delivered', via: 'agent_read' });
    expect(pdAlert).not.toHaveBeenCalled();
  });

  it('уведомление агенту не уходило (большая группа: его вид «ждёт оператора» и до, и после) — так и сказано, не «не принял»', async () => {
    w.targets = [];
    w.agents = [{ key_id: 'k-1' }];
    w.status = { ...baseStatus(), lead_group_over: true };
    notifyRun.mockResolvedValue(run({ changed: 0, due: 0 }));
    const o = await deliverAnswerNotice('501', deps());
    expect(ran(NOTICE_UNDELIVERED_SQL)[0]!.params).toEqual(['501', 'agent:no_change']);
    expect(o).toMatchObject({ state: 'undelivered', why: { agent: 'not_sent' } });
    expect(managerText().text).toContain('ИИ-агенту уведомление не ушло: в его виде заявки ничего не изменилось');
    expect(managerText().text).not.toMatch(/не принял/);
    const line = operatorOutcomeLine(o);
    expect(line).toContain('ИИ-агенту уведомление не ушло');
    expect(line).not.toMatch(/не принял/);
  });

  it('сверка агента не уложилась в срок — «slow», и письмо менеджеру не ждёт её дольше срока', async () => {
    vi.useFakeTimers();
    w.targets = [];
    w.agents = [{ key_id: 'k-1' }];
    notifyRun.mockImplementation(() => new Promise(() => {}));
    const p = deliverAnswerNotice('501', deps());
    await vi.advanceTimersByTimeAsync(NOTICE_AGENT_TIMEOUT_MS);
    const o = await p;
    expect(ran(NOTICE_UNDELIVERED_SQL)[0]!.params).toEqual(['501', 'agent:slow']);
    expect(o).toMatchObject({ state: 'undelivered', manager: 'max' });
  });

  it('письмо менеджеру зависло — через срок «не дошло», и добивка повторит', async () => {
    vi.useFakeTimers();
    w.targets = [];
    pdAlert.mockImplementation(() => new Promise(() => {}));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = deliverAnswerNotice('501', deps());
    await vi.advanceTimersByTimeAsync(NOTICE_MANAGER_TIMEOUT_MS);
    const o = await p;
    spy.mockRestore();
    expect(o).toMatchObject({ state: 'undelivered', manager: 'none' });
    expect(ran(NOTICE_MANAGER_SQL)[0]!.params).toEqual(['501', 'none']);
  });

  it('вид заявки уже не из этого ответа (бронь) — пропущено, никому ничего', async () => {
    w.status = { ...baseStatus(), booking_status: 'confirmed' };
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toEqual({ state: 'skipped', reason: 'outgrown' });
    expect(sendMax).not.toHaveBeenCalled();
    expect(pdAlert).not.toHaveBeenCalled();
    expect(ran(NOTICE_SKIPPED_SQL)[0]!.params).toEqual(['501', 'outgrown']);
  });

  describe('отказ «погода или безопасность» (2в): только даты, прошедшие проверку', () => {
    const weather = () => {
      w.row = { ...baseRow(), answer: 'decline', decline_reason: 'weather', refused_dates: [], weather_refused_dates: [] };
      w.status = { ...baseStatus(), lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: 'weather' };
    };
    const sentText = () => (sendMax.mock.calls[0] as [string, string, unknown[]]);
    /** Ни одной даты и ни слова «безопасно» — в любом сообщении без названных дат. */
    const noDates = (text: string) => {
      // Дата самой заявки стоит в шапке — других дат в сообщении быть не должно.
      expect(text.replace('15.01.2027', '')).not.toMatch(/\d\d\.\d\d|безопасн(?:о|ы|а|ая|ые)(?![а-яё])|Подобрать другой тур/);
      expect(text).toContain('на эту дату — погода или безопасность. Решение о выезде за оператором.');
      expect(text).toMatch(/Экстренный вызов — 112\.$/);
    };
    const again = () => {
      sendMax.mockClear();
      w.row = { ...w.row, state: 'pending' };
    };

    it('данные видят причину отказа: она названа, даты — только прошедшие проверку, что проверено — словами; без кнопок, с 112', async () => {
      weather();
      w.free = ['2027-01-13', '2027-01-14', '2027-01-16', '2027-01-18', '2027-01-20'];
      checkDates.mockResolvedValue(confirmed({ clear: ['2027-01-14', '2027-01-18'], risk: 1, unchecked: 1, beyond: 1 }));
      const o = await deliverAnswerNotice('501', deps());
      const [, text, buttons] = sentText();
      expect(text).toContain('на эту дату — погода или безопасность. Решение о выезде за оператором.');
      // Объяснение замены — то, что данные Ведара называют опасным на дату заявки.
      expect(text).toContain('По данным Ведара на вашу дату: погода: ветер до 90 км/ч.');
      expect(text).toContain('Вместо неё называю свободные по календарю тура, на которые Ведар сейчас не нашёл ни опасной погоды в прогнозе, ни предупреждений: 14.01, 18.01.');
      // «На дату» и «на сейчас» названы порознь: статус места и оценка зоны о дате не говорят.
      // Предупреждения — «уже выпущенные» и «по главному месту»: на дни вперёд их могли ещё не выпустить, чужое место не проверялось.
      expect(text).toContain('Проверено: прогноз погоды на дату и уже выпущенные официальные предупреждения по главному месту тура («Горелый»); статус места и оценка опасности зоны — на сейчас.');
      expect(text).toContain('Это не обещание погоды и не разрешение на выезд');
      expect(text).toContain('Другие свободные даты рядом не называю: с опасной погодой или действующим предупреждением — 1, вне прогноза — 1, проверить не удалось — 1.');
      expect(text).toContain('https://');
      expect(text).toMatch(/Экстренный вызов — 112\.$/);
      // Ни одной даты, не прошедшей проверку; слова «безопасно» нет.
      expect(text).not.toMatch(/13\.01|16\.01|20\.01|безопасн(?:о|ы|а|ая|ые)(?![а-яё])|Подобрать другой тур/);
      expect(buttons).toEqual([]);
      // Кандидатов берётся больше, чем показывается: часть отсеет проверка.
      expect(freeDates).toHaveBeenCalledWith(42, 3, '2027-01-15', ['2027-01-15'], NOTICE_CHECK_CANDIDATES);
      // Проверке уходят тур, дата отказа и свободные даты — о человеке ничего.
      expect(checkDates).toHaveBeenCalledWith(42, '2027-01-15', w.free, { now: undefined });
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: ['2027-01-14', '2027-01-18'], check: 'confirmed' });
      // Даты названы — слов «других дат не назвал» в строке оператору нет.
      expect(operatorOutcomeLine(o)).toBe('Туристу ушло сообщение в MAX: ваш ответ и свободные даты рядом, на которые Ведар не нашёл ни опасной погоды в прогнозе, ни предупреждений по месту (14.01.2027, 18.01.2027); выезд на них подтверждаете вы.');
    });

    it('оценка зоны не входила в проверку — в словах её нет; чужой текст из сводки экранирован, пунктов — не больше трёх', async () => {
      weather();
      checkDates.mockResolvedValue(confirmed({
        clear: ['2027-01-14'], zoneAssessed: false, place: 'Мыс <Маячный>',
        risks: ['официальное предупреждение: Шторм <b>сильный</b>', 'погода: ветер до 90 км/ч', 'погода: туман', 'ещё одно', 'и ещё'],
      }));
      await deliverAnswerNotice('501', deps());
      const text = sentText()[1];
      expect(text).toContain('Проверено: прогноз погоды на дату и уже выпущенные официальные предупреждения по главному месту тура («Мыс &lt;Маячный&gt;»); статус места — на сейчас.');
      expect(text).not.toContain('оценка опасности зоны');
      expect(text).toContain('По данным Ведара на вашу дату: официальное предупреждение: Шторм &lt;b&gt;сильный&lt;/b&gt;; погода: ветер до 90 км/ч; погода: туман и ещё 2.');
      expect(text).not.toContain('<b>сильный</b>');
    });

    it('длинный пункт причины обрезается до 200 знаков — чужой заголовок сообщение не раздувает', async () => {
      weather();
      checkDates.mockResolvedValue(confirmed({ clear: ['2027-01-14'], risks: [`официальное предупреждение: ${'я'.repeat(300)}`] }));
      await deliverAnswerNotice('501', deps());
      const text = sentText()[1];
      const item = /По данным Ведара на вашу дату: (.+?)\. Вместо неё/.exec(text)![1];
      expect(item).toHaveLength(200);
      expect(item.endsWith('…')).toBe(true);
    });

    it('в данных Ведара причина отказа не отражена — дат нет: оператор знает больше; оператору сказано, что туриста отправили к нему', async () => {
      weather();
      checkDates.mockResolvedValue({ state: 'unconfirmed', place: 'Горелый', zoneAssessed: true });
      const o = await deliverAnswerNotice('501', deps());
      const text = sentText()[1];
      noDates(text);
      expect(text).toContain('Других дат не предлагаю: в данных Ведара причина отказа не отражена (проверено: прогноз погоды на дату и уже выпущенные официальные предупреждения по главному месту тура («Горелый»); статус места и оценка опасности зоны — на сейчас)');
      expect(text).toContain('оператор знает то, чего в этих данных нет, и назвать другую дату проверенной по ним нельзя. О других датах спросите его: контакты на странице тура https://');
      // Ведар не спорит с оператором: слов «опасного не видно» о дате отказа нет.
      expect(text).not.toMatch(/опасного не видно|не опасн/);
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: [], check: 'unconfirmed' });
      expect(operatorOutcomeLine(o)).toBe('Туристу ушло сообщение в MAX: ваш ответ. Других дат Ведар туристу не назвал: причины вашего отказа он по своим данным назвать не может — туристу сказано спросить о датах у вас.');
    });

    it('на дату заявки действует постоянный режим — он назван как есть, причиной не объявлен; дат нет', async () => {
      weather();
      checkDates.mockResolvedValue({ state: 'unconfirmed', place: 'Горелый', zoneAssessed: false, standing: ['Проезд по <b>пропускам</b>'] });
      const o = await deliverAnswerNotice('501', deps());
      let text = sentText()[1];
      noDates(text);
      // Чужой заголовок экранирован; о причине сказано «не знаю», а не «вот причина» и не «причины нет».
      expect(text).toContain('Других дат не предлагаю: на вашу дату по данным Ведара действует предупреждение «Проезд по &lt;b&gt;пропускам&lt;/b&gt;» — причина ли это отказа, Ведар не знает (проверено: прогноз погоды на дату и уже выпущенные официальные предупреждения по главному месту тура («Горелый»); статус места — на сейчас). Назвать другую дату проверенной по этим данным нельзя. О других датах спросите оператора: контакты на странице тура https://');
      expect(text).not.toMatch(/причина отказа не отражена|По данным Ведара на вашу дату:|опасного не видно|не опасн/);
      expect(text).toContain('Экстренный вызов — 112.');
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: [], check: 'unconfirmed' });

      // Несколько — не больше трёх, остальные числом; длинный заголовок обрезан до 200 знаков.
      checkDates.mockResolvedValue({ state: 'unconfirmed', place: 'Горелый', zoneAssessed: true, standing: ['Первое', 'Второе', 'я'.repeat(300), 'Четвёртое', 'Пятое'] });
      again();
      await deliverAnswerNotice('501', deps());
      text = sentText()[1];
      expect(text).toContain(`действуют предупреждения «Первое», «Второе», «${'я'.repeat(199)}…» и ещё 2 — причина ли это отказа, Ведар не знает`);
      expect(text).not.toMatch(/Четвёртое|Пятое/);
    });

    it('проверка вернула «чисто», но причину отказа данные не видят — даты всё равно не называются', async () => {
      weather();
      // Такого ответа настоящая проверка не даёт; отправка не должна зависеть от её аккуратности.
      checkDates.mockResolvedValue({ state: 'unconfirmed', place: 'Горелый', zoneAssessed: true, clear: ['2027-01-14'] } as DateCheck);
      const o = await deliverAnswerNotice('501', deps());
      noDates(sentText()[1]);
      expect(o).toMatchObject({ dates: [] });
    });

    it('место или зона сейчас опасны; дата вне прогноза или прошла; данных для проверки нет; проверить не удалось — каждое своими словами, туристу и оператору', async () => {
      weather();
      const cases: Array<[DateCheck, string, string]> = [
        [{ state: 'place_risk', place: 'Горелый', level: 'closed' }, 'главное место тура «Горелый» сейчас отмечено закрытым — пока это так, назвать другую дату проверенной нельзя', 'главное место тура сейчас закрыто либо в жёлтом или красном статусе'],
        [{ state: 'place_risk', place: 'Горелый', level: 'yellow' }, 'главное место тура «Горелый» сейчас в статусе ЖЁЛТЫЙ', 'главное место тура сейчас закрыто либо в жёлтом или красном статусе'],
        [{ state: 'zone_risk', zone: 'Авачинская <группа>', level: 'high' }, 'опасность в зоне «Авачинская &lt;группа&gt;» сейчас оценена как высокая — пока это так, назвать другую дату проверенной нельзя. Позже о дате можно спросить здесь, в чате.', 'опасность в зоне тура сейчас оценена не ниже высокой'],
        [{ state: 'zone_risk', zone: 'Северная группа', level: 'critical' }, 'опасность в зоне «Северная группа» сейчас оценена как критическая', 'опасность в зоне тура сейчас оценена не ниже высокой'],
        [{ state: 'beyond' }, `ваша дата вне прогноза, и проверить, чем она опасна и чем от неё отличаются соседние, Ведару нечем. Прогноз есть только на ${SITUATION_FORECAST_DAYS} суток, считая сегодня`, 'дата заявки дальше прогноза'],
        [{ state: 'past' }, 'дата заявки уже прошла, и сверить её с прогнозом нельзя. О новой дате можно спросить здесь, в чате.', 'дата заявки уже прошла'],
        [{ state: 'no_data', missing: ['place'] }, 'у Ведара нет данных, чтобы проверить место этого тура. О других датах спросите оператора: контакты на странице тура https://', 'у тура на Ведаре не хватает данных для проверки (координаты, главное место со сводками и зоной); туристу сказано спросить о датах у вас'],
        [{ state: 'unchecked', why: ['статус главного места устарел'] }, 'проверить обстановку на вашу дату сейчас не удалось. Позже о дате можно спросить здесь, в чате.', 'проверить обстановку сейчас не удалось'],
      ];
      for (const [check, words, toOperator] of cases) {
        again();
        checkDates.mockResolvedValue(check);
        const o = await deliverAnswerNotice('501', deps());
        const text = sentText()[1];
        noDates(text);
        expect(text, check.state).toContain(`Других дат не предлагаю: ${words}`);
        expect(o, check.state).toEqual({ state: 'delivered', via: 'max', dates: [], check: check.state });
        // Оператор читает не голое «ваш ответ.», а что туристу сказано о других датах.
        expect(operatorOutcomeLine(o), check.state).toBe(`Туристу ушло сообщение в MAX: ваш ответ. Других дат Ведар туристу не назвал: ${toOperator}.`);
      }
      // Прошедшей дате не говорят «ближе к дате», и про прогноз — только когда дело в нём.
      expect(sentText()[1]).not.toContain('устарел');
      again();
      checkDates.mockResolvedValue({ state: 'past' });
      await deliverAnswerNotice('501', deps());
      expect(sentText()[1]).not.toMatch(/ближе к дате|Прогноз есть только/);
    });

    it('причина видна, но ни одна свободная дата не прошла — сказано, сколько каких; про прогноз — только когда дело в нём', async () => {
      weather();
      checkDates.mockResolvedValue(confirmed({ risk: 2 }));
      await deliverAnswerNotice('501', deps());
      let text = sentText()[1];
      noDates(text);
      expect(text).toContain('По данным Ведара на вашу дату: погода: ветер до 90 км/ч. Других дат не предлагаю: из свободных дат рядом проверку не прошла ни одна (с опасной погодой или действующим предупреждением — 2).');
      expect(text).not.toContain('Прогноз есть только');
      // Причина видна, дат нет — оператору так и сказано.
      expect(operatorOutcomeLine({ state: 'delivered', via: 'max', dates: [], check: 'confirmed' }))
        .toBe('Туристу ушло сообщение в MAX: ваш ответ. Других дат Ведар туристу не назвал: из свободных рядом проверку по прогнозу и предупреждениям не прошла ни одна.');

      again();
      checkDates.mockResolvedValue(confirmed({ risk: 1, beyond: 3, unchecked: 1 }));
      await deliverAnswerNotice('501', deps());
      text = sentText()[1];
      noDates(text);
      expect(text).toContain('проверку не прошла ни одна (с опасной погодой или действующим предупреждением — 1, вне прогноза — 3, проверить не удалось — 1).');
      expect(text).toContain(`Прогноз есть только на ${SITUATION_FORECAST_DAYS} суток, считая сегодня; ближе к дате о дате можно спросить здесь, в чате.`);

      again();
      checkDates.mockResolvedValue(confirmed());
      await deliverAnswerNotice('501', deps());
      expect(sentText()[1]).toContain('Других свободных дат рядом, которые можно проверить, нет.');
    });

    it('без подмены отправка зовёт настоящую проверку дат — с туром, датой отказа, свободными датами и числом людей', async () => {
      weather();
      realCheck.fn.mockReset();
      realCheck.fn.mockResolvedValue(confirmed({ clear: ['2027-01-18'] }));
      const { checkDates: _omit, ...withoutStub } = deps();
      const o = await deliverAnswerNotice('501', withoutStub);
      expect(realCheck.fn).toHaveBeenCalledTimes(1);
      expect(realCheck.fn).toHaveBeenCalledWith(42, '2027-01-15', ['2027-01-14', '2027-01-18'], { now: undefined });
      expect(checkDates).not.toHaveBeenCalled();
      expect(o).toMatchObject({ dates: ['2027-01-18'], check: 'confirmed' });
    });

    it('дата, которой нет среди свободных, не называется, даже если проверка её вернула', async () => {
      weather();
      checkDates.mockResolvedValue(confirmed({ clear: ['2027-01-14', '2027-02-01'] }));
      const o = await deliverAnswerNotice('501', deps());
      expect(sentText()[1]).toContain('ни предупреждений: 14.01.');
      expect(sentText()[1]).not.toMatch(/01\.02/);
      expect(o).toMatchObject({ dates: ['2027-01-14'] });
    });

    it('прошло больше, чем показывается, — ближайшие к дате заявки, по возрастанию', async () => {
      weather();
      w.free = ['2027-01-09', '2027-01-11', '2027-01-13', '2027-01-14', '2027-01-16', '2027-01-17', '2027-01-21', '2027-01-25'];
      const o = await deliverAnswerNotice('501', deps());
      expect(NOTICE_DATES).toBe(4);
      expect(o).toMatchObject({ dates: ['2027-01-13', '2027-01-14', '2027-01-16', '2027-01-17'], check: 'confirmed' });
    });

    it('даты, по которым на этом туре уже отказывали по погоде, не проверяются и не называются — но и «в календаре дат нет» про них не говорится', async () => {
      weather();
      w.free = ['2027-01-13', '2027-01-14', '2027-01-16', '2027-01-18'];
      w.row = { ...w.row, weather_refused_dates: ['2027-01-14', '2027-01-16', '2027-03-01'] };
      // Проверка вернула «чисто» и по отказанной дате — отправка её всё равно не называет.
      checkDates.mockResolvedValue(confirmed({ clear: ['2027-01-13', '2027-01-14', '2027-01-18'] }));
      const o = await deliverAnswerNotice('501', deps());
      // Календарь читается без этого отсева: иначе свободные даты сошли бы за «дат нет».
      // …и с запасом на отказанные даты: три будущих отказа — на три даты шире.
      expect(freeDates).toHaveBeenCalledWith(42, 3, '2027-01-15', ['2027-01-15'], NOTICE_CHECK_CANDIDATES + 3);
      expect(checkDates).toHaveBeenCalledWith(42, '2027-01-15', ['2027-01-13', '2027-01-18'], { now: undefined });
      const text = sentText()[1];
      expect(text).toContain('ни предупреждений: 13.01, 18.01.');
      expect(text).not.toMatch(/14\.01|16\.01/);
      expect(text).toContain('Другие свободные даты рядом не называю: уже был отказ по погоде или безопасности — 2.');
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: ['2027-01-13', '2027-01-18'], check: 'confirmed' });
    });

    it('запас на отказанные даты — только будущие; проверке уходит не больше восьми ближайших к дате заявки', async () => {
      weather();
      const now = () => Date.parse('2027-01-12T03:00:00Z');
      // Одиннадцать свободных; две — с прежним отказом по погоде, ещё один отказ — в прошлом и календаря не касается.
      w.free = ['2027-01-13', '2027-01-14', '2027-01-16', '2027-01-17', '2027-01-18', '2027-01-19', '2027-01-20', '2027-01-21', '2027-01-22', '2027-01-23', '2027-01-24'];
      w.row = { ...w.row, weather_refused_dates: ['2027-01-05', '2027-01-14', '2027-01-16'] };
      await deliverAnswerNotice('501', { ...deps(), now });
      // Восемь ближайших отказанных не должны заслонить девятую свободную: календарь читается шире ровно на будущие отказы.
      expect(freeDates).toHaveBeenCalledWith(42, 3, '2027-01-15', ['2027-01-15'], NOTICE_CHECK_CANDIDATES + 2);
      expect(NOTICE_CHECK_CANDIDATES).toBe(8);
      // Девять открытых — проверяются восемь ближайших к 15.01; 24.01 — дальше всех.
      expect(checkDates).toHaveBeenCalledWith(42, '2027-01-15',
        ['2027-01-13', '2027-01-17', '2027-01-18', '2027-01-19', '2027-01-20', '2027-01-21', '2027-01-22', '2027-01-23'], { now });
    });

    it('по всем свободным датам рядом уже был отказ по погоде — так и сказано, проверка не зовётся', async () => {
      weather();
      w.free = ['2027-01-14', '2027-01-16'];
      w.row = { ...w.row, weather_refused_dates: ['2027-01-14', '2027-01-16'] };
      const o = await deliverAnswerNotice('501', deps());
      const text = sentText()[1];
      noDates(text);
      expect(text).toContain('Других дат не предлагаю: по свободным датам рядом (2) уже был отказ из-за погоды или безопасности. О других датах спросите оператора: контакты на странице тура https://');
      // Свободные даты в календаре есть — слов «в календаре дат нет» быть не может.
      expect(text).not.toContain('в календаре тура на год вперёд нет');
      expect(checkDates).not.toHaveBeenCalled();
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: [], check: 'weather_refused' });
      expect(operatorOutcomeLine(o)).toBe('Туристу ушло сообщение в MAX: ваш ответ. Других дат Ведар туристу не назвал: по свободным датам рядом уже был отказ по погоде или безопасности; туристу сказано спросить о датах у вас.');
    });

    it('причина видна, дат нет, а часть свободных — с прежним отказом по погоде: это названо числом', async () => {
      weather();
      w.free = ['2027-01-14', '2027-01-16'];
      w.row = { ...w.row, weather_refused_dates: ['2027-01-16'] };
      checkDates.mockResolvedValue(confirmed({ risk: 1 }));
      await deliverAnswerNotice('501', deps());
      noDates(sentText()[1]);
      expect(sentText()[1]).toContain('проверку не прошла ни одна (с опасной погодой или действующим предупреждением — 1, уже был отказ по погоде или безопасности — 1).');
    });

    it('проверка не уложилась в срок или упала — сообщение уходит без дат, причина в логе', async () => {
      weather();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      checkDates.mockImplementation(() => new Promise(() => {}));
      const run = deliverAnswerNotice('501', deps());
      await vi.advanceTimersByTimeAsync(NOTICE_CHECK_TIMEOUT_MS + 1);
      let o = await run;
      vi.useRealTimers();
      noDates(sentText()[1]);
      expect(sentText()[1]).toContain('Других дат не предлагаю: проверить обстановку на вашу дату сейчас не удалось.');
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: [], check: 'unchecked' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('не кончилась (timeout)'));

      again();
      checkDates.mockRejectedValue(new Error('boom'));
      o = await deliverAnswerNotice('501', deps());
      noDates(sentText()[1]);
      expect(o).toMatchObject({ state: 'delivered', dates: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('не кончилась (exception)'));
      warn.mockRestore();
    });

    it('свободных дат нет, календаря нет, даты не прочитались — проверка не зовётся, слова свои', async () => {
      weather();
      w.free = [];
      await deliverAnswerNotice('501', deps());
      expect(sentText()[1]).toContain('Других свободных дат на 3 чел. в календаре тура на год вперёд нет.');

      for (const [answer, words] of [
        [{ state: 'ok', dates: [], hasCalendar: false }, 'Расписания у тура на Ведаре нет — других дат назвать не могу'],
        [{ state: 'failed' }, 'это сбой, а не «дат нет». Других дат не предлагаю.'],
      ] as const) {
        again();
        freeDates.mockResolvedValue(answer);
        await deliverAnswerNotice('501', deps());
        expect(sentText()[1]).toContain(words);
      }
      expect(checkDates).not.toHaveBeenCalled();
    });

    it('тура нет на витрине — дат нет, проверка и календарь не читаются, 112 на месте', async () => {
      weather();
      w.row = { ...w.row, tour_public: false };
      await deliverAnswerNotice('501', deps());
      const text = sentText()[1];
      noDates(text);
      expect(text).toContain('Других дат не предлагаю: назвать можно только проверенную по прогнозу и предупреждениям, а для этой заявки такой проверки нет.');
      expect(text).not.toContain('Прогноз есть только');
      expect(freeDates).not.toHaveBeenCalled();
      expect(checkDates).not.toHaveBeenCalled();
    });

    it('менеджеру при недоставке — проверенные даты названы проверенными', async () => {
      weather();
      w.targets = [];
      checkDates.mockResolvedValue(confirmed({ clear: ['2027-01-14'], unchecked: 1 }));
      await deliverAnswerNotice('501', deps());
      expect(managerText().text).toContain(`Свободные даты рядом, на которые Ведар не нашёл ни опасной погоды, ни предупреждений (${DATE_CHECK_SHORT}): 14.01 — выезд и места подтверждает оператор.`);
      // Зоны в коротком перечне нет: она входит в проверку не у каждого тура.
      expect(DATE_CHECK_SHORT).not.toMatch(/зон/);
      expect(managerText().text).not.toMatch(/18\.01/);
    });

    it('не погода — проверка не зовётся, даты по календарю как раньше, чужие отказы по погоде их не убирают', async () => {
      w.row = { ...baseRow(), weather_refused_dates: ['2027-01-14'] };
      await deliverAnswerNotice('501', deps());
      expect(checkDates).not.toHaveBeenCalled();
      expect(freeDates).toHaveBeenCalledWith(42, 3, '2027-01-15', ['2027-01-15', '2027-01-15'], NOTICE_DATES);
      expect(sentText()[1]).toContain('по календарю тура на Ведаре: 14.01, 18.01');
    });
  });

  it('большая группа после «Нет мест» — «увидят другие операторы», без дат', async () => {
    w.status = { ...baseStatus(), lead_group_over: true };
    await deliverAnswerNotice('501', deps());
    const [, text] = sendMax.mock.calls[0] as [string, string];
    expect(text).toContain('Заявку на группу увидят другие операторы');
    expect(freeDates).not.toHaveBeenCalled();
  });

  it('после «Отказать» и у части поездки — даты текстом, без кнопок «Изменить дату»', async () => {
    w.row = { ...baseRow(), answer: 'decline', decline_reason: 'seats' };
    w.status = { ...baseStatus(), lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: 'seats' };
    await deliverAnswerNotice('501', deps());
    expect(sendMax.mock.calls[0]![2]).toEqual([]);
    expect(sendMax.mock.calls[0]![1]).toContain('Заявку на другую дату можно оставить на странице тура: ');

    w = { ...w, row: { ...baseRow(), trip_part: true }, status: baseStatus() };
    sendMax.mockClear();
    await deliverAnswerNotice('501', deps());
    expect(sendMax.mock.calls[0]![2]).toEqual([]);
  });

  it('поездка уже прошла или лимит смен за сутки исчерпан — даты текстом, без «сразу встанет в заявку» (то же правило, что у нажатия)', async () => {
    // Сегодня по Камчатке — 20.01.2027, заявка — на 15.01.
    const late: NoticeDeps = { ...deps(), now: () => Date.parse('2027-01-20T00:00:00Z') };
    await deliverAnswerNotice('501', late);
    const [, text, buttons] = sendMax.mock.calls[0] as [string, string, unknown[]];
    expect(buttons).toEqual([]);
    expect(text).not.toMatch(/сразу встанет в заявку/);
    expect(text).toContain('по календарю тура на Ведаре: 14.01, 18.01');

    w = { ...w, row: { ...baseRow(), date_actions: 3 } };
    sendMax.mockClear();
    await deliverAnswerNotice('501', { ...deps(), now: () => Date.parse('2027-01-10T00:00:00Z') });
    expect(sendMax.mock.calls[0]![2]).toEqual([]);
    expect(sendMax.mock.calls[0]![1]).not.toMatch(/сразу встанет в заявку/);

    // Граница: две смены за сутки — кнопки ещё есть.
    w = { ...w, row: { ...baseRow(), date_actions: 2 } };
    sendMax.mockClear();
    await deliverAnswerNotice('501', { ...deps(), now: () => Date.parse('2027-01-10T00:00:00Z') });
    expect((sendMax.mock.calls[0]![2] as unknown[]).length).toBe(3);
  });

  it('в логах нет id чата, имени и телефона', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pdAlert.mockResolvedValue({ channel: 'none', delivered: false, reason: `чат ${CHAT_ID} не найден` });
    sendMax.mockResolvedValue({ ok: false, code: `Chat ${CHAT_ID} not found` });
    await deliverAnswerNotice('501', deps());
    const logged = [...spy.mock.calls, ...warn.mock.calls].flat().map(String).join(' ');
    expect(logged).not.toContain(CHAT_ID);
    expect(logged).not.toMatch(/Ирина|79995550707/);
    // Код отправки в «куда пробовали» — тоже без id: CHECK 1424 принял бы только [a-z0-9_:,].
    expect(String(ran(NOTICE_UNDELIVERED_SQL)[0]!.params[1])).toMatch(/^[a-z0-9_:,]+$/);
    expect(String(ran(NOTICE_UNDELIVERED_SQL)[0]!.params[1])).not.toContain(CHAT_ID);
    spy.mockRestore();
    warn.mockRestore();
  });

  it('уже не «ждёт» — повторно не шлёт и называет записанный исход', async () => {
    w.row = { ...baseRow(), state: 'undelivered', tried: 'max:bad_id', manager_channel: 'telegram-stub' };
    expect(await deliverAnswerNotice('501', deps())).toEqual({
      state: 'undelivered', manager: 'telegram-stub', why: { broken: false, chat: 'refused', agent: 'none' },
    });
    expect(sendMax).not.toHaveBeenCalled();
  });
});

describe('нога ИИ-агента — по итогу сверки', () => {
  it('отказ приёмника — его код; не уходило — свой код, у каждой причины свой', () => {
    expect(agentLegCode(run({ receiver_failed: { http_503: 1 } }))).toBe('http_503');
    expect(agentLegCode(run({ receiver_failed: { redirect_301: 1 } }))).toBe('redirect_301');
    expect(agentLegCode(run({ receiver_failed: { 'Bad Thing!': 1 } }))).toBe('not_accepted');
    expect(agentLegCode(run({ status: 'no_encryption', checked: 0, changed: 0 }))).toBe('no_encryption');
    expect(agentLegCode(run({ status: 'db_error' }))).toBe('db_error');
    expect(agentLegCode(run({ delivered: 1 }))).toBe('db_error');
    expect(agentLegCode(run({ checked: 0, changed: 0, missing_view: 1 }))).toBe('no_view');
    expect(agentLegCode(run({ changed: 0, due: 0 }))).toBe('no_change');
    expect(agentLegCode(run({ deferred: { ...run().deferred, claimed_elsewhere: 1 } }))).toBe('claimed_elsewhere');
    expect(agentLegCode(run({ deferred: { ...run().deferred, host_day_budget: 1 } }))).toBe('deferred');
    expect(agentLegCode(run({ due: 0 }))).toBe('retry_later');
    expect(agentLegCode(undefined)).toBe('exception');
  });
});

describe('добивка', () => {
  it('третий обрыв — человеку больше не шлём, менеджеру сразу; «куда пробовали» — «неизвестно», а не «чата нет»', async () => {
    w.row = { ...baseRow(), attempts: 2 };
    const r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ status: 'ok', picked: 1, undelivered: 1 });
    expect(sendMax).not.toHaveBeenCalled();
    expect(ran(NOTICE_UNDELIVERED_SQL)[0]!.params).toEqual(['501', 'retry_exhausted']);
    expect(pdAlert).toHaveBeenCalledTimes(1);
    const { text } = managerText();
    expect(text).toContain('Куда пробовали: отправка несколько раз обрывалась сбоем — дошло ли что-то до человека, неизвестно.');
    expect(text).not.toMatch(/чата с человеком нет|подписки ИИ-агента нет/);
    // Оператору при повторном нажатии — то же «неизвестно», а не «чат не подключён».
    const again = operatorOutcomeLine(outcomeOfRow({ state: 'undelivered', skipped_reason: null, delivered_via: null, tried: 'retry_exhausted', manager_channel: 'max' }));
    expect(again).toMatch(/дошло ли — неизвестно/);
    expect(again).not.toMatch(/не подключён/);
  });

  it('обрыв в первый раз — ещё одна попытка отправки человеку; попытка записана при разборе', async () => {
    const r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ delivered: 1 });
    expect(sendMax).toHaveBeenCalledTimes(1);
    expect(ran(NOTICE_ATTEMPT_SQL)).toHaveLength(1);
    expect(w.row.attempts).toBe(1);
  });

  it('по сроку прогона: новые строки не начинаются, отпускаются без потраченной попытки', async () => {
    w.due = [{ id: '501', state: 'pending' }, { id: '502', state: 'pending' }, { id: '503', state: 'undelivered' }];
    let clock = 0;
    // Первая строка шла долго — до конца шага вторая и третья не успели бы.
    sendMax.mockImplementation(async () => { clock += NOTICE_RUN_START_BUDGET_MS; return { ok: true }; });
    const r = await runAnswerNotices({ ...deps(), now: () => clock });
    expect(r).toMatchObject({ picked: 3, delivered: 1, time_budget: 2 });
    expect(ran(NOTICE_ATTEMPT_SQL).map((c) => c.params[0])).toEqual(['501']);
    expect(ran(NOTICE_RELEASE_SQL)[0]!.params).toEqual([['502', '503']]);
  });

  it('заявка переросла ответ, пока письмо ждало повтора: «ждёт» — пропущено, «не доставлено» — менеджеру не пишем', async () => {
    w.status = { ...baseStatus(), booking_status: 'confirmed' };
    w.row = { ...baseRow(), attempts: 2 };
    let r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ skipped: 1, undelivered: 0 });
    expect(ran(NOTICE_SKIPPED_SQL)[0]!.params).toEqual(['501', 'outgrown']);
    expect(pdAlert).not.toHaveBeenCalled();

    calls.length = 0;
    w.row = { ...baseRow(), state: 'undelivered', tried: 'max:bad_id', manager_channel: 'none' };
    r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ manager_not_needed: 1, manager_retried: 0 });
    expect(ran(NOTICE_MANAGER_SQL)[0]!.params).toEqual(['501', 'not_needed']);
    expect(pdAlert).not.toHaveBeenCalled();
    expect(operatorOutcomeLine(outcomeOfRow({ ...w.row, manager_channel: 'not_needed' } as Parameters<typeof outcomeOfRow>[0])))
      .toMatch(/Заявка с тех пор изменилась — менеджеру её не передавал/);
  });

  it('большую группу передали другим операторам: недошедшее не гаснет — повтор человеку и письмо менеджеру идут (Bugbot к #3263)', async () => {
    // Крон добивки снял адресата: ответа ТЕКУЩЕГО адресата нет, вид «передана» построен из отказа прежнего.
    const handedOff = (): Partial<StatusRow> => ({
      ...baseStatus(), lead_answer: null, lead_answer_id: null, lead_group_over: true, lead_addressed: false,
      lead_declined_by: 'vulkany-sever', lead_declined_answer_id: '77', lead_declined_answer: 'no_seats',
    });
    w.status = handedOff();
    w.row = { ...baseRow(), state: 'undelivered', tried: 'max:bad_id', manager_channel: 'none' };
    let r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ manager_retried: 1, manager_not_needed: 0 });
    expect(pdAlert).toHaveBeenCalledTimes(1);
    expect(ran(NOTICE_MANAGER_SQL).map((c) => c.params[1])).not.toContain('not_needed');

    // «Ждёт» после обрыва: отправка идёт, а не «переросло».
    calls.length = 0;
    pdAlert.mockClear();
    w.row = baseRow();
    r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ delivered: 1, skipped: 0 });
    expect(ran(NOTICE_SKIPPED_SQL)).toHaveLength(0);
    expect(sendMax.mock.calls[0]![1]).toMatch(/увидят другие операторы/);

    // Заявку взял менеджер (contacted) или отказ был по погоде — вид не из этого ответа, письма нет.
    for (const st of [{ ...handedOff(), lead_status: 'contacted' }, { ...handedOff(), lead_declined_answer: 'decline', lead_decline_reason: null, lead_declined_reason: 'weather' }]) {
      calls.length = 0;
      pdAlert.mockClear();
      w.status = st;
      w.row = { ...baseRow(), state: 'undelivered', tried: 'max:bad_id', manager_channel: 'none' };
      r = await runAnswerNotices(deps());
      expect(r).toMatchObject({ manager_not_needed: 1, manager_retried: 0 });
      expect(pdAlert).not.toHaveBeenCalled();
    }
  });

  it('дошло после письма менеджеру — одна строка «звонить не нужно» без ПД; второй прогон её не повторит', async () => {
    w.row = { ...baseRow(), state: 'delivered', delivered_via: 'agent_read', manager_alerted: true, manager_cleared: false, manager_channel: 'max' };
    const r = await runAnswerNotices(deps());
    expect(r.manager_cleared).toBe(1);
    const sent = managerText();
    expect(sent.text).toBe(sent.stub);
    expect(sent.text).toMatch(/звонить не нужно/);
    expect(sent.text).toContain('ИИ-агент прочитал статус');
    expect(ran(NOTICE_CLEARED_SQL)).toHaveLength(1);
    pdAlert.mockClear();
    await runAnswerNotices(deps());
    expect(pdAlert).not.toHaveBeenCalled();
  });

  it('менеджеру не дошло ничего — добивка повторяет письмо, человеку не пишет', async () => {
    w.row = { ...baseRow(), state: 'undelivered', tried: 'max:bad_id', manager_channel: 'none' };
    const r = await runAnswerNotices(deps());
    expect(r.manager_retried).toBe(1);
    expect(pdAlert).toHaveBeenCalledTimes(1);
    expect(sendMax).not.toHaveBeenCalled();
  });
});

describe('срок шага: худшая строка успевает', () => {
  // Сам шаг и супервизор — артефакты: их сроки читаются из файлов, а не повторяются здесь числом.
  const stepMaxTime = () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/cron-safety-heartbeat.yml'), 'utf8');
    const step = wf.split(/^\s*- name:/m).find((s) => s.includes('/api/cron/answer-notices'));
    return Number(step?.match(/--max-time\s+(\d+)/)?.[1]) * 1000;
  };
  const supervisorTimeout = () => {
    const start = readFileSync(join(ROOT, 'start.js'), 'utf8');
    return Number(start.match(/\/api\/cron\/answer-notices',\s*everyMin: \d+,\s*timeoutMs: (\d+)/)?.[1]);
  };

  it('строка, начатая на краю бюджета, кончается до срока шага и супервизора', () => {
    const last = NOTICE_RUN_START_BUDGET_MS + NOTICE_ROW_WORST_MS;
    expect(stepMaxTime()).toBeGreaterThan(last);
    expect(supervisorTimeout()).toBeGreaterThan(last);
  });

  it('число худшего срока в комментариях шага и роута — то же, что в коде', () => {
    const sec = `${NOTICE_ROW_WORST_MS / 1000} с`;
    expect(readFileSync(join(ROOT, '.github/workflows/cron-safety-heartbeat.yml'), 'utf8')).toContain(`# ${sec} (lib/requests/answer-notice, NOTICE_ROW_WORST_MS`);
    expect(readFileSync(join(ROOT, 'app/api/cron/answer-notices/route.ts'), 'utf8')).toContain(`худшая идёт ${sec} (NOTICE_ROW_WORST_MS)`);
  });

  it('худший срок строки длиннее суммы сроков всех её ног, включая проверку дат после отказа по погоде', () => {
    // Строго больше: сверх ног строка ещё ходит в базу.
    expect(NOTICE_ROW_WORST_MS).toBeGreaterThan(
      NOTICE_CHECK_TIMEOUT_MS + NOTICE_CHAT_TARGETS_MAX * NOTICE_SEND_TIMEOUT_MS + NOTICE_AGENT_TIMEOUT_MS + NOTICE_MANAGER_TIMEOUT_MS,
    );
  });

  it('срок отправки в чат длиннее сокетного срока MAX: дошедшее не запишется «не дошло»', () => {
    expect(MAX_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(NOTICE_SEND_TIMEOUT_MS).toBeGreaterThan(MAX_FETCH_TIMEOUT_MS);
  });
});

describe('слова', () => {
  const F: NoticeFacts = {
    leadId: LEAD, answer: 'other_date', reason: null, tourTitle: 'Тур', tourUrl: 'https://vedarai.ru/catalog/tours/t',
    date: '2027-01-15', people: 2, operatorName: 'Оп', groupPassedOn: false,
  };
  it('«Другая дата»: даты — просьбой оператору, а не «встанет в заявку»', () => {
    const m = touristAnswerText(F, { kind: 'dates', dates: ['2027-01-20'] }, true);
    expect(m.text).toContain('предложит другую — напишет или позвонит');
    expect(m.text).toContain('оператор получит вашу просьбу перенести');
    expect(m.text).not.toMatch(/сразу встанет в заявку/);
  });
  it('погода: блок просто свободных дат после такого отказа молчит — непроверенная дата не называется', () => {
    const wf = { ...F, answer: 'decline' as const, reason: 'weather' as const };
    const t = touristAnswerText(wf, { kind: 'dates', dates: ['2027-01-20'] }, true);
    expect(t.text).not.toMatch(/20\.01/);
    expect(t.text).toContain('Других дат не предлагаю: проверить свободные даты сейчас не удалось.');
    expect(t.buttons).toEqual([]);
    // Проверенные даты у других ответов не печатаются: такого блока у них нет.
    const checked = { kind: 'checked' as const, dates: ['2027-01-20'], check: { state: 'confirmed' as const, risks: ['погода: туман'], clear: ['2027-01-20'], risk: 0, unchecked: 0, beyond: 0, place: 'Горелый', zoneAssessed: true } };
    expect(touristAnswerText({ ...F, answer: 'no_seats' }, checked, false).text).not.toMatch(/20\.01|По данным Ведара/);
    // Слова «что проверено» собираются из того, что входило в проверку.
    expect(dateCheckWords({ place: 'Горелый', zoneAssessed: true })).toContain('оценка опасности зоны');
    expect(dateCheckWords({ place: 'Горелый', zoneAssessed: false })).not.toContain('оценка опасности зоны');
    // Менеджеру по обычному отказу — прежние слова, без «не нашёл опасного».
    expect(managerUndeliveredText({ ...F, answer: 'no_seats' }, { name: null, phone: null }, [], ['2027-01-20']).text)
      .toContain('Свободные даты рядом по календарю: 20.01 — места подтверждает оператор.');
  });
  it('сбой дат — «сбой, а не дат нет»; календаря нет — «показать не могу»', () => {
    expect(touristAnswerText({ ...F, answer: 'no_seats' }, { kind: 'failed' }, true).text).toContain('это сбой, а не «дат нет»');
    expect(touristAnswerText({ ...F, answer: 'no_seats' }, { kind: 'no_calendar' }, true).text).toContain('показать не могу');
  });
  it('отказ «Даты не подходят» говорит о «датах ниже», только когда они ниже есть', () => {
    const d = { ...F, answer: 'decline' as const, reason: 'dates' as const };
    expect(touristAnswerText(d, { kind: 'dates', dates: ['2027-01-20'] }, false).text).toContain('даты ниже взяты только из календаря');
    for (const kind of ['skip', 'none', 'no_calendar', 'failed'] as const) {
      const t = touristAnswerText(d, { kind }, false).text;
      expect(t, kind).toContain('отказал по заявке: даты не подходят.');
      expect(t, kind).not.toMatch(/ниже/);
    }
  });
  it('заглушка менеджеру — без ПД и без «в MAX»', () => {
    const m = managerUndeliveredText({ ...F, answer: 'no_seats' }, { name: 'Ирина Тестова', phone: '+79995550707' }, ['max:bad_id'], []);
    expect(m.text).toContain('+79995550707');
    expect(m.stub).not.toMatch(/Ирина|79995550707|в MAX/);
    expect(m.stub).toContain('в админке');
  });
  it('оператору: исход словами для каждого состояния', () => {
    const why = (over: object = {}) => ({ broken: false, chat: 'none' as const, agent: 'none' as const, ...over });
    expect(operatorOutcomeLine({ state: 'delivered', via: 'max', dates: ['2027-01-20'] })).toMatch(/^Туристу ушло сообщение в MAX/);
    expect(operatorOutcomeLine({ state: 'undelivered', manager: 'none', why: why() })).toBe(
      'Туристу сообщить не удалось: чат с ним не подключён. И менеджеру Ведара сейчас не дошло — повторю автоматически. '
        + 'Если можете, позвоните заказчику сами по телефону из заявки.',
    );
    expect(operatorOutcomeLine({ state: 'undelivered', manager: 'max', why: why({ chat: 'refused', agent: 'refused' }) }))
      .toMatch(/^Туристу сообщить не удалось: чат не принял сообщение, ИИ-агент уведомления не принял\./);
    expect(operatorOutcomeLine({ state: 'undelivered', manager: 'max', why: why({ agent: 'not_sent' }) }))
      .toMatch(/^Туристу сообщить не удалось: чат с ним не подключён, ИИ-агенту уведомление не ушло\./);
    expect(operatorOutcomeLine({ state: 'undelivered', manager: 'max', why: why({ broken: true }) })).toMatch(/дошло ли — неизвестно/);
    expect(operatorOutcomeLine({ state: 'skipped', reason: 'lead_closed' })).toMatch(/уже была закрыта/);
    expect(operatorOutcomeLine({ state: 'pending' })).toMatch(/повторю автоматически/);
  });
});

// ── Машина целиком и прокат: «Не могу» (этап 2б-2) ──────────────────────────

const PHONE_IN_TITLE = '+79001112233';
type Vehicle = 'charter' | 'car_rental';

/** Строка сообщения по ответу из журнала заявки: кнопки туроператора у неё нет. */
const vehicleRow = (kind: Vehicle, over: Record<string, unknown> = {}) => ({
  ...baseRow(), answer_id: null, activity_id: '901', answer: 'decline',
  vehicle_kind: kind,
  vehicle_title: kind === 'charter' ? 'Вулкан Горелый <база>' : 'Suzuki Jimny',
  vehicle_from: '2027-01-15', vehicle_to: kind === 'charter' ? '2027-01-16' : '2027-01-17',
  // Перевозчик «Не могу» закрывает заявку, прокатчик статус не меняет.
  lead_status: kind === 'charter' ? 'lost' : 'new',
  lead_date: null, people: null, tour_id: null, tour_title: null, tour_slug: null, tour_public: false,
  operator_name: kind === 'charter' ? 'Шатун' : 'Лагуна Прокат', refused_dates: [],
  ...over,
});
const vehicleStatus = (kind: Vehicle, over: Partial<StatusRow> = {}): Partial<StatusRow> => ({
  tool_name: kind === 'charter' ? 'request_charter' : 'create_car_rental_request', lead_id: LEAD,
  lead_status: kind === 'charter' ? 'lost' : 'new', booking_status: null,
  lead_answer: null, lead_answer_id: null, lead_partner_answer: 'decline', lead_partner_answer_id: '901', lead_kind: kind,
  ...over,
});
const arm = (kind: Vehicle, row: Record<string, unknown> = {}, status: Partial<StatusRow> = {}) => {
  w.row = vehicleRow(kind, row);
  w.status = vehicleStatus(kind, status);
};

describe('машина целиком и прокат: «Не могу» перевозчика и прокатчика', () => {
  it('перевозчик: заказчику одно сообщение о машине — направление, даты, вывеска, где смотреть других; дат рядом и кнопок нет', async () => {
    arm('charter');
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toEqual({ state: 'delivered', via: 'max', dates: [] });
    expect(pdAlert).not.toHaveBeenCalled();
    expect(freeDates).not.toHaveBeenCalled();
    const [chat, text, buttons] = sendMax.mock.calls[0]! as [string, string, unknown[]];
    expect(chat).toBe(CHAT_ID);
    expect(buttons).toEqual([]);
    expect(text.split('\n')).toEqual([
      '<b>Ответ по вашей заявке на машину</b>',
      'Машина под заказ: направление «Вулкан Горелый &lt;база&gt;», с 15.01.2027 по 16.01.2027.',
      'Перевозчик «Шатун» ответил: выполнить заявку не может. Брони не было, машина за вами не закреплялась.',
      expect.stringMatching(/^Другие перевозчики и их цены за машину — https?:\/\/[^ ]+\/transfers; новую заявку можно оставить там же\.$/),
    ]);
    // Обещаний, которых никто не исполняет, и слов о туре в сообщении нет.
    expect(text).not.toMatch(/менеджер|свяжется|тур|оператор/i);
    expect(operatorOutcomeLine(o, 'client')).toBe('Заказчику ушло сообщение в MAX: ваш ответ.');
  });

  it('прокат: текст о прокате и его витрине; выезд без даты возврата и машина без названия названы как есть', async () => {
    arm('car_rental');
    await deliverAnswerNotice('501', deps());
    const text = String(sendMax.mock.calls[0]![1]);
    expect(text).toContain('<b>Ответ по вашей заявке на прокат</b>');
    expect(text).toContain('Прокат: «Suzuki Jimny», с 15.01.2027 по 17.01.2027.');
    expect(text).toContain('Прокат «Лагуна Прокат» ответил: выполнить заявку не может.');
    expect(text).toMatch(/Другие машины проката — https?:\/\/[^ ]+\/car-rental; новую заявку можно оставить там же\.$/);

    // Журнал до 30.10 вида не нёс — это прокат; пустые поля не выдумываются.
    const F0: NoticeFacts = { leadId: LEAD, kind: 'rental', answer: 'decline', reason: null, tourTitle: null, tourUrl: null, date: null, people: null, operatorName: null, groupPassedOn: false };
    expect(touristAnswerText({ ...F0, vehicleFrom: 'завтра' }, { kind: 'skip' }, true).text).toContain('Прокат: машина не названа.');
    expect(touristAnswerText({ ...F0, kind: 'charter', vehicleFrom: '2027-01-15', vehicleTo: '2027-01-15' }, { kind: 'skip' }, true).text)
      .toContain('Машина под заказ: направление не названо, выезд 15.01.2027.');
    arm('car_rental', { vehicle_kind: null });
    sendMax.mockClear();
    await deliverAnswerNotice('501', deps());
    expect(String(sendMax.mock.calls[0]![1])).toContain('на прокат');
  });

  it('направление заявки — свободный ввод заказчика — в Telegram не уходит вовсе: ни в его чат, ни в заглушку менеджеру; в MAX — как есть', async () => {
    // Телефон и почту чистка вырезала бы; адрес и имя — нет. Поэтому в Telegram направления нет совсем.
    const dirty = `Горелый, встретить Петра у дома на Тестовой, ${PHONE_IN_TITLE} или anna@example.com`;
    arm('charter', { vehicle_title: dirty });
    w.targets = [{ channel: 'telegram', chat_id: CHAT_ID, can_pick: false }];
    await deliverAnswerNotice('501', deps());
    const tg = String(sendTelegram.mock.calls[0]![1]);
    expect(tg).toContain('Машина под заказ: направление — в заявке, с 15.01.2027 по 16.01.2027.');
    expect(tg).not.toMatch(/Горелый|Петра|Тестовой|не названо/);
    expect(tg).not.toContain(PHONE_IN_TITLE);
    expect(tg).not.toContain('anna@example.com');

    arm('charter', { vehicle_title: dirty });
    w.targets = [{ channel: 'max', chat_id: CHAT_ID, can_pick: false }];
    sendMax.mockResolvedValue({ ok: false, code: 'bad_id' });
    await deliverAnswerNotice('501', deps());
    // MAX — российский канал с ПД: слова заказчика уходят ему же как есть.
    expect(String(sendMax.mock.calls[0]![1])).toContain(PHONE_IN_TITLE);
    const m = managerText();
    expect(m.text).toContain(PHONE_IN_TITLE);
    expect(m.stub).toContain('машина под заказ — направление — в заявке');
    expect(m.stub).not.toMatch(/Горелый|Петра|Тестовой/);
    expect(m.stub).not.toContain(PHONE_IN_TITLE);
    expect(m.stub).not.toContain('anna@example.com');
    expect(m.stub).not.toMatch(/Ирина|79995550707/);
    // Скрывается только направление; остальные факты те же.
    const f: NoticeFacts = { leadId: LEAD, kind: 'charter', vehicleTitle: dirty, answer: 'decline', reason: null, tourTitle: null, tourUrl: null, date: null, people: null, operatorName: 'Шатун', groupPassedOn: false };
    expect(telegramSafeFacts(f)).toEqual({ ...f, vehicleTitle: null, vehicleTitleHidden: true });
    expect(telegramSafeFacts({ ...f, vehicleTitle: null })).toEqual({ ...f, vehicleTitle: null });
    // Название машины проката — из прайса прокатчика: остаётся, телефон из него на всякий случай вырезается.
    const rental = telegramSafeFacts({ ...f, kind: 'rental', vehicleTitle: `Suzuki Jimny ${PHONE_IN_TITLE}` });
    expect(rental.vehicleTitle).toContain('Suzuki Jimny');
    expect(rental.vehicleTitle).not.toContain(PHONE_IN_TITLE);
    expect(rental.vehicleTitleHidden).toBeUndefined();
  });

  it('до заказчика не дошло: менеджеру сразу — о перевозчике, а не об операторе тура; имя и телефон только в MAX', async () => {
    arm('charter');
    w.targets = [];
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toEqual({ state: 'undelivered', manager: 'max', why: { broken: false, chat: 'none', agent: 'none' } });
    const m = managerText();
    expect(m.text).toContain('<b>Ответ перевозчика не доставлен клиенту — позвонить</b>');
    expect(m.text).toContain('машина под заказ — направление «Вулкан Горелый &lt;база&gt;», с 15.01.2027 по 16.01.2027.');
    expect(m.text).toContain('Ответ перевозчика «Шатун»: выполнить заявку не может.');
    expect(m.text).toContain('Ирина Тестова');
    expect(m.text).toContain('+79995550707');
    expect(m.text).toContain('Брони не было; машина за заказчиком не закреплялась.');
    expect(m.text).not.toMatch(/оператор|Свободные даты/);
    expect(m.stub).toContain('Ответ перевозчика не доставлен клиенту');
    expect(m.stub).not.toMatch(/Ирина|79995550707/);
    expect(operatorOutcomeLine(o, 'client')).toBe('Заказчику сообщить не удалось: чат с ним не подключён. Заявку с телефоном получил менеджер Ведара — он позвонит.');

    arm('car_rental');
    w.targets = [];
    pdAlert.mockClear();
    await deliverAnswerNotice('501', deps());
    expect(managerText().text).toContain('<b>Ответ прокатчика не доставлен клиенту — позвонить</b>');
    expect(managerText().text).toContain('Ответ проката «Лагуна Прокат»: выполнить заявку не может.');
  });

  it('чатов нет, у ключа подписка ИИ-агента: сверка приняла — доставка, менеджер молчит', async () => {
    arm('charter');
    w.targets = [];
    w.agents = [{ key_id: 'k-9' }];
    notifyRun.mockImplementation(async () => { w.row.state = 'delivered'; w.row.delivered_via = 'agent_webhook'; return run({ delivered: 1 }); });
    const o = await deliverAnswerNotice('501', deps());
    expect(notifyRun).toHaveBeenCalledWith(['k-9']);
    expect(o).toEqual({ state: 'delivered', via: 'agent_webhook', dates: [] });
    expect(pdAlert).not.toHaveBeenCalled();
    expect(operatorOutcomeLine(o, 'client')).toBe('Ответ ушёл ИИ-агенту заказчика: его уведомление принято.');
  });

  it('вид заявки уже не из этого ответа — пропущено, никому ничего: статус перерос, ответ другой, источник не тот', async () => {
    const skipped = async () => {
      sendMax.mockClear();
      pdAlert.mockClear();
      const o = await deliverAnswerNotice('501', deps());
      expect(o).toEqual({ state: 'skipped', reason: 'outgrown' });
      expect(sendMax).not.toHaveBeenCalled();
      expect(pdAlert).not.toHaveBeenCalled();
      return o;
    };
    // Прокатчик статус не меняет: заявку успел взять в работу человек.
    arm('car_rental', {}, { lead_status: 'contacted' });
    // Заявку уже вели, сообщение не ушло: об отказе заказчику больше сказать некому — партнёру так и сказано.
    expect(operatorOutcomeLine(await skipped(), 'client')).toBe(
      'Статус заявки уже сменился — заказчику ничего не отправлял. Если он ещё не знает об отказе, сообщите ему сами по телефону из заявки.',
    );
    // У перевозчика «закрыта отказом» — его же статус: вид держится; «в работе» — уже нет.
    arm('charter', {}, { lead_status: 'contacted' });
    await skipped();
    // В журнале уже другая запись ответа.
    arm('charter', {}, { lead_partner_answer_id: '902' });
    await skipped();
    // Тот же номер у ответа другого источника — не совпадение: строка о кнопке туроператора, вид — из журнала.
    w.row = { ...baseRow(), answer_id: '901' };
    w.status = vehicleStatus('charter');
    await skipped();
    // И наоборот: строка о журнале, вид — из кнопки туроператора с тем же номером.
    w.row = vehicleRow('charter');
    w.status = { ...baseStatus(), lead_answer_id: '901' };
    await skipped();
    // Заявки не прочитать — тоже не шлём.
    arm('charter');
    w.status = null;
    await skipped();
  });

  it('статус перевозчику сменить не удалось (заявка ещё «новая») — сообщение всё равно уходит', async () => {
    arm('charter', { lead_status: 'new' }, { lead_status: 'new' });
    expect(await deliverAnswerNotice('501', deps())).toMatchObject({ state: 'delivered', via: 'max' });
  });

  it('добивка: дошло после письма менеджеру — «ответ перевозчика дошёл, звонить не нужно»; заявка переросла — письмо не повторяется', async () => {
    arm('charter', { state: 'delivered', delivered_via: 'page_seen', manager_alerted: true, manager_cleared: false, manager_channel: 'max' });
    const r = await runAnswerNotices(deps());
    expect(r.manager_cleared).toBe(1);
    expect(managerText().text).toMatch(/ответ перевозчика до клиента дошёл \(клиент открыл страницу заявки\) — звонить не нужно/);
    expect(managerClearedText(LEAD, { state: 'delivered', via: 'agent_read', dates: [] }, 'rental')).toContain('ответ прокатчика до клиента дошёл');
    expect(managerClearedText(LEAD, { state: 'delivered', via: 'agent_read', dates: [] })).toContain('ответ оператора до клиента дошёл');

    arm('car_rental', { state: 'undelivered', manager_channel: 'none', tried: null }, { lead_status: 'contacted' });
    pdAlert.mockClear();
    const again = await runAnswerNotices(deps());
    expect(again.manager_not_needed).toBe(1);
    expect(pdAlert).not.toHaveBeenCalled();
    expect(ran(NOTICE_MANAGER_SQL).at(-1)!.params).toEqual(['501', 'not_needed']);

    arm('car_rental', { state: 'undelivered', manager_channel: 'none', tried: null });
    const retry = await runAnswerNotices(deps());
    expect(retry.manager_retried).toBe(1);
    expect(managerText().text).toContain('Ответ прокатчика не доставлен клиенту');
  });

  it('партнёру о заказчике — словом «заказчик», а не «турист», в каждом исходе', () => {
    const why = { broken: false, chat: 'refused' as const, agent: 'refused' as const };
    const lines = [
      operatorOutcomeLine({ state: 'delivered', via: 'telegram', dates: [] }, 'client'),
      operatorOutcomeLine({ state: 'delivered', via: 'agent_read', dates: [] }, 'client'),
      operatorOutcomeLine({ state: 'delivered', via: 'page_seen', dates: [] }, 'client'),
      operatorOutcomeLine({ state: 'undelivered', manager: 'telegram-stub', why }, 'client'),
      operatorOutcomeLine({ state: 'undelivered', manager: 'none', why }, 'client'),
      operatorOutcomeLine({ state: 'skipped', reason: 'lead_closed' }, 'client'),
      operatorOutcomeLine({ state: 'skipped', reason: 'not_addressee' }, 'client'),
      operatorOutcomeLine({ state: 'skipped', reason: 'self' }, 'client'),
      operatorOutcomeLine({ state: 'skipped', reason: 'outgrown' }, 'client'),
      operatorOutcomeLine({ state: 'pending' }, 'client'),
    ];
    for (const l of lines) {
      expect(l, l).toMatch(/[Зз]аказчик/);
      expect(l, l).not.toMatch(/турист|бронь|новый ответ/i);
    }
    expect(lines[1]).toBe('Ваш ответ уже прочитал ИИ-агент заказчика.');
    expect(lines[2]).toBe('Заказчик уже открыл страницу заявки и видит ваш ответ.');
    // У тура слова прежние.
    expect(operatorOutcomeLine({ state: 'skipped', reason: 'outgrown' })).toBe('Статус заявки уже сменился (бронь или новый ответ) — туристу ничего не отправлял.');
  });

  it('повторное нажатие читает исход по заявке; сообщения нет — null, сбой чтения — null и строка в логе', async () => {
    const q = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe(NOTICE_BY_VEHICLE_LEAD_SQL);
      expect(params).toEqual([LEAD]);
      return { rows: [{ state: 'delivered', skipped_reason: null, delivered_via: 'max', tried: null, manager_channel: null }] };
    });
    expect(await readVehicleNoticeOutcome(LEAD, { query: q })).toEqual({ state: 'delivered', via: 'max', dates: [] });
    expect(await readVehicleNoticeOutcome(LEAD, { query: async () => ({ rows: [] }) })).toBeNull();
    // Строку «ждёт» ещё держит захват нажатия — отправка идёт: «не ушло» было бы неправдой за секунду до «ушло».
    const row = (held: boolean | null) => ({ state: 'pending', skipped_reason: null, delivered_via: null, tried: null, manager_channel: null, held });
    expect(await readVehicleNoticeOutcome(LEAD, { query: async () => ({ rows: [row(true)] }) })).toEqual({ state: 'pending', sending: true });
    expect(await readVehicleNoticeOutcome(LEAD, { query: async () => ({ rows: [row(false)] }) })).toEqual({ state: 'pending' });
    expect(await readVehicleNoticeOutcome(LEAD, { query: async () => ({ rows: [row(null)] }) })).toEqual({ state: 'pending' });
    expect(operatorOutcomeLine({ state: 'pending', sending: true }, 'client')).toBe(
      'Сообщение заказчику отправляется; не уйдёт — повторю автоматически, не выйдет — передам менеджеру Ведара.',
    );
    expect(operatorOutcomeLine({ state: 'pending', sending: true })).toMatch(/^Сообщение туристу отправляется;/);
    expect(operatorOutcomeLine({ state: 'pending' }, 'client')).toMatch(/сейчас не ушло/);
    // Захват у доставленной или недоставленной строки на слова не влияет.
    expect(outcomeOfRow({ state: 'delivered', skipped_reason: null, delivered_via: 'max', tried: null, manager_channel: null, held: true })).toEqual({ state: 'delivered', via: 'max', dates: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await readVehicleNoticeOutcome(LEAD, { query: async () => { throw Object.assign(new Error('x'), { code: '57P01' }); } })).toBeNull();
    expect(err.mock.calls.flat().join(' ')).toMatch(/исход сообщения не прочитан, SQLSTATE 57P01/);
    err.mockRestore();
  });
});

describe('другие компании к месту на дату (этап 4а)', () => {
  const FORM_A = 'https://vedarai.ru/catalog/tours/gorely-za-den?date=2027-01-15&guests=3#booking';
  const FORM_B = 'https://vedarai.ru/catalog/tours/202?date=2027-01-15&guests=3#booking';
  const PLACE_URL = 'https://vedarai.ru/places/gorely#tours';
  const offersOk = (n = 2) => ({
    state: 'ok' as const, placeName: 'Вулкан <Горелый>', placeUrl: PLACE_URL,
    offers: [
      { partnerName: 'Компания «А&Б»', tourId: '201', title: 'Горелый за день', price: '12 000 ₽ за человека', seats: 'calendar' as const, url: FORM_A, moreTours: 2 },
      { partnerName: 'Вторая', tourId: '202', title: 'К кратеру', price: null, seats: 'by_request' as const, url: FORM_B, moreTours: 0 },
    ].slice(0, n),
    more: 1,
  });
  /** Сегодня по Камчатке — 10.01.2027: заявка на 15.01 впереди. */
  const at = (): NoticeDeps => ({ ...deps(), now: () => Date.parse('2027-01-10T00:00:00Z') });
  const NOT_ANSWER = 'Это не ответ этих компаний: места и дату каждая подтверждает сама. Заявку вы оставляете сами по ссылке — имя и телефон получит только та компания, которой вы её оставите.';

  it('после «Нет мест»: компании с турами к месту на дату — ссылкой на заявку, без ПД и без оценок; оператору сказано, что они названы', async () => {
    otherOffers.mockResolvedValue(offersOk());
    const o = await deliverAnswerNotice('501', at());
    expect(o).toEqual({ state: 'delivered', via: 'max', dates: ['2027-01-14', '2027-01-18'], offers: 2 });
    // Читается по туру, дате и числу людей заявки — имени и телефона среди аргументов нет.
    // Номер заявки — чтобы список знал ответы компаний на вопрос Ведара (4б); имени и телефона в чтении нет.
    expect(otherOffers.mock.calls[0]![0]).toEqual({ tourId: 42, date: '2027-01-15', people: 3, leadId: LEAD });
    const text = sendMax.mock.calls[0]![1] as string;
    const lines = text.split('\n');
    const head = lines.indexOf('<b>К месту «Вулкан &lt;Горелый&gt;» на 15.01.2027 — другие компании</b>');
    expect(head).toBeGreaterThan(0);
    expect(lines.slice(head + 1, head + 6)).toEqual([
      // Ссылка экранирована, как весь чужой текст в HTML-сообщении: «&» в адресе — «&amp;».
      `1. «Компания «А&amp;Б»» — тур «Горелый за день», 12 000 ₽ за человека; в календаре на эту дату места на 3 чел. есть; у компании к этому месту ещё 2 тура. Заявка: ${FORM_A.replace('&', '&amp;')}`,
      `2. «Вторая» — тур «К кратеру», цена не указана; расписания на Ведаре нет — дату подтверждает оператор. Заявка: ${FORM_B.replace('&', '&amp;')}`,
      `Ещё 1 компания — на странице места: ${PLACE_URL}`,
      NOT_ANSWER,
      OFFER_ORDER_NOTE_ON_DATE_RU,
    ]);
    // Блок стоит после дат этого же тура и перед «подобрать другой тур».
    expect(text.indexOf('по календарю тура на Ведаре')).toBeLessThan(text.indexOf('другие компании</b>'));
    expect(lines[lines.length - 1]).toBe('Подобрать другой тур можно здесь же — напишите, что ищете.');
    expect(text).not.toMatch(/Ирина|79995550707/);
    expect(text).not.toMatch(/лучш|дешевл|выгодн|рекоменд|советуем/i);
    expect(operatorOutcomeLine(o)).toBe(
      'Туристу ушло сообщение в MAX: ваш ответ и свободные даты тура рядом по календарю (14.01.2027, 18.01.2027). '
      + 'Ещё туристу названы 2 другие компании с турами к этому месту на эту дату — по общему правилу порядка витрины.',
    );
  });

  it('одна компания — «названа другая компания»; в Telegram блок тот же', async () => {
    otherOffers.mockResolvedValue({ ...offersOk(1), more: 0 });
    w.targets = [{ channel: 'telegram', chat_id: CHAT_ID, can_pick: false }];
    const o = await deliverAnswerNotice('501', at());
    expect(o).toMatchObject({ state: 'delivered', via: 'telegram', offers: 1 });
    const text = sendTelegram.mock.calls[0]![1] as string;
    expect(text).toContain('<b>К месту «Вулкан &lt;Горелый&gt;» на 15.01.2027 — другие компании</b>');
    expect(text).toContain(`Заявка: ${FORM_A.replace('&', '&amp;')}`);
    expect(text).not.toContain('&guests=');
    // Больше компаний нет — строки «ещё N» нет.
    expect(text).not.toContain('на странице места:');
    expect(operatorOutcomeLine(o)).toContain('Ещё туристу названа другая компания с турами к этому месту на эту дату');
  });

  it('после отказа с причиной не по погоде блок есть — и у «не подходит группа», где дат своего тура не называют', async () => {
    for (const reason of ['seats', 'dates', 'group', 'other'] as const) {
      otherOffers.mockReset();
      otherOffers.mockResolvedValue(offersOk());
      sendMax.mockClear();
      w.row = { ...baseRow(), answer: 'decline', decline_reason: reason };
      w.status = { ...baseStatus(), lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: reason };
      const o = await deliverAnswerNotice('501', at());
      expect(o, reason).toMatchObject({ state: 'delivered', offers: 2 });
      expect(sendMax.mock.calls[0]![1], reason).toContain('— другие компании</b>');
    }
  });

  it('не читаются вовсе: отказ по погоде, «другая дата», большая группа, заявка без даты или тура, прошедшая дата', async () => {
    const cases: Array<[string, () => void, NoticeDeps?]> = [
      ['погода', () => {
        w.row = { ...baseRow(), answer: 'decline', decline_reason: 'weather', refused_dates: [], weather_refused_dates: [] };
        w.status = { ...baseStatus(), lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: 'weather' };
      }],
      ['другая дата', () => {
        w.row = { ...baseRow(), answer: 'other_date' };
        w.status = { ...baseStatus(), lead_status: 'contacted', lead_answer: 'other_date' };
      }],
      ['большая группа', () => { w.status = { ...baseStatus(), lead_group_over: true }; }],
      ['заявка без даты', () => { w.row = { ...baseRow(), lead_date: null }; }],
      ['заявка без тура', () => { w.row = { ...baseRow(), tour_id: null, tour_public: false }; }],
      ['дата прошла', () => {}, { ...deps(), now: () => Date.parse('2027-01-20T00:00:00Z') }],
    ];
    for (const [name, set, d] of cases) {
      w = { ...w, row: baseRow(), status: baseStatus() };
      otherOffers.mockReset();
      otherOffers.mockResolvedValue(offersOk());
      sendMax.mockClear();
      set();
      const o = await deliverAnswerNotice('501', d ?? at());
      expect(otherOffers, name).not.toHaveBeenCalled();
      expect(String(sendMax.mock.calls[0]?.[1] ?? 'сообщение не ушло'), name).not.toContain('другие компании');
      expect(o, name).toMatchObject({ state: 'delivered' });
      expect(o, name).not.toHaveProperty('offers');
    }
  });

  it('у машины и проката блока нет: там свои витрины', async () => {
    for (const kind of ['charter', 'car_rental'] as const) {
      otherOffers.mockReset();
      otherOffers.mockResolvedValue(offersOk());
      sendMax.mockClear();
      arm(kind);
      const o = await deliverAnswerNotice('501', at());
      expect(o, kind).toMatchObject({ state: 'delivered' });
      expect(otherOffers, kind).not.toHaveBeenCalled();
      expect(String(sendMax.mock.calls[0]![1]), kind).not.toContain('другие компании');
    }
  });

  it('компаний нет или чтение не удалось — сообщение уходит без блока, и «нет» не говорится', async () => {
    for (const answer of [{ state: 'none' as const }, { state: 'failed' as const }]) {
      otherOffers.mockReset();
      otherOffers.mockResolvedValue(answer);
      sendMax.mockClear();
      w.row = baseRow();
      const o = await deliverAnswerNotice('501', at());
      expect(o, answer.state).toEqual({ state: 'delivered', via: 'max', dates: ['2027-01-14', '2027-01-18'] });
      const text = sendMax.mock.calls[0]![1] as string;
      expect(text, answer.state).not.toMatch(/други[ех] компани/);
      expect(operatorOutcomeLine(o), answer.state).not.toContain('названы');
    }
    // Чтение упало исключением — то же: сообщение ушло, отказ в логе без текста ошибки.
    otherOffers.mockReset();
    otherOffers.mockRejectedValue(new Error('секрет из текста ошибки'));
    sendMax.mockClear();
    w.row = baseRow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = await deliverAnswerNotice('501', at());
    const logged = warn.mock.calls.flat().join(' ');
    warn.mockRestore();
    expect(o).toMatchObject({ state: 'delivered', via: 'max' });
    expect(o).not.toHaveProperty('offers');
    expect(logged).toContain('другие компании на дату не прочитались (exception)');
    expect(logged).not.toContain('секрет');
  });

  it('чтение зависло — через срок сообщение уходит без блока; срок не длиннее проверки дат, и худшая строка не растёт', async () => {
    vi.useFakeTimers();
    otherOffers.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = deliverAnswerNotice('501', at());
    await vi.advanceTimersByTimeAsync(NOTICE_OFFERS_TIMEOUT_MS);
    const o = await p;
    warn.mockRestore();
    expect(o).toEqual({ state: 'delivered', via: 'max', dates: ['2027-01-14', '2027-01-18'] });
    expect(sendMax.mock.calls[0]![1]).not.toContain('другие компании');
    // Проверка дат (погода) и другие компании в одной строке не встречаются: срок строки считает большее из двух.
    expect(NOTICE_OFFERS_TIMEOUT_MS).toBeLessThanOrEqual(NOTICE_CHECK_TIMEOUT_MS);
  });

  it('не дошло до человека — исход без «названы»; менеджеру, который будет звонить, названо, кого ещё можно предложить', async () => {
    otherOffers.mockResolvedValue(offersOk());
    w.targets = [];
    const o = await deliverAnswerNotice('501', at());
    expect(o).toMatchObject({ state: 'undelivered', manager: 'max' });
    expect(o).not.toHaveProperty('offers');
    const m = managerText();
    expect(m.text).toContain(
      'Кого ещё можно назвать клиенту на эту дату — к месту «Вулкан &lt;Горелый&gt;», по календарю Ведара, это не ответ компаний: '
      + '«Компания «А&amp;Б»» — тур «Горелый за день» (в календаре места есть); «Вторая» — тур «К кратеру» (дату подтверждает оператор); ещё 1 компания. '
      + `Все туры к месту: ${PLACE_URL} Заявку другой компании клиент оставляет сам.`,
    );
    // Заглушка в Telegram короткая: список — в письме с телефоном и на странице места.
    expect(m.stub).not.toContain('Кого ещё можно назвать');
    expect(m.text).not.toMatch(/рекоменд|лучш|дешевл/i);
  });

  it('письмо менеджеру: не больше трёх компаний, остальные — числом; после погоды, у группы и без списка строки нет', () => {
    const five = {
      kind: 'offers' as const, placeName: 'Вулкан Горелый', placeUrl: PLACE_URL, more: 2,
      offers: ['А', 'Б', 'В', 'Г', 'Д'].map((n, i) => ({
        partnerName: n, tourId: String(300 + i), title: `Тур ${n}`, price: null, seats: 'calendar' as const, url: FORM_A, moreTours: 0,
      })),
    };
    const contact = { name: null, phone: null };
    const F: NoticeFacts = {
      leadId: LEAD, answer: 'no_seats', reason: null, tourTitle: 'Тур', tourUrl: null,
      date: '2027-01-15', people: 2, operatorName: 'Оп', groupPassedOn: false,
    };
    const text = managerUndeliveredText({ ...F, answer: 'no_seats' }, contact, [], [], five).text;
    expect(MANAGER_OFFERS_MAX).toBe(3);
    expect(text).toContain('«А» — тур «Тур А» (в календаре места есть); «Б» — тур «Тур Б» (в календаре места есть); «В» — тур «Тур В» (в календаре места есть); ещё 4 компании.');
    expect(text).not.toMatch(/«Г»|«Д»/);
    // Те же случаи, где человеку список не называют, — и менеджеру не называем.
    const silent = (f: NoticeFacts, block?: Parameters<typeof managerUndeliveredText>[4] | null) => managerUndeliveredText(f, contact, [], [], block === null ? undefined : block ?? five).text;
    expect(silent({ ...F, answer: 'decline', reason: 'weather' })).not.toContain('Кого ещё можно назвать');
    expect(silent({ ...F, answer: 'no_seats', groupPassedOn: true })).not.toContain('Кого ещё можно назвать');
    expect(silent({ ...F, answer: 'other_date' })).not.toContain('Кого ещё можно назвать');
    for (const block of [{ kind: 'none' as const }, { kind: 'failed' as const }, { kind: 'skip' as const }, null]) {
      expect(silent({ ...F, answer: 'no_seats' }, block)).not.toContain('Кого ещё можно назвать');
    }
    // Проверка самой проверки: с переданным списком строка есть.
    expect(silent({ ...F, answer: 'no_seats' })).toContain('Кого ещё можно назвать');
  });

  it('длинные названия обрезаны, а блок укладывается в предел сообщения: не вошедшие компании названы числом и в исход не идут', async () => {
    const long = (i: number) => ({
      partnerName: `Компания ${i} ${'очень длинная вывеска '.repeat(20)}`, tourId: String(300 + i), title: `Тур ${i} ${'очень длинное название '.repeat(20)}`,
      price: '12 000 ₽ за человека', seats: 'calendar' as const,
      url: `https://vedarai.ru/catalog/tours/${'ochen-dlinnyj-adres-'.repeat(40)}${i}?date=2027-01-15&guests=3#booking`, moreTours: 0,
    });
    otherOffers.mockResolvedValue({ state: 'ok', placeName: 'Горелый', placeUrl: PLACE_URL, offers: [1, 2, 3, 4, 5].map(long), more: 2 });
    const o = await deliverAnswerNotice('501', at());
    const text = sendMax.mock.calls[0]![1] as string;
    expect(text.length).toBeLessThanOrEqual(NOTICE_TEXT_MAX);
    const shown = text.split('\n').filter((l) => /^[1-5]\. «Компания /.test(l));
    // Вошли не все и не ноль — иначе проверять нечего.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(5);
    // Вывеска и название обрезаны с многоточием, а не целиком.
    expect(shown[0]).toMatch(/^1\. «Компания 1 [^»]{1,90}…» — тур «Тур 1 [^»]{1,90}…», /);
    // Не вошедшие и те, что не вошли ещё при отборе, — одним числом; в исходе — только названные.
    expect(text).toContain(`Ещё ${2 + (5 - shown.length)} компани`);
    expect(o).toMatchObject({ state: 'delivered', offers: shown.length });
    // Сам ответ оператора и подпись порядка на месте.
    expect(text).toContain('ответил: на эту дату мест нет.');
    expect(text).toContain(OFFER_ORDER_NOTE_ON_DATE_RU);
  });

  it('блок не помещается вовсе — сообщение об отказе уходит как было, без блока', () => {
    const base: NoticeFacts = {
      leadId: LEAD, answer: 'no_seats', reason: null, tourTitle: 'Тур', tourUrl: null, date: '2027-01-15', people: 2,
      operatorName: 'Оператор', groupPassedOn: false,
    };
    const huge = { partnerName: 'К', title: 'Т', price: null, seats: 'calendar' as const, url: `https://vedarai.ru/${'a'.repeat(NOTICE_TEXT_MAX)}`, moreTours: 0 };
    const plain = touristAnswerText(base, { kind: 'none' }, false);
    const tried = touristAnswerText(base, { kind: 'none' }, false, { kind: 'offers', placeName: 'Горелый', placeUrl: PLACE_URL, offers: [huge], more: 0 });
    expect(tried.text).toBe(plain.text);
    expect(tried.offers).toBe(0);
    expect(plain.offers).toBe(0);
  });

  it('слова блока: без блока по умолчанию; после погоды, «другой даты», у группы и машины он не печатается, даже если передан', () => {
    const base: NoticeFacts = {
      leadId: LEAD, answer: 'no_seats', reason: null, tourTitle: 'Тур', tourUrl: null, date: '2027-01-15', people: null,
      operatorName: null, groupPassedOn: false,
    };
    const block = { kind: 'offers' as const, placeName: 'Горелый', placeUrl: PLACE_URL, offers: offersOk().offers, more: 0 };
    expect(touristAnswerText(base, { kind: 'skip' }, false).text).not.toContain('другие компании');
    // Число людей не записано — «на N чел.» не выдумывается.
    expect(touristAnswerText(base, { kind: 'skip' }, false, block).text).toContain('в календаре на эту дату места есть; у компании');
    for (const f of [
      { ...base, answer: 'decline' as const, reason: 'weather' as const },
      { ...base, answer: 'other_date' as const },
      { ...base, groupPassedOn: true },
      { ...base, kind: 'charter' as const },
    ]) {
      expect(touristAnswerText(f, { kind: 'skip' }, false, block).text, JSON.stringify(f)).not.toContain('другие компании');
    }
    for (const empty of [{ kind: 'none' as const }, { kind: 'failed' as const }, { kind: 'skip' as const }, { ...block, offers: [] }]) {
      expect(touristAnswerText(base, { kind: 'skip' }, false, empty).text).not.toContain('другие компании');
    }
  });
});
