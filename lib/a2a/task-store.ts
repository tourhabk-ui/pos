/**
 * Хранилище задач A2A: первый слой — память процесса, на час.
 *
 * SendMessage у нас блокирующий: задача рождается уже в терминальном
 * состоянии и целиком уходит в ответ; GetTask нужен клиенту, который потерял
 * ответ или сверяет его позже.
 *
 * ── 13.10: часа в памяти не было ─────────────────────────────────────────
 *
 * 12.10 решено было держать задачи только здесь: «час в памяти это
 * покрывает», а таблица хранила бы переписку с именами и телефонами. Журнал
 * A2A 13.10 показал, что часа нет: agent-collector спросил GetTask через
 * 11 минут после SendMessage и получил TaskNotFound — каждый пуш в main
 * перезапускает контейнер, а в тот вечер их было больше двадцати. С памятью
 * пропадала и переписка по contextId. Теперь у этого слоя есть второй, в
 * базе (lib/a2a/durable-store, миграция 1229): копия после redactPII, без
 * токенов и ключей. Решение — по праву, данному владельцем 13.10.
 *
 * Этот слой остаётся первым: пока процесс жив, задача отдаётся ровно такой,
 * какой ушла в ответ. Диспетчер (lib/a2a/handle) работает с интерфейсом
 * A2ATaskStore — у него три исхода чтения: нашлась, нет её, и «хранилище не
 * прочиталось» (§4.0: «не смог» не выдаётся за «задачи нет»).
 *
 * В историю задачи не кладётся ВХОДЯЩЕЕ сообщение агента: ответ уходит тому,
 * кто спрашивал, повторять ему его же слова незачем, а хранить их — тем более.
 *
 * Переписка по contextId (чтобы второй вопрос помнил первый) хранится рядом,
 * тем же сроком и не больше десяти реплик.
 *
 * Сторож: tests/unit/a2a-task-store.test.ts.
 */

import type { TaskRecord } from './wire';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const TASK_TTL_MS = 60 * 60 * 1000;
export const TASK_STORE_MAX = 2000;
export const CONTEXT_TURNS_MAX = 10;

export interface TaskStoreOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

export interface TaskStore {
  put(task: TaskRecord): void;
  get(id: string): TaskRecord | null;
  /** Последние реплики переписки по contextId — для следующего вопроса. */
  historyFor(contextId: string): ChatTurn[];
  remember(contextId: string, turns: ChatTurn[]): void;
  size(): number;
}

export function createTaskStore(opts: TaskStoreOptions = {}): TaskStore {
  const ttl = opts.ttlMs ?? TASK_TTL_MS;
  const max = opts.max ?? TASK_STORE_MAX;
  const now = opts.now ?? Date.now;
  const tasks = new Map<string, { task: TaskRecord; expiresAt: number }>();
  const contexts = new Map<string, { turns: ChatTurn[]; expiresAt: number }>();

  function sweep(): void {
    const t = now();
    for (const [id, e] of tasks) if (e.expiresAt <= t) tasks.delete(id);
    for (const [id, e] of contexts) if (e.expiresAt <= t) contexts.delete(id);
  }

  return {
    put(task) {
      sweep();
      // Самая старая запись уходит первой: Map хранит порядок вставки.
      while (tasks.size >= max) {
        const oldest = tasks.keys().next().value;
        if (oldest === undefined) break;
        tasks.delete(oldest);
      }
      tasks.set(task.id, { task, expiresAt: now() + ttl });
    },
    get(id) {
      const e = tasks.get(id);
      if (!e) return null;
      if (e.expiresAt <= now()) {
        tasks.delete(id);
        return null;
      }
      return e.task;
    },
    historyFor(contextId) {
      const e = contexts.get(contextId);
      if (!e) return [];
      if (e.expiresAt <= now()) {
        contexts.delete(contextId);
        return [];
      }
      return e.turns.slice();
    },
    remember(contextId, turns) {
      sweep();
      while (contexts.size >= max) {
        const oldest = contexts.keys().next().value;
        if (oldest === undefined) break;
        contexts.delete(oldest);
      }
      const prev = this.historyFor(contextId);
      contexts.set(contextId, { turns: [...prev, ...turns].slice(-CONTEXT_TURNS_MAX), expiresAt: now() + ttl });
    },
    size() {
      sweep();
      return tasks.size;
    },
  };
}

/** Чтение задачи: нашлась, нет её, или хранилище не прочиталось — три разных ответа агенту. */
export type TaskLookup =
  | { kind: 'found'; task: TaskRecord }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** Хранилище, с которым работает диспетчер A2A. */
export interface A2ATaskStore {
  put(task: TaskRecord): Promise<void>;
  get(id: string): Promise<TaskLookup>;
  historyFor(contextId: string): Promise<ChatTurn[]>;
  remember(contextId: string, turns: ChatTurn[]): Promise<void>;
}

/** Только память, без базы: для диспетчера в тестах и как образец интерфейса. */
export function memoryTaskStore(store: TaskStore = createTaskStore()): A2ATaskStore {
  return {
    async put(task) { store.put(task); },
    async get(id) {
      const task = store.get(id);
      return task ? { kind: 'found', task } : { kind: 'missing' };
    },
    async historyFor(contextId) { return store.historyFor(contextId); },
    async remember(contextId, turns) { store.remember(contextId, turns); },
  };
}
