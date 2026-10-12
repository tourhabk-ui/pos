// @vitest-environment node
/**
 * Диспетчер A2A (lib/a2a/handle) с подставными исполнителями.
 *
 * Держит перевод исхода инструмента в состояние задачи (ok → completed с
 * артефактом и ссылкой «продолжить», refused/rate_limited/unknown_tool →
 * rejected, failed → failed), путь свободного текста (ответ Кузьмича →
 * completed, переписка запоминается по contextId), ошибки протокола для
 * того, чего нет (поток, push, список, расширенная карточка), GetTask и
 * CancelTask, и то, что входящее сообщение агента в историю задачи не
 * попадает (pd-guard).
 */
import { describe, it, expect, vi } from 'vitest';
import { handleA2A, readText, readToolCall, type A2AExecutors } from '@/lib/a2a/handle';
import { createTaskStore } from '@/lib/a2a/task-store';
import type { PublicToolOutcome } from '@/lib/mcp/tool-outcome';

function deps(toolOutcome: PublicToolOutcome, chat: Awaited<ReturnType<A2AExecutors['chat']>> = { ok: true, text: 'Кузьмич отвечает' }) {
  const executors: A2AExecutors = {
    runTool: vi.fn(async () => toolOutcome),
    chat: vi.fn(async () => chat),
  };
  const store = createTaskStore();
  return { executors, store };
}

let n = 0;
const ctx = (version: '1.0' | '0.3' = '1.0') => ({ version, now: () => 1_760_000_000_000, newId: () => `id-${++n}` });

function dataMsg(tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { message: { messageId: 'm', parts: [{ data: { tool, arguments: args } }], ...extra } };
}

