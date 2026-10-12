// @vitest-environment node
/**
 * Хранилище задач A2A в памяти (lib/a2a/task-store): срок час, потолок по
 * числу, переписка по contextId не длиннее десяти реплик. Истёкшая задача —
 * «не найдена», а не воскресшая.
 */
import { describe, it, expect } from 'vitest';
import { createTaskStore, CONTEXT_TURNS_MAX, TASK_TTL_MS, TASK_STORE_MAX } from '@/lib/a2a/task-store';
import type { TaskRecord } from '@/lib/a2a/wire';

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
