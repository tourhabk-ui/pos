/**
 * «Выполнено» под напоминанием о задаче CRM (план «гид в чате», шаг 9) —
 * вызовом, а не поиском строки в исходнике.
 *
 * Что держит:
 *  - напоминание несёт кнопку на каждую показанную задачу (не больше десяти,
 *    как строк), с номером, когда задач несколько; копия менеджерам — без
 *    кнопок-действий;
 *  - в Telegram кнопки «Выполнено» нет: заглушка `sendPdAlert` (настоящая,
 *    с подменённым fetch) несёт только ссылку, а подпись кнопки с заголовком
 *    задачи туда не уходит;
 *  - нажатие отмечает задачу карточки ЭТОГО чата: из чужого чата — «задача
 *    не найдена», повтор — «уже отмечена», чат без карточки — «не
 *    подключён»; не из личного диалога ничего не отмечается, отказ базы
 *    назван словами и SQLSTATE в логе;
 *  - вебхук MAX: незаверенное нажатие не доходит до отметки и говорит, что
 *    не засчитано; заверенное доходит с чатом сообщения — общий прогон всех
 *    кнопок-действий вызовом POST, max-verified-press.test.ts (`tk:d:`).
 * SQL отметки и проверки «уже» на настоящей базе — crm-contacts.pg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_PRESS_TEXT, isTaskPressPayload, parseTaskPress, taskDoneButton, taskDonePayload,
} from '@/lib/crm/chat-task-press';
import { DONE_TASK_SQL, TASK_OF_CHAT_SQL, handleTaskPress } from '@/lib/crm/chat-task-action';
import { SHOWN_PER_MESSAGE, reminderMessage, runTaskReminders, teamCopyOf, type DueTaskRow } from '@/lib/crm/reminders';
import { sendPdAlert, type PdAlertParams, type PdAlertResult } from '@/lib/notifications/pd-alert';
import { pressActionOf } from '@/lib/max/verified-press';

const MINE = '00000000-0000-4000-8000-0000000000a1';
const THEIRS = '00000000-0000-4000-8000-0000000000b1';
const P_MINE = 'p-mine';
const P_OTHER = 'p-other';

const task = (over: Partial<DueTaskRow> = {}): DueTaskRow => ({
  id: MINE, partner_id: P_MINE, category: 'guide',
  title: 'Перезвонить', due_at: new Date('2026-10-29T00:00:00Z'), contact_name: 'Клиент Один',
  ...over,
});

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('payload и подпись', () => {
  it('в payload только номер задачи; испорченное не разбирается', () => {
    expect(taskDonePayload(MINE)).toBe(`tk:d:${MINE}`);
    expect(parseTaskPress(`tk:d:${MINE.toUpperCase()}`)).toEqual({ taskId: MINE });
    expect(parseTaskPress('tk:d:1')).toBeNull();
    expect(parseTaskPress(`tk:x:${MINE}`)).toBeNull();
    expect(parseTaskPress(`bk:c:${MINE}`)).toBeNull();
    expect(isTaskPressPayload(`tk:d:${MINE}`)).toBe(true);
    // Кнопка — действие с записью: вебхук пускает её только заверенной.
    expect(pressActionOf(`tk:d:${MINE}`)).toBe('task');
  });

  it('одна задача — «Выполнено»; несколько — номер и начало заголовка', () => {
    expect(taskDoneButton({ id: MINE, title: 'Перезвонить' }, null).text).toBe('Выполнено');
    const long = taskDoneButton({ id: MINE, title: 'Уточнить состав группы и время сбора у гостиницы' }, 3);
    expect(long.text).toBe('Выполнено: 3. Уточнить состав группы…');
    expect(long.payload).toBe(`tk:d:${MINE}`);
  });
});

describe('напоминание: кнопка на каждую показанную задачу', () => {
  it('задача одна — одна кнопка и ссылка последней', () => {
    const msg = reminderMessage([task()]);
    expect(msg.buttons).toEqual([
      { text: 'Выполнено', payload: `tk:d:${MINE}` },
      // Кабинет в чате (30.10): там же «На завтра».
      { text: 'Задачи в чате', payload: 'cb:n:t' },
      { text: 'Открыть задачи', url: 'https://vedarai.ru/hub/guide/tasks' },
    ]);
    expect(msg.text).toMatch(/^• Перезвонить — Клиент Один/m);
  });

  it('несколько — строки пронумерованы, кнопки называют номер; сверх десяти кнопок нет', () => {
    const many = Array.from({ length: 12 }, (_, i) => task({
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, title: `Задача ${i}`,
    }));
    const msg = reminderMessage(many);
    const actions = msg.buttons.filter((b): b is { text: string; payload: string } => 'payload' in b && b.payload.startsWith('tk:'));
    expect(actions).toHaveLength(SHOWN_PER_MESSAGE);
    expect(msg.buttons.filter((b) => 'payload' in b && b.payload === 'cb:n:t')).toHaveLength(1);
    expect(actions.map((b) => b.payload)).toEqual(many.slice(0, SHOWN_PER_MESSAGE).map((t) => `tk:d:${t.id}`));
    expect(actions[0]?.text).toBe('Выполнено: 1. Задача 0');
    expect(actions[9]?.text).toBe('Выполнено: 10. Задача 9');
    expect(msg.text).toMatch(/^1\. Задача 0 — /m);
    expect(msg.text).toMatch(/^10\. Задача 9 — /m);
    expect(msg.text).toMatch(/…и ещё 2/);
    expect(msg.buttons.at(-1)).toEqual({ text: 'Открыть задачи', url: 'https://vedarai.ru/hub/guide/tasks' });
  });

  it('копия менеджерам — тот же текст, без «Выполнено»', async () => {
    const msg = reminderMessage([task({ category: 'operator' })]);
    expect(teamCopyOf(msg)).toEqual({ text: msg.text, stub: msg.stub, buttons: [{ text: 'Открыть задачи', url: 'https://vedarai.ru/hub/operator/tasks' }] });

    const team = vi.fn(async () => ({ state: 'sent' as const, members: 1, delivered: 1, stubbed: 0 }));
    const send = vi.fn(async (_p: PdAlertParams): Promise<PdAlertResult> => ({ channel: 'max', delivered: true, reason: 'ok' }));
    const db = { query: vi.fn(async (sql: string) => (sql.includes('FROM crm_tasks t') ? { rows: [task({ category: 'operator' })] } : { rows: [], rowCount: 1 })) };
    await runTaskReminders(new Date('2026-10-10T00:00:00Z'), {
      db: db as never, send, team, reach: async () => ({ telegramChatId: '1', maxChatId: '2', telegramSource: 'partner', reachable: true }),
    });
    expect(send.mock.calls[0]?.[0].buttons).toEqual(msg.buttons);
    expect(team.mock.calls[0]?.[1]).toEqual(teamCopyOf(msg));
  });

  it('Telegram: настоящая заглушка pd-alert несёт только ссылку — ни кнопки, ни заголовка задачи', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('TELEGRAM_API_BASE', 'https://tg.test');
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response('{}', { status: 200 });
    }));
    const msg = reminderMessage([task({ title: 'Перезвонить Клиенту Два' }), task({ id: THEIRS, title: 'Второе' })]);
    const res = await sendPdAlert({ ...msg, to: { maxChatId: null, telegramChatId: '111' } });
    expect(res.channel).toBe('telegram-stub');
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as { text: string; reply_markup: { inline_keyboard: unknown } };
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: 'Открыть задачи', url: 'https://vedarai.ru/hub/guide/tasks' }]]);
    expect(bodies[0]).not.toMatch(/Клиент|Перезвонить|Второе|tk:d:/);
  });
});

/**
 * Модель crm_tasks и partners в памяти: настоящий handleTaskPress и настоящий
 * completeTask шлют свой SQL, модель отвечает по чату и скоупу partner_id
 * так, как ответил бы PostgreSQL (сам SQL — в crm-contacts.pg).
 */
