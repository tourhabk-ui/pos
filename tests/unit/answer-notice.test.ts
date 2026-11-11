/**
 * tests/unit/answer-notice.test.ts
 *
 * Сообщение человеку после ответа туроператора кнопкой (план «после отказа»,
 * этап 2б; слово владельца 11.11 «мы доверяем агенту»). Судится вызовом, с
 * подложенными базой, MAX, Telegram, письмом менеджеру и сверкой подписки:
 *  - первое принятое сообщение — доставка, второй канал не трогается,
 *    менеджера не будят;
 *  - чаты не приняли и агента нет — «не доставлено», менеджеру сразу: имя и
 *    телефон только в тексте MAX, в заглушке их нет;
 *  - агент принял уведомление во внеочередной сверке — доставка, менеджер молчит;
 *  - прочли статус посреди отправки — письма менеджеру нет;
 *  - вид заявки уже не из этого ответа — «пропущено», ничего не отправлено;
 *  - погода — без дат и без «подобрать другой тур»; большая группа — передача;
 *    после «Отказать» и у части поездки — без кнопок дат;
 *  - в логах нет id чата, имени и телефона;
 *  - добивка: третий обрыв — менеджеру, а не человеку ещё раз; дошедшее после
 *    письма менеджеру — одна строка «звонить не нужно».
 * Сам SQL — на настоящем PostgreSQL: tests/integration/request-chat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTICE_AGENT_KEYS_SQL, NOTICE_CLAIM_DUE_SQL, NOTICE_CLEARED_SQL, NOTICE_CONTACT_SQL, NOTICE_DELIVERED_SQL, NOTICE_FACTS_SQL,
  NOTICE_MANAGER_SQL, NOTICE_SKIPPED_SQL, NOTICE_TARGETS_SQL, NOTICE_UNDELIVERED_SQL, deliverAnswerNotice, runAnswerNotices,
  type NoticeDeps,
} from '@/lib/requests/answer-notice';
import { REQUEST_STATUS_BY_LEAD_SQL, type StatusRow } from '@/lib/mcp/request-status';
import { operatorOutcomeLine, touristAnswerText, type NoticeFacts } from '@/lib/requests/answer-notice-text';
import { parseMyTripDate } from '@/lib/requests/my-trip-ask';
import { unwrapPress } from '@/lib/chat-cabinet/signed-payload';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CHAT_ID = '987654321';

interface World {
  row: Record<string, unknown>;
  status: Partial<StatusRow> | null;
  targets: Array<{ channel: 'max' | 'telegram'; chat_id: string; can_pick: boolean }>;
  agents: Array<{ key_id: string; last_error: string | null }>;
  /** Сколько строк вернёт перевод в «не доставлено» (0 — статус прочли раньше). */
  undeliveredRows: number;
  free: string[];
}
let w: World;
const calls: Array<{ sql: string; params: unknown[] }> = [];

