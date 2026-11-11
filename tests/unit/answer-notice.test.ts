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
 *  - худшая строка успевает до срока шага workflow и супервизора.
 * Сам SQL — на настоящем PostgreSQL: tests/integration/request-chat.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTICE_AGENT_KEYS_SQL, NOTICE_AGENT_TIMEOUT_MS, NOTICE_ATTEMPT_SQL, NOTICE_CLAIM_DUE_SQL, NOTICE_CLEARED_SQL, NOTICE_CONTACT_SQL,
  NOTICE_DELIVERED_SQL, NOTICE_FACTS_SQL, NOTICE_MANAGER_SQL, NOTICE_MANAGER_TIMEOUT_MS, NOTICE_RELEASE_SQL, NOTICE_ROW_WORST_MS,
  NOTICE_RUN_START_BUDGET_MS, NOTICE_SEND_TIMEOUT_MS, NOTICE_SKIPPED_SQL, NOTICE_TARGETS_SQL, NOTICE_UNDELIVERED_SQL,
  agentLegCode, deliverAnswerNotice, outcomeOfRow, runAnswerNotices, type NoticeDeps,
} from '@/lib/requests/answer-notice';
import { REQUEST_STATUS_BY_LEAD_SQL, type StatusRow } from '@/lib/mcp/request-status';
import type { NotifyRunResult } from '@/lib/mcp/request-notify';
import { managerUndeliveredText, operatorOutcomeLine, touristAnswerText, type NoticeFacts } from '@/lib/requests/answer-notice-text';
import { parseMyTripDate } from '@/lib/requests/my-trip-ask';
import { unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { MAX_FETCH_TIMEOUT_MS } from '@/lib/max/max-fetch';

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
const deps = (): NoticeDeps => ({ query, sendMax, sendTelegram, pdAlert, notifyRun, freeDates });
const ran = (sql: string) => calls.filter((c) => c.sql === sql);
const managerText = () => (pdAlert.mock.calls[0]![0] as { text: string; stub: string });

beforeEach(() => {
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
  calls.length = 0;
  for (const f of [sendMax, sendTelegram, pdAlert, notifyRun, freeDates]) f.mockReset();
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
    expect(text).toContain('Тур «Горелый &amp; кратер», 15.01.2027, 3 чел.');
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
    const sent = pdAlert.mock.calls[0]![0] as { text: string; stub: string; to?: unknown };
    expect(sent.to).toBeUndefined();
    expect(sent.text).toContain('+79995550707');
    expect(sent.text).toContain('Ирина Тестова');
    expect(sent.text).toContain('MAX не принял (bad_id); подписки ИИ-агента нет.');
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

  it('погода: без дат и без «подобрать другой тур», причина словами и 112; дат даже не читаем', async () => {
    w.row = { ...baseRow(), answer: 'decline', decline_reason: 'weather' };
    w.status = { ...baseStatus(), lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: 'weather' };
    await deliverAnswerNotice('501', deps());
    const [, text, buttons] = sendMax.mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain('на эту дату — погода или безопасность');
    expect(text).toContain('112');
    expect(text).not.toMatch(/Подобрать другой тур|по календарю тура/);
    expect(buttons).toEqual([]);
    expect(freeDates).not.toHaveBeenCalled();
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
