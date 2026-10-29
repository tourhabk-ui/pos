/**
 * Кабинет в чате: кто вправе, что читается и что пишется (lib/chat-cabinet/
 * service) — вызовом. Подменены база и функции CRM: их SQL судят свои тесты
 * и tests/integration/chat-cabinet.pg.test.ts; здесь — что им передано и что
 * человек увидит.
 *
 * Держит:
 *  - нажатие не из личного диалога, чат не подключён, «не смог проверить»,
 *    пилот проката и агент — свой отказ, ничего не прочитано и не записано;
 *  - запись — карточке ЭТОГО чата и её аккаунтом: completeTask, updateTask,
 *    addContactTouch, createTask получают партнёра из чата, не из payload;
 *  - повтор нажатия не удваивает звонок и напоминание;
 *  - Telegram: карточки клиента и поиска нет, заголовка задачи в ответе нет;
 *  - «Найти клиента»: последняя кнопка главная (гасит ожидание причины
 *    отказа и сообщения по заявке), поиск уступает кнопке, нажатой позже,
 *    беде и контролю выхода; текст поиска уходит только в listContacts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  find: vi.fn(),
  inbox: vi.fn(),
  listTasks: vi.fn(),
  completeTask: vi.fn(),
  updateTask: vi.fn(),
  createTask: vi.fn(),
  listContacts: vi.fn(),
  card: vi.fn(),
  touch: vi.fn(),
  query: vi.fn(),
  tx: [] as string[],
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => m.query(...a),
    connect: async () => ({
      query: async (sql: string) => { m.tx.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [], rowCount: 1 }; },
      release: () => undefined,
    }),
  },
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => m.find(...a) }));
vi.mock('@/lib/crm/inbox', () => ({ loadInbox: (...a: unknown[]) => m.inbox(...a) }));
vi.mock('@/lib/crm/tasks', () => ({
  listTasks: (...a: unknown[]) => m.listTasks(...a),
  completeTask: (...a: unknown[]) => m.completeTask(...a),
  updateTask: (...a: unknown[]) => m.updateTask(...a),
  createTask: (...a: unknown[]) => m.createTask(...a),
}));
vi.mock('@/lib/crm/contact-queries', () => ({
  listContacts: (...a: unknown[]) => m.listContacts(...a),
  getContactCard: (...a: unknown[]) => m.card(...a),
}));
vi.mock('@/lib/crm/events', () => ({ addContactTouch: (...a: unknown[]) => m.touch(...a) }));

const svc = await import('@/lib/chat-cabinet/service');
const { CABINET_TEXT, CLIENT_NOT_FOUND, SEARCH_TELEGRAM, TELEGRAM_NO_NAMES, ITEM_GONE } = await import('@/lib/chat-cabinet/screens');
const { cabinetPayload } = await import('@/lib/chat-cabinet/payload');

const PID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const WAIT = '55555555-5555-4555-8555-555555555555';
const CHAT = 7_001;
/** 30.10 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 9, 30, 0, 0);

const OPERATOR = {
  partnerId: PID, partnerName: 'Местечко', slug: 'mesto', category: 'operator', crmCategory: 'operator', userId: USER, sellsTours: true,
};

const press = (payload: string, over: Partial<{ channel: 'max' | 'telegram'; privateChat: boolean }> = {}) =>
  svc.handleCabinetPress({ channel: 'max', chatId: CHAT, privateChat: true, payload, nowMs: NOW, ...over });

function taskItem(over: Record<string, unknown> = {}) {
  return {
    id: TASK, title: 'Перезвонить Анне', details: null, due_at: '2026-10-30T03:00:00.000Z', done_at: null,
    contact: { id: CONTACT, display_name: 'Анна Петрова' }, created_at: '2026-10-29T00:00:00.000Z', reminder: null, ...over,
  };
}

const EMPTY_INBOX = {
  category: 'operator', items: [], failed: [], chat: { state: 'none' }, not_here: [],
  response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
};

beforeEach(() => {
  for (const f of Object.values(m)) if (typeof f === 'function') f.mockReset();
  m.tx.length = 0;
  m.find.mockResolvedValue({ outcome: 'found', partner: OPERATOR });
  m.inbox.mockResolvedValue(EMPTY_INBOX);
  m.listTasks.mockResolvedValue([taskItem()]);
  m.listContacts.mockResolvedValue({ items: [], total: 0 });
  m.query.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** Снятие ждущего поиска другой кнопкой кабинета (`dropCabinetSearch`) — до любого действия в MAX. */
