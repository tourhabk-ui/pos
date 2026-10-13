// @vitest-environment node
/**
 * Хранилище задач A2A.
 *
 * Память (lib/a2a/task-store): срок час, потолок по числу, переписка по
 * contextId не длиннее десяти реплик. Истёкшая задача — «не найдена», а не
 * воскресшая.
 *
 * База (lib/a2a/durable-store, 13.10): задача и переписка переживают
 * перезапуск — новый процесс с пустой памятью читает их из базы. Копия в
 * базе — без телефонов и почт, без ссылки handoff с токеном, у заявок — без
 * ключа статуса. База не ответила — «unavailable», а не «нет»; отказ записи
 * не роняет ответ и называется в логе с SQLSTATE. База подставная — SQL тех
 * же запросов проверен на PostgreSQL 16 (миграция 1229, записи и чтения).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: {
    tasks: new Map<string, unknown>(),
    contexts: new Map<string, unknown>(),
    fail: null as null | { code: string },
  },
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (db.fail) throw Object.assign(new Error('connection terminated'), db.fail);
      if (/^DELETE/.test(sql)) return { rows: [] };
      if (/INSERT INTO a2a_tasks/.test(sql)) { db.tasks.set(String(params[0]), JSON.parse(String(params[1]))); return { rows: [] }; }
      if (/FROM a2a_tasks/.test(sql)) return { rows: db.tasks.has(String(params[0])) ? [{ record: db.tasks.get(String(params[0])) }] : [] };
      if (/INSERT INTO a2a_contexts/.test(sql)) { db.contexts.set(String(params[0]), JSON.parse(String(params[1]))); return { rows: [] }; }
      if (/FROM a2a_contexts/.test(sql)) return { rows: db.contexts.has(String(params[0])) ? [{ turns: db.contexts.get(String(params[0])) }] : [] };
      throw new Error(`неожиданный запрос: ${sql}`);
    },
  },
}));

import { createTaskStore, CONTEXT_TURNS_MAX, TASK_TTL_MS, TASK_STORE_MAX } from '@/lib/a2a/task-store';
import { createDurableTaskStore, storableTask } from '@/lib/a2a/durable-store';
import { contextKey } from '@/lib/a2a/journal';
import type { TaskRecord, OutPart } from '@/lib/a2a/wire';

function task(id: string): TaskRecord {
  return { id, contextId: 'c', state: 'completed', statusMessage: null, timestamp: 'now', artifacts: [], history: [], metadata: {} };
}

describe('хранилище задач', () => {
  it('константы: час и две тысячи', () => {
    expect(TASK_TTL_MS).toBe(3_600_000);
    expect(TASK_STORE_MAX).toBe(2000);
    expect(CONTEXT_TURNS_MAX).toBe(10);
  });

  it('задача читается по id, пока не истёк срок; после — null', () => {
    let t = 0;
    const store = createTaskStore({ ttlMs: 100, now: () => t });
    store.put(task('a'));
    expect(store.get('a')?.id).toBe('a');
    t = 99;
    expect(store.get('a')?.id).toBe('a');
    t = 100;
    expect(store.get('a')).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('при переполнении уходит самая старая', () => {
    const store = createTaskStore({ max: 2 });
    store.put(task('a'));
    store.put(task('b'));
    store.put(task('c'));
    expect(store.size()).toBe(2);
    expect(store.get('a')).toBeNull();
    expect(store.get('c')?.id).toBe('c');
  });

  it('переписка по contextId копится до десяти реплик и истекает вместе с задачами', () => {
    let t = 0;
    const store = createTaskStore({ ttlMs: 100, now: () => t });
    for (let i = 0; i < 7; i++) {
      store.remember('ctx', [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` }]);
    }
    const turns = store.historyFor('ctx');
    expect(turns).toHaveLength(CONTEXT_TURNS_MAX);
    expect(turns[0]).toEqual({ role: 'user', content: 'q2' });
    expect(turns[turns.length - 1]).toEqual({ role: 'assistant', content: 'a6' });
    expect(store.historyFor('other')).toEqual([]);
    t = 100;
    expect(store.historyFor('ctx')).toEqual([]);
  });

  it('historyFor отдаёт копию: правка снаружи не меняет хранилище', () => {
    const store = createTaskStore();
    store.remember('ctx', [{ role: 'user', content: 'q' }]);
    store.historyFor('ctx').push({ role: 'assistant', content: 'подделка' });
    expect(store.historyFor('ctx')).toHaveLength(1);
  });
});

/** Задача, как её собирает диспетчер (lib/a2a/handle makeTask). */
function realTask(id: string, parts: OutPart[], metadata: Record<string, unknown>, state: TaskRecord['state'] = 'completed'): TaskRecord {
  const status = { messageId: `m-${id}`, role: 'agent' as const, parts, contextId: 'ctx-1', taskId: id };
  return {
    id, contextId: 'ctx-1', state, statusMessage: status, timestamp: '2026-10-13T09:00:00.000Z',
    artifacts: state === 'completed' ? [{ artifactId: `a-${id}`, name: 'answer', parts }] : [],
    history: [status], metadata,
  };
}

