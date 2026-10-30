/**
 * Задачи и память разговора A2A переживают перезапуск сервиса (13.10,
 * миграция 1229).
 *
 * Второй слой под памятью процесса (lib/a2a/task-store). Пока процесс жив,
 * отвечает память — задача ровно такая, какой ушла в ответ SendMessage.
 * После перезапуска (каждый пуш в main) — копия из базы. Копия не равна
 * ответу, и это намеренно (152-ФЗ, pd-guard):
 *   · тексты и строки данных — после redactPII: телефоны и почты заменены
 *     плейсхолдерами;
 *   · ссылка «продолжить» (continue_url) не хранится: в ней токен handoff;
 *   · у пишущих инструментов (заявки) вместо ответа — заглушка без ключа
 *     статуса и ключа подписи уведомлений (notify_url, 29.10): агент получил
 *     их в ответе SendMessage, а ключ в открытом виде в базе — второй ключ от
 *     заявки (ключ подписи — право подделывать наши уведомления);
 *   · память разговора — по hash contextId, реплики после redactPII.
 *
 * Чтение — три исхода (§4.0): нашлась; нет её (или старше часа); база не
 * ответила или запись не читается как задача — «unavailable», и агент
 * слышит «не смог», а не «задачи нет». Отказ записи ответу не мешает — агент
 * уже получил задачу, — но называется в логе с SQLSTATE.
 *
 * Срок — час (TASK_TTL_MS). Старое удаляет сам писатель перед записью, тем
 * же приёмом, что журнал общения: отдельного крона, который мог бы молча не
 * запуститься, нет.
 *
 * Сторож: tests/unit/a2a-task-store.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { redactPII } from '@/lib/security/pii-redact';
import { WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { logText } from '@/lib/log/log-text';
import { contextKey } from './journal';
import { CONTEXT_TURNS_MAX, TASK_TTL_MS, createTaskStore, type A2ATaskStore, type ChatTurn, type TaskStore } from './task-store';
import { TERMINAL_STATES, type OutMessage, type OutPart, type TaskRecord, type TaskState } from './wire';

const TTL_SECONDS = Math.round(TASK_TTL_MS / 1000);

/** Строки — через redactPII, числа и прочее — как есть: JSON не ломается. */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactPII(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

function writeToolStub(tool: string, state: string): string {
  return state === 'completed'
    ? `Инструмент ${tool} выполнил запись. Ответ с ключом статуса заявки (и ключом подписи уведомлений, если передан notify_url) был в ответе SendMessage; `
      + 'после перезапуска сервиса Ведар его не хранит: ключ в открытом виде в базе был бы вторым ключом от заявки.'
    : `Инструмент ${tool} записи не сделал (${state}). Причина была в ответе SendMessage; `
      + 'после перезапуска сервиса Ведар её не хранит.';
}

function cleanPart(p: OutPart): OutPart {
  if ('text' in p) return { text: redactPII(p.text) };
  const data: Record<string, unknown> = { ...p.data };
  delete data.continue_url;
  return { data: redactDeep(data) as Record<string, unknown> };
}

/** Копия задачи для базы: без ПД, без токена handoff, у заявок — без ключа статуса. */
export function storableTask(task: TaskRecord): TaskRecord {
  const tool = typeof task.metadata.tool === 'string' ? task.metadata.tool : null;
  const stub = tool !== null && WRITE_TOOL_NAMES.has(tool) ? writeToolStub(tool, task.state) : null;
  const parts = (list: OutPart[]): OutPart[] => (stub !== null ? [{ text: stub }] : list.map(cleanPart));
  const message = (m: OutMessage): OutMessage => ({ ...m, contextId: redactPII(m.contextId), parts: parts(m.parts) });
  return {
    ...task,
    contextId: redactPII(task.contextId),
    statusMessage: task.statusMessage ? message(task.statusMessage) : null,
    artifacts: task.artifacts.map((a) => ({ ...a, parts: parts(a.parts) })),
    history: task.history.map(message),
  };
}

function isTaskRecord(x: unknown): x is TaskRecord {
  if (!x || typeof x !== 'object') return false;
  const t = x as Record<string, unknown>;
  // Задачи у нас рождаются завершёнными: другое состояние в базе — порча, не задача.
  return typeof t.id === 'string' && typeof t.contextId === 'string'
    && typeof t.state === 'string' && TERMINAL_STATES.has(t.state as TaskState)
    && typeof t.timestamp === 'string' && Array.isArray(t.artifacts) && Array.isArray(t.history)
    && (t.statusMessage === null || typeof t.statusMessage === 'object')
    && !!t.metadata && typeof t.metadata === 'object';
}

function isTurn(x: unknown): x is ChatTurn {
  if (!x || typeof x !== 'object') return false;
  const t = x as Record<string, unknown>;
  return (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string';
}

function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[a2a-store] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
    logText(err instanceof Error ? err.message : err, 200),
  );
}