const isDrop = (sql: unknown) => /^\s*UPDATE chat_cabinet_waits SET status = 'superseded'/.test(String(sql));
/** Ответы базы по порядку; снятие поиска отвечает само и в очередь не входит. */
function answers(...vals: Array<{ rows: unknown[]; rowCount?: number }>) {
  const q = [...vals];
  m.query.mockImplementation(async (sql: unknown) => (isDrop(sql) ? { rows: [], rowCount: 0 } : (q.shift() ?? { rows: [], rowCount: 0 })));
}
const sqlCalls = () => m.query.mock.calls.filter((c) => !isDrop(c[0]));

const nothingTouched = () => {
  for (const f of [m.inbox, m.listTasks, m.completeTask, m.updateTask, m.createTask, m.listContacts, m.card, m.touch, m.query]) {
    expect(f).not.toHaveBeenCalled();
  }
};

describe('кто вправе', () => {
  it('испорченная кнопка — отказ до чтения карточки', async () => {
    expect((await press('cb:zz')).text).toBe(CABINET_TEXT.unknownButton);
    expect(m.find).not.toHaveBeenCalled();
  });

  it('не личный диалог, чат не подключён, «не смог проверить» — свой отказ, без строки кабинета', async () => {
    const group = await press(cabinetPayload.tasks(), { privateChat: false });
    expect(group).toEqual({ text: CABINET_TEXT.notDialog, rows: [], pd: false });
    expect(m.find).not.toHaveBeenCalled();
    m.find.mockResolvedValueOnce({ outcome: 'none' });
    expect((await press(cabinetPayload.tasks())).text).toBe(CABINET_TEXT.notBound);
    m.find.mockResolvedValueOnce({ outcome: 'unavailable' });
    expect((await press(cabinetPayload.tasks())).text).toBe(CABINET_TEXT.unchecked);
    nothingTouched();
  });

  it('пилот проката и агент — у них кабинета в чате нет', async () => {
    for (const partner of [
      { ...OPERATOR, category: 'transfer', crmCategory: 'transfer', slug: 'laguna-prokat' },
      { ...OPERATOR, category: 'agent', crmCategory: 'agent' },
    ]) {
      m.find.mockResolvedValueOnce({ outcome: 'found', partner });
      expect((await press(cabinetPayload.inbox())).text).toBe(CABINET_TEXT.noCabinet);
    }
    nothingTouched();
  });

  it('карточка читается по чату сообщения с кнопкой, в своём канале', async () => {
    await press(cabinetPayload.inbox(), { channel: 'telegram' });
    expect(m.find).toHaveBeenCalledWith('telegram', CHAT);
    expect(m.inbox).toHaveBeenCalledWith(PID, 'operator', USER, { nowMs: NOW });
  });
});

describe('Telegram — без имён', () => {
  it('карточка клиента и поиск в Telegram не открываются: ничего не прочитано из карточки, ожидания нет', async () => {
    const card = await press(cabinetPayload.client(CONTACT), { channel: 'telegram' });
    expect(card.text).toContain(TELEGRAM_NO_NAMES);
    expect(m.card).not.toHaveBeenCalled();
    const search = await press(cabinetPayload.search(), { channel: 'telegram' });
    expect(search.text).toContain(SEARCH_TELEGRAM);
    expect(m.tx).toEqual([]);
    // Счёт клиентов — без строк: limit 0.
    expect(m.listContacts).toHaveBeenCalledWith(PID, { limit: 0, offset: 0 });
  });

  it('«Готово» из Telegram — отметка без заголовка задачи в ответе', async () => {
    m.completeTask.mockResolvedValue({ outcome: 'done', task: taskItem() });
    m.listTasks.mockResolvedValue([]);
    const s = await press(cabinetPayload.taskDone(TASK), { channel: 'telegram' });
    expect(s.text).toContain('Задача отмечена выполненной.');
    expect(s.text).not.toContain('Перезвонить');
    expect(s.pd).toBe(false);
  });
});

