// @vitest-environment node
/**
 * Проводной слой A2A (lib/a2a/wire): версия из заголовка, имена операций
 * обеих версий, таблица ошибок по спецификации 1.0, кодек Task в формах 1.0 и
 * 0.3, чтение входящего сообщения.
 *
 * Держит: пустая версия — 0.3 (так велит спецификация), чужая — отказ;
 * `message/send` и `SendMessage` — одна операция; 1.0 без `kind`, с
 * `TASK_STATE_*` и `ROLE_*`, SendMessage в обёртке `{ task }`; 0.3 — наоборот.
 */
import { describe, it, expect } from 'vitest';
import {
  A2A_ERROR, A2A_METHOD_NAMES, a2aError, encodeSendMessageResult, encodeTask, httpErrorBody,
  readOperation, readPart, readSendMessageParams, readTaskIdParams, readVersion, MAX_PARTS, MAX_TEXT_CHARS,
  type TaskRecord,
} from '@/lib/a2a/wire';

const task: TaskRecord = {
  id: 't1',
  contextId: 'c1',
  state: 'completed',
  statusMessage: { messageId: 'm1', role: 'agent', parts: [{ text: 'Готово' }], contextId: 'c1', taskId: 't1' },
  timestamp: '2026-10-12T05:00:00.000Z',
  artifacts: [{ artifactId: 'a1', name: 'get_tours', parts: [{ text: 'Готово' }, { data: { tool: 'get_tours' } }] }],
  history: [
    { messageId: 'm0', role: 'agent', parts: [{ text: 'раньше' }], contextId: 'c1', taskId: 't1' },
    { messageId: 'm1', role: 'agent', parts: [{ text: 'Готово' }], contextId: 'c1', taskId: 't1' },
  ],
  metadata: { input: 'tool' },
};

describe('версия протокола', () => {
  it('пустой заголовок — 0.3, как велит спецификация; 1.0 и 0.3 называются явно', () => {
    expect(readVersion(null)).toEqual({ ok: true, version: '0.3', declared: false });
    expect(readVersion('')).toEqual({ ok: true, version: '0.3', declared: false });
    expect(readVersion('1.0')).toEqual({ ok: true, version: '1.0', declared: true });
    expect(readVersion('1.0.3')).toEqual({ ok: true, version: '1.0', declared: true });
    expect(readVersion('0.3')).toEqual({ ok: true, version: '0.3', declared: true });
    expect(readVersion('0.2.6')).toEqual({ ok: true, version: '0.3', declared: true });
  });

  it('чужая версия — отказ, а не молчаливая подмена', () => {
    expect(readVersion('2.0')).toEqual({ ok: false, requested: '2.0' });
    expect(readVersion('latest')).toEqual({ ok: false, requested: 'latest' });
    expect(readVersion('0.1')).toEqual({ ok: false, requested: '0.1' });
  });
});

describe('операции обеих версий', () => {
  it('имена 1.0 и 0.3 ведут к одной операции', () => {
    expect(readOperation('SendMessage')).toBe('SendMessage');
    expect(readOperation('message/send')).toBe('SendMessage');
    expect(readOperation('GetTask')).toBe('GetTask');
    expect(readOperation('tasks/get')).toBe('GetTask');
    expect(readOperation('CancelTask')).toBe('CancelTask');
    expect(readOperation('tasks/cancel')).toBe('CancelTask');
    expect(readOperation('message/stream')).toBe('SendStreamingMessage');
    expect(readOperation('tasks/resubscribe')).toBe('SubscribeToTask');
    expect(readOperation('tasks/pushNotificationConfig/set')).toBe('CreateTaskPushNotificationConfig');
    expect(readOperation('agent/getAuthenticatedExtendedCard')).toBe('GetExtendedAgentCard');
  });

  it('неизвестный метод — null, прототипные имена не считаются операциями', () => {
    expect(readOperation('tools/call')).toBeNull();
    expect(readOperation('constructor')).toBeNull();
    expect(readOperation('__proto__')).toBeNull();
    expect(A2A_METHOD_NAMES).toContain('message/send');
    expect(A2A_METHOD_NAMES).toContain('SendMessage');
  });
});

describe('ошибки по спецификации 1.0 (раздел 5.4)', () => {
  it('коды JSON-RPC, HTTP-статусы и причины', () => {
    expect(A2A_ERROR.TaskNotFound).toMatchObject({ code: -32001, http: 404, status: 'NOT_FOUND' });
    expect(A2A_ERROR.TaskNotCancelable.code).toBe(-32002);
    expect(A2A_ERROR.PushNotificationNotSupported.code).toBe(-32003);
    expect(A2A_ERROR.UnsupportedOperation.code).toBe(-32004);
    expect(A2A_ERROR.ContentTypeNotSupported).toMatchObject({ code: -32005, status: 'INVALID_ARGUMENT' });
    expect(A2A_ERROR.InvalidAgentResponse).toMatchObject({ code: -32006, http: 500 });
    expect(A2A_ERROR.VersionNotSupported.code).toBe(-32009);
  });

  it('тело REST-ошибки — google.rpc.Status с ErrorInfo (раздел 11.6)', () => {
    const { status, body } = httpErrorBody(a2aError('TaskNotFound', 'нет такой', { taskId: 'x' }), () => Date.parse('2026-10-12T05:00:00Z'));
    expect(status).toBe(404);
    expect(body).toEqual({
      error: {
        code: 404,
        status: 'NOT_FOUND',
        message: 'нет такой',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'TASK_NOT_FOUND',
          domain: 'a2a-protocol.org',
          metadata: { taskId: 'x', timestamp: '2026-10-12T05:00:00.000Z' },
        }],
      },
    });
  });
});

