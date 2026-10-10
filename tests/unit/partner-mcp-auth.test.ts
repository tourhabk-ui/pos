/**
 * Сторож MCP партнёра по ключу (CRM #2325, шаг 1д-2).
 *
 * Условия владельца (карт-бланш на 1д) держатся исполнением:
 *  - ключ хранится хешем и показывается один раз: в INSERT уходит sha256, в
 *    списке кабинета нет ни ключа, ни хеша;
 *  - ключ отзывается: проверка ключа требует `revoked_at IS NULL`, отзыв —
 *    только своего ключа;
 *  - по умолчанию — только чтение: ключ без права записи пишущих
 *    инструментов не видит, а их вызов — ошибка протокола без обращения к
 *    базе;
 *  - партнёр — только из ключа, не из аргументов; запись подписана `mcp`;
 *  - без ключа, с чужим, битым или отозванным — 401 до разбора тела; база
 *    не ответила — 503, а не 401;
 *  - вызовы партнёра не пишутся в журнал публичного MCP и не смешиваются с
 *    его реестром инструментов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

const query = vi.fn();
const executeCrmTool = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/crm/tools', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/tools')>()),
  executeCrmTool: (...a: unknown[]) => executeCrmTool(...a),
}));

const keys = await import('@/lib/crm/agent-keys');
const { POST, GET } = await import('@/app/api/mcp/partner/route');

const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const K = 'eeeeeeee-0000-4000-8000-000000000001';
const KEY = keys.generateAgentKey(() => Buffer.alloc(32, 7));

function keyRow(over: Record<string, unknown> = {}) {
  return { id: K, partner_id: P, can_write: false, name: 'Вулкан-Тур', category: 'operator', user_id: 'u-1', profile_status: 'approved', ...over };
}

/** База: проверка ключа отдаёт `row`; прочие запросы (отметка использования) — пусто. */
function db(row: Record<string, unknown> | null) {
  query.mockImplementation(async (sql: string) => {
    if (/FROM partner_api_keys k/.test(sql)) return { rows: row ? [row] : [] };
    return { rows: [], rowCount: 1 };
  });
}