interface Card { id: string; chat: number; user: string | null }
interface Row { id: string; partner_id: string; title: string; done: boolean }

function taskDb(cards: Card[], rows: Row[]) {
  const updates: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql === TASK_OF_CHAT_SQL) {
      const [taskId, chat] = params as [string, string];
      const bound = cards.some((c) => String(c.chat) === chat);
      const row = rows.find((r) => r.id === taskId);
      const card = row && cards.find((c) => c.id === row.partner_id && String(c.chat) === chat);
      return {
        rows: [row && card
          ? { bound, partner_id: row.partner_id, user_id: card.user, title: row.title, done: row.done }
          : { bound, partner_id: null, user_id: null, title: null, done: null }],
      };
    }
    const [partnerId, taskId] = params as [string, string];
    const row = rows.find((r) => r.id === taskId && r.partner_id === partnerId);
    if (sql.includes('UPDATE crm_tasks SET done_at')) {
      updates.push(params);
      if (!row || row.done) return { rows: [] };
      row.done = true;
      return {
        rows: [{
          id: row.id, title: row.title, details: null, due_at: new Date(), done_at: new Date(), contact_id: null,
          created_at: new Date(), reminded_at: null, reminder_channel: null, contact_name: null,
        }],
      };
    }
    if (sql === DONE_TASK_SQL) return { rows: row?.done ? [{ title: row.title }] : [] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  });
  return { db: { query } as never, query, updates };
}

const CARDS: Card[] = [
  { id: P_MINE, chat: 10, user: 'u-1' },
  { id: P_OTHER, chat: 20, user: 'u-2' },
];

