/**
 * Сторож напоминаний о сроке задачи (CRM 1в-2, #2325).
 *
 * Держит четыре вещи. Тихие часы 22–08 считаются по Камчатке, а не по UTC
 * сервера. Имена клиентов и заголовки задач уходят только текстом для MAX —
 * заглушка для Telegram их не несёт, а всё введённое человеком экранировано.
 * Три исхода пишутся, отказ доставки и «не смог прочитать адрес» — нет (их
 * повторит следующий прогон). Крон честен: ни одной доставки при должниках
 * — 502, отказ базы — 500, ночь — 200 без похода в базу.
 * Исполнение SQL — в интеграционном crm-contacts.pg.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DUE_TASKS_SQL, MARK_REMINDED_SQL, isQuietHour, kamchatkaHour, reminderMessage, runTaskReminders, tasksUrl,
  type DueTaskRow,
} from '@/lib/crm/reminders';
import type { PartnerReach } from '@/lib/partners/reach';
import type { PdAlertParams, PdAlertResult } from '@/lib/notifications/pd-alert';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// 12:00 по Камчатке = 00:00 UTC.
const NOON = new Date('2026-10-10T00:00:00Z');

const task = (over: Partial<DueTaskRow> = {}): DueTaskRow => ({
  id: '00000000-0000-4000-8000-0000000000a1', partner_id: 'p-1', category: 'guide',
  title: 'Перезвонить', due_at: new Date('2026-10-09T22:00:00Z'), contact_name: 'Анна',
  ...over,
});

const REACH_BOTH: PartnerReach = { telegramChatId: '111', maxChatId: '222', telegramSource: 'partner', reachable: true };
const REACH_NONE: PartnerReach = { telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false };

function fakeDb(rows: DueTaskRow[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return sql === DUE_TASKS_SQL ? { rows } : { rows: [], rowCount: 1 };
  });
  return { db: { query } as unknown as { query: typeof import('@/lib/db-pool').pool.query }, calls };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('тихие часы — по Камчатке', () => {
  it('час считается со смещением UTC+12', () => {
    expect(kamchatkaHour(new Date('2026-10-09T10:00:00Z'))).toBe(22);
    expect(kamchatkaHour(new Date('2026-10-09T20:00:00Z'))).toBe(8);
  });

  it('22:00–07:59 — тихо, 08:00–21:59 — можно', () => {
    expect(isQuietHour(new Date('2026-10-09T09:59:00Z'))).toBe(false); // 21:59
    expect(isQuietHour(new Date('2026-10-09T10:00:00Z'))).toBe(true); // 22:00
    expect(isQuietHour(new Date('2026-10-09T19:59:00Z'))).toBe(true); // 07:59
    expect(isQuietHour(new Date('2026-10-09T20:00:00Z'))).toBe(false); // 08:00
  });
});

describe('сообщение: ПД только для MAX', () => {
  it('имя клиента и заголовок — в тексте, заглушка их не несёт', () => {
    const m = reminderMessage([task({ title: 'Уточнить состав группы', contact_name: 'Анна Петрова' })]);
    expect(m.text).toMatch(/Уточнить состав группы — Анна Петрова/);
    expect(m.stub).not.toMatch(/Анна|Петрова|Уточнить/);
    expect(m.stub).toMatch(/Подошёл срок: 1 задача/);
  });

  it('введённое человеком экранируется', () => {
    const m = reminderMessage([task({ title: '<b>Срочно</b> & <a href="x">', contact_name: '<i>Иван</i>' })]);
    expect(m.text).not.toMatch(/<b>Срочно|<a href|<i>Иван/);
    expect(m.text).toMatch(/&lt;b&gt;Срочно&lt;\/b&gt; &amp; &lt;a href=&quot;x&quot;&gt;/);
  });

  it('больше десяти — «и ещё», счёт и склонение по всем; ссылка — в кабинет своей роли', () => {
    const many = Array.from({ length: 12 }, (_, i) => task({ id: `t${i}`, title: `Задача ${i}`, category: 'transfer' }));
    const m = reminderMessage(many);
    expect(m.text).toMatch(/Подошёл срок: 12 задач/);
    expect(m.text).toMatch(/…и ещё 2/);
    expect(m.text).not.toMatch(/Задача 10/);
    expect(m.buttons).toEqual([{ text: 'Открыть задачи', url: 'https://vedarai.ru/hub/carrier/tasks' }]);
    expect(tasksUrl('stay')).toBe('https://vedarai.ru/hub/stay/tasks');
    expect(tasksUrl('непонятно')).toBe('https://vedarai.ru/hub');
  });
});

describe('прогон: три исхода пишутся, отказ — нет', () => {
  it('ночью — ни базы, ни отправки', async () => {
    const { db, calls } = fakeDb([task()]);
    const send = vi.fn();
    const r = await runTaskReminders(new Date('2026-10-09T12:00:00Z'), { db, send, reach: vi.fn() }); // 00:00
    expect(r.quiet).toBe(true);
    expect(calls).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('одно сообщение на партнёра; адрес — его, а не рабочий чат платформы', async () => {
    const { db, calls } = fakeDb([task({ id: 'a' }), task({ id: 'b', title: 'Второе' })]);
    const send = vi.fn(async (_p: PdAlertParams): Promise<PdAlertResult> => ({ channel: 'max', delivered: true, reason: 'ok' }));
    const r = await runTaskReminders(NOON, { db, send, reach: async () => REACH_BOTH });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toEqual({ maxChatId: '222', telegramChatId: '111' });
    const mark = calls.find((c) => c.sql === MARK_REMINDED_SQL);
    expect(mark?.params).toEqual(['p-1', ['a', 'b'], 'max']);
    expect(r).toMatchObject({ due: 2, partners: 1, sent_max: 1, sent_stub: 0, failed: 0 });
  });

  it('заглушка в Telegram — исход telegram_stub', async () => {
    const { db, calls } = fakeDb([task()]);
    const send = vi.fn(async (): Promise<PdAlertResult> => ({ channel: 'telegram-stub', delivered: false, reason: 'нет max' }));
    const r = await runTaskReminders(NOON, { db, send, reach: async () => ({ ...REACH_BOTH, maxChatId: null }) });
    expect(calls.find((c) => c.sql === MARK_REMINDED_SQL)?.params[2]).toBe('telegram_stub');
    expect(r.sent_stub).toBe(1);
  });

  it('каналов нет — unreachable записан, отправки нет', async () => {
    const { db, calls } = fakeDb([task()]);
    const send = vi.fn();
    const r = await runTaskReminders(NOON, { db, send, reach: async () => REACH_NONE });
    expect(send).not.toHaveBeenCalled();
    expect(calls.find((c) => c.sql === MARK_REMINDED_SQL)?.params[2]).toBe('unreachable');
    expect(r.unreachable).toBe(1);
  });

  it('доставка отказала или адрес не прочитан — ничего не записано: повтор в следующем прогоне', async () => {
    const two = [task({ id: 'a', partner_id: 'p-1' }), task({ id: 'b', partner_id: 'p-2' })];
    const { db, calls } = fakeDb(two);
    const send = vi.fn(async (): Promise<PdAlertResult> => ({ channel: 'none', delivered: false, reason: 'MAX API error' }));
    const r = await runTaskReminders(NOON, {
      db, send, reach: async (pid) => (pid === 'p-1' ? REACH_BOTH : null),
    });
    expect(calls.filter((c) => c.sql === MARK_REMINDED_SQL)).toHaveLength(0);
    expect(r).toMatchObject({ partners: 2, failed: 1, reach_unknown: 1, sent_max: 0 });
  });
});

describe('SQL отбора', () => {
  it('открытые, без напоминания, срок наступил, окно — параметром-числом, а не склейкой', () => {
    expect(DUE_TASKS_SQL).toMatch(/t\.done_at IS NULL/);
    expect(DUE_TASKS_SQL).toMatch(/t\.reminded_at IS NULL/);
    expect(DUE_TASKS_SQL).toMatch(/t\.due_at <= \$1::timestamptz/);
    expect(DUE_TASKS_SQL).toMatch(/\(\$2::int \* INTERVAL '1 day'\)/);
    // Заведённая уже просроченной — её срок партнёр видел, когда писал.
    expect(DUE_TASKS_SQL).toMatch(/t\.due_at > t\.created_at/);
  });

  it('исход пишется только своему партнёру и только необработанной открытой задаче', () => {
    expect(MARK_REMINDED_SQL).toMatch(/WHERE partner_id = \$1/);
    expect(MARK_REMINDED_SQL).toMatch(/done_at IS NULL/);
    expect(MARK_REMINDED_SQL).toMatch(/reminded_at IS NULL/);
  });

  it('словарь исходов — один в коде и в CHECK миграции', async () => {
    const { REMINDER_CHANNELS } = await import('@/lib/crm/tasks');
    const m = /crm_tasks_reminder_channel_check\s+CHECK \(reminder_channel IS NULL OR reminder_channel IN \(([^)]*)\)\)/
      .exec(read('migrations/1198_crm_task_reminders.sql'));
    expect(m, 'CHECK исхода не найден').not.toBeNull();
    expect([...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()).toEqual([...REMINDER_CHANNELS].sort());
  });

  it('перенос срока сбрасывает напоминание — о новом сроке напомнят заново', () => {
    const src = read('lib/crm/tasks.ts');
    expect(src).toMatch(/reminded_at = CASE WHEN \$6::timestamptz IS NULL THEN reminded_at END/);
    expect(src).toMatch(/reminder_channel = CASE WHEN \$6::timestamptz IS NULL THEN reminder_channel END/);
  });
});