describe('структурированный вызов инструмента', () => {
  it('ok → completed: текст инструмента в статусе и в артефакте, ссылка «продолжить» в DataPart', async () => {
    const d = deps({ kind: 'ok', text: 'Два тура', handoffUrl: 'https://vedarai.ru/mcp/h/abc' });
    const out = await handleA2A('SendMessage', dataMsg('get_tours', { activity_type: 'вулканы' }), ctx(), d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const task = out.result.task as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'TASK_STATE_COMPLETED' });
    const artifacts = task.artifacts as Array<{ name: string; parts: unknown[] }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('get_tours');
    expect(artifacts[0].parts).toEqual([{ text: 'Два тура' }, { data: { tool: 'get_tours', continue_url: 'https://vedarai.ru/mcp/h/abc' } }]);
    expect(d.executors.runTool).toHaveBeenCalledWith('get_tours', { activity_type: 'вулканы' });
    expect(d.executors.chat).not.toHaveBeenCalled();
    // Задача сохранена и читается по id.
    const got = await handleA2A('GetTask', { id: task.id }, ctx(), d);
    expect(got.ok && (got.result.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
  });

  it('отказ по входу и лимит → rejected без артефакта; неизвестный инструмент → rejected со списком имён', async () => {
    for (const outcome of [
      { kind: 'refused', text: 'Нет согласия' },
      { kind: 'rate_limited', text: 'Подождите' },
    ] as PublicToolOutcome[]) {
      const out = await handleA2A('SendMessage', dataMsg('create_lead'), ctx(), deps(outcome));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const task = out.result.task as Record<string, unknown>;
      expect(task.status).toMatchObject({ state: 'TASK_STATE_REJECTED', message: { parts: [{ text: (outcome as { text: string }).text }] } });
      expect(task.artifacts).toEqual([]);
    }
    const unknown = await handleA2A('SendMessage', dataMsg('get_tour'), ctx(), deps({ kind: 'unknown_tool', message: 'Нет такого', data: { available: ['get_tours'], suggestion: 'get_tours' } }));
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    const task = unknown.result.task as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'TASK_STATE_REJECTED', message: { parts: [{ text: 'Нет такого' }, { data: { available: ['get_tours'], suggestion: 'get_tours' } }] } });
  });

  it('сбой инструмента → failed: «не смог» не выдаётся за «ничего нет»', async () => {
    const out = await handleA2A('SendMessage', dataMsg('get_weather'), ctx(), deps({ kind: 'failed', text: 'Сбой на стороне Ведара' }));
    expect(out.ok && (out.result.task as { status: { state: string } }).status.state).toBe('TASK_STATE_FAILED');
  });

  it('0.3: тот же исход в старой форме — Task без обёртки, с kind и строчным состоянием', async () => {
    const out = await handleA2A('SendMessage', dataMsg('get_tours'), ctx('0.3'), deps({ kind: 'ok', text: 'ок', handoffUrl: null }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
    expect(out.result).not.toHaveProperty('task');
  });
});

describe('свободный текст', () => {
  it('ответ Кузьмича → completed; переписка по contextId запоминается и уходит в следующий вопрос', async () => {
    const d = deps({ kind: 'failed', text: 'не должен звать' });
    const first = await handleA2A('SendMessage', { message: { parts: [{ text: 'Что на Горелом?' }], contextId: 'ctx-1' } }, ctx(), d);
    expect(first.ok && (first.result.task as { status: { state: string }; contextId: string }).contextId).toBe('ctx-1');
    expect(d.executors.chat).toHaveBeenCalledWith('Что на Горелом?', []);
    await handleA2A('SendMessage', { message: { parts: [{ text: 'А погода?' }], contextId: 'ctx-1' } }, ctx(), d);
    expect(d.executors.chat).toHaveBeenLastCalledWith('А погода?', [
      { role: 'user', content: 'Что на Горелом?' },
      { role: 'assistant', content: 'Кузьмич отвечает' },
    ]);
    expect(d.executors.runTool).not.toHaveBeenCalled();
  });

  it('входящее сообщение агента в историю задачи не попадает — только ответ', async () => {
    const d = deps({ kind: 'failed', text: '' });
    const out = await handleA2A('SendMessage', { message: { parts: [{ text: 'Меня зовут Иван, телефон +79990000000' }] } }, ctx(), d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(JSON.stringify(out.result)).not.toContain('79990000000');
    expect((out.result.task as { history: unknown[] }).history).toHaveLength(1);
  });

  it('лимит на вопросы → rejected, сбой модели → failed', async () => {
    const limited = await handleA2A('SendMessage', { message: { parts: [{ text: 'q' }] } }, ctx(), deps({ kind: 'failed', text: '' }, { ok: false, text: 'Подождите минуту', rejected: true }));
    expect(limited.ok && (limited.result.task as { status: { state: string } }).status.state).toBe('TASK_STATE_REJECTED');
    const failed = await handleA2A('SendMessage', { message: { parts: [{ text: 'q' }] } }, ctx(), deps({ kind: 'failed', text: '' }, { ok: false, text: 'Кузьмич не смог' }));
    expect(failed.ok && (failed.result.task as { status: { state: string } }).status.state).toBe('TASK_STATE_FAILED');
  });

  it('только файл — ContentTypeNotSupported; пустое — InvalidParams', async () => {
    const file = await handleA2A('SendMessage', { message: { parts: [{ file: { uri: 'x' } }] } }, ctx(), deps({ kind: 'failed', text: '' }));
    expect(!file.ok && file.error.code).toBe(-32005);
    const empty = await handleA2A('SendMessage', { message: { parts: [{ text: '   ' }] } }, ctx(), deps({ kind: 'failed', text: '' }));
    expect(!empty.ok && empty.error.code).toBe(-32602);
    const bad = await handleA2A('SendMessage', { nope: true }, ctx(), deps({ kind: 'failed', text: '' }));
    expect(!bad.ok && bad.error.code).toBe(-32602);
  });
});

describe('задачи и то, чего нет', () => {
  it('GetTask неизвестной — TaskNotFound; CancelTask завершённой — TaskNotCancelable', async () => {
    const d = deps({ kind: 'ok', text: 'ок', handoffUrl: null });
    const missing = await handleA2A('GetTask', { id: 'nope' }, ctx(), d);
    expect(!missing.ok && missing.error).toMatchObject({ code: -32001, data: { taskId: 'nope' } });
    const sent = await handleA2A('SendMessage', dataMsg('get_tours'), ctx(), d);
    const id = sent.ok ? (sent.result.task as { id: string }).id : '';
    const cancel = await handleA2A('CancelTask', { id }, ctx(), d);
    expect(!cancel.ok && cancel.error.code).toBe(-32002);
    expect(!cancel.ok && cancel.error.data).toMatchObject({ state: 'completed' });
  });

  it('повтор в завершённую задачу по taskId — объяснение, как начать новую; неизвестный taskId — TaskNotFound', async () => {
    const d = deps({ kind: 'ok', text: 'ок', handoffUrl: null });
    const sent = await handleA2A('SendMessage', dataMsg('get_tours'), ctx(), d);
    const id = sent.ok ? (sent.result.task as { id: string }).id : '';
    const again = await handleA2A('SendMessage', dataMsg('get_tours', {}, { taskId: id }), ctx(), d);
    expect(!again.ok && again.error).toMatchObject({ code: -32602, message: expect.stringContaining('без taskId') });
    const ghost = await handleA2A('SendMessage', dataMsg('get_tours', {}, { taskId: 'ghost' }), ctx(), d);
    expect(!ghost.ok && ghost.error.code).toBe(-32001);
  });

  it('поток, подписка, push, список и расширенная карточка названы неподдерживаемыми своими кодами', async () => {
    const d = deps({ kind: 'ok', text: 'ок', handoffUrl: null });
    for (const op of ['SendStreamingMessage', 'SubscribeToTask', 'ListTasks', 'GetExtendedAgentCard'] as const) {
      const out = await handleA2A(op, {}, ctx(), d);
      expect(!out.ok && out.error.code, op).toBe(-32004);
    }
    for (const op of ['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig'] as const) {
      const out = await handleA2A(op, {}, ctx(), d);
      expect(!out.ok && out.error.code, op).toBe(-32003);
    }
  });

  it('historyLength из configuration ограничивает историю в ответе SendMessage', async () => {
    const d = deps({ kind: 'ok', text: 'ок', handoffUrl: null });
    const out = await handleA2A('SendMessage', { ...dataMsg('get_tours'), configuration: { historyLength: 0 } }, ctx(), d);
    expect(out.ok && (out.result.task as { history: unknown[] }).history).toEqual([]);
  });
});

describe('разбор частей', () => {
  it('DataPart с tool берётся первым, текст склеивается по строкам', () => {
    expect(readToolCall([{ kind: 'text', text: 'x' }, { kind: 'data', data: { tool: ' get_tours ', arguments: { a: 1 } } }])).toEqual({ tool: 'get_tours', arguments: { a: 1 } });
    expect(readToolCall([{ kind: 'data', data: { tool: '' } }])).toBeNull();
    expect(readToolCall([{ kind: 'data', data: { foo: 'bar' } }])).toBeNull();
    expect(readText([{ kind: 'text', text: ' a ' }, { kind: 'file' }, { kind: 'text', text: 'b' }])).toBe('a\nb');
  });
});