describe('задачи и переписка переживают перезапуск', () => {
  beforeEach(() => { db.tasks.clear(); db.contexts.clear(); db.fail = null; });

  it('новый процесс с пустой памятью читает задачу и переписку из базы; копия без телефона и токена', async () => {
    const before = createDurableTaskStore(createTaskStore());
    const task = realTask('t-1', [
      { text: 'Оператор: +7 (999) 123-45-67, почта op@example.ru. Тур за 11 000 ₽.' },
      { data: { tool: 'get_tours', continue_url: 'https://vedarai.ru/mcp/h/SECRET-TOKEN', result: { phone: '+79991234567', price: 11000, at: 1760000000000 } } },
    ], { input: 'tool', tool: 'get_tours' });
    await before.put(task);
    await before.remember('ctx-1', [{ role: 'user', content: 'мой телефон +79991234567' }, { role: 'assistant', content: 'Записал вопрос' }]);
    // До перезапуска — задача ровно такая, какой ушла в ответ.
    expect(await before.get('t-1')).toEqual({ kind: 'found', task });

    const after = createDurableTaskStore(createTaskStore());
    const got = await after.get('t-1');
    expect(got.kind).toBe('found');
    if (got.kind !== 'found') return;
    expect(got.task).toMatchObject({ id: 't-1', state: 'completed', contextId: 'ctx-1' });
    const flat = JSON.stringify(got.task);
    expect(flat).not.toMatch(/999|op@example\.ru|SECRET-TOKEN|continue_url/);
    expect(flat).toContain('[телефон]');
    expect(flat).toContain('11 000 ₽');
    // Числа данных не тронуты: JSON не ломается, цена — цена.
    expect(got.task.artifacts[0]!.parts[1]).toEqual({ data: { tool: 'get_tours', result: { phone: '[телефон]', price: 11000, at: 1760000000000 } } });

    const turns = await after.historyFor('ctx-1');
    expect(turns).toEqual([{ role: 'user', content: 'мой телефон [телефон]' }, { role: 'assistant', content: 'Записал вопрос' }]);
    // Разговор продолжается с того, что было в базе, а не с нуля.
    await after.remember('ctx-1', [{ role: 'user', content: 'а погода?' }, { role: 'assistant', content: 'Ясно' }]);
    expect(db.contexts.get(contextKey('ctx-1')!)).toHaveLength(4);
    // В базе ключ — hash contextId, не сам contextId.
    expect([...db.contexts.keys()]).toEqual([contextKey('ctx-1')]);
  });

  it('заявка: в базе заглушка без ключа статуса и ссылки, состояние то же', () => {
    const lead = realTask('t-2', [
      { text: 'Заявка передана оператору. Ключ статуса заявки: K3y-ABCDEFGH12345 — по нему get_request_status покажет ответ.' },
      { data: { tool: 'create_lead', continue_url: 'https://vedarai.ru/mcp/h/TOKEN' } },
    ], { input: 'tool', tool: 'create_lead' });
    const copy = storableTask(lead);
    expect(JSON.stringify(copy)).not.toMatch(/K3y-ABCDEFGH12345|TOKEN|continue_url/);
    expect(copy.state).toBe('completed');
    expect(copy.artifacts[0]!.parts).toEqual([{ text: expect.stringMatching(/create_lead выполнил запись.*ключом статуса.*не хранит/) }]);
    const refused = storableTask(realTask('t-3', [{ text: 'Телефон +79991234567 не похож на номер' }], { input: 'tool', tool: 'create_lead' }, 'rejected'));
    expect(JSON.stringify(refused)).not.toContain('79991234567');
    expect(refused.statusMessage!.parts).toEqual([{ text: expect.stringMatching(/записи не сделал \(rejected\)/) }]);
  });

  it('нет в базе — missing; запись не задача — unavailable, а не found', async () => {
    const store = createDurableTaskStore(createTaskStore());
    expect(await store.get('nope')).toEqual({ kind: 'missing' });
    db.tasks.set('bad', { foo: 1 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.get('bad')).toEqual({ kind: 'unavailable' });
    err.mockRestore();
  });

  it('база не ответила: чтение — unavailable, запись не роняет ответ, отказ в логе с SQLSTATE', async () => {
    const store = createDurableTaskStore(createTaskStore());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.fail = { code: '57P01' };
    expect(await store.get('t-1')).toEqual({ kind: 'unavailable' });
    expect(await store.historyFor('ctx-9')).toEqual([]);
    await expect(store.put(realTask('t-4', [{ text: 'ок' }], { input: 'text' }))).resolves.toBeUndefined();
    await expect(store.remember('ctx-9', [{ role: 'user', content: 'q' }])).resolves.toBeUndefined();
    // Память процесса при этом работает: только что записанное читается.
    expect((await store.get('t-4')).kind).toBe('found');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[a2a-store]'), 'SQLSTATE=57P01', expect.any(String));
    err.mockRestore();
  });
});