describe('нажатие «Выполнено»', () => {
  const press = (chatId: number, privateChat = true, payload = `tk:d:${MINE}`) => ({ chatId, privateChat, payload });

  it('из своего чата — отмечена: партнёр — карточка чата, автор — её аккаунт', async () => {
    const { db, updates } = taskDb(CARDS, [{ id: MINE, partner_id: P_MINE, title: 'Перезвонить <Клиенту>', done: false }]);
    const text = await handleTaskPress(press(10), { db });
    expect(text).toBe(TASK_PRESS_TEXT.done('Перезвонить &lt;Клиенту&gt;'));
    expect(updates).toEqual([[P_MINE, MINE, 'u-1']]);
  });

  it('повтор нажатия — «уже отмечена», второй записи нет', async () => {
    const { db, updates } = taskDb(CARDS, [{ id: MINE, partner_id: P_MINE, title: 'Перезвонить', done: false }]);
    await handleTaskPress(press(10), { db });
    const again = await handleTaskPress(press(10), { db });
    expect(again).toBe(TASK_PRESS_TEXT.already('Перезвонить'));
    expect(again).toMatch(/уже отмечена/);
    expect(updates).toHaveLength(1);
  });

  it('из чужого чата — «задача не найдена»: ни отметки, ни «уже»', async () => {
    const { db, updates } = taskDb(CARDS, [
      { id: MINE, partner_id: P_MINE, title: 'Перезвонить', done: false },
      { id: THEIRS, partner_id: P_MINE, title: 'Закрытая', done: true },
    ]);
    const text = await handleTaskPress(press(20), { db });
    expect(text).toBe(TASK_PRESS_TEXT.notFound);
    expect(text).toMatch(/не найдена/);
    // Чужая закрытая — тоже «не найдена», а не «уже отмечена».
    expect(await handleTaskPress(press(20, true, `tk:d:${THEIRS}`), { db })).toBe(TASK_PRESS_TEXT.notFound);
    expect(updates).toEqual([]);
  });

  it('две карточки на одном чате: отмечается задача той, чья она, от её аккаунта', async () => {
    const shared: Card[] = [{ id: P_MINE, chat: 30, user: 'u-1' }, { id: P_OTHER, chat: 30, user: 'u-2' }];
    const { db, updates } = taskDb(shared, [{ id: THEIRS, partner_id: P_OTHER, title: 'Задача гида', done: false }]);
    const text = await handleTaskPress(press(30, true, `tk:d:${THEIRS}`), { db });
    expect(text).toBe(TASK_PRESS_TEXT.done('Задача гида'));
    expect(updates).toEqual([[P_OTHER, THEIRS, 'u-2']]);
  });

  it('не личный диалог, испорченная кнопка — база не спрошена, ничего не отмечено', async () => {
    const { db, query } = taskDb(CARDS, [{ id: MINE, partner_id: P_MINE, title: 'Перезвонить', done: false }]);
    expect(await handleTaskPress(press(10, false), { db })).toBe(TASK_PRESS_TEXT.notDialog);
    expect(await handleTaskPress(press(10, true, 'tk:d:нет'), { db })).toBe(TASK_PRESS_TEXT.unknownButton);
    expect(query).not.toHaveBeenCalled();
  });

  it('чат без карточки — «не подключён», а не «не найдена»; ответа базы нет — «не отмечена»', async () => {
    const { db, updates } = taskDb(CARDS, [{ id: MINE, partner_id: P_MINE, title: 'Перезвонить', done: false }]);
    expect(await handleTaskPress(press(99), { db })).toBe(TASK_PRESS_TEXT.notBound);
    const empty = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await handleTaskPress(press(10), { db: empty as never })).toBe(TASK_PRESS_TEXT.dbFailed);
    expect(updates).toEqual([]);
  });

  it('отказ базы — назван словами, в логе SQLSTATE без значений строки', async () => {
    const fail = { query: vi.fn(async () => { throw Object.assign(new Error('значение Перезвонить'), { code: '57014' }); }) };
    expect(await handleTaskPress(press(10), { db: fail as never })).toBe(TASK_PRESS_TEXT.dbFailed);
    const logged = errorLog.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('SQLSTATE 57014');
    expect(logged).not.toContain('Перезвонить');
  });

  it('два нажатия одного апдейта наперегонки: второе — «уже», а не «не найдена»; не проверить — так и сказано', async () => {
    const open = { bound: true, partner_id: P_MINE, user_id: 'u-1', title: 'Перезвонить', done: false };
    const race = (done: () => unknown) => ({
      query: vi.fn(async (sql: string) => {
        if (sql === TASK_OF_CHAT_SQL) return { rows: [open] };
        if (sql.includes('UPDATE crm_tasks SET done_at')) return { rows: [] };
        return done();
      }),
    });
    expect(await handleTaskPress(press(10), { db: race(() => ({ rows: [{ title: 'Перезвонить' }] })) as never }))
      .toBe(TASK_PRESS_TEXT.already('Перезвонить'));
    expect(await handleTaskPress(press(10), { db: race(() => ({ rows: [] })) as never })).toBe(TASK_PRESS_TEXT.notFound);
    expect(await handleTaskPress(press(10), { db: race(() => { throw Object.assign(new Error('x'), { code: '08006' }); }) as never }))
      .toBe(TASK_PRESS_TEXT.doneUnchecked);
  });
});
