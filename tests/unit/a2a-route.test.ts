// @vitest-environment node
/**
 * Роуты A2A (app/api/a2a — JSON-RPC, app/api/a2a/v1 — HTTP+JSON) с
 * подставными исполнителями: версия из заголовка решает форму ответа,
 * ошибки протокола уходят телом JSON-RPC с HTTP 200 (как у MCP), REST
 * отвечает google.rpc.Status со статусом из таблицы, тип содержимого
 * application/a2a+json, CORS на каждом ответе.
 *
 * 13.10: задачи переживают перезапуск — задача, которой нет в памяти процесса,
 * читается из базы (a2a_tasks); база не ответила — -32603 и HTTP 500, а не
 * «задачи нет». MCP-клиент, пришедший на адрес A2A, получает адрес MCP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { runPublicTool, answerAgentMessage, query } = vi.hoisted(() => ({
  runPublicTool: vi.fn(),
  answerAgentMessage: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool }));
vi.mock('@/lib/a2a/chat', () => ({ answerAgentMessage }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { POST, GET, OPTIONS } from '@/app/api/a2a/route';
import { POST as restPost, GET as restGet, DELETE as restDelete } from '@/app/api/a2a/v1/[[...path]]/route';

let ipCounter = 0;
function req(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) {
  ipCounter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    // Свой адрес на каждый запрос — лимит вопросов в памяти общий на модуль.
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.8.0.${ipCounter % 250}`, ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)),
  });
}

function rpc(method: string, params: unknown, headers: Record<string, string> = {}, id: number | string = 1) {
  return POST(req('/api/a2a', { method: 'POST', body: { jsonrpc: '2.0', id, method, params }, headers }));
}

const restCtx = (path: string) => ({ params: Promise.resolve({ path: path === '' ? [] : path.split('/') }) });

beforeEach(() => {
  runPublicTool.mockReset();
  answerAgentMessage.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  runPublicTool.mockResolvedValue({ kind: 'ok', text: 'Два тура', handoffUrl: 'https://vedarai.ru/mcp/h/x' });
  answerAgentMessage.mockResolvedValue({ ok: true, text: 'Ответ Кузьмича' });
});

describe('JSON-RPC биндинг', () => {
  it('1.0: SendMessage с DataPart → { task } в форме 1.0; инструмент зван с аргументами и адресом', async () => {
    const res = await rpc('SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ data: { tool: 'get_tours', arguments: { activity_type: 'вулканы' } } }] } }, { 'A2A-Version': '1.0' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(body.result.task.artifacts[0].parts[1]).toEqual({ data: { tool: 'get_tours', continue_url: 'https://vedarai.ru/mcp/h/x' } });
    expect(runPublicTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'get_tours', rawArguments: { activity_type: 'вулканы' }, self: false }));
    expect(typeof runPublicTool.mock.calls[0][0].ip).toBe('string');
  });

  it('без заголовка — форма 0.3: message/send, Task с kind и строчным состоянием', async () => {
    const res = await rpc('message/send', { message: { messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'Что на Горелом?' }] } });
    const body = await res.json();
    expect(body.result.kind).toBe('task');
    expect(body.result.status.state).toBe('completed');
    expect(body.result.status.message.parts[0]).toEqual({ kind: 'text', text: 'Ответ Кузьмича' });
    expect(answerAgentMessage).toHaveBeenCalledWith('Что на Горелом?', [], expect.objectContaining({ self: false }));
  });

  it('GetTask / tasks/get читают сохранённую задачу; незнакомый id — -32001', async () => {
    const sent = await (await rpc('SendMessage', { message: { parts: [{ data: { tool: 'get_tours' } }] } }, { 'A2A-Version': '1.0' })).json();
    const id = sent.result.task.id as string;
    const got = await (await rpc('GetTask', { id }, { 'A2A-Version': '1.0' })).json();
    expect(got.result.id).toBe(id);
    expect(got.result.status.state).toBe('TASK_STATE_COMPLETED');
    const legacy = await (await rpc('tasks/get', { id })).json();
    expect(legacy.result.kind).toBe('task');
    const missing = await (await rpc('tasks/get', { id: 'nope' })).json();
    expect(missing.error.code).toBe(-32001);
  });

  it('чужая версия — HTTP 400 и -32009; неизвестный метод — -32601 со списком имён', async () => {
    const bad = await rpc('SendMessage', {}, { 'A2A-Version': '3.0' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32009);
    const unknown = await (await rpc('tools/call', {})).json();
    expect(unknown.error.code).toBe(-32601);
    expect(unknown.error.data.methods).toContain('SendMessage');
    expect(unknown.error.data.methods).toContain('message/send');
    // tools/call — метод MCP: агенту назван адрес MCP (13.10, BrickBlueBot).
    expect(unknown.error.data.mcp).toMatch(/\/api\/mcp$/);
    expect(unknown.error.message).toContain('MCP-сервер Ведара');
    const other = await (await rpc('tasks/explode', {})).json();
    expect(other.error.code).toBe(-32601);
    expect(other.error.data).not.toHaveProperty('mcp');
  });

  it('после перезапуска задача читается из базы; база не ответила — -32603 и HTTP 500, не «задачи нет»', async () => {
    const stored = {
      id: 'from-db', contextId: 'ctx-db', state: 'completed', timestamp: '2026-10-13T09:00:00.000Z', metadata: { input: 'text' },
      statusMessage: { messageId: 'm', role: 'agent', parts: [{ text: 'Ответ из базы' }], contextId: 'ctx-db', taskId: 'from-db' },
      artifacts: [{ artifactId: 'a', name: 'answer', parts: [{ text: 'Ответ из базы' }] }],
      history: [],
    };
    query.mockImplementation((sql: string, params: unknown[] = []) =>
      Promise.resolve({ rows: /FROM a2a_tasks/.test(sql) && params[0] === 'from-db' ? [{ record: stored }] : [] }));
    const got = await (await rpc('GetTask', { id: 'from-db' }, { 'A2A-Version': '1.0' })).json();
    expect(got.result).toMatchObject({ id: 'from-db', contextId: 'ctx-db', status: { state: 'TASK_STATE_COMPLETED' } });
    expect((await (await rpc('GetTask', { id: 'other' }, { 'A2A-Version': '1.0' })).json()).error.code).toBe(-32001);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation((sql: string) => /FROM a2a_tasks/.test(sql)
      ? Promise.reject(Object.assign(new Error('connection terminated'), { code: '57P01' }))
      : Promise.resolve({ rows: [] }));
    const down = await (await rpc('GetTask', { id: 'from-db' }, { 'A2A-Version': '1.0' })).json();
    expect(down.error.code).toBe(-32603);
    expect(down.error.message).toMatch(/не читается/);
    const rest = await restGet(req('/api/a2a/v1/tasks/from-db', { method: 'GET', headers: { 'A2A-Version': '1.0' } }), restCtx('tasks/from-db'));
    expect(rest.status).toBe(500);
    spy.mockRestore();
  });

  it('уведомление — 202 без тела; не JSON — 400 и -32700; пакет — -32600', async () => {
    const notice = await POST(req('/api/a2a', { method: 'POST', body: { jsonrpc: '2.0', method: 'SendMessage', params: {} } }));
    expect(notice.status).toBe(202);
    const broken = await POST(req('/api/a2a', { method: 'POST', body: '{не json' }));
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.code).toBe(-32700);
    const batch = await POST(req('/api/a2a', { method: 'POST', body: [{ jsonrpc: '2.0', id: 1, method: 'SendMessage' }] }));
    expect((await batch.json()).error.code).toBe(-32600);
  });

  it('GET отдаёт визитку, OPTIONS — предполёт с заголовком версии', async () => {
    const card = await (await GET()).json();
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC');
    const pre = await OPTIONS();
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('A2A-Version');
  });

  it('исключение исполнителя — -32603 общим текстом, без err.message наружу', async () => {
    runPublicTool.mockRejectedValueOnce(new Error('pg: relation x does not exist'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await rpc('SendMessage', { message: { parts: [{ data: { tool: 'get_tours' } }] } })).json();
    expect(body.error.code).toBe(-32603);
    expect(JSON.stringify(body)).not.toContain('relation x');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('HTTP+JSON биндинг', () => {
  it('POST /message:send → 200 application/a2a+json, форма по заголовку версии', async () => {
    const res = await restPost(req('/api/a2a/v1/message:send', { method: 'POST', body: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ data: { tool: 'get_tours' } }] } }, headers: { 'A2A-Version': '1.0' } }), restCtx('message:send'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/a2a+json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('GET /tasks/{id} читает задачу; незнакомая — 404 google.rpc.Status с TASK_NOT_FOUND', async () => {
    const sent = await (await restPost(req('/api/a2a/v1/message:send', { method: 'POST', body: { message: { parts: [{ data: { tool: 'get_tours' } }] } }, headers: { 'A2A-Version': '1.0' } }), restCtx('message:send'))).json();
    const id = sent.task.id as string;
    const got = await restGet(req(`/api/a2a/v1/tasks/${id}?historyLength=0`, { method: 'GET', headers: { 'A2A-Version': '1.0' } }), restCtx(`tasks/${id}`));
    expect(got.status).toBe(200);
    const task = await got.json();
    expect(task.id).toBe(id);
    expect(task.history).toEqual([]);
    const missing = await restGet(req('/api/a2a/v1/tasks/nope', { method: 'GET' }), restCtx('tasks/nope'));
    expect(missing.status).toBe(404);
    const err = (await missing.json()).error;
    expect(err).toMatchObject({ code: 404, status: 'NOT_FOUND' });
    expect(err.details[0]).toMatchObject({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' });
  });

  it('поток, подписка, push и список — 400 FAILED_PRECONDITION с причиной; неизвестный путь — 404', async () => {
    const stream = await restPost(req('/api/a2a/v1/message:stream', { method: 'POST', body: {} }), restCtx('message:stream'));
    expect(stream.status).toBe(400);
    expect((await stream.json()).error.details[0].reason).toBe('UNSUPPORTED_OPERATION');
    const push = await restPost(req('/api/a2a/v1/tasks/abc/pushNotificationConfigs', { method: 'POST', body: {} }), restCtx('tasks/abc/pushNotificationConfigs'));
    expect((await push.json()).error.details[0].reason).toBe('PUSH_NOTIFICATION_NOT_SUPPORTED');
    const del = await restDelete(req('/api/a2a/v1/tasks/abc/pushNotificationConfigs/c1', { method: 'DELETE' }), restCtx('tasks/abc/pushNotificationConfigs/c1'));
    expect(del.status).toBe(400);
    const list = await restGet(req('/api/a2a/v1/tasks', { method: 'GET' }), restCtx('tasks'));
    expect((await list.json()).error.details[0].reason).toBe('UNSUPPORTED_OPERATION');
    const unknown = await restGet(req('/api/a2a/v1/whatever', { method: 'GET' }), restCtx('whatever'));
    expect(unknown.status).toBe(404);
  });

  it('POST /tasks/{id}:cancel завершённой — 400 TASK_NOT_CANCELABLE; корень — визитка', async () => {
    const sent = await (await restPost(req('/api/a2a/v1/message:send', { method: 'POST', body: { message: { parts: [{ data: { tool: 'get_tours' } }] } } }), restCtx('message:send'))).json();
    const cancel = await restPost(req(`/api/a2a/v1/tasks/${sent.id}:cancel`, { method: 'POST' }), restCtx(`tasks/${sent.id}:cancel`));
    expect(cancel.status).toBe(400);
    expect((await cancel.json()).error.details[0].reason).toBe('TASK_NOT_CANCELABLE');
    const root = await restGet(req('/api/a2a/v1', { method: 'GET' }), restCtx(''));
    expect((await root.json()).supportedInterfaces).toBeDefined();
  });
});