describe('задачи', () => {
  it('«Готово» — completeTask карточки этого чата и её аккаунтом; экран задач с отметкой', async () => {
    m.completeTask.mockResolvedValue({ outcome: 'done', task: taskItem({ title: 'Счёт <x>' }) });
    m.listTasks.mockResolvedValue([]);
    const s = await press(cabinetPayload.taskDone(TASK));
    expect(m.completeTask).toHaveBeenCalledWith(PID, TASK, USER, expect.anything(), 'partner_user');
    expect(s.text).toContain('Готово: «Счёт &lt;x&gt;».');
    expect(s.text).toContain('Открытых задач нет.');
  });

  it('чужая или уже закрытая — «ничего не изменено»; отказ базы — «не изменено», а не «готово»', async () => {
    m.completeTask.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await press(cabinetPayload.taskDone(TASK))).text).toContain('Задача уже закрыта или не найдена среди ваших');
    m.completeTask.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect((await press(cabinetPayload.taskDone(TASK))).text).toBe(CABINET_TEXT.dbFailed);
  });

  it('«На завтра»: сегодняшняя — на завтра 10:00 по Камчатке; будущая не придвигается', async () => {
    m.updateTask.mockResolvedValue(taskItem({ due_at: '2026-10-30T22:00:00.000Z' }));
    const s = await press(cabinetPayload.taskTomorrow(TASK));
    expect(m.updateTask).toHaveBeenCalledWith(PID, TASK, { dueAt: new Date('2026-10-30T22:00:00.000Z') });
    expect(s.text).toContain('Перенёс «Перезвонить Анне» на завтра, 10:00.');
    m.updateTask.mockClear();
    m.listTasks.mockResolvedValue([taskItem({ due_at: '2026-11-04T22:00:00.000Z' })]);
    expect((await press(cabinetPayload.taskTomorrow(TASK))).text).toContain('переносить не нужно');
    expect(m.updateTask).not.toHaveBeenCalled();
    // Задачи нет среди открытых этой карточки — не трогаем.
    m.listTasks.mockResolvedValue([]);
    expect((await press(cabinetPayload.taskTomorrow(TASK))).text).toContain('не найдена среди ваших');
    expect(m.updateTask).not.toHaveBeenCalled();
  });
});