const baseRow = () => ({
  id: '501', lead_id: LEAD, answer_id: '77', answer: 'no_seats', decline_reason: null, state: 'pending',
  skipped_reason: null, delivered_via: null, tried: null, attempts: 0, manager_channel: null,
  manager_alerted: false, manager_cleared: false, lead_date: '2027-01-15', people: 3, tour_id: 42,
  tour_title: 'Горелый & кратер', tour_slug: 'gorely', tour_public: true, operator_name: 'Вулканы <Север>',
  trip_part: false, refused_dates: ['2027-01-15'],
});
const baseStatus = (): Partial<StatusRow> => ({
  tool_name: 'create_booking_request', lead_id: LEAD, lead_status: 'new', booking_status: null,
  lead_answer: 'no_seats', lead_answer_id: '77', lead_decline_reason: null, lead_group_over: false,
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
  if (sql === NOTICE_CLAIM_DUE_SQL) return Promise.resolve({ rows: [{ id: '501', state: w.row.state, attempts: w.row.attempts }] });
  return Promise.reject(new Error(`неожиданный запрос: ${sql.slice(0, 60)}`));
}

const sendMax = vi.fn();
const sendTelegram = vi.fn();
const pdAlert = vi.fn();
const notifyRun = vi.fn();
const freeDates = vi.fn();
const deps = (): NoticeDeps => ({ query, sendMax, sendTelegram, pdAlert, notifyRun, freeDates });
const ran = (sql: string) => calls.filter((c) => c.sql === sql);

beforeEach(() => {
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
  calls.length = 0;
  for (const f of [sendMax, sendTelegram, pdAlert, notifyRun, freeDates]) f.mockReset();
  w = {
    row: baseRow(), status: baseStatus(), targets: [{ channel: 'max', chat_id: CHAT_ID, can_pick: true }],
    agents: [], undeliveredRows: 1, free: ['2027-01-14', '2027-01-18'],
  };
  sendMax.mockResolvedValue({ ok: true });
  sendTelegram.mockResolvedValue({ ok: true });
  pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  freeDates.mockImplementation(async () => ({ state: 'ok', dates: w.free.map((d) => ({ date: d, free: 5 })), hasCalendar: true }));
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

  it('чаты не приняли, агента нет: не доставлено, менеджеру сразу; имя и телефон — только в тексте MAX', async () => {
    w.targets = [{ channel: 'max', chat_id: CHAT_ID, can_pick: true }];
    sendMax.mockResolvedValue({ ok: false, code: 'bad_id' });
    const o = await deliverAnswerNotice('501', deps());
    expect(o).toEqual({ state: 'undelivered', manager: 'max', hadChat: true });
    expect(pdAlert).toHaveBeenCalledTimes(1);
    const sent = pdAlert.mock.calls[0]![0] as { text: string; stub: string; to?: unknown };
    expect(sent.to).toBeUndefined();
    expect(sent.text).toContain('+79995550707');
    expect(sent.text).toContain('Ирина Тестова');
    expect(sent.text).toContain('MAX не принял (bad_id)');
    expect(sent.stub).not.toMatch(/Ирина|79995550707/);
    expect(ran(NOTICE_MANAGER_SQL)[0]!.params).toEqual(['501', 'max']);
    expect(operatorOutcomeLine(o)).toMatch(/менеджер Ведара — он позвонит/);
  });

  it('чатов нет, у ключа живая подписка ИИ-агента: внеочередная сверка приняла — доставка, менеджер молчит', async () => {
    w.targets = [];
    w.agents = [{ key_id: 'k-1', last_error: null }];
    notifyRun.mockImplementation(async () => { w.row.state = 'delivered'; w.row.delivered_via = 'agent_webhook'; });
    const o = await deliverAnswerNotice('501', deps());
    expect(notifyRun).toHaveBeenCalledWith(['k-1']);
    expect(o).toEqual({ state: 'delivered', via: 'agent_webhook', dates: [] });
    expect(pdAlert).not.toHaveBeenCalled();
    expect(ran(NOTICE_UNDELIVERED_SQL)).toHaveLength(0);
  });

  it('агент не принял — код его отказа в «куда пробовали»; прочли статус посреди отправки — письма нет', async () => {
    w.targets = [];
    w.agents = [{ key_id: 'k-1', last_error: 'http_503' }];
    await deliverAnswerNotice('501', deps());
    expect(ran(NOTICE_UNDELIVERED_SQL)[0]!.params).toEqual(['501', 'agent:http_503']);

    w = { ...w, row: baseRow(), undeliveredRows: 0 };
    calls.length = 0;
    pdAlert.mockClear();
    w.row.state = 'pending';
    // Перевод в «не доставлено» не прошёл: статус успели прочитать — строка уже «доставлено».
    const q2 = (sql: string, p: unknown[] = []) => {
      if (sql === NOTICE_UNDELIVERED_SQL) { w.row.state = 'delivered'; w.row.delivered_via = 'agent_read'; }
      return query(sql, p);
    };
    const o = await deliverAnswerNotice('501', { ...deps(), query: q2 });
    expect(o).toMatchObject({ state: 'delivered', via: 'agent_read' });
    expect(pdAlert).not.toHaveBeenCalled();
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
    expect(await deliverAnswerNotice('501', deps())).toEqual({ state: 'undelivered', manager: 'telegram-stub', hadChat: true });
    expect(sendMax).not.toHaveBeenCalled();
  });
});

describe('добивка', () => {
  it('третий обрыв — человеку больше не шлём, менеджеру сразу', async () => {
    w.row = { ...baseRow(), attempts: 3 };
    const r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ status: 'ok', picked: 1, undelivered: 1 });
    expect(sendMax).not.toHaveBeenCalled();
    expect(ran(NOTICE_UNDELIVERED_SQL)[0]!.params).toEqual(['501', 'retry_exhausted']);
    expect(pdAlert).toHaveBeenCalledTimes(1);
  });

  it('обрыв в первый раз — ещё одна попытка отправки человеку', async () => {
    w.row = { ...baseRow(), attempts: 1 };
    const r = await runAnswerNotices(deps());
    expect(r).toMatchObject({ delivered: 1 });
    expect(sendMax).toHaveBeenCalledTimes(1);
  });

  it('дошло после письма менеджеру — одна строка «звонить не нужно» без ПД; второй прогон её не повторит', async () => {
    w.row = { ...baseRow(), state: 'delivered', delivered_via: 'agent_read', manager_alerted: true, manager_cleared: false, manager_channel: 'max' };
    const r = await runAnswerNotices(deps());
    expect(r.manager_cleared).toBe(1);
    const sent = pdAlert.mock.calls[0]![0] as { text: string; stub: string };
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
  it('оператору: исход словами для каждого состояния', () => {
    expect(operatorOutcomeLine({ state: 'delivered', via: 'max', dates: ['2027-01-20'] })).toMatch(/^Туристу ушло сообщение в MAX/);
    expect(operatorOutcomeLine({ state: 'undelivered', manager: 'none', hadChat: false })).toMatch(/чат с ним не подключён.*повторю автоматически/);
    expect(operatorOutcomeLine({ state: 'skipped', reason: 'lead_closed' })).toMatch(/уже была закрыта/);
    expect(operatorOutcomeLine({ state: 'pending' })).toMatch(/повторю автоматически/);
  });
});
