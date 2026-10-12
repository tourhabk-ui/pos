// @vitest-environment node
/**
 * Журнал A2A и страница «A2A: кто приходит из ИИ» (решение владельца 12.10:
 * «я бы хотел видеть в админ-хабе A2A, хотя бы кто заходит из ИИ»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. «Кто» — самоназвание программы из заголовка, не строка целиком: известный
 *    обходчик по реестру семейств, иначе первый неродовой токен Name/Version,
 *    браузер — «браузер», пусто — «не представился». Род агента: свой,
 *    проверка реестра A2A, иная проверка, внешний.
 * 2. Журнал пишет факт запроса фиксированным списком колонок; сырой
 *    User-Agent, IP и contextId в параметры не попадают (contextId — hash);
 *    отказ записи — в лог с SQLSTATE, не наружу и не молча.
 * 3. Оба биндинга журналируют КАЖДЫЙ исход: успех, ошибку диспетчера, отказ
 *    до него (версия, метод, тело), уведомление, чтение визитки; факты
 *    SendMessage (вход, инструмент, состояние, контекст) берутся из ответа
 *    обеих форм протокола.
 * 4. Миграция 1219: таблица без колонок User-Agent, IP, текста и аргументов.
 * 5. Срез /api/admin/analytics/a2a — за админом, три блока с тремя исходами
 *    каждый: данные, «пусто с датой журнала», «не прочиталось» (SQLSTATE) — и
 *    отказ одного блока не роняет остальные.
 * 6. Страница /hub/admin/a2a: сервер с noindex, клиент зовёт срез, отказ
 *    показан отказом, пункт меню в «Каналах».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const { runPublicTool, answerAgentMessage, query, requireAdmin } = vi.hoisted(() => ({
  runPublicTool: vi.fn(),
  answerAgentMessage: vi.fn(),
  query: vi.fn(),
  requireAdmin: vi.fn(),
}));
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool }));
vi.mock('@/lib/a2a/chat', () => ({ answerAgentMessage }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));

import {
  agentLabel, a2aAgentKind, contextKey, sendMessageFacts, logA2aRequest, UNKNOWN_AGENT, AGENT_LABEL_MAX,
} from '@/lib/a2a/journal';
import { POST, GET } from '@/app/api/a2a/route';
import { POST as restPost, GET as restGet, DELETE as restDelete } from '@/app/api/a2a/v1/[[...path]]/route';
import { GET as adminGet, readWindowDays, PSEUDO_FAMILY_LABELS } from '@/app/api/admin/analytics/a2a/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const INSERT_COLUMNS = [
  'binding', 'op', 'version', 'version_declared', 'ok', 'error_code', 'input', 'tool', 'state',
  'duration_ms', 'agent', 'ua_family', 'caller_hash', 'context_key', 'is_self',
];
const HASH = /^[0-9a-f]{32}$/;

/** Последняя запись в журнал: SQL и параметры INSERT. */
function lastInsert(): { sql: string; params: unknown[] } {
  const calls = query.mock.calls.filter((c) => /INSERT INTO a2a_requests/.test(String(c[0])));
  expect(calls.length).toBeGreaterThan(0);
  const [sql, params] = calls[calls.length - 1] as [string, unknown[]];
  return { sql, params };
}