describe('звонок и напоминание', () => {
  it('звонок: клиент этой карточки — касание в ленту её аккаунтом; повтор за две минуты не пишется', async () => {
    answers({ rows: [{ display_name: 'Анна Петрова', repeated: false }] });
    m.touch.mockResolvedValue({ outcome: 'recorded', id: '1' });
    const s = await press(cabinetPayload.touch('missed', CONTACT));
    expect(sqlCalls()[0]![0]).toBe(svc.TOUCH_GUARD_SQL);
    expect(sqlCalls()[0]![1]).toEqual([PID, CONTACT, 'call', 'Звонок: не дозвонился']);
    expect(m.touch).toHaveBeenCalledWith(PID, CONTACT, {
      kind: 'call', title: 'Звонок: не дозвонился', actorKind: 'partner_user', actorUserId: USER,
    }, expect.anything());
    expect(s.text).toContain('Записал в ленту клиента: «Звонок: не дозвонился». Клиент: Анна П.');
    // Не дозвонился — предложено напомнить.
    expect(s.rows.flat().some((b) => 'payload' in b && b.payload === cabinetPayload.remind('hour', CONTACT))).toBe(true);

    m.touch.mockClear();
    answers({ rows: [{ display_name: 'Анна Петрова', repeated: true }] });
    expect((await press(cabinetPayload.touch('missed', CONTACT))).text).toContain('уже записан только что');
    expect(m.touch).not.toHaveBeenCalled();
  });

  it('«Договорились» — заметка; чужой клиент — «нет в вашей CRM», ничего не записано', async () => {
    answers({ rows: [{ display_name: null, repeated: false }] });
    m.touch.mockResolvedValue({ outcome: 'recorded', id: '2' });
    await press(cabinetPayload.touch('agreed', CONTACT));
    expect(m.touch.mock.calls[0]![2]).toMatchObject({ kind: 'note', title: 'Договорились' });
    m.touch.mockClear();
    answers({ rows: [] });
    expect((await press(cabinetPayload.touch('reached', CONTACT))).text).toBe(CLIENT_NOT_FOUND);
    expect(m.touch).not.toHaveBeenCalled();
  });

  it('напоминание: срок по кнопке, задача клиенту этой карточки; та же задача на тот же срок второй раз не заводится', async () => {
    m.createTask.mockResolvedValue({ outcome: 'created', task: taskItem() });
    for (const [when, at] of [
      ['hour', new Date(NOW + 3_600_000)],
      ['tomorrow', new Date('2026-10-30T22:00:00.000Z')],
      ['days3', new Date('2026-11-01T22:00:00.000Z')],
    ] as const) {
      m.createTask.mockClear();
      answers({ rows: [{ display_name: 'Анна Петрова', repeated: false }] });
      const s = await press(cabinetPayload.remind(when, CONTACT));
      expect(sqlCalls().at(-1)![1]).toEqual([PID, CONTACT, 'Связаться с клиентом', at.toISOString()]);
      expect(m.createTask).toHaveBeenCalledWith(PID, {
        title: 'Связаться с клиентом', dueAt: at, contactId: CONTACT, createdBy: USER, origin: 'manual',
      }, expect.anything());
      expect(s.text).toContain('Завёл задачу «Связаться с клиентом»');
    }
    m.createTask.mockClear();
    answers({ rows: [{ display_name: 'Анна Петрова', repeated: true }] });
    expect((await press(cabinetPayload.remind('tomorrow', CONTACT))).text).toContain('уже есть — вторую не завожу');
    expect(m.createTask).not.toHaveBeenCalled();
  });
});

describe('карточка предмета', () => {
  const item = {
    kind: 'operator_booking', id: '501', created_at: '2026-10-29T00:00:00.000Z', title: 'Горелый', date: '2026-11-05',
    people: 2, contact_id: null, contact_name: null, waiting_minutes: 30,
  };
  it('есть — карточка; уже не ждёт — список с «уже нет»; вид не прочитался — «не прочитались», а не «уже ответили»', async () => {
    m.inbox.mockResolvedValueOnce({ ...EMPTY_INBOX, items: [item] });
    expect((await press(cabinetPayload.item('operator_booking', '501'))).text).toMatch(/^<b>Бронь тура<\/b>/);
    m.inbox.mockResolvedValueOnce(EMPTY_INBOX);
    expect((await press(cabinetPayload.item('operator_booking', '501'))).text).toContain(ITEM_GONE);
    m.inbox.mockResolvedValueOnce({ ...EMPTY_INBOX, failed: ['operator_booking'] });
    const failed = await press(cabinetPayload.item('operator_booking', '501'));
    expect(failed.text).toContain(CABINET_TEXT.inboxFailed);
    expect(failed.text).not.toContain(ITEM_GONE);
  });
});