function req(body: unknown, auth: string | null = `Bearer ${KEY}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth !== null) headers.authorization = auth;
  return new NextRequest('http://localhost/api/mcp/partner', { method: 'POST', headers, body: JSON.stringify(body) });
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

beforeEach(() => {
  query.mockReset();
  executeCrmTool.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ключ: хеш, форма, один показ', () => {
  it('ключ — префикс и 43 знака base64url; хеш — sha256 hex', () => {
    expect(KEY).toMatch(/^vdr_pk_[A-Za-z0-9_-]{43}$/);
    expect(keys.isAgentKeyShape(KEY)).toBe(true);
    expect(keys.hashAgentKey(KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.isAgentKeyShape('vdr_pk_short')).toBe(false);
    expect(keys.bearerKey(`Bearer ${KEY}`)).toBe(KEY);
    expect(keys.bearerKey(`Basic ${KEY}`)).toBeNull();
  });

  it('при выпуске в базу уходит хеш, а не ключ; ключ возвращается один раз', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: K, label: 'Claude', key_prefix: 'vdr_pk_BwcHBw', can_write: false, created_at: new Date(), last_used_at: null, revoked_at: null }] });
    const r = await keys.createAgentKey(P, { label: 'Claude', canWrite: false, createdBy: 'u-1' }, { query } as never, () => Buffer.alloc(32, 7));
    expect(r).toMatchObject({ outcome: 'created', key: KEY });
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(KEY);
    expect(params).toContain(keys.hashAgentKey(KEY));
    expect(params).toContain(KEY.slice(0, 13));
    if (r.outcome === 'created') expect(JSON.stringify(r.item)).not.toContain(KEY);
  });

  it('предел действующих ключей — в том же запросе, что вставка; подключения OAuth в него не считаются', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await keys.createAgentKey(P, { label: 'x', canWrite: false, createdBy: null }, { query } as never)).toEqual({ outcome: 'limit' });
    expect(query.mock.calls[0][0]).toMatch(/count\(\*\) FROM partner_api_keys\s+WHERE partner_id = \$1::uuid AND revoked_at IS NULL AND oauth_client_id IS NULL\) < \$7/);
  });

  it('список кабинета не выбирает ни ключа, ни хеша', () => {
    const src = readFileSync('lib/crm/agent-keys.ts', 'utf8');
    const list = /const LIST_COLUMNS = '([^']+)'/.exec(src)?.[1] ?? '';
    expect(list).not.toMatch(/key_hash/);
    expect(list).toMatch(/key_prefix/);
  });

  it('в миграции нет колонки для самого ключа — только хеш и начало', () => {
    const sql = readFileSync('migrations/1203_partner_api_keys.sql', 'utf8');
    expect(sql).toMatch(/key_hash\s+CHAR\(64\) NOT NULL/);
    expect(sql).not.toMatch(/^\s*(api_key|key|secret|token)\s+/m);
    expect(sql).toMatch(/can_write\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it('отзыв — только своего действующего ключа; проверка — только действующих', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await keys.revokeAgentKey(P, K, 'u-1', { query } as never)).toBe(false);
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = \$2::uuid AND partner_id = \$1 AND revoked_at IS NULL/);
    const src = readFileSync('lib/crm/agent-keys.ts', 'utf8');
    expect(src).toMatch(/WHERE k\.key_hash = \$1 AND k\.revoked_at IS NULL/);
  });
});

describe('вход в MCP партнёра', () => {
  it('без ключа, с битым и с неизвестным (или отозванным) — 401 с WWW-Authenticate', async () => {
    db(null);
    for (const auth of [null, 'Bearer nope', `Bearer ${KEY}`]) {
      const res = await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth));
      expect(res.status, String(auth)).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
    // Битый ключ до базы не доходит.
    expect(query).toHaveBeenCalledTimes(1);
    expect(executeCrmTool).not.toHaveBeenCalled();
  });

  it('база не ответила — 503, а не 401', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    expect((await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(503);
  });

  it('агент без одобрения — 403: CRM кабинета ему не положена', async () => {
    db(keyRow({ category: 'agent', profile_status: 'pending' }));
    expect((await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(403);
  });

  it('поток событий не поддерживается — 405', async () => {
    expect((await GET()).status).toBe(405);
  });
});

describe('инструменты по ключу', () => {
  it('ключ только для чтения: пишущих инструментов не видно, вызов — ошибка протокола без исполнения', async () => {
    db(keyRow({ can_write: false }));
    const list = await (await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).json();
    const names = (list.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>).map((t) => t.name);
    expect(names).toEqual(['crm_inbox', 'crm_find_contact', 'crm_contact_card', 'crm_tasks']);
    for (const t of list.result.tools as Array<{ annotations: { readOnlyHint: boolean } }>) expect(t.annotations.readOnlyHint).toBe(true);

    const res = await (await POST(req(call('crm_add_task', { title: 'x', due: '2030-01-01' })))).json();
    expect(res.error.code).toBe(-32602);
    expect(executeCrmTool).not.toHaveBeenCalled();
  });

  it('ключ на запись видит пишущие; партнёр — из ключа, а не из аргументов; запись от mcp', async () => {
    db(keyRow({ can_write: true }));
    executeCrmTool.mockResolvedValueOnce({ ok: true, data: { created: true } });
    const list = await (await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).json();
    expect((list.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain('crm_add_task');

    const res = await (await POST(req(call('crm_add_task', { title: 'x', due: '2030-01-01', partner_id: 'чужой' })))).json();
    expect(res.result.content[0].text).toBe('{"created":true}');
    expect(executeCrmTool).toHaveBeenCalledWith(
      'crm_add_task',
      { title: 'x', due: '2030-01-01', partner_id: 'чужой' },
      { partnerId: P, category: 'operator', userId: 'u-1', actor: 'mcp', canWrite: true },
    );
  });

  it('отказ инструмента — isError с текстом, а не пустой успех', async () => {
    db(keyRow());
    executeCrmTool.mockResolvedValueOnce({ ok: false, error: 'Клиент не найден среди клиентов партнёра' });
    const res = await (await POST(req(call('crm_contact_card', { contact_id: K })))).json();
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'Не выполнено: Клиент не найден среди клиентов партнёра' }], isError: true });
  });

  it('рукопожатие называет партнёра и право ключа; неизвестный метод — -32601', async () => {
    db(keyRow());
    const init = await (await POST(req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))).json();
    expect(init.result.serverInfo.name).toBe('vedar-partner-crm');
    expect(init.result.instructions).toMatch(/Вулкан-Тур.*только для чтения/s);
    const unknown = await (await POST(req({ jsonrpc: '2.0', id: 2, method: 'resources/list' }))).json();
    expect(unknown.error.code).toBe(-32601);
  });
});

describe('отдельно от публичного MCP', () => {
  it('журнал публичного канала партнёрские вызовы не пишет', () => {
    for (const f of ['app/api/mcp/partner/route.ts', 'lib/mcp/partner-server.ts', 'lib/crm/agent-keys.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/logMcpToolCall|logMcpClient|INSERT INTO mcp_tool_calls/);
      expect(src, f).not.toMatch(/from '@\/lib\/mcp\/call-log'/);
    }
  });

  it('ключи выпускаются и отзываются в кабинете: панель на «Задачах» — экране всех шести ролей', () => {
    expect(readFileSync('components/crm/TasksScreen.tsx', 'utf8')).toMatch(/<AgentKeysPanel \/>/);
    const panel = readFileSync('components/crm/AgentKeysPanel.tsx', 'utf8');
    expect(panel).toMatch(/второй раз его не показать/);
    // По умолчанию — только чтение: флажок записи стартует выключенным.
    expect(panel).toMatch(/const \[canWrite, setCanWrite\] = useState\(false\)/);
  });

  it('CORS не открыт: ключ — секрет партнёра, браузерной странице держать его незачем', () => {
    expect(readFileSync('app/api/mcp/partner/route.ts', 'utf8')).not.toMatch(/Access-Control-Allow-Origin/);
  });
});