let ipCounter = 0;
function req(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) {
  ipCounter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.0.${ipCounter % 250}`, 'user-agent': 'python-requests/2.32.3', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)),
  });
}
const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
  POST(req('/api/a2a', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, headers }));
const restCtx = (path: string) => ({ params: Promise.resolve({ path: path === '' ? [] : path.split('/') }) });

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  runPublicTool.mockReset();
  answerAgentMessage.mockReset();
  requireAdmin.mockReset();
  runPublicTool.mockResolvedValue({ kind: 'ok', text: 'Два тура', handoffUrl: 'https://vedarai.ru/mcp/h/x' });
  answerAgentMessage.mockResolvedValue({ ok: true, text: 'Ответ Кузьмича' });
});

describe('самоназвание и род агента', () => {
  it('имя программы из заголовка — без версии, платформы и скобок', () => {
    expect(agentLabel('A2A-Registry-TaskProbe/1.0')).toBe('A2A-Registry-TaskProbe');
    expect(agentLabel('python-requests/2.32.3')).toBe('python-requests');
    expect(agentLabel('a2a-sdk/0.3.0 python/3.12')).toBe('a2a-sdk');
    expect(agentLabel('curl/8.5.0')).toBe('curl');
    expect(agentLabel('Go-http-client/1.1')).toBe('Go-http-client');
    expect(agentLabel('okhttp/4.12')).toBe('okhttp');
    expect(agentLabel('node')).toBe('node');
    // Известные обходчики — как они себя пишут, где бы ни стояли в строке.
    expect(agentLabel('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)')).toBe('GPTBot');
    expect(agentLabel('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe('ClaudeBot');
    expect(agentLabel('Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)')).toBe('Bytespider');
    expect(agentLabel('Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)')).toBe('Sogou web spider');
    // Чужой бот без вендора в реестре — свой токен, не «браузер».
    expect(agentLabel('Mozilla/5.0 (compatible; Foo-Agent/1.0; +https://example.com)')).toBe('Foo-Agent');
    // Только родовые токены — браузер человека.
    expect(agentLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36')).toBe('браузер');
    expect(agentLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('браузер');
    expect(agentLabel('')).toBe(UNKNOWN_AGENT);
    expect(agentLabel(null)).toBe(UNKNOWN_AGENT);
    expect(agentLabel('   ')).toBe(UNKNOWN_AGENT);
    expect(agentLabel('(((')).toBe('не разобран');
    // Ни почты, ни адреса, ни версии, ни скобок — и не длиннее колонки.
    for (const ua of ['python-requests/2.32.3 (x@y.ru)', `${'x'.repeat(200)}/1.0`, 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)']) {
      const label = agentLabel(ua);
      expect(label).not.toMatch(/[@()\s]|\d+\.\d+\.\d+|https?:/);
      expect(label.length).toBeLessThanOrEqual(AGENT_LABEL_MAX);
    }
  });

  it('род: свой, проверка реестра A2A, иная проверка (по образцу ремесла или curl), внешний', () => {
    expect(a2aAgentKind('A2A-Registry-TaskProbe', 'неизвестен', false)).toBe('registry');
    expect(a2aAgentKind('A2A-Registry-Smoke', 'неизвестен', false)).toBe('registry');
    expect(a2aAgentKind('glama-mcp-inspector', 'node', false)).toBe('probe');
    expect(a2aAgentKind('curl', 'curl', false)).toBe('probe');
    expect(a2aAgentKind('python-requests', 'python', false)).toBe('external');
    expect(a2aAgentKind('GPTBot', 'openai', false)).toBe('external');
    // Метка владельца сильнее любого имени.
    expect(a2aAgentKind('A2A-Registry-TaskProbe', 'неизвестен', true)).toBe('self');
  });

  it('контекст считается по hash, не читается; факты SendMessage — из обеих форм ответа', () => {
    expect(contextKey(null)).toBeNull();
    expect(contextKey('')).toBeNull();
    expect(contextKey('ctx-1')).toMatch(HASH);
    expect(contextKey('ctx-1')).toBe(contextKey('ctx-1'));
    expect(contextKey('ctx-1')).not.toBe(contextKey('ctx-2'));
    expect(contextKey('ctx-1')).not.toContain('ctx');
    expect(sendMessageFacts({ task: { contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' }, metadata: { input: 'tool', tool: 'get_tours' } } }))
      .toEqual({ contextId: 'c1', state: 'completed', input: 'tool', tool: 'get_tours' });
    expect(sendMessageFacts({ kind: 'task', contextId: 'c2', status: { state: 'rejected' }, metadata: { input: 'text' } }))
      .toEqual({ contextId: 'c2', state: 'rejected', input: 'text', tool: null });
    // Несуществующий инструмент в журнал идёт как 'unknown' (та же дисциплина, что у MCP).
    expect(sendMessageFacts({ task: { contextId: 'c3', status: { state: 'TASK_STATE_REJECTED' }, metadata: { input: 'tool', tool: 'drop_table' } } }).tool).toBe('unknown');
    expect(sendMessageFacts({ task: { status: { state: 'TASK_STATE_WORKING' } } })).toEqual({ contextId: null, state: null, input: null, tool: null });
  });
});

describe('запись в журнал', () => {
  it('фиксированный список колонок; UA, IP и contextId в параметры не попадают', () => {
    logA2aRequest({
      binding: 'rest', op: 'SendMessage', version: '1.0', versionDeclared: true, ok: true, errorCode: 'ignored-when-ok',
      input: 'tool', tool: 'get_tours', state: 'completed', contextId: 'ctx-secret', durationMs: 42.6,
      ip: '203.0.113.7', userAgent: 'A2A-Registry-TaskProbe/1.0 (+https://a2aregistry.org)', self: false,
    });
    const { sql, params } = lastInsert();
    expect(sql).toContain(`INSERT INTO a2a_requests (${INSERT_COLUMNS.join(', ')})`);
    expect(sql).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14, \$15\)/);
    expect(params).toHaveLength(INSERT_COLUMNS.length);
    expect(params.slice(0, 12)).toEqual(['rest', 'SendMessage', '1.0', true, true, null, 'tool', 'get_tours', 'completed', 43, 'A2A-Registry-TaskProbe', 'неизвестен']);
    expect(params[12]).toMatch(HASH);
    expect(params[13]).toMatch(HASH);
    expect(params[14]).toBe(false);
    const flat = JSON.stringify(params);
    expect(flat).not.toContain('203.0.113.7');
    expect(flat).not.toContain('a2aregistry.org');
    expect(flat).not.toContain('ctx-secret');
    expect(flat).not.toContain('/1.0');
  });

  it('ошибка протокола пишется кодом; версия — до 8 знаков; чужое имя инструмента — unknown', () => {
    logA2aRequest({ binding: 'jsonrpc', op: 'invalid', version: '2.0.0-beta.1', versionDeclared: true, ok: false, errorCode: 'VersionNotSupported', ip: '10.0.0.1', userAgent: '', self: true });
    let { params } = lastInsert();
    expect(params.slice(0, 6)).toEqual(['jsonrpc', 'invalid', '2.0.0-be', true, false, 'VersionNotSupported']);
    expect(params[10]).toBe(UNKNOWN_AGENT);
    expect(params[13]).toBeNull();
    expect(params[14]).toBe(true);
    logA2aRequest({ binding: 'jsonrpc', op: 'SendMessage', version: '0.3', versionDeclared: false, ok: true, input: 'tool', tool: 'drop_table', state: 'rejected', ip: '10.0.0.1', userAgent: 'curl/8', self: false });
    ({ params } = lastInsert());
    expect(params[7]).toBe('unknown');
    expect(params[9]).toBeNull();
  });

  it('отказ записи — в лог с SQLSTATE, не наружу', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(Object.assign(new Error('relation "a2a_requests" does not exist'), { code: '42P01' }));
    expect(() => logA2aRequest({ binding: 'rest', op: 'card', version: '0.3', versionDeclared: false, ok: true, ip: '', userAgent: 'curl/8', self: false })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[a2a-journal]'), 'SQLSTATE=42P01', expect.any(String));
    err.mockRestore();
  });

  it('журнал живёт вне пяти чистых файлов A2A и не пишет текст, аргументы и заголовок целиком', () => {
    const src = read('lib/a2a/journal.ts');
    expect(src.match(/INSERT INTO a2a_requests/g)).toHaveLength(1);
    expect(src).not.toMatch(/user_agent|raw_ua|arguments|question_text/);
    for (const f of ['app/api/a2a/_shared.ts', 'app/api/a2a/route.ts', 'app/api/a2a/v1/[[...path]]/route.ts', 'lib/a2a/handle.ts', 'lib/a2a/wire.ts']) {
      expect(read(f), f).not.toMatch(/pool\.query|INSERT INTO/);
    }
    // Факты берутся из ответа диспетчера, а не считаются заново в обработчике.
    expect(read('app/api/a2a/_shared.ts')).toMatch(/sendMessageFacts\(f\.out\.result\)/);
  });
});

describe('оба биндинга журналируют каждый исход', () => {
  it('JSON-RPC: SendMessage 1.0 с DataPart — инструмент, состояние, контекст, версия, агент', async () => {
    const res = await rpc('SendMessage', { message: { messageId: 'm1', contextId: 'ctx-1', role: 'ROLE_USER', parts: [{ data: { tool: 'get_tours', arguments: { activity_type: 'вулканы' } } }] } }, { 'A2A-Version': '1.0' });
    expect(res.status).toBe(200);
    const { params } = lastInsert();
    expect(params.slice(0, 9)).toEqual(['jsonrpc', 'SendMessage', '1.0', true, true, null, 'tool', 'get_tours', 'completed']);
    expect(params[9]).toEqual(expect.any(Number));
    expect(params[10]).toBe('python-requests');
    expect(params[11]).toBe('python');
    expect(params[13]).toBe(contextKey('ctx-1'));
    expect(params[14]).toBe(false);
  });

  it('JSON-RPC: текст без заголовка — 0.3 по умолчанию, вход text; отказ Кузьмича — rejected', async () => {
    await rpc('message/send', { message: { messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'Что на Горелом?' }] } });
    let { params } = lastInsert();
    expect(params.slice(0, 9)).toEqual(['jsonrpc', 'SendMessage', '0.3', false, true, null, 'text', null, 'completed']);
    expect(params[13]).toMatch(HASH);
    answerAgentMessage.mockResolvedValueOnce({ ok: false, text: 'Подождите', rejected: true });
    await rpc('message/send', { message: { messageId: 'm2', role: 'user', parts: [{ kind: 'text', text: 'Ещё раз' }] } });
    ({ params } = lastInsert());
    expect(params[8]).toBe('rejected');
  });

  it('JSON-RPC: ошибка диспетчера, неподдерживаемая версия, неизвестный метод, уведомление, визитка', async () => {
    await rpc('GetTask', { id: 'no-such' }, { 'A2A-Version': '1.0' });
    expect(lastInsert().params.slice(0, 6)).toEqual(['jsonrpc', 'GetTask', '1.0', true, false, 'TaskNotFound']);
    const bad = await rpc('SendMessage', { message: { parts: [] } }, { 'A2A-Version': '2.0' });
    expect(bad.status).toBe(400);
    expect(lastInsert().params.slice(0, 6)).toEqual(['jsonrpc', 'invalid', '2.0', true, false, 'VersionNotSupported']);
    await rpc('tasks/explode', {}, { 'A2A-Version': '1.0' });
    expect(lastInsert().params.slice(0, 6)).toEqual(['jsonrpc', 'invalid', '1.0', true, false, 'MethodNotFound']);
    await POST(req('/api/a2a', { method: 'POST', body: { jsonrpc: '2.0', method: 'message/send', params: {} } }));
    expect(lastInsert().params.slice(0, 6)).toEqual(['jsonrpc', 'notification', '0.3', false, true, null]);
    await POST(req('/api/a2a', { method: 'POST', body: 'не json' }));
    expect(lastInsert().params.slice(0, 6)).toEqual(['jsonrpc', 'invalid', '0.3', false, false, 'ParseError']);
    await GET(req('/api/a2a', { method: 'GET', headers: { 'user-agent': 'A2A-Registry-Smoke/1.0' } }));
    expect(lastInsert().params.slice(0, 6)).toEqual(['jsonrpc', 'card', '0.3', false, true, null]);
    expect(lastInsert().params[10]).toBe('A2A-Registry-Smoke');
    // Визитка без запроса (старые вызовы GET()) — ответ есть, журнала нет, падения нет.
    const before = query.mock.calls.length;
    expect((await GET()).status).toBe(200);
    expect(query.mock.calls.length).toBe(before);
  });

  it('REST: message:send, визитка, неподдерживаемый поток, неизвестный путь, версия, DELETE', async () => {
    const ok = await restPost(req('/api/a2a/v1/message:send', { method: 'POST', body: { message: { parts: [{ data: { tool: 'get_tours', arguments: {} } }] } }, headers: { 'A2A-Version': '1.0', 'user-agent': 'a2a-sdk/0.3.0 python/3.12' } }), restCtx('message:send'));
    expect(ok.status).toBe(200);
    let { params } = lastInsert();
    expect(params.slice(0, 9)).toEqual(['rest', 'SendMessage', '1.0', true, true, null, 'tool', 'get_tours', 'completed']);
    expect(params[10]).toBe('a2a-sdk');
    await restGet(req('/api/a2a/v1', { method: 'GET' }), restCtx(''));
    expect(lastInsert().params.slice(0, 6)).toEqual(['rest', 'card', '0.3', false, true, null]);
    await restPost(req('/api/a2a/v1/message:stream', { method: 'POST', body: {}, headers: { 'A2A-Version': '1.0' } }), restCtx('message:stream'));
    expect(lastInsert().params.slice(0, 6)).toEqual(['rest', 'invalid', '1.0', true, false, 'UnsupportedOperation']);
    await restGet(req('/api/a2a/v1/nothing', { method: 'GET', headers: { 'A2A-Version': '1.0' } }), restCtx('nothing'));
    expect(lastInsert().params.slice(0, 6)).toEqual(['rest', 'invalid', '1.0', true, false, 'MethodNotFound']);
    const bad = await restGet(req('/api/a2a/v1/tasks/x', { method: 'GET', headers: { 'A2A-Version': '9.9' } }), restCtx('tasks/x'));
    expect(bad.status).toBe(400);
    expect(lastInsert().params.slice(0, 6)).toEqual(['rest', 'invalid', '9.9', true, false, 'VersionNotSupported']);
    await restPost(req('/api/a2a/v1/message:send', { method: 'POST', body: '{не json', headers: { 'A2A-Version': '1.0' } }), restCtx('message:send'));
    expect(lastInsert().params.slice(0, 6)).toEqual(['rest', 'invalid', '1.0', true, false, 'ParseError']);
    await restDelete(req('/api/a2a/v1/tasks/x', { method: 'DELETE' }), restCtx('tasks/x'));
    expect(lastInsert().params.slice(0, 6)).toEqual(['rest', 'invalid', '0.3', false, false, 'MethodNotFound']);
    ({ params } = lastInsert());
    expect(params[13]).toBeNull();
  });

  it('метка владельца в адресе — is_self', async () => {
    const prev = process.env.MCP_SELF_TAG;
    process.env.MCP_SELF_TAG = 'owner-tag-12345';
    try {
      await POST(req('/api/a2a?self=owner-tag-12345', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'привет' }] } } } }));
      expect(lastInsert().params[14]).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MCP_SELF_TAG; else process.env.MCP_SELF_TAG = prev;
    }
  });

  it('в исходниках: каждый ранний выход роутов зовёт журнал', () => {
    const rpcSrc = read('app/api/a2a/route.ts');
    for (const code of ['VersionNotSupported', 'BodyTooLarge', 'ParseError', 'InvalidRequest', 'MethodNotFound', 'Internal']) {
      expect(rpcSrc, code).toMatch(new RegExp(`note\\(\\{ op(?:: 'invalid')?, errorCode: '${code}' \\}\\)`));
    }
    expect(rpcSrc).toMatch(/note\(\{ op: 'notification' \}\)/);
    expect(rpcSrc).toMatch(/note\(\{ op, out \}\)/);
    expect(rpcSrc).toMatch(/journalA2a\(request, 'jsonrpc', Date\.now\(\), \{ op: 'card'/);
    const rest = read('app/api/a2a/v1/[[...path]]/route.ts');
    for (const code of ['VersionNotSupported', 'BodyTooLarge', 'ParseError', 'UnsupportedOperation', 'PushNotificationNotSupported', 'MethodNotFound']) {
      expect(rest, code).toContain(`'${code}', a2aError(`);
    }
    expect(rest).toMatch(/journalA2a\(request, 'rest', startedAt, \{ op, version: read, out \}\)/);
    expect(rest).toMatch(/journalA2a\(request, 'rest', startedAt, \{ op, version: read, errorCode: 'Internal' \}\)/);
    expect(rest).toMatch(/journalA2a\(request, 'rest', startedAt, \{ op: 'card'/);
  });
});

describe('миграция 1219', () => {
  it('таблица a2a_requests: колонки журнала, без UA, IP, текста и аргументов; индексы по времени и агенту', () => {
    const sql = read('migrations/1219_a2a_requests.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS a2a_requests/);
    const ddl = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf(');')).replace(/--.*$/gm, '');
    for (const col of INSERT_COLUMNS) expect(ddl, col).toMatch(new RegExp(`^\\s*${col}\\s+`, 'm'));
    expect(ddl).not.toMatch(/user_agent|\bip\b|\btext\b|arguments|question/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_a2a_requests_created_at/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_a2a_requests_agent_created/);
    expect(sql).toMatch(/COMMENT ON TABLE a2a_requests/);
    expect(read('docs/DB_SCHEMA.md')).toMatch(/a2a_requests/);
  });
});

describe('срез /api/admin/analytics/a2a', () => {
  const adminReq = (qs = '') => new NextRequest(`http://localhost/api/admin/analytics/a2a${qs}`, { method: 'GET' });

  function answer(sql: string): { rows: unknown[] } {
    if (/AS total FROM a2a_requests/.test(sql)) return { rows: [{ since: '2026-10-12', total: 3 }] };
    if (/GROUP BY agent, ua_family, is_self/.test(sql)) {
      return { rows: [
        { agent: 'A2A-Registry-TaskProbe', ua_family: 'неизвестен', is_self: false, requests: 2, sends: 2, text_sends: 1, tool_sends: 1, completed: 2, rejected: 0, failed: 0, protocol_errors: 0, card_reads: 0, dialogs: 2, caller_days: 1, versions: '1.0', bindings: 'rest', first_seen: '2026-10-12 09:00', last_seen: '2026-10-12 10:00' },
        { agent: 'python-requests', ua_family: 'python', is_self: false, requests: 1, sends: 0, text_sends: 0, tool_sends: 0, completed: 0, rejected: 0, failed: 0, protocol_errors: 1, card_reads: 0, dialogs: 0, caller_days: 1, versions: '0.3,2.0', bindings: 'jsonrpc', first_seen: '2026-10-12 11:00', last_seen: '2026-10-12 11:00' },
      ] };
    }
    if (/GROUP BY 1 ORDER BY 1/.test(sql)) return { rows: [{ day: '2026-10-12', requests: 3, agents: 2 }] };
    if (/WHERE tool IS NOT NULL/.test(sql)) return { rows: [{ tool: 'get_tours', calls: 1, completed: 1, rejected: 0, failed: 0, agents: 1 }] };
    if (/ORDER BY created_at DESC/.test(sql)) return { rows: [{ at: '2026-10-12 10:00:00', binding: 'rest', op: 'SendMessage', version: '1.0', version_declared: true, ok: true, error_code: null, input: 'tool', tool: 'get_tours', state: 'completed', duration_ms: 120, agent: 'A2A-Registry-TaskProbe', ua_family: 'неизвестен', is_self: false }] };
    if (/FROM mcp_clients/.test(sql)) {
      return { rows: [
        { client_name: 'claude-ai', ua_family: 'claude', caller_days: 4, days: 3, first_seen: '2026-10-01', last_seen: '2026-10-12 08:00' },
        { client_name: null, ua_family: 'curl', caller_days: 1, days: 1, first_seen: '2026-10-11', last_seen: '2026-10-11 08:00' },
      ] };
    }
    if (/FROM agent_entry_hits/.test(sql) && /MIN\(day\)/.test(sql)) return { rows: [{ since: '2026-10-12', total: 10 }] };
    if (/FROM agent_entry_hits/.test(sql)) return { rows: [{ family: 'openai', hits: 7, paths: 3, last_day: '2026-10-12' }, { family: 'tool', hits: 3, paths: 1, last_day: '2026-10-12' }] };
    throw new Error(`неожиданный SQL: ${sql.slice(0, 80)}`);
  }

  beforeEach(() => {
    requireAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    query.mockImplementation(async (sql: unknown) => answer(String(sql)));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('три блока: агенты с родом и версиями, клиенты MCP с происхождением имени, семейства с вендором', async () => {
    const res = await adminGet(adminReq('?days=7'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.window_days).toBe(7);
    expect(json.degraded).toEqual([]);
    expect(json.a2a.ok).toBe(true);
    expect(json.a2a.since).toBe('2026-10-12');
    expect(json.a2a.total_all_time).toBe(3);
    expect(json.a2a.total_window).toBe(3);
    expect(json.a2a.by_agent[0]).toMatchObject({ agent: 'A2A-Registry-TaskProbe', kind: 'registry', versions: ['1.0'], bindings: ['rest'], dialogs: 2 });
    expect(json.a2a.by_agent[1]).toMatchObject({ agent: 'python-requests', kind: 'external', versions: ['0.3', '2.0'] });
    expect(json.a2a.recent[0]).toMatchObject({ op: 'SendMessage', tool: 'get_tours', kind: 'registry' });
    expect(json.a2a.by_tool).toEqual([{ tool: 'get_tours', calls: 1, completed: 1, rejected: 0, failed: 0, agents: 1 }]);
    expect(json.mcp.ok).toBe(true);
    expect(json.mcp.clients[0]).toMatchObject({ client: 'claude-ai', kind: 'представился', origin: 'external', days: 3 });
    expect(json.mcp.clients[1]).toMatchObject({ client: 'curl', kind: 'по заголовку', origin: 'probe' });
    expect(json.entries.ok).toBe(true);
    expect(json.entries.by_family[0]).toMatchObject({ family: 'openai', vendor: 'OpenAI', hits: 7 });
    expect(json.entries.by_family[1].vendor).toBe(PSEUDO_FAMILY_LABELS.tool);
    // Окно уходит параметром и считается без склейки строк (sql-interval-not-concatenated).
    const windowSql = query.mock.calls.map((c) => String(c[0])).find((s) => /GROUP BY agent, ua_family, is_self/.test(s)) ?? '';
    expect(windowSql).toContain("created_at >= NOW() - ($1::int * INTERVAL '1 day')");
    expect(query.mock.calls.find((c) => /GROUP BY agent, ua_family, is_self/.test(String(c[0])))?.[1]).toEqual([7]);
    expect(JSON.stringify(json)).not.toMatch(/user_agent|203\.0\.113/);
  });

  it('отказ одного блока — ok:false с SQLSTATE и строка в degraded; остальные блоки живут', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: unknown) => {
      if (/FROM a2a_requests/.test(String(sql))) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return answer(String(sql));
    });
    const res = await adminGet(adminReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.a2a).toEqual({ ok: false, error: 'не прочиталось (SQLSTATE=42P01)' });
    expect(json.degraded).toEqual(['a2a']);
    expect(json.mcp.ok).toBe(true);
    expect(json.entries.ok).toBe(true);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[admin/analytics/a2a] блок a2a не прочитался: SQLSTATE=42P01'), expect.any(String));
  });

  it('пустой журнал — ноль с пустой датой, а не ошибка; окно по умолчанию 30 и в пределах 1..90', async () => {
    query.mockImplementation(async (sql: unknown) => (/AS total FROM a2a_requests/.test(String(sql)) ? { rows: [{ since: null, total: 0 }] } : { rows: [] }));
    const json = await (await adminGet(adminReq())).json();
    expect(json.window_days).toBe(30);
    expect(json.a2a).toMatchObject({ ok: true, since: null, total_all_time: 0, total_window: 0, by_agent: [], recent: [] });
    expect(json.entries).toMatchObject({ ok: true, since: null, total_all_time: 0, total_window: 0 });
    expect(readWindowDays(null)).toBe(30);
    expect(readWindowDays('7')).toBe(7);
    expect(readWindowDays('0')).toBe(30);
    expect(readWindowDays('91')).toBe(30);
    expect(readWindowDays('x')).toBe(30);
  });

  it('не админ — ответ гарда без единого запроса к базе', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ success: false, error: 'Требуется аутентификация' }, { status: 401 }));
    const res = await adminGet(adminReq());
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    const src = read('app/api/admin/analytics/a2a/route.ts');
    expect(src).toMatch(/const auth = await requireAdmin\(request\);\s*\n\s*if \(auth instanceof NextResponse\) return auth;/);
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/);
  });
});