describe('поиск клиента', () => {
  it('кнопка гасит ожидание причины отказа и сообщения по заявке этого чата и ставит своё — в одной транзакции', async () => {
    const s = await press(cabinetPayload.search());
    expect(s.text).toMatch(/^<b>Найти клиента<\/b>/);
    expect(m.tx[0]).toBe('BEGIN');
    expect(m.tx[1]).toMatch(/^UPDATE chat_cabinet_waits SET status = 'superseded'/);
    expect(m.tx[2]).toMatch(/^UPDATE partner_chat_actions SET status = 'superseded' .*status = 'awaiting_reason'/);
    expect(m.tx[3]).toMatch(/^UPDATE request_chat_waits SET status = 'superseded' .*status = 'waiting'/);
    // Повтор апдейта упирается в ожидание первого нажатия и ничего не вставляет — не отказ.
    expect(m.tx[4]).toMatch(/^INSERT INTO chat_cabinet_waits .*NOW\(\) \+ make_interval.*ON CONFLICT \(channel, chat_id\) WHERE status = 'waiting' DO NOTHING$/);
    expect(m.tx[5]).toBe('COMMIT');
    // Сама кнопка поиска своё ожидание не снимает.
    expect(m.query.mock.calls.some((c) => isDrop(c[0]))).toBe(false);
  });

  it('другая кнопка кабинета в MAX снимает ждущий поиск до действия; «Не надо» и Telegram — нет', async () => {
    await press(cabinetPayload.tasks());
    expect(isDrop(m.query.mock.calls[0]![0])).toBe(true);
    expect(m.query.mock.calls[0]![1]).toEqual([String(CHAT)]);
    m.query.mockClear();
    await press(cabinetPayload.searchCancel());
    expect(m.query.mock.calls.some((c) => isDrop(c[0]))).toBe(false);
    m.query.mockClear();
    await press(cabinetPayload.tasks(), { channel: 'telegram' });
    expect(m.query).not.toHaveBeenCalled();
    // Отказ снятия нажатие не останавливает: экран открыт, в лог — SQLSTATE.
    m.query.mockRejectedValueOnce(Object.assign(new Error('d'), { code: '53300' }));
    expect((await press(cabinetPayload.tasks())).text).toMatch(/^<b>Задачи<\/b>/);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('53300');
  });

  const wait = (over: Record<string, unknown> = {}) => ({ rows: [{ id: WAIT, partner_id: PID, newer: false, ...over }], rowCount: 1 });
  const capture = (text: string, partner: typeof OPERATOR = OPERATOR) => svc.captureCabinetSearch({ chatId: CHAT, partner, text });

  it('ждёт — следующий текст становится запросом: только в listContacts, обрезан до 60 знаков', async () => {
    m.query.mockResolvedValueOnce(wait()).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    m.listContacts.mockResolvedValue({ items: [], total: 0 });
    const q = `Петрова ${'x'.repeat(80)}`;
    const s = await capture(q);
    expect(m.query.mock.calls[0]![0]).toBe(svc.SEARCH_WAIT_SQL);
    expect(m.query.mock.calls[1]![0]).toMatch(/SET status = 'used', used_at = NOW\(\)/);
    expect(m.listContacts).toHaveBeenCalledWith(PID, { q: q.slice(0, 60), limit: 6, offset: 0 });
    expect(s?.text).toContain('Никого не нашёл');
  });

  it('команда, слово меню и пустое — не запрос, ожидание остаётся, база не спрашивается', async () => {
    for (const t of ['/start', 'Входящие', 'Задачи', '   ']) expect(await capture(t), t).toBeNull();
    expect(m.query).not.toHaveBeenCalled();
  });

  it('позже нажата кнопка брони или заявки — ожидание гаснет, а текст не уходит ни в поиск, ни дальше', async () => {
    m.query.mockResolvedValueOnce(wait({ newer: true })).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const s = await capture('Петрова');
    expect(s?.text).toBe(CABINET_TEXT.searchYielded);
    expect(m.query.mock.calls[1]![1]).toEqual([WAIT, 'superseded']);
    expect(m.listContacts).not.toHaveBeenCalled();
    // Беда сильнее: даже при более поздней кнопке сообщение идёт своим путём.
    m.query.mockReset();
    m.query.mockResolvedValueOnce(wait({ newer: true })).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await capture('помогите, человек упал со скалы')).toBeNull();
  });

  it('беда, контроль выхода, чат другой карточки — ожидание гаснет, текст идёт своим путём', async () => {
    for (const [text, over] of [
      ['помогите, человек упал со скалы', {}],
      ['поставьте на контроль выхода', {}],
      ['Петрова', { partner_id: '99999999-9999-4999-8999-999999999999' }],
    ] as const) {
      m.query.mockReset();
      m.query.mockResolvedValueOnce(wait(over)).mockResolvedValueOnce({ rows: [], rowCount: 1 });
      expect(await capture(text), text).toBeNull();
      expect(m.query.mock.calls[1]![0]).toMatch(/UPDATE chat_cabinet_waits SET status = \$2/);
      expect(m.query.mock.calls[1]![1]).toEqual([WAIT, 'superseded']);
    }
    expect(m.listContacts).not.toHaveBeenCalled();
  });

  it('«не надо» — отмена и экран клиентов; ожидания нет — null; второе сообщение того же мгновения — не запрос', async () => {
    m.query.mockResolvedValueOnce(wait()).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const s = await capture('не надо');
    expect(m.query.mock.calls[1]![1]).toEqual([WAIT, 'cancelled']);
    expect(s?.text).toContain('Поиск отменён.');
    m.query.mockReset();
    m.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await capture('Петрова')).toBeNull();
    m.query.mockReset();
    m.query.mockResolvedValueOnce(wait()).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    m.listContacts.mockClear();
    expect(await capture('Петрова')).toBeNull();
    expect(m.listContacts).not.toHaveBeenCalled();
  });

  it('отказ базы при проверке ожидания — сообщение идёт дальше, в лог — SQLSTATE', async () => {
    m.query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '08006' }));
    expect(await capture('Петрова')).toBeNull();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('08006');
  });

  it('awaitsCabinetSearch (чат администратора): ждёт — true; нет — false; база не ответила — false и SQLSTATE', async () => {
    m.query.mockResolvedValueOnce(wait());
    expect(await svc.awaitsCabinetSearch(CHAT)).toBe(true);
    expect(m.query.mock.calls[0]).toEqual([svc.SEARCH_WAIT_SQL, [String(CHAT)]]);
    m.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await svc.awaitsCabinetSearch(CHAT)).toBe(false);
    m.query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '08001' }));
    expect(await svc.awaitsCabinetSearch(CHAT)).toBe(false);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('08001');
  });
});