export function createDurableTaskStore(memory: TaskStore = createTaskStore()): A2ATaskStore {
  return {
    async put(task) {
      memory.put(task);
      try {
        await pool.query('DELETE FROM a2a_tasks WHERE expires_at < NOW()');
        await pool.query(
          `INSERT INTO a2a_tasks (task_id, record, expires_at)
           VALUES ($1, $2::jsonb, NOW() + ($3::int * INTERVAL '1 second'))
           ON CONFLICT (task_id) DO UPDATE SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at`,
          [task.id, JSON.stringify(storableTask(task)), TTL_SECONDS],
        );
      } catch (err) {
        logFailure('задача не записана — GetTask после перезапуска её не найдёт', err);
      }
    },

    async get(id) {
      const hit = memory.get(id);
      if (hit) return { kind: 'found', task: hit };
      try {
        const r = await pool.query<{ record: unknown }>(
          'SELECT record FROM a2a_tasks WHERE task_id = $1 AND expires_at > NOW()',
          [id],
        );
        if (r.rows.length === 0) return { kind: 'missing' };
        const record = r.rows[0]!.record;
        if (!isTaskRecord(record)) {
          console.error('[a2a-store] запись в a2a_tasks не читается как задача — отвечаем «не смог», а не «нет»');
          return { kind: 'unavailable' };
        }
        return { kind: 'found', task: record };
      } catch (err) {
        logFailure('задача не прочитана', err);
        return { kind: 'unavailable' };
      }
    },

    async historyFor(contextId) {
      const turns = memory.historyFor(contextId);
      if (turns.length > 0) return turns;
      const key = contextKey(contextId);
      if (!key) return [];
      try {
        const r = await pool.query<{ turns: unknown }>(
          'SELECT turns FROM a2a_contexts WHERE context_key = $1 AND expires_at > NOW()',
          [key],
        );
        const raw = r.rows[0]?.turns;
        if (raw === undefined) return [];
        if (!Array.isArray(raw)) {
          console.error('[a2a-store] запись в a2a_contexts не читается как переписка — вопрос уйдёт без прошлых реплик');
          return [];
        }
        const stored = raw.filter(isTurn).slice(-CONTEXT_TURNS_MAX);
        // Память процесса продолжает разговор с того, что было в базе.
        if (stored.length > 0) memory.remember(contextId, stored);
        return stored;
      } catch (err) {
        logFailure('переписка не прочитана — вопрос уйдёт без прошлых реплик', err);
        return [];
      }
    },

    async remember(contextId, turns) {
      memory.remember(contextId, turns);
      const key = contextKey(contextId);
      if (!key) return;
      const all = memory.historyFor(contextId).map((t) => ({ role: t.role, content: redactPII(t.content) }));
      try {
        await pool.query('DELETE FROM a2a_contexts WHERE expires_at < NOW()');
        await pool.query(
          `INSERT INTO a2a_contexts (context_key, turns, updated_at, expires_at)
           VALUES ($1, $2::jsonb, NOW(), NOW() + ($3::int * INTERVAL '1 second'))
           ON CONFLICT (context_key) DO UPDATE SET turns = EXCLUDED.turns, updated_at = NOW(), expires_at = EXCLUDED.expires_at`,
          [key, JSON.stringify(all), TTL_SECONDS],
        );
      } catch (err) {
        logFailure('переписка не записана', err);
      }
    },
  };
}

/** Единственное хранилище процесса — для роутов A2A. */
export const a2aTaskStore: A2ATaskStore = createDurableTaskStore();