describe('кодек Task', () => {
  it('1.0: без kind, роли ROLE_*, состояния TASK_STATE_*, SendMessage в обёртке { task }', () => {
    const t = encodeTask(task, '1.0');
    expect(t).not.toHaveProperty('kind');
    expect(t.status).toMatchObject({ state: 'TASK_STATE_COMPLETED', timestamp: task.timestamp });
    expect((t.status as { message: Record<string, unknown> }).message).toMatchObject({ role: 'ROLE_AGENT', parts: [{ text: 'Готово' }] });
    expect((t.artifacts as Array<Record<string, unknown>>)[0].parts).toEqual([{ text: 'Готово' }, { data: { tool: 'get_tours' } }]);
    expect(t.metadata).toEqual({ input: 'tool' });
    expect(encodeSendMessageResult(task, '1.0')).toEqual({ task: t });
  });

  it('0.3: kind у задачи, сообщения и частей, роли и состояния строчные, SendMessage — Task как есть', () => {
    const t = encodeTask(task, '0.3');
    expect(t.kind).toBe('task');
    expect(t.status).toMatchObject({ state: 'completed' });
    const msg = (t.status as { message: Record<string, unknown> }).message;
    expect(msg).toMatchObject({ kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'Готово' }] });
    expect((t.artifacts as Array<Record<string, unknown>>)[0].parts).toEqual([{ kind: 'text', text: 'Готово' }, { kind: 'data', data: { tool: 'get_tours' } }]);
    expect(encodeSendMessageResult(task, '0.3')).toEqual(t);
  });

  it('historyLength режет историю с конца; 0 — пусто; null — вся', () => {
    expect((encodeTask(task, '1.0', null).history as unknown[]).length).toBe(2);
    expect((encodeTask(task, '1.0', 1).history as Array<{ messageId: string }>)[0].messageId).toBe('m1');
    expect((encodeTask(task, '1.0', 0).history as unknown[]).length).toBe(0);
  });

  it('состояния с дефисом в 1.0 — через подчёркивание', () => {
    expect((encodeTask({ ...task, state: 'input-required' }, '1.0').status as { state: string }).state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect((encodeTask({ ...task, state: 'auth-required' }, '0.3').status as { state: string }).state).toBe('auth-required');
  });
});

describe('чтение входящего сообщения', () => {
  it('части обеих версий: {text}, {kind:"text"}, {data}, {kind:"data"}, файл, мусор', () => {
    expect(readPart({ text: 'привет' })).toEqual({ kind: 'text', text: 'привет' });
    expect(readPart({ kind: 'text', text: 'привет' })).toEqual({ kind: 'text', text: 'привет' });
    expect(readPart({ data: { tool: 'get_tours' } })).toEqual({ kind: 'data', data: { tool: 'get_tours' } });
    expect(readPart({ kind: 'data', data: { a: 1 } })).toEqual({ kind: 'data', data: { a: 1 } });
    expect(readPart({ kind: 'file', file: { uri: 'x' } })).toEqual({ kind: 'file' });
    expect(readPart({ file: { bytes: 'x' } })).toEqual({ kind: 'file' });
    expect(readPart('строка')).toEqual({ kind: 'unknown' });
    expect(readPart({ kind: 'text' })).toEqual({ kind: 'unknown' });
  });

  it('SendMessage: message с parts обязателен; contextId, taskId, historyLength читаются', () => {
    const r = readSendMessageParams({
      message: { messageId: 'm', role: 'ROLE_USER', contextId: 'ctx', taskId: ' t ', parts: [{ text: 'q' }] },
      configuration: { historyLength: 2.7 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.message).toEqual({ messageId: 'm', contextId: 'ctx', taskId: 't', parts: [{ kind: 'text', text: 'q' }] });
    expect(r.params.historyLength).toBe(2);
    expect(readSendMessageParams({ message: { parts: [{ text: 'q' }] } })).toMatchObject({ ok: true });
  });

  it('без message, без parts, пустые parts, слишком много частей или длинный текст — отказ с причиной', () => {
    expect(readSendMessageParams(null)).toMatchObject({ ok: false });
    expect(readSendMessageParams({})).toMatchObject({ ok: false, reason: expect.stringContaining('message') });
    expect(readSendMessageParams({ message: { parts: [] } })).toMatchObject({ ok: false });
    expect(readSendMessageParams({ message: { parts: Array.from({ length: MAX_PARTS + 1 }, () => ({ text: 'x' })) } })).toMatchObject({ ok: false });
    expect(readSendMessageParams({ message: { parts: [{ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }] } })).toMatchObject({ ok: false });
  });

  it('GetTask/CancelTask: id обязателен, historyLength необязателен', () => {
    expect(readTaskIdParams({ id: 'abc', historyLength: 3 })).toEqual({ ok: true, id: 'abc', historyLength: 3 });
    expect(readTaskIdParams({ id: 'abc' })).toEqual({ ok: true, id: 'abc', historyLength: null });
    expect(readTaskIdParams({})).toMatchObject({ ok: false });
    expect(readTaskIdParams({ id: 42 })).toMatchObject({ ok: false });
  });
});