describe('разделы без нажатия', () => {
  it('cabinetSectionFor — те же экраны и тот же замок по каналу', async () => {
    const s = await svc.cabinetSectionFor(OPERATOR, 'telegram', 'tasks', NOW);
    expect(s.text).toMatch(/^<b>Задачи<\/b>/);
    expect(s.text).not.toContain('Перезвонить');
    expect(s.pd).toBe(false);
    const more = await svc.cabinetSectionFor(OPERATOR, 'max', 'more', NOW);
    expect(more.text).toMatch(/^<b>Ещё<\/b>/);
    const pilot = await svc.cabinetSectionFor({ ...OPERATOR, slug: 'laguna-prokat' }, 'max', 'inbox', NOW);
    expect(pilot.text).toBe(CABINET_TEXT.noCabinet);
  });

  it('отказ чтения задач — «не изменено», а не пустой список', async () => {
    m.listTasks.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '42P01' }));
    const s = await press(cabinetPayload.tasks());
    expect(s.text).toBe(CABINET_TEXT.dbFailed);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('42P01');
  });

  it('запись прошла, а список следом не прочитался — итог записи остаётся, не «ничего не изменено»', async () => {
    m.completeTask.mockResolvedValue({ outcome: 'done', task: taskItem() });
    m.listTasks.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    const s = await press(cabinetPayload.taskDone(TASK));
    expect(s.text).toContain('Готово: «Перезвонить Анне».');
    expect(s.text).toContain(CABINET_TEXT.listFailed);
    expect(s.text).not.toContain('ничего не изменено');
    // Отмена поиска прошла, список клиентов не прочитался.
    answers({ rows: [], rowCount: 1 });
    m.listContacts.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    const c = await press(cabinetPayload.searchCancel());
    expect(c.text).toContain('Поиск отменён.');
    expect(c.text).toContain(CABINET_TEXT.listFailed);
  });
});
