/**
 * Хранилище задач A2A — в памяти процесса, на час.
 *
 * Почему не таблица. SendMessage у нас блокирующий: задача рождается уже в
 * терминальном состоянии и целиком уходит в ответ; GetTask нужен клиенту,
 * который потерял ответ или сверяет его позже. Час в памяти это покрывает.
 * Таблица же хранила бы историю переписки агентов, а в ней — имена и телефоны
 * из заявок (152-ФЗ, pd-guard): данных, которые никому не нужны «для дела»,
 * не должно быть ни в одной таблице. На Timeweb приложение живёт одним
 * контейнером; после перезапуска задачи пропадают, и клиент получает честный
 * TaskNotFoundError, а не выдуманную задачу.
 *
 * По тому же правилу в историю задачи не кладётся ВХОДЯЩЕЕ сообщение
 * агента: ответ уходит тому, кто спрашивал, повторять ему его же слова
 * незачем, а хранить их — тем более.
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

/** Единственное хранилище процесса — для роутов A2A. */
export const a2aTaskStore: TaskStore = createTaskStore();