describe('страница /hub/admin/a2a', () => {
  it('сервер с noindex, клиент зовёт срез и показывает отказ отказом; пункт меню в «Каналах»', () => {
    const page = read('app/hub/admin/a2a/page.tsx');
    expect(page).toMatch(/robots: 'noindex, nofollow'/);
    expect(page).toMatch(/from '\.\/_A2aClient'/);
    expect(page).not.toMatch(/'use client'/);
    const client = read('app/hub/admin/a2a/_A2aClient.tsx');
    expect(client).toMatch(/^'use client';/);
    expect(client).toContain('fetch(`/api/admin/analytics/a2a?days=${days}`');
    expect(client).toMatch(/Журнал A2A не прочитался/);
    expect(client).toMatch(/Журнал пуст/);
    expect(client).toMatch(/отказ чтения, а не «никто не приходил»/);
    expect(client).not.toMatch(/FROM a2a_requests|pool\.query/);
    // Дизайн-система: токены, не hex; без эмодзи.
    expect(client).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(client).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    const layout = read('app/hub/admin/layout.tsx');
    expect(layout).toMatch(/\{ href: '\/hub\/admin\/a2a', label: 'A2A: кто приходит', icon: Bot, section: 'Каналы' \}/);
    expect(layout).toMatch(/BookUser, Bot,\} from 'lucide-react'/);
    expect(existsSync(join(ROOT, 'app/hub/admin/a2a/page.tsx'))).toBe(true);
  });
});
