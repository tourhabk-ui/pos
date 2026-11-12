// @vitest-environment node
/**
 * Ключ заявки не доходит до базы открытым текстом — через POST роута, а не по
 * исходнику (ревью безопасности к #3280, 12.11).
 *
 * Ревью показало обход правила «ключ в журнал не пишется»: агент путает имя
 * поля (`status_key`), инструмент отвечает отказом, а отказ тоже пишется в
 * `mcp_tool_calls` — со значением. Поэтому здесь судится то, что на деле ушло
 * в базу: параметры каждого запроса за вызов.
 *
 * Держит:
 *   - у инструментов с ключом заявки (статус, отмена и перенос) в журнале имя
 *     аргумента есть, значения нет — под любым именем и в любой обёртке;
 *   - сам ключ не уходит в базу ни одним запросом вызова: заявку ищут по хэшу;
 *   - у читающего инструмента значение, в котором есть ключ, записано как
 *     «[скрыто]», а обычное — как есть;
 *   - инструмент с параметром `key` в схеме обязан стоять в KEY_ARG_TOOL_NAMES.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query, executeKuzmichTool } = vi.hoisted(() => ({ query: vi.fn(), executeKuzmichTool: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query,
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  },
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool }));

import { POST } from '@/app/api/mcp/route';
import { HIDDEN_VALUE } from '@/lib/mcp/call-reason';
import { CHANGE_TOOL_NAMES, KEY_ARG_TOOL_NAMES, PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';

// Форма настоящего ключа: 24 случайных байта в base64url, 32 знака.
const KEY = 'Zq3vT-xYLmK_aB7cDreFlgH8jNopRisU';
// Без единой цифры — таких около 0,4%; правило «20 знаков и цифра» их не узнавало.
const KEY_NO_DIGITS = 'ZqXvT-xYLmK_aBkcDreFlgHmjNopRisU';

let ipCounter = 0;
async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  ipCounter += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    // Свой адрес на каждый вызов — лимит чтения в памяти общий на модуль.
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.12.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const body = await res.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' };
}

/** Строки журнала вызовов, ушедшие в базу: [tool, …, arg_key, arg_value]. */
function journalRows(): { tool: unknown; errorCode: unknown; argKey: unknown; argValue: unknown }[] {
  return query.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO mcp_tool_calls'))
    .map(([, p]) => ({ tool: (p as unknown[])[0], errorCode: (p as unknown[])[7], argKey: (p as unknown[])[8], argValue: (p as unknown[])[9] }));
}

/** Всё, что ушло в базу параметрами за вызов, одной строкой. */
const sentToDb = (): string => JSON.stringify(query.mock.calls.map(([, params]) => params ?? []));

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  executeKuzmichTool.mockReset().mockResolvedValue('Погода: ясно');
});

describe('инструменты с ключом заявки: в журнале имя аргумента, значения нет', () => {
  it('набор — ровно инструменты, у которых в схеме есть параметр key', () => {
    const withKey = PUBLIC_MCP_TOOLS
      .filter((t) => Object.keys(t.inputSchema.properties ?? {}).includes('key'))
      .map((t) => t.name)
      .sort();
    expect([...KEY_ARG_TOOL_NAMES].sort()).toEqual(withKey);
    expect(withKey).toEqual(['change_request', 'get_request_status']);
    // Меняющий заявку по ключу инструмент без ключа не бывает.
    for (const name of CHANGE_TOOL_NAMES) expect(KEY_ARG_TOOL_NAMES.has(name), name).toBe(true);
  });

  const cases: [label: string, args: Record<string, unknown>, argKey: string][] = [
    ['ключ под своим именем', { key: KEY }, 'key'],
    ['ключ без цифр под чужим именем', { status_key: KEY_NO_DIGITS }, 'status_key'],
    ['ключ в кавычках под чужим именем', { status_key: `"${KEY}"` }, 'status_key'],
    ['ключ с приставкой под чужим именем', { request: `key: ${KEY_NO_DIGITS}` }, 'request'],
  ];

  for (const tool of ['get_request_status', 'change_request']) {
    for (const [label, args, argKey] of cases) {
      it(`${tool}: ${label}`, async () => {
        const res = await call(tool, tool === 'change_request' ? { ...args, action: 'cancel' } : args);
        // Заявки по такому ключу нет (или ключ не под тем именем) — отказ, и он тоже пишется в журнал.
        expect(res.isError).toBe(true);
        const rows = journalRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ tool, argKey, argValue: null });
        expect(typeof rows[0].errorCode).toBe('string');
        // Ни один запрос вызова не несёт ключ: заявку ищут по хэшу.
        const sent = sentToDb();
        expect(sent).not.toContain(KEY);
        expect(sent).not.toContain(KEY_NO_DIGITS);
      });
    }
  }

  it('ключ под своим именем дошёл до поиска заявки — хэшем', async () => {
    await call('get_request_status', { key: KEY });
    await call('change_request', { key: KEY, action: 'cancel' });
    const lookups = query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('agent_request_keys'));
    // Иначе проверка выше зелёная и тогда, когда инструмент до базы не дошёл вовсе.
    expect(lookups.length).toBeGreaterThanOrEqual(2);
    for (const [, params] of lookups) expect(String((params as unknown[])[0])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('читающий инструмент: значение с ключом — «[скрыто]», обычное — как есть', () => {
  it('ключ в значении чужого аргумента скрыт, название места записано', async () => {
    await call('get_weather', { location: `Петропавловск ${KEY}` });
    await call('get_weather', { location: KEY_NO_DIGITS });
    await call('get_weather', { location: 'Петропавловск-Камчатский' });
    const rows = journalRows();
    expect(rows.map((r) => r.argValue)).toEqual([HIDDEN_VALUE, HIDDEN_VALUE, 'Петропавловск-Камчатский']);
    for (const r of rows) expect(r).toMatchObject({ tool: 'get_weather', argKey: 'location' });
    const journal = JSON.stringify(query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('mcp_tool_calls')).map(([, p]) => p));
    expect(journal).not.toContain(KEY);
    expect(journal).not.toContain(KEY_NO_DIGITS);
  });
});
